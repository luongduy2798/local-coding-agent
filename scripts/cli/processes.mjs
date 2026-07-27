// Local Coding Agent CLI process and transport helpers.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  LOG_PATH,
  PID_PATH,
  SERVER_DIR,
  SERVER_SCRIPT,
  SCRIPT_DIR,
  SUPERVISOR_BACKOFF_MS,
  ensureConfigDir,
  readJsonFile,
  yamlEscape
} from "./config.mjs";
import {
  atomicWriteJson,
  createProcessRecord,
  expectedExecutablePath,
  inspectProcess,
  terminateProcessRecord,
  verifyProcessRecord
} from "../process-lifecycle.mjs";

async function readJson(url, timeoutMs = 1500, { headers } = {}) {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function appendLog(line) {
  ensureConfigDir();
  const stamp = new Date().toISOString();
  writeFileSync(LOG_PATH, `[${stamp}] ${line}\n`, { encoding: "utf8", flag: "a" });
}

function spawnLogged(label, command, args, options = {}) {
  const printable = `${command} ${args.join(" ")}`;
  console.log(`[${label}] ${printable}`);
  appendLog(`[${label}] ${printable}`);
  const child = spawn(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    stdio: options.stdio || "inherit",
    detached: Boolean(options.detached),
    shell: false,
    windowsHide: true
  });
  child.on("error", (error) => {
    appendLog(`[${label}] spawn error=${error.message}`);
  });
  child.on("exit", (code, signal) => {
    appendLog(`[${label}] exited code=${code} signal=${signal || ""}`);
    if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGINT") {
      console.error(`[${label}] exited code=${code} signal=${signal || ""}`);
    }
  });
  return child;
}

function readPidState() {
  const state = readJsonFile(PID_PATH, {});
  return state && typeof state === "object" && !Array.isArray(state) ? state : {};
}

async function writePidState(state) {
  ensureConfigDir();
  await atomicWriteJson(PID_PATH, state, { mode: 0o600 });
}

async function readDetailedServerHealth(port, instanceNonce, timeoutMs = 1500) {
  if (!instanceNonce) return null;
  return readJson(
    `http://127.0.0.1:${port}/healthz/details`,
    timeoutMs,
    { headers: { "x-lca-instance-nonce": instanceNonce } }
  );
}

