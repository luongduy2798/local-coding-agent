import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createIsolatedTestRoot,
  safeRemove
} from "../server/tests/helpers/test-guard.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(SCRIPT_DIR, "local-coding-agent.mjs");

async function dynamicPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function runCli(args, env, timeoutMs = 25_000) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: path.dirname(SCRIPT_DIR),
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI timed out: ${args.join(" ")}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        durationMs: performance.now() - startedAt
      });
    });
  });
}

function processAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index];
}

function lifecycleCycles() {
  const value = Number(process.env.LCA_LIFECYCLE_CYCLES || "1");
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new Error("LCA_LIFECYCLE_CYCLES must be an integer from 1 to 10000");
  }
  return value;
}

async function createFakeTunnelClient(target) {
  const source = `#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : ""; };
const socketPath = value("--health.unix-socket");
const urlFile = value("--health.url-file");
const server = http.createServer((request, response) => {
  if (request.url === "/healthz") { response.writeHead(200, { "content-type": "application/json" }); response.end("{\\"status\\":\\"ok\\"}"); return; }
  response.writeHead(404); response.end();
});
const shutdown = () => server.close(() => process.exit(0));
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
if (socketPath) {
  try { fs.rmSync(socketPath, { force: true }); } catch {}
  server.listen(socketPath);
} else {
  server.listen(0, "127.0.0.1", () => {
    if (urlFile) fs.writeFileSync(urlFile, "http://127.0.0.1:" + server.address().port + "\\n", "utf8");
  });
}
`;
  await writeFile(target, source, "utf8");
  await chmod(target, 0o755);
  return target;
}

async function spawnLegacyServer(target, { port, configId, version = "4.5.0-pro" }) {
  const source = `import http from "node:http";
const port = Number(process.env.PORT);
const configId = process.env.CONFIG_ID;
const version = process.env.LEGACY_VERSION;
const server = http.createServer((request, response) => {
  if (request.url !== "/healthz") { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    status: "ok",
    version,
    pid: process.pid,
    config_id: configId,
    mcp_endpoint: "http://127.0.0.1:" + port + "/mcp"
  }));
});
const shutdown = () => server.close(() => process.exit(0));
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
server.listen(port, "127.0.0.1");
`;
  await writeFile(target, source, "utf8");
  const child = spawn(process.execPath, [target], {
    cwd: path.dirname(target),
    env: {
      ...process.env,
      PORT: String(port),
      CONFIG_ID: configId,
      LEGACY_VERSION: version
    },
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(250)
      });
      if (response.ok) return child;
    } catch {
      // Wait for the fixture listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill("SIGKILL");
  throw new Error("Legacy server fixture did not become ready.");
}

