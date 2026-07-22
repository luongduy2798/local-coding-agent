// Local Coding Agent CLI supervisor lifecycle.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  adoptProcessRecord,
  newInstanceNonce
} from "../process-lifecycle.mjs";
import {
  INTERNAL_SUPERVISOR_ENV,
  PID_PATH,
  PROCESS_STATE_SCHEMA_VERSION,
  REPO_ROOT,
  SCRIPT_DIR,
  SERVER_DIR,
  SERVER_SCRIPT,
  SUPERVISOR_MAX_RESTARTS,
  SUPERVISOR_STABLE_WINDOW_MS,
  configId,
  effectiveOptions,
  saveConfig,
  stripRuntimeFields,
  tunnelConfigId,
  tunnelHealthConfig,
  validate
} from "./config.mjs";
import {
  appendLog,
  cleanupTunnelHealth,
  processExpectation,
  probeTunnelHealth,
  readDetailedServerHealth,
  readJson,
  readPidState,
  recordCurrentSupervisor,
  recordSpawnedProcess,
  resolveManagedRecord,
  spawnLogged,
  stopVerifiedRecord,
  supervisorBackoffMs,
  waitForChildStable,
  waitForHealth,
  waitForTunnelReady,
  writePidState,
  writeTunnelProfile
} from "./processes.mjs";
import { assertNodeSqlite } from "./setup.mjs";

let services = Object.create(null);

export function configureSupervisorServices(next) {
  services = { ...services, ...next };
}

function statePid(state, role) {
  return state?.[role]?.pid || state?.[`${role}Pid`] || null;
}

function sameProcessStateOwner(current, owner) {
  if (!current || !Object.keys(current).length) return false;
  if (owner?.instanceNonce && current.instanceNonce) {
    return owner.instanceNonce === current.instanceNonce;
  }
  const ownerPids = [statePid(owner, "server"), statePid(owner, "tunnel")].filter(Boolean).map(Number);
  const currentPids = [statePid(current, "server"), statePid(current, "tunnel")].filter(Boolean).map(Number);
  return ownerPids.length > 0 && ownerPids.every((pid) => currentPids.includes(pid));
}