async function waitForHealth(
  port,
  attempts = 40,
  predicate = () => true,
  { instanceNonce } = {}
) {
  for (let i = 0; i < attempts; i++) {
    const health = instanceNonce
      ? await readDetailedServerHealth(port, instanceNonce)
      : await readJson(`http://127.0.0.1:${port}/healthz`);
    if (health?.status === "ok" && predicate(health)) return health;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

function processExpectation(role, opts) {
  if (role === "supervisor") {
    return {
      role,
      executable: expectedExecutablePath(process.execPath, SCRIPT_DIR),
      commandMarker: "local-coding-agent.mjs"
    };
  }
  if (role === "server") {
    return {
      role,
      executable: expectedExecutablePath(opts.node, SERVER_DIR),
      commandMarker: SERVER_SCRIPT
    };
  }
  return {
    role,
    executable: expectedExecutablePath(opts.tunnelBin, dirname(opts.tunnelBin)),
    commandMarker: basename(opts.tunnelBin)
  };
}

async function resolveManagedRecord({ state, role, pid, opts, instanceNonce }) {
  if (!pid) return { record: null, alive: false, verified: false, reason: "missing-pid" };
  const expected = processExpectation(role, opts);
  const existing = state?.[role];
  if (existing?.pid && Number(existing.pid) === Number(pid)) {
    const verification = await verifyProcessRecord(existing, {
      role,
      executable: existing.executable || existing.expectedExecutable || expected.executable,
      commandMarker: existing.commandMarker || expected.commandMarker,
      instanceNonce: state.instanceNonce || existing.instanceNonce
    });
    if (verification.verified || verification.alive) {
      return { record: existing, ...verification };
    }
  }
  // A PID plus a matching command line is not sufficient ownership evidence:
  // the PID may have been reused by another LCA checkout. Adoption is reserved
  // for a child handle spawned by this process (see rollbackSpawnedProcesses).
  const observed = await inspectProcess(pid);
  return {
    record: null,
    alive: Boolean(observed?.alive),
    verified: false,
    observed,
    reason: observed?.alive ? "missing-verified-record" : "not-running"
  };
}

async function recordSpawnedProcess({ role, child, opts, instanceNonce, spawnedAt }) {
  const observed = await inspectProcess(child.pid);
  return createProcessRecord({
    ...processExpectation(role, opts),
    pid: child.pid,
    instanceNonce,
    observed,
    spawnedAt
  });
}

async function recordCurrentSupervisor(opts, instanceNonce) {
  const observed = await inspectProcess(process.pid);
  return createProcessRecord({
    ...processExpectation("supervisor", opts),
    pid: process.pid,
    instanceNonce,
    observed,
    spawnedAt: new Date().toISOString()
  });
}

export function supervisorBackoffMs(restartCount) {
  const index = Math.max(0, Math.min(
    SUPERVISOR_BACKOFF_MS.length - 1,
    Number(restartCount || 1) - 1
  ));
  return SUPERVISOR_BACKOFF_MS[index];
}

async function waitForChildStable(child, label, timeoutMs = 900) {
  if (!child?.pid) throw new Error(`${label} did not provide a PID.`);
  if (child.exitCode !== null || child.signalCode) {
    throw new Error(`${label} exited before becoming ready (code=${child.exitCode ?? "?"}, signal=${child.signalCode || "none"}).`);
  }
  await new Promise((resolveWait, rejectWait) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) rejectWait(error);
      else resolveWait();
    };
    const onError = (error) => finish(new Error(`${label} failed to start: ${error.message}`));
    const onExit = (code, signal) => finish(new Error(`${label} exited during startup (code=${code ?? "?"}, signal=${signal || "none"}).`));
    const timer = setTimeout(() => finish(), timeoutMs);
    child.once("error", onError);
    child.once("exit", onExit);
  });
  const observed = await inspectProcess(child.pid);
  if (!observed.alive) throw new Error(`${label} exited before readiness verification.`);
  return observed;
}

function probeUnixSocketHealth(socketPath, timeoutMs = 800) {
  return new Promise((resolveProbe) => {
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      resolveProbe(ready);
    };
    const request = httpRequest(
      {
        method: "GET",
        path: "/healthz",
        socketPath,
        timeout: timeoutMs
      },
      (response) => {
        response.resume();
        finish(response.statusCode === 200);
      }
    );
    request.on("timeout", () => {
      request.destroy();
      finish(false);
    });
    request.on("error", () => finish(false));
    request.end();
  });
}

async function probeTunnelHealth(health, timeoutMs = 800) {
  if (!health) return false;
  if (health.kind === "unix-socket" && health.socketPath) {
    return probeUnixSocketHealth(health.socketPath, timeoutMs);
  }
  let url = String(health.url || "").trim();
  if (!url && health.kind === "url-file" && health.urlFile && existsSync(health.urlFile)) {
    try {
      url = (await readFile(health.urlFile, "utf8")).trim();
    } catch {
      return false;
    }
  }
  if (!url) return false;
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForTunnelReady(child, health, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(
        `tunnel-client exited during startup (code=${child.exitCode ?? "?"}, signal=${child.signalCode || "none"}).`
      );
    }
    const remainingMs = Math.max(1, deadline - performance.now());
    if (await probeTunnelHealth(health, Math.min(500, remainingMs))) {
      if (health.kind === "url-file" && health.urlFile) {
        try {
          health.url = (await readFile(health.urlFile, "utf8")).trim();
        } catch {
          // The successful probe already confirmed the resolved URL.
        }
      }
      return health;
    }
    const sleepMs = Math.min(100, Math.max(0, deadline - performance.now()));
    if (sleepMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, sleepMs));
  }
  throw new Error(`tunnel-client process started but /healthz did not become ready within ${timeoutMs}ms.`);
}