test("V5 stop safely adopts verified V4.5 PID-only runtime state", async () => {
  const context = await createIsolatedTestRoot({ prefix: "lca-legacy-runtime-" });
  const port = await dynamicPort();
  const configId = "legacy-config-fixture";
  const configPath = path.join(context.dataDir, "cli-config.json");
  const statePath = path.join(context.dataDir, "processes.json");
  let legacyServer;
  try {
    legacyServer = await spawnLegacyServer(path.join(context.fixtureDir, "server.mjs"), {
      port,
      configId
    });
    await writeFile(statePath, `${JSON.stringify({
      serverPid: legacyServer.pid,
      updatedAt: new Date().toISOString(),
      configId,
      port: String(port)
    }, null, 2)}\n`, "utf8");
    const stopped = await runCli([
      "stop",
      "--port", String(port),
      "--node", process.execPath,
      "--no-tunnel"
    ], { ...process.env, LCA_CONFIG_PATH: configPath, AGENT_DATA_DIR: context.dataDir });
    assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
    assert.match(stopped.stdout, /verified legacy 4\.5\.0-pro runtime/);
    assert.equal(processAlive(legacyServer.pid), false);
    legacyServer = null;
  } finally {
    if (legacyServer && processAlive(legacyServer.pid)) legacyServer.kill("SIGKILL");
    await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});

test("V5 stop keeps an unverified PID-only listener alive", async () => {
  const context = await createIsolatedTestRoot({ prefix: "lca-unverified-runtime-" });
  const port = await dynamicPort();
  const configPath = path.join(context.dataDir, "cli-config.json");
  const statePath = path.join(context.dataDir, "processes.json");
  let listener;
  try {
    listener = await spawnLegacyServer(path.join(context.fixtureDir, "server.mjs"), {
      port,
      configId: "listener-config",
      version: "unverified-service"
    });
    await writeFile(statePath, `${JSON.stringify({
      serverPid: listener.pid,
      updatedAt: new Date().toISOString(),
      configId: "listener-config",
      port: String(port)
    }, null, 2)}\n`, "utf8");
    const stopped = await runCli([
      "stop",
      "--port", String(port),
      "--node", process.execPath,
      "--no-tunnel"
    ], { ...process.env, LCA_CONFIG_PATH: configPath, AGENT_DATA_DIR: context.dataDir });
    assert.notEqual(stopped.code, 0);
    assert.match(stopped.stderr, /instance nonce could not be verified/);
    assert.equal(processAlive(listener.pid), true);
  } finally {
    if (listener && processAlive(listener.pid)) listener.kill("SIGKILL");
    await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});

test("background start is idempotent and a verified supervisor owns the runtime", async () => {
  const context = await createIsolatedTestRoot({ prefix: "lca-supervisor-" });
  const port = await dynamicPort();
  const cycles = lifecycleCycles();
  const withTunnel = process.env.LCA_LIFECYCLE_WITH_TUNNEL === "1";
  const configPath = path.join(context.dataDir, "cli-config.json");
  const tunnelBin = withTunnel
    ? await createFakeTunnelClient(path.join(context.dataDir, "fake-tunnel-client"))
    : null;
  const env = {
    ...process.env,
    LCA_CONFIG_PATH: configPath,
    AGENT_DATA_DIR: context.dataDir,
    ...(withTunnel ? { CONTROL_PLANE_API_KEY: "test-runtime-key" } : {})
  };
  const legacyDataDir = path.join(context.dataDir, "v5");
  await mkdir(legacyDataDir, { recursive: true });
  await writeFile(path.join(legacyDataDir, "migration-manifest.json"), "{\"legacy\":true}\n", "utf8");
  await writeFile(path.join(context.fixtureDir, "README.md"), "supervisor fixture\n", "utf8");
  const startArgs = [
    "start",
    "--background",
    "--workspace", context.fixtureDir,
    "--port", String(port),
    "--node", process.execPath,
    "--mode", "safe",
    "--policy", "balanced",
    ...(withTunnel
      ? [
          "--tunnel-bin", tunnelBin,
          "--tunnel-id", "tunnel_lifecycle_fixture",
          "--profile-dir", path.join(context.dataDir, "profiles")
        ]
      : ["--no-tunnel"])
  ];
  let activeStatus;
  const serverReadyDurations = [];
  const warmStartDurations = [];
  try {
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      const started = await runCli(startArgs, env);
      assert.equal(started.code, 0, `cycle=${cycle}\n${started.stdout}\n${started.stderr}`);
      serverReadyDurations.push(started.durationMs);
      const activation = JSON.parse(await readFile(
        path.join(context.dataDir, "runtime", ".runtime-activation.json"),
        "utf8"
      ));
      assert.equal(activation.active, true);
      assert.ok(activation.source);
      assert.equal(
        await readFile(path.join(context.dataDir, "runtime", "migration-manifest.json"), "utf8"),
        "{\"legacy\":true}\n"
      );

      const statusOne = await runCli(["status", "--json", "--include-instance-nonce"], env);
      assert.equal(statusOne.code, 0, statusOne.stderr);
      activeStatus = JSON.parse(statusOne.stdout);
      assert.equal(activeStatus.pids.supervisor_alive, true);
      assert.equal(activeStatus.pids.supervisor_verified, true);
      assert.equal(activeStatus.pids.server_alive, true);
      assert.equal(activeStatus.pids.server_verified, true);
      assert.notEqual(activeStatus.pids.supervisor, activeStatus.pids.server);
      assert.ok(activeStatus.instance_nonce);
      if (withTunnel) {
        assert.equal(activeStatus.pids.tunnel_alive, true);
        assert.equal(activeStatus.pids.tunnel_verified, true);
        assert.equal(activeStatus.pids.tunnel_ready, true);
        assert.equal(activeStatus.connector.configured, true);
        assert.equal(activeStatus.connector.ready, true);
        assert.ok(activeStatus.connector.round_trip_ms >= 0);
      } else {
        assert.deepEqual(activeStatus.connector, {
          configured: false,
          ready: false,
          round_trip_ms: null
        });
      }

      const repeated = await runCli(startArgs, env);
      assert.equal(repeated.code, 0, `cycle=${cycle}\n${repeated.stdout}\n${repeated.stderr}`);
      assert.match(repeated.stdout, /already running and ready/);
      warmStartDurations.push(repeated.durationMs);
      const statusTwo = await runCli(["status", "--json"], env);
      const secondStatus = JSON.parse(statusTwo.stdout);
      assert.equal(secondStatus.pids.supervisor, activeStatus.pids.supervisor);
      assert.equal(secondStatus.pids.server, activeStatus.pids.server);
      assert.equal("instance_nonce" in secondStatus, false);

      const stopped = await runCli([
        "stop",
        "--port", String(port),
        ...(withTunnel ? ["--tunnel-bin", tunnelBin] : ["--no-tunnel"])
      ], env);
      assert.equal(stopped.code, 0, `cycle=${cycle}\n${stopped.stdout}\n${stopped.stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(processAlive(activeStatus.pids.supervisor), false, `orphan supervisor at cycle ${cycle}`);
      assert.equal(processAlive(activeStatus.pids.server), false, `orphan server at cycle ${cycle}`);
      if (withTunnel) {
        assert.equal(processAlive(activeStatus.pids.tunnel), false, `orphan tunnel at cycle ${cycle}`);
      }
      activeStatus = null;
    }
    const serverReadyP95 = percentile(serverReadyDurations, 95);
    const warmStartP95 = percentile(warmStartDurations, 95);
    assert.ok(
      serverReadyP95 < (withTunnel ? 5_000 : 1_500),
      `${withTunnel ? "server+tunnel" : "server"} readiness p95 exceeded ` +
        `${withTunnel ? "5s" : "1.5s"}: ${serverReadyP95.toFixed(2)}ms`
    );
    assert.ok(
      warmStartP95 < 300,
      `warm lca p95 exceeded 300ms: ${warmStartP95.toFixed(2)}ms`
    );
    console.log(
      `[MEASURE] lifecycle cycles=${cycles}; tunnel=${withTunnel}; ` +
      `${withTunnel ? "server+tunnel" : "server"}-ready p95=${serverReadyP95.toFixed(2)}ms; ` +
      `warm-lca p95=${warmStartP95.toFixed(2)}ms; orphan=0`
    );
  } finally {
    if (activeStatus && (
      processAlive(activeStatus.pids.supervisor) ||
      processAlive(activeStatus.pids.server) ||
      processAlive(activeStatus.pids.tunnel)
    )) {
      await runCli([
        "stop",
        "--port", String(port),
        ...(withTunnel ? ["--tunnel-bin", tunnelBin] : ["--no-tunnel"])
      ], env).catch(() => {});
    }
    await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});