function removePidStateIfOwned(owner) {
  const current = readPidState();
  if (!Object.keys(current).length) return true;
  if (!sameProcessStateOwner(current, owner)) return false;
  try {
    rmSync(PID_PATH, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function stopExistingManagedProcess({ state, role, pid, opts, instanceNonce }) {
  const resolved = await resolveManagedRecord({ state, role, pid, opts, instanceNonce });
  if (!resolved.alive) {
    if (role === "tunnel") cleanupTunnelHealth(state.tunnelHealth);
    return { stopped: true, record: null, reason: "not-running" };
  }
  if (!resolved.verified || !resolved.record) {
    throw new Error(
      `Refusing to stop ${role} PID ${pid}: process identity does not match the saved executable/start time. ` +
      "Inspect it manually before removing the stale process state."
    );
  }
  console.log(`[${role}] stopping verified PID ${pid}`);
  const result = await stopVerifiedRecord(
    resolved.record,
    { ...state, instanceNonce: state.instanceNonce || instanceNonce },
    role,
    opts
  );
  if (!result.stopped) {
    throw new Error(`Could not stop verified ${role} PID ${pid}: ${result.reason}.`);
  }
  if (role === "tunnel") cleanupTunnelHealth(state.tunnelHealth);
  return { ...result, record: resolved.record };
}

async function rollbackSpawnedProcesses(started, opts, instanceNonce) {
  const errors = [];
  for (const role of ["tunnel", "server"]) {
    const item = started[role];
    if (!item?.child?.pid) continue;
    let record = item.record;
    if (!record) {
      const adopted = await adoptProcessRecord({
        ...processExpectation(role, opts),
        pid: item.child.pid,
        instanceNonce
      });
      if (!adopted.observed?.alive) {
        if (role === "tunnel") cleanupTunnelHealth(item.health);
        continue;
      }
      record = adopted.record;
    }
    if (!record) {
      errors.push(`${role} PID ${item.child.pid} could not be re-verified for rollback`);
      continue;
    }
    const result = await stopVerifiedRecord(record, { instanceNonce }, role, opts);
    if (!result.stopped) errors.push(`${role} PID ${record.pid}: ${result.reason}`);
    else if (role === "tunnel") cleanupTunnelHealth(item.health);
  }
  return errors;
}

function buildProcessState({
  previousState,
  instanceNonce,
  config,
  tunnelConfig,
  port,
  supervisorRecord = previousState?.supervisor || null,
  serverRecord,
  tunnelRecord,
  tunnelHealth,
  phase = serverRecord ? "ready" : "starting",
  restart = previousState?.restart || null
}) {
  const now = new Date().toISOString();
  const state = {
    schemaVersion: PROCESS_STATE_SCHEMA_VERSION,
    instanceNonce,
    startedAt:
      previousState?.instanceNonce === instanceNonce && previousState.startedAt
        ? previousState.startedAt
        : now,
    updatedAt: now,
    configId: config,
    tunnelConfigId: tunnelRecord ? tunnelConfig : "",
    port: String(port),
    phase,
    supervisorPid: supervisorRecord?.pid || null,
    supervisor: supervisorRecord || null,
    serverPid: serverRecord?.pid || null,
    server: serverRecord || null
  };
  if (restart) state.restart = restart;
  if (tunnelRecord) {
    state.tunnelPid = tunnelRecord.pid;
    state.tunnel = tunnelRecord;
    state.tunnelHealth = tunnelHealth || null;
  }
  return state;
}

async function runManagedRuntime(flags, { supervisorRecord } = {}) {
  const opts = effectiveOptions(flags);
  validate(opts, { requireWorkspace: true, requireTunnel: true });
  await assertNodeSqlite(opts.node);
  await services.selectCliWorkspace(opts.workspace);
  if (!existsSync(join(SERVER_DIR, SERVER_SCRIPT))) throw new Error(`Missing ${SERVER_SCRIPT} in ${SERVER_DIR}`);
  if (!existsSync(join(SERVER_DIR, "node_modules"))) {
    throw new Error("server/node_modules is missing. Run `node scripts/local-coding-agent.mjs install` first.");
  }
  if (flags.save) await saveConfig(stripRuntimeFields(opts));

  const runtimeKey = opts.noTunnel
    ? ""
    : flags.runtimeKey || process.env[opts.runtimeKeyEnv] || opts.runtimeKey;
  if (!opts.noTunnel && !runtimeKey) {
    throw new Error(`Missing Runtime API key. Set ${opts.runtimeKeyEnv}, pass --runtime-key, or run key set.`);
  }
  const profilePath = opts.noTunnel ? "" : writeTunnelProfile(opts);
  const id = configId(opts);
  const requestedTunnelConfigId = opts.noTunnel ? "" : tunnelConfigId(opts, runtimeKey);
  const healthUrl = `http://127.0.0.1:${opts.port}/healthz`;
  let previousState = readPidState();
  let instanceNonce =
    supervisorRecord?.instanceNonce ||
    previousState.instanceNonce ||
    previousState.server?.instanceNonce ||
    previousState.tunnel?.instanceNonce ||
    newInstanceNonce();
  const started = {
    server: { child: null, record: null },
    tunnel: { child: null, record: null, health: null }
  };
  let stateWasReplaced = false;
  let finalState = null;
  let serverRecord = null;
  let tunnelRecord = null;
  let tunnelHealth = null;
  let serverChild = null;
  let tunnelChild = null;
  const liveness = await readJson(healthUrl);
  let health = liveness
    ? await readDetailedServerHealth(opts.port, instanceNonce)
    : null;

  try {
    if (liveness && !health) {
      throw new Error(
        `A server is listening at ${healthUrl}, but its instance nonce could not be verified. ` +
        "Use the owning `lca stop` process or free the configured port; LCA will not replace an unverified process."
      );
    }
    if (health?.status === "ok" && health.config_id !== id) {
      console.log(`[server] existing server config differs; replacing verified PID ${health.pid}`);
      const previousTunnelPid = statePid(previousState, "tunnel");
      if (previousTunnelPid) {
        await stopExistingManagedProcess({
          state: previousState,
          role: "tunnel",
          pid: previousTunnelPid,
          opts,
          instanceNonce
        });
      }
      await stopExistingManagedProcess({
        state: previousState,
        role: "server",
        pid: health.pid,
        opts,
        instanceNonce
      });
      const previousServerPid = statePid(previousState, "server");
      if (previousServerPid && Number(previousServerPid) !== Number(health.pid)) {
        await stopExistingManagedProcess({
          state: previousState,
          role: "server",
          pid: previousServerPid,
          opts,
          instanceNonce
        });
      }
      removePidStateIfOwned(previousState);
      previousState = {};
      instanceNonce = supervisorRecord?.instanceNonce || newInstanceNonce();
      stateWasReplaced = true;
      health = null;
    }

    if (!health) {
      const previousTunnelPid = statePid(previousState, "tunnel");
      if (previousTunnelPid) {
        await stopExistingManagedProcess({
          state: previousState,
          role: "tunnel",
          pid: previousTunnelPid,
          opts,
          instanceNonce
        });
      }
      const previousServerPid = statePid(previousState, "server");
      if (previousServerPid) {
        await stopExistingManagedProcess({
          state: previousState,
          role: "server",
          pid: previousServerPid,
          opts,
          instanceNonce
        });
      }
      if (previousTunnelPid || previousServerPid || stateWasReplaced) {
        removePidStateIfOwned(previousState);
        previousState = {};
        instanceNonce = supervisorRecord?.instanceNonce || newInstanceNonce();
        stateWasReplaced = true;
      }

      const env = {
        ...process.env,
        PORT: String(opts.port),
        AGENT_HOST: "127.0.0.1",
        AGENT_WORKSPACE: opts.workspace,
        AGENT_MODE: opts.mode,
        AGENT_POLICY: opts.policy,
        AGENT_CONFIG_ID: id,
        AGENT_EXTRA_ROOTS: opts.extraRoots || "",
        MCP_AUTH_TOKEN: opts.authToken || "",
        LCA_INSTANCE_NONCE: instanceNonce
      };
      const stdio = flags.background ? ["ignore", "ignore", "ignore"] : "inherit";
      const spawnedAt = new Date().toISOString();
      serverChild = spawnLogged("server", opts.node, [SERVER_SCRIPT], {
        cwd: SERVER_DIR,
        env,
        detached: Boolean(flags.background),
        stdio
      });
      started.server.child = serverChild;
      health = await waitForHealth(
        opts.port,
        40,
        (candidate) =>
          candidate.config_id === id &&
          Number(candidate.pid) === Number(serverChild.pid),
        { instanceNonce }
      );
      if (!health) {
        throw new Error(`MCP server did not become ready with the expected PID/config at ${healthUrl}`);
      }
      await waitForChildStable(serverChild, "MCP server", 200);
      serverRecord = await recordSpawnedProcess({
        role: "server",
        child: serverChild,
        opts,
        instanceNonce,
        spawnedAt
      });
      started.server.record = serverRecord;
      if (flags.background) serverChild.unref();
    } else {
      const resolved = await resolveManagedRecord({
        state: previousState,
        role: "server",
        pid: health.pid,
        opts,
        instanceNonce
      });
      if (!resolved.verified || !resolved.record) {
        throw new Error(
          `MCP health endpoint answered from PID ${health.pid}, but its executable/start time could not be verified. ` +
          "Refusing to reuse or replace it."
        );
      }
      serverRecord = resolved.record;
      instanceNonce = serverRecord.instanceNonce;
      console.log(`[server] already running; reusing verified PID ${serverRecord.pid}`);
    }

    console.log(`[server] MCP OK:    http://127.0.0.1:${opts.port}/mcp`);
    console.log(`[server] Version:   ${health.version || "unknown"} ${health.tier ? `(${health.tier})` : ""}`);

    const previousTunnelPid = statePid(previousState, "tunnel");
    if (opts.noTunnel) {
      if (previousTunnelPid) {
        await stopExistingManagedProcess({
          state: previousState,
          role: "tunnel",
          pid: previousTunnelPid,
          opts,
          instanceNonce
        });
      }
    } else {
      console.log(`[tunnel] Profile: ${profilePath}`);
      if (previousTunnelPid) {
        const resolved = await resolveManagedRecord({
          state: previousState,
          role: "tunnel",
          pid: previousTunnelPid,
          opts,
          instanceNonce
        });
        if (resolved.alive && (!resolved.verified || !resolved.record)) {
          throw new Error(
            `Refusing to replace tunnel PID ${previousTunnelPid}: saved identity no longer matches the process.`
          );
        }
        const reusableConfig =
          resolved.verified &&
          previousState.configId === id &&
          previousState.tunnelConfigId === requestedTunnelConfigId;
        const tunnelReady = reusableConfig && await probeTunnelHealth(previousState.tunnelHealth);
        if (tunnelReady) {
          tunnelRecord = resolved.record;
          tunnelHealth = previousState.tunnelHealth;
          console.log(`[tunnel] already running and ready; reusing verified PID ${tunnelRecord.pid}`);
        } else if (resolved.verified && resolved.record) {
          const result = await stopVerifiedRecord(resolved.record, previousState, "tunnel", opts);
          if (!result.stopped) {
            throw new Error(`Could not replace tunnel PID ${previousTunnelPid}: ${result.reason}.`);
          }
          cleanupTunnelHealth(previousState.tunnelHealth);
        }
      }

      if (!tunnelRecord) {
        const env = {
          ...process.env,
          CONTROL_PLANE_API_KEY: runtimeKey,
          CONTROL_PLANE_TUNNEL_ID: opts.tunnelId,
          LCA_INSTANCE_NONCE: instanceNonce
        };
        if (opts.authToken) {
          env.MCP_AUTH_HEADER = `Bearer ${opts.authToken}`;
          env.MCP_EXTRA_HEADERS = "Authorization: env:MCP_AUTH_HEADER";
        }
        tunnelHealth = tunnelHealthConfig(instanceNonce);
        started.tunnel.health = tunnelHealth;
        const args = [
          "run",
          "--profile", opts.profile,
          "--profile-dir", opts.profileDir,
          "--control-plane.tunnel-id", opts.tunnelId,
          ...tunnelHealth.args
        ];
        const stdio = flags.background ? ["ignore", "ignore", "ignore"] : "inherit";
        const spawnedAt = new Date().toISOString();
        tunnelChild = spawnLogged("tunnel", opts.tunnelBin, args, {
          cwd: dirname(opts.tunnelBin),
          env,
          detached: Boolean(flags.background),
          stdio
        });
        started.tunnel.child = tunnelChild;
        tunnelHealth = await waitForTunnelReady(tunnelChild, tunnelHealth);
        tunnelRecord = await recordSpawnedProcess({
          role: "tunnel",
          child: tunnelChild,
          opts,
          instanceNonce,
          spawnedAt
        });
        started.tunnel.record = tunnelRecord;
        if (flags.background) tunnelChild.unref();
      }
    }

    finalState = buildProcessState({
      previousState,
      instanceNonce,
      config: id,
      tunnelConfig: requestedTunnelConfigId,
      port: opts.port,
      supervisorRecord,
      serverRecord,
      tunnelRecord,
      tunnelHealth
    });
    await writePidState(finalState);
  } catch (error) {
    const rollbackErrors = await rollbackSpawnedProcesses(started, opts, instanceNonce);
    const reusableServer = started.server.child ? null : serverRecord;
    const reusableTunnel = started.tunnel.child ? null : tunnelRecord;
    if (reusableServer || reusableTunnel) {
      try {
        await writePidState(buildProcessState({
          previousState,
          instanceNonce,
          config: id,
          tunnelConfig: requestedTunnelConfigId,
          port: opts.port,
          supervisorRecord,
          serverRecord: reusableServer,
          tunnelRecord: reusableTunnel,
          tunnelHealth: reusableTunnel ? tunnelHealth : null
        }));
      } catch (stateError) {
        rollbackErrors.push(`state recovery failed: ${stateError.message}`);
      }
    } else if (supervisorRecord) {
      await writePidState(buildProcessState({
        previousState,
        instanceNonce,
        config: id,
        tunnelConfig: requestedTunnelConfigId,
        port: opts.port,
        supervisorRecord,
        serverRecord: null,
        tunnelRecord: null,
        tunnelHealth: null,
        phase: "restart-pending"
      })).catch((stateError) => {
        rollbackErrors.push(`state recovery failed: ${stateError.message}`);
      });
    } else if (stateWasReplaced || started.server.child || started.tunnel.child) {
      removePidStateIfOwned({
        instanceNonce,
        serverPid: started.server.child?.pid || null,
        tunnelPid: started.tunnel.child?.pid || null
      });
    }
    if (rollbackErrors.length) {
      throw new Error(`${error.message} Rollback warnings: ${rollbackErrors.join("; ")}.`);
    }
    throw error;
  }

  if (flags.background) {
    console.log("Running in background.");
    return { reason: "background", uptimeMs: 0 };
  }

  const childrenToWait = [
    tunnelChild ? { role: "tunnel", child: tunnelChild } : null,
    serverChild ? { role: "server", child: serverChild } : null
  ].filter(Boolean);
  if (!childrenToWait.length) {
    console.log("Already running.");
    return { reason: "already-running", uptimeMs: 0 };
  }

  const readyAt = Date.now();
  let requestedExitCode = 0;
  let shutdownPromise = null;
  const shutdown = () => {
    if (!shutdownPromise) shutdownPromise = rollbackSpawnedProcesses(started, opts, instanceNonce);
    return shutdownPromise;
  };
  const onSigint = () => {
    requestedExitCode = 130;
    void shutdown();
  };
  const onSigterm = () => {
    requestedExitCode = 143;
    void shutdown();
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    const firstExit = await Promise.race(childrenToWait.map(({ role, child }) => {
      if (child.exitCode !== null || child.signalCode) {
        return Promise.resolve({ role, code: child.exitCode, signal: child.signalCode });
      }
      return new Promise((resolveExit) => {
        child.once("exit", (code, signal) => resolveExit({ role, code, signal }));
      });
    }));
    if (!requestedExitCode) {
      console.error(`[${firstExit.role}] stopped unexpectedly (code=${firstExit.code ?? "?"}, signal=${firstExit.signal || "none"}).`);
    }
    return {
      reason: requestedExitCode ? "shutdown" : "child-exit",
      requestedExitCode,
      uptimeMs: Date.now() - readyAt,
      exit: firstExit
    };
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    const rollbackErrors = await shutdown();
    const remainingServer = started.server.child ? null : serverRecord;
    const remainingTunnel = started.tunnel.child ? null : tunnelRecord;
    if (remainingServer || remainingTunnel || supervisorRecord) {
      await writePidState(buildProcessState({
        previousState: finalState,
        instanceNonce,
        config: id,
        tunnelConfig: requestedTunnelConfigId,
        port: opts.port,
        supervisorRecord,
        serverRecord: remainingServer,
        tunnelRecord: remainingTunnel,
        tunnelHealth: remainingTunnel ? tunnelHealth : null,
        phase: requestedExitCode ? "stopping" : "restart-pending"
      }));
    } else {
      removePidStateIfOwned(finalState);
    }
    if (rollbackErrors.length) {
      console.error(`Shutdown warnings: ${rollbackErrors.join("; ")}`);
    }
  }
}

function encodeSupervisorPayload(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeSupervisorPayload() {
  const encoded = String(process.env[INTERNAL_SUPERVISOR_ENV] || "").trim();
  if (!encoded) throw new Error("Missing internal supervisor launch payload.");
  delete process.env[INTERNAL_SUPERVISOR_ENV];
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid internal supervisor launch payload.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid internal supervisor launch payload.");
  }
  return payload;
}

async function waitForSupervisorReady({ child, opts, instanceNonce, config, tunnelConfig }, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (child.exitCode !== null || child.signalCode) return null;
    const state = readPidState();
    if (
      state.instanceNonce === instanceNonce &&
      Number(statePid(state, "supervisor")) === Number(child.pid) &&
      state.configId === config
    ) {
      const supervisor = await resolveManagedRecord({
        state,
        role: "supervisor",
        pid: child.pid,
        opts,
        instanceNonce
      });
      const health = await readDetailedServerHealth(opts.port, instanceNonce, 500);
      const tunnelReady = opts.noTunnel || (
        state.tunnelConfigId === tunnelConfig &&
        await probeTunnelHealth(state.tunnelHealth, 500)
      );
      if (
        supervisor.verified &&
        health?.status === "ok" &&
        health.config_id === config &&
        Number(health.pid) === Number(statePid(state, "server")) &&
        tunnelReady
      ) {
        return { state, health };
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return null;
}

async function waitForSupervisorBackoff(delayMs, isStopping) {
  const deadline = Date.now() + delayMs;
  while (!isStopping() && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(100, deadline - Date.now())));
  }
}

async function superviseRuntime(flags) {
  const opts = effectiveOptions(flags);
  const instanceNonce = String(flags.internalInstanceNonce || "").trim() || newInstanceNonce();
  const supervisorRecord = await recordCurrentSupervisor(opts, instanceNonce);
  const runtimeKey = opts.noTunnel
    ? ""
    : flags.runtimeKey || process.env[opts.runtimeKeyEnv] || opts.runtimeKey;
  const id = configId(opts);
  const requestedTunnelConfigId = opts.noTunnel ? "" : tunnelConfigId(opts, runtimeKey);
  let stopSignal = "";
  const onSigint = () => { stopSignal = "SIGINT"; };
  const onSigterm = () => { stopSignal = "SIGTERM"; };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  let restartCount = 0;

  try {
    await writePidState(buildProcessState({
      previousState: readPidState(),
      instanceNonce,
      config: id,
      tunnelConfig: requestedTunnelConfigId,
      port: opts.port,
      supervisorRecord,
      serverRecord: null,
      tunnelRecord: null,
      tunnelHealth: null,
      phase: "starting",
      restart: { count: 0, max: SUPERVISOR_MAX_RESTARTS, last_error: null }
    }));

    while (!stopSignal) {
      let outcome;
      let failure = null;
      try {
        outcome = await runManagedRuntime(
          { ...flags, background: false, internalInstanceNonce: instanceNonce },
          { supervisorRecord }
        );
      } catch (error) {
        failure = error;
        appendLog(`[supervisor] runtime failure=${error?.message || error}`);
      }

      if (stopSignal || outcome?.reason === "shutdown") break;
      if (outcome?.reason === "already-running") {
        failure = new Error("Supervisor found a runtime it does not own; refusing to monitor an ambiguous process pair.");
      }
      if ((outcome?.uptimeMs || 0) >= SUPERVISOR_STABLE_WINDOW_MS) restartCount = 0;
      restartCount += 1;
      const failureText = failure?.message || (
        outcome?.exit
          ? `${outcome.exit.role} exited code=${outcome.exit.code ?? "?"} signal=${outcome.exit.signal || "none"}`
          : "runtime stopped unexpectedly"
      );
      if (restartCount > SUPERVISOR_MAX_RESTARTS) {
        await writePidState(buildProcessState({
          previousState: readPidState(),
          instanceNonce,
          config: id,
          tunnelConfig: requestedTunnelConfigId,
          port: opts.port,
          supervisorRecord,
          serverRecord: null,
          tunnelRecord: null,
          tunnelHealth: null,
          phase: "failed",
          restart: {
            count: restartCount - 1,
            max: SUPERVISOR_MAX_RESTARTS,
            exhausted: true,
            last_error: failureText,
            updated_at: new Date().toISOString()
          }
        }));
        throw new Error(`Supervisor restart budget exhausted: ${failureText}`);
      }

      const delayMs = supervisorBackoffMs(restartCount);
      await writePidState(buildProcessState({
        previousState: readPidState(),
        instanceNonce,
        config: id,
        tunnelConfig: requestedTunnelConfigId,
        port: opts.port,
        supervisorRecord,
        serverRecord: null,
        tunnelRecord: null,
        tunnelHealth: null,
        phase: "restart-pending",
        restart: {
          count: restartCount,
          max: SUPERVISOR_MAX_RESTARTS,
          delay_ms: delayMs,
          last_error: failureText,
          updated_at: new Date().toISOString()
        }
      }));
      appendLog(`[supervisor] restart=${restartCount}/${SUPERVISOR_MAX_RESTARTS} delay_ms=${delayMs} reason=${failureText}`);
      await waitForSupervisorBackoff(delayMs, () => Boolean(stopSignal));
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    removePidStateIfOwned({ instanceNonce, supervisorPid: process.pid });
  }
}

async function start(flags) {
  const opts = effectiveOptions(flags);
  validate(opts, { requireWorkspace: true, requireTunnel: true });
  if (!existsSync(join(SERVER_DIR, SERVER_SCRIPT))) throw new Error(`Missing ${SERVER_SCRIPT} in ${SERVER_DIR}`);
  if (!existsSync(join(SERVER_DIR, "node_modules"))) {
    throw new Error("server/node_modules is missing. Run `node scripts/local-coding-agent.mjs install` first.");
  }
  await services.prepareCliRuntimeDataDirectory(opts);
  if (flags.save) await saveConfig(stripRuntimeFields(opts));

  const runtimeKey = opts.noTunnel
    ? ""
    : flags.runtimeKey || process.env[opts.runtimeKeyEnv] || opts.runtimeKey;
  if (!opts.noTunnel && !runtimeKey) {
    throw new Error(`Missing Runtime API key. Set ${opts.runtimeKeyEnv}, pass --runtime-key, or run key set.`);
  }
  const id = configId(opts);
  const requestedTunnelConfigId = opts.noTunnel ? "" : tunnelConfigId(opts, runtimeKey);
  let state = readPidState();
  const stateNonce = state.instanceNonce || state.supervisor?.instanceNonce || "";
  const supervisorPid = statePid(state, "supervisor");
  const supervisor = await resolveManagedRecord({
    state,
    role: "supervisor",
    pid: supervisorPid,
    opts,
    instanceNonce: stateNonce || newInstanceNonce()
  });

  if (supervisor.alive && !supervisor.verified) {
    throw new Error(
      `Refusing to replace supervisor PID ${supervisorPid}: its executable/start time/process group no longer matches saved state.`
    );
  }
  if (supervisor.verified) {
    const health = await readDetailedServerHealth(state.port || opts.port, stateNonce);
    const tunnelReady = opts.noTunnel || (
      state.tunnelConfigId === requestedTunnelConfigId &&
      await probeTunnelHealth(state.tunnelHealth)
    );
    if (
      health?.status === "ok" &&
      health.config_id === id &&
      state.configId === id &&
      tunnelReady
    ) {
      console.log(`[supervisor] already running and ready; reusing verified PID ${supervisorPid}`);
      return;
    }
    await services.stop(flags);
    state = {};
  } else {
    const legacyRuntimePresent = Boolean(
      statePid(state, "server") ||
      statePid(state, "tunnel") ||
      await readJson(`http://127.0.0.1:${state.port || opts.port}/healthz`)
    );
    if (legacyRuntimePresent) {
      await services.stop(flags);
      state = {};
    } else if (Object.keys(state).length) {
      removePidStateIfOwned(state);
      state = {};
    }
  }

  const instanceNonce = newInstanceNonce();
  const supervisorFlags = {
    ...opts,
    ...flags,
    workspace: opts.workspace,
    runtimeKey,
    background: false,
    save: false,
    internalInstanceNonce: instanceNonce
  };
  if (!flags.background) {
    return superviseRuntime(supervisorFlags);
  }

  const env = {
    ...process.env,
    [INTERNAL_SUPERVISOR_ENV]: encodeSupervisorPayload(supervisorFlags)
  };
  const child = spawnLogged(
    "supervisor",
    process.execPath,
    [join(SCRIPT_DIR, "local-coding-agent.mjs"), "supervise"],
    {
      cwd: REPO_ROOT,
      env,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"]
    }
  );
  child.unref();
  const ready = await waitForSupervisorReady({
    child,
    opts,
    instanceNonce,
    config: id,
    tunnelConfig: requestedTunnelConfigId
  });
  if (!ready) {
    const failedState = readPidState();
    const failedSupervisor = await resolveManagedRecord({
      state: failedState,
      role: "supervisor",
      pid: child.pid,
      opts,
      instanceNonce
    });
    if (failedSupervisor.verified && failedSupervisor.record) {
      await stopVerifiedRecord(failedSupervisor.record, failedState, "supervisor", opts).catch(() => {});
    } else {
      const adopted = await adoptProcessRecord({
        ...processExpectation("supervisor", opts),
        pid: child.pid,
        instanceNonce
      });
      if (adopted.record) {
        await stopVerifiedRecord(adopted.record, { instanceNonce }, "supervisor", opts).catch(() => {});
      }
    }
    throw new Error("Supervisor did not make the server/tunnel pair ready within the startup deadline.");
  }
  console.log(`[supervisor] ready PID ${child.pid}`);
  console.log("Running in background.");
}


export {
  decodeSupervisorPayload,
  removePidStateIfOwned,
  runManagedRuntime,
  statePid,
  start,
  stopExistingManagedProcess,
  superviseRuntime
};
