// Local Coding Agent
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SERVER_PATH = path.resolve(HELPERS_DIR, "../..", "server.mjs");

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export async function waitForHealth(port, stderrRef = { value: "" }, attempts = 80) {
  for (let index = 0; index < attempts; index++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Server did not become healthy on port ${port}\n${stderrRef.value || ""}`);
}

export async function startTestServer({
  serverPath = DEFAULT_SERVER_PATH,
  workspace,
  dataDir,
  runId,
  port,
  mode = "safe",
  policy = "full",
  env = {}
}) {
  if (!workspace || !dataDir || !runId) throw new Error("startTestServer requires workspace, dataDir and runId.");
  const selectedPort = port || await getFreePort();
  if (selectedPort === 8789) throw new Error("Tests must not use the runtime port 8789.");
  const stderrRef = { value: "" };
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: {
      ...process.env,
      PORT: String(selectedPort),
      AGENT_WORKSPACE: workspace,
      AGENT_DATA_DIR: dataDir,
      LCA_TEST_RUN_ID: runId,
      AGENT_MODE: mode,
      AGENT_POLICY: policy,
      AGENT_EXTRA_ROOTS_JSON: "[]",
      MCP_AUTH_TOKEN: "",
      AGENT_AUDIT: "1",
      ...env
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", (chunk) => { stderrRef.value += chunk.toString(); });
  await waitForHealth(selectedPort, stderrRef).catch(async (error) => {
    await stopTestProcess(child);
    throw error;
  });
  return { child, port: selectedPort, stderrRef };
}

export async function stopTestProcess(child) {
  if (!child?.pid || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(1500).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    })
  ]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