function cleanupTunnelHealth(health) {
  if (!health) return;
  if (
    health.kind === "unix-socket" &&
    typeof health.socketPath === "string" &&
    /^\/tmp\/lca-tunnel-[A-Za-z0-9_-]+\.sock$/.test(health.socketPath)
  ) {
    try { rmSync(health.socketPath, { force: true }); } catch { /* ignore owned health socket cleanup */ }
  }
  if (health.kind === "url-file" && typeof health.urlFile === "string") {
    const file = resolve(health.urlFile);
    if (
      dirname(file) === resolve(dirname(PID_PATH)) &&
      /^\.tunnel-health-[A-Za-z0-9_-]+\.url$/.test(basename(file))
    ) {
      try { rmSync(file, { force: true }); } catch { /* ignore owned health URL cleanup */ }
    }
  }
}

async function stopVerifiedRecord(record, state, role, opts) {
  if (!record) return { stopped: true, verified: false, reason: "not-running" };
  const fallback = processExpectation(role, opts);
  const expected = {
    role,
    executable: record.executable || record.expectedExecutable || fallback.executable,
    commandMarker: record.commandMarker || fallback.commandMarker,
    instanceNonce: state.instanceNonce || record.instanceNonce
  };
  return terminateProcessRecord(
    record,
    expected,
    role === "supervisor" ? { timeoutMs: 12_000 } : undefined
  );
}

function writeTunnelProfile(opts) {
  if (!opts.tunnelId) throw new Error("Missing tunnel ID. Run `setup` or pass --tunnel-id.");
  mkdirSync(opts.profileDir, { recursive: true });
  const fileName = opts.profile.endsWith(".yaml") ? opts.profile : `${opts.profile}.yaml`;
  const profilePath = join(opts.profileDir, fileName);
  const lines = [
    "config_version: 1",
    "control_plane:",
    '  base_url: "https://api.openai.com"',
    `  tunnel_id: "${yamlEscape(opts.tunnelId.trim())}"`,
    '  api_key: "env:CONTROL_PLANE_API_KEY"'
  ];
  if (opts.organizationId) {
    lines.push("  extra_headers:");
    lines.push(`    - "OpenAI-Organization: ${yamlEscape(opts.organizationId.trim())}"`);
  }
  lines.push(
    "log:",
    "  level: info",
    "  format: json",
    "mcp:",
    "  server_urls:",
    "    - channel: main",
    `      url: "http://127.0.0.1:${opts.port}/mcp"`
  );
  writeFileSync(profilePath, `${lines.join("\n")}\n`, "utf8");
  return profilePath;
}


async function runChecked(label, command, args, options = {}) {
  const child = spawnLogged(label, command, args, options);
  const code = await new Promise((resolveExit) => child.on("exit", resolveExit));
  if (code !== 0) throw new Error(`${label} failed with exit code ${code}`);
  return code;
}

async function capture(command, args, options = {}) {
  return new Promise((resolveCapture) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolveCapture({ code: 127, signal: null, stdout, stderr: error.message }));
    child.on("exit", (code, signal) => resolveCapture({ code, signal, stdout, stderr }));
  });
}


export {
  appendLog,
  capture,
  cleanupTunnelHealth,
  processExpectation,
  probeTunnelHealth,
  readDetailedServerHealth,
  readJson,
  readPidState,
  recordCurrentSupervisor,
  recordSpawnedProcess,
  resolveManagedRecord,
  runChecked,
  spawnLogged,
  stopVerifiedRecord,
  waitForChildStable,
  waitForHealth,
  waitForTunnelReady,
  writePidState,
  writeTunnelProfile
};
