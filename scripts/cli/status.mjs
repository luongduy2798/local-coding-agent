// Local Coding Agent CLI status, shutdown, doctor, and config commands.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync } from "node:fs";
import { createInterface as createPromptInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";
import { adoptProcessRecord, newInstanceNonce } from "../process-lifecycle.mjs";
import {
  CONFIG_PATH,
  DEFAULT_PORT,
  LOG_PATH,
  PID_PATH,
  SERVER_DIR,
  SERVER_SCRIPT,
  effectiveOptions,
  loadConfig,
  normalize,
  saveConfig,
  stripRuntimeFields,
  validate
} from "./config.mjs";
import {
  capture,
  processExpectation,
  probeTunnelHealth,
  readDetailedServerHealth,
  readJson,
  readPidState,
  resolveManagedRecord
} from "./processes.mjs";
import {
  probeNodeSqlite,
  promptChoice,
  promptLine,
  promptSecretUpdate,
  promptYesNo
} from "./setup.mjs";
import {
  removePidStateIfOwned,
  start,
  statePid,
  stopExistingManagedProcess
} from "./supervisor.mjs";

let services = Object.create(null);

export function configureStatusServices(next) {
  services = { ...services, ...next };
}

async function stop(flags) {
  const opts = effectiveOptions(flags);
  const state = readPidState();
  let instanceNonce =
    state.instanceNonce ||
    state.server?.instanceNonce ||
    state.tunnel?.instanceNonce ||
    newInstanceNonce();
  let managedState = state;
  const statePort = state.port || opts.port;
  const liveness = await readJson(`http://127.0.0.1:${statePort}/healthz`);
  let details = liveness
    ? await readDetailedServerHealth(statePort, instanceNonce)
    : null;
  if (liveness && !details) {
    const adopted = await adoptLegacyPidOnlyRuntime({
      state,
      health: liveness,
      port: statePort,
      opts,
      instanceNonce
    });
    if (!adopted) {
      throw new Error(
        `Refusing to stop the process on port ${statePort}: its instance nonce could not be verified.`
      );
    }
    managedState = adopted.state;
    instanceNonce = adopted.instanceNonce;
    details = liveness;
    console.log(`[migration] verified legacy ${liveness.version} runtime from PID-only state`);
  }
  const health = details || liveness;
  const unresolved = [];
  const supervisorPid = statePid(managedState, "supervisor");
  if (supervisorPid) {
    try {
      await stopExistingManagedProcess({
        state: managedState,
        role: "supervisor",
        pid: supervisorPid,
        opts,
        instanceNonce
      });
    } catch (error) {
      throw new Error(`Stop incomplete. ${error.message}`);
    }
  }
  const tunnelPid = statePid(managedState, "tunnel");
  if (tunnelPid) {
    try {
      await stopExistingManagedProcess({
        state: managedState,
        role: "tunnel",
        pid: tunnelPid,
        opts,
        instanceNonce
      });
    } catch (error) {
      unresolved.push(error.message);
    }
  }
  const serverPids = [...new Set([health?.pid, statePid(managedState, "server")].filter(Boolean).map(Number))];
  for (const serverPid of serverPids) {
    try {
      await stopExistingManagedProcess({
        state: managedState,
        role: "server",
        pid: serverPid,
        opts,
        instanceNonce
      });
    } catch (error) {
      unresolved.push(error.message);
    }
  }
  if (unresolved.length) {
    throw new Error(`Stop incomplete. ${unresolved.join(" ")}`);
  }
  removePidStateIfOwned(state);
  console.log("Stopped.");
}

async function adoptLegacyPidOnlyRuntime({ state, health, port, opts, instanceNonce }) {
  if (!legacyRuntimeHealthMatchesState(state, health, port)) return null;
  const records = {};
  for (const role of ["server", "tunnel"]) {
    const pid = statePid(state, role);
    if (!pid) continue;
    const adopted = await adoptProcessRecord({
      ...processExpectation(role, opts),
      pid,
      instanceNonce
    });
    if (!adopted.record || !legacyStartTimeMatchesState(adopted.record, state)) return null;
    records[role] = adopted.record;
  }
  if (!records.server) return null;
  return {
    instanceNonce,
    state: {
      ...state,
      instanceNonce,
      server: records.server,
      ...(records.tunnel ? { tunnel: records.tunnel } : {})
    }
  };
}

function legacyRuntimeHealthMatchesState(state, health, port) {
  const serverPid = Number(statePid(state, "server"));
  const numericPort = Number(port);
  return Boolean(
    state &&
    !state.instanceNonce &&
    !state.server &&
    !state.tunnel &&
    !state.supervisor &&
    health?.status === "ok" &&
    health.version === "4.5.0-pro" &&
    Number.isInteger(serverPid) &&
    serverPid > 0 &&
    Number(health.pid) === serverPid &&
    String(health.config_id || "") !== "" &&
    health.config_id === state.configId &&
    health.mcp_endpoint === `http://127.0.0.1:${numericPort}/mcp`
  );
}

function legacyStartTimeMatchesState(record, state) {
  const processStartedAt = Date.parse(record?.startedAt || "");
  const stateUpdatedAt = Date.parse(state?.updatedAt || "");
  if (!Number.isFinite(processStartedAt) || !Number.isFinite(stateUpdatedAt)) return true;
  return Math.abs(processStartedAt - stateUpdatedAt) <= 10_000;
}

async function runningStatusForConfig(cfg = effectiveOptions()) {
  const state = readPidState();
  const port = state.port || cfg.port;
  const health = await readJson(`http://127.0.0.1:${port}/healthz`);
  const instanceNonce =
    state.instanceNonce ||
    state.server?.instanceNonce ||
    state.tunnel?.instanceNonce ||
    newInstanceNonce();
  const supervisor = await resolveManagedRecord({
    state,
    role: "supervisor",
    pid: statePid(state, "supervisor"),
    opts: cfg,
    instanceNonce
  });
  const server = await resolveManagedRecord({
    state,
    role: "server",
    pid: health?.pid || statePid(state, "server"),
    opts: cfg,
    instanceNonce
  });
  const tunnel = await resolveManagedRecord({
    state,
    role: "tunnel",
    pid: statePid(state, "tunnel"),
    opts: cfg,
    instanceNonce
  });
  return {
    state,
    health,
    running: Boolean(supervisor.alive || health?.status === "ok" || server.alive || tunnel.alive)
  };
}

async function restartIfRunning(beforeCfg, afterCfg) {
  const before = await runningStatusForConfig(beforeCfg);
  if (!before.running) return false;
  console.log("Config changed; restarting running agent...");
  await stop(beforeCfg);
  await start({ ...afterCfg, background: true });
  return true;
}

async function status(flags) {
  const opts = effectiveOptions(flags);
  const state = readPidState();
  const port = state.port || opts.port;
  const instanceNonce =
    state.instanceNonce ||
    state.server?.instanceNonce ||
    state.tunnel?.instanceNonce ||
    newInstanceNonce();
  const liveness = await readJson(`http://127.0.0.1:${port}/healthz`);
  const storedNonce =
    state.instanceNonce ||
    state.server?.instanceNonce ||
    state.tunnel?.instanceNonce ||
    "";
  const details = storedNonce
    ? await readJson(
        `http://127.0.0.1:${port}/healthz/details`,
        1500,
        { headers: { "x-lca-instance-nonce": storedNonce } }
      )
    : null;
  const health = details || liveness;
  const serverStatus = await resolveManagedRecord({
    state,
    role: "server",
    pid: health?.pid || statePid(state, "server"),
    opts,
    instanceNonce
  });
  const tunnelStatus = await resolveManagedRecord({
    state,
    role: "tunnel",
    pid: statePid(state, "tunnel"),
    opts,
    instanceNonce
  });
  const supervisorStatus = await resolveManagedRecord({
    state,
    role: "supervisor",
    pid: statePid(state, "supervisor"),
    opts,
    instanceNonce
  });
  const tunnelProbeStarted = performance.now();
  const tunnelReady = tunnelStatus.verified && await probeTunnelHealth(state.tunnelHealth);
  const tunnelRoundTripMs = tunnelStatus.verified
    ? Math.round((performance.now() - tunnelProbeStarted) * 100) / 100
    : null;
  const runtime = await services.readCliRuntimeStatus();
  const data = {
    config_path: CONFIG_PATH,
    pid_path: PID_PATH,
    log_path: LOG_PATH,
    configured_workspace: opts.workspace || null,
    mcp_url: `http://127.0.0.1:${port}/mcp`,
    ...(flags.includeInstanceNonce
      ? { instance_nonce: state.instanceNonce || null }
      : {}),
    server: health || null,
    pids: {
      supervisor: statePid(state, "supervisor"),
      supervisor_alive: Boolean(supervisorStatus.alive),
      supervisor_verified: Boolean(supervisorStatus.verified),
      server: health?.pid || statePid(state, "server"),
      server_alive: Boolean(health?.status === "ok" || serverStatus.alive),
      server_verified: Boolean(serverStatus.verified),
      tunnel: statePid(state, "tunnel"),
      tunnel_alive: Boolean(tunnelStatus.alive),
      tunnel_verified: Boolean(tunnelStatus.verified),
      tunnel_ready: Boolean(tunnelReady)
    },
    connector: {
      configured: Boolean(statePid(state, "tunnel")),
      ready: Boolean(tunnelReady),
      round_trip_ms: tunnelRoundTripMs
    },
    runtime_id: health?.runtime_id || null,
    audit: health?.audit || runtime.audit,
    sessions: health?.mcp_sessions || null,
    workspaces: runtime.workspaces,
    selected_workspace: runtime.selected_workspace,
    active_tasks: runtime.active_tasks,
    recent_tasks: runtime.recent_tasks,
    storage: runtime.storage,
    storage_error: runtime.error || null
  };
  if (flags.json) console.log(JSON.stringify(data, null, 2));
  else {
    console.log(`Config:    ${data.config_path}`);
    console.log(`MCP URL:   ${data.mcp_url}`);
    console.log(`Supervisor:${
      data.pids.supervisor_alive
        ? ` ${data.pids.supervisor_verified ? "active" : "UNVERIFIED"} pid=${data.pids.supervisor}`
        : " offline"
    }`);
    console.log(`Server:    ${health ? `ONLINE ${health.version || ""} (${health.mode || "mode?"}/${health.policy || "policy?"}) pid=${health.pid || "?"}` : "offline"}`);
    console.log(
      `Connector: ${
        data.pids.tunnel_alive
          ? `${data.pids.tunnel_verified ? (data.pids.tunnel_ready ? "ready" : "verified/not-ready") : "UNVERIFIED"} pid=${data.pids.tunnel}`
          : "offline"
      }`
    );
    console.log(`Sessions:  ${data.sessions?.active ?? 0}/${data.sessions?.max ?? 32}`);
    console.log(`Audit:     ${data.audit?.enabled ? data.audit.path || "enabled" : "disabled"}`);
    console.log(
      `Workspace: ${data.selected_workspace
        ? `${data.selected_workspace.id} (${data.selected_workspace.canonicalRoot})`
        : "(none selected)"}`
    );
    console.log(`Registry:  ${data.workspaces.length} workspace(s), ${data.active_tasks.length} active task(s)`);
    if (data.storage_error) console.log(`Storage:   ERROR ${data.storage_error}`);
  }
}

async function doctor(flags, { requireServer = true } = {}) {
  const opts = effectiveOptions(flags);
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });
  add("server directory", existsSync(SERVER_DIR), SERVER_DIR);
  add("server.mjs", existsSync(join(SERVER_DIR, SERVER_SCRIPT)), join(SERVER_DIR, SERVER_SCRIPT));
  add("server node_modules", existsSync(join(SERVER_DIR, "node_modules")), join(SERVER_DIR, "node_modules"));
  add("workspace", Boolean(opts.workspace && existsSync(opts.workspace)), opts.workspace || "(not set)");
  add("tunnel-client", opts.noTunnel || existsSync(opts.tunnelBin), opts.noTunnel ? "disabled" : opts.tunnelBin);
  add("runtime key", opts.noTunnel || Boolean(process.env[opts.runtimeKeyEnv] || opts.runtimeKey), opts.noTunnel ? "disabled" : opts.runtimeKeyEnv);
  const sqlite = await probeNodeSqlite(opts.node);
  add("node:sqlite", sqlite.code === 0, sqlite.code === 0 ? `${opts.node} supports DatabaseSync` : `${opts.node} lacks node:sqlite`);
  const rg = await capture(process.platform === "win32" ? "rg.exe" : "rg", ["--version"]);
  add("ripgrep", rg.code === 0, rg.code === 0 ? rg.stdout.split(/\r?\n/)[0] : "missing; run lca setup to auto-install or install ripgrep manually");
  const health = requireServer
    ? await readJson(`http://127.0.0.1:${opts.port}/healthz`)
    : null;
  add(
    "server health",
    requireServer ? Boolean(health) : true,
    requireServer
      ? (health ? `${health.version} pid=${health.pid || "managed"}` : "offline")
      : "not required because the agent was stopped before update"
  );
  for (const check of checks) {
    console.log(`${check.ok ? "OK " : "ERR"} ${check.name}: ${check.detail}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) process.exitCode = 1;
}

function redactConfigForDisplay(cfg) {
  const visible = { ...cfg };
  if (visible.runtimeKey) visible.runtimeKey = "<saved>";
  if (visible.authToken) visible.authToken = "<saved>";
  return visible;
}

async function promptConfigWizard() {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Interactive terminal required. Use `lca config show` for non-interactive output.");
  }
  const beforeCfg = normalize(loadConfig());
  const cfg = { ...beforeCfg };
  const rl = createPromptInterface({ input, output });
  let saved = false;
  try {
    while (true) {
      console.log("\nLocal Coding Agent config");
      console.log(`  Workspace: ${cfg.workspace || "(not set)"}`);
      console.log(`  Mode:      ${cfg.mode}`);
      console.log(`  Policy:    ${cfg.policy}`);
      console.log(`  MCP port:  ${cfg.port}`);
      console.log(`  Tunnel:    ${cfg.noTunnel ? "disabled" : "enabled"}`);
      console.log("");
      const action = await promptChoice(rl, "Choose what to change", [
        { id: "mode", label: "Mode" },
        { id: "policy", label: "Policy" },
        { id: "workspace", label: "Workspace path" },
        { id: "port", label: "MCP port" },
        { id: "tunnel", label: "Tunnel on/off" },
        { id: "show", label: "Show full config" },
        { id: "save", label: "Save and apply" },
        { id: "cancel", label: "Cancel" }
      ], "save");
      if (action.id === "mode") {
        cfg.mode = (await promptChoice(rl, "Mode", [
          { id: "full", label: "full - fewer command blocks" },
          { id: "safe", label: "safe - stricter command guardrail" }
        ], cfg.mode)).id;
      } else if (action.id === "policy") {
        cfg.policy = (await promptChoice(rl, "Policy", [
          { id: "full", label: "full - fewer approval gates" },
          { id: "balanced", label: "balanced - approval for risky actions" },
          { id: "strict", label: "strict - tighter/read-review focused" }
        ], cfg.policy)).id;
      } else if (action.id === "workspace") {
        cfg.workspace = await promptLine(rl, "Workspace path", cfg.workspace || process.cwd());
      } else if (action.id === "port") {
        cfg.port = await promptLine(rl, "MCP port", cfg.port || DEFAULT_PORT);
      } else if (action.id === "tunnel") {
        cfg.noTunnel = await promptYesNo(rl, "Server only, no tunnel", cfg.noTunnel);
      } else if (action.id === "show") {
        console.log(JSON.stringify(redactConfigForDisplay(cfg), null, 2));
      } else if (action.id === "save") {
        validate(cfg);
        await saveConfig(stripRuntimeFields(cfg));
        saved = true;
        console.log("Saved config.");
        const restarted = await restartIfRunning(beforeCfg, cfg);
        if (!restarted) console.log("Agent is not running; next `lca` will use the new config.");
        break;
      } else if (action.id === "cancel") {
        console.log("Canceled.");
        break;
      }
    }
  } finally {
    rl.close();
  }
  return saved;
}

async function configCommand(rest) {
  const [sub, key, ...valueParts] = rest;
  const beforeCfg = normalize(loadConfig());
  const cfg = loadConfig();
  if (!sub) {
    return promptConfigWizard();
  }
  if (sub === "show") {
    console.log(JSON.stringify(redactConfigForDisplay(cfg), null, 2));
    return;
  }
  if (sub === "path") {
    console.log(CONFIG_PATH);
    return;
  }
  if (sub === "set") {
    if (!key || valueParts.length === 0) throw new Error("Usage: config set <key> <value>");
    cfg[key] = valueParts.join(" ");
    await saveConfig(cfg);
    console.log(`Set ${key}.`);
    await restartIfRunning(beforeCfg, normalize(cfg));
    return;
  }
  if (sub === "unset") {
    if (!key) throw new Error("Usage: config unset <key>");
    delete cfg[key];
    await saveConfig(cfg);
    console.log(`Unset ${key}.`);
    await restartIfRunning(beforeCfg, normalize(cfg));
    return;
  }
  throw new Error(`Unknown config command: ${sub}`);
}

async function keyCommand(rest) {
  const [sub] = rest;
  const cfg = loadConfig();
  if (sub === "clear") {
    cfg.runtimeKey = "";
    await saveConfig(cfg);
    console.log("Cleared saved runtime key.");
    return;
  }
  if (sub === "set") {
    const rl = createPromptInterface({ input, output });
    try {
      console.log("Warning: the universal CLI stores this key in a local config file, not DPAPI.");
      cfg.runtimeKey = await promptSecretUpdate(rl, "Runtime API key", cfg.runtimeKey);
      await saveConfig(cfg);
      console.log("Saved runtime key.");
    } finally {
      rl.close();
    }
    return;
  }
  throw new Error("Usage: key set|clear");
}




export {
  configCommand,
  doctor,
  keyCommand,
  restartIfRunning,
  runningStatusForConfig,
  status,
  stop
};
