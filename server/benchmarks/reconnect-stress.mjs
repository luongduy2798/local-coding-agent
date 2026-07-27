// Local Coding Agent runtime stateful reconnect stress benchmark
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { createIsolatedTestRoot, safeRemove } from "../tests/helpers/test-guard.mjs";
import { startTestServer, stopTestProcess } from "../tests/helpers/test-runtime.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const cycles = parseCycles(process.argv.slice(2));
const context = await createIsolatedTestRoot({
  prefix: "lca-reconnect-stress-",
  protectedPaths: [path.resolve("..")]
});
await writeFile(path.join(context.fixtureDir, "README.md"), "# reconnect stress fixture\n", "utf8");

let runtime = null;
let seedSessionId = null;
const failures = [];
const durations = [];
let successes = 0;
let taskId = null;

try {
  runtime = await startTestServer({
    workspace: context.fixtureDir,
    dataDir: context.dataDir,
    runId: context.runId,
    mode: "safe",
    policy: "full",
    env: {
      LCA_TEST_RUNTIME_DIAGNOSTICS: "0",
      AGENT_MCP_MAX_SESSIONS: "32",
      AGENT_MCP_SESSION_IDLE_MS: String(30 * 60 * 1_000)
    }
  });

  seedSessionId = await initializeSession(runtime.port, "seed");
  const listed = await callTool(runtime.port, seedSessionId, 10, "workspace_list", {});
  const primaryWorkspaceId = listed.data.workspaces[0]?.workspace_id;
  assert.ok(primaryWorkspaceId, "fixture workspace must be registered");
  const opened = await callTool(runtime.port, seedSessionId, 11, "task_open", {
    title: "Reconnect stress task",
    primary_workspace_id: primaryWorkspaceId
  });
  const taskToken = opened.data.task_token || opened.data.task?.task_token;
  taskId = opened.data.task?.id;
  assert.ok(taskId?.startsWith("task_"));
  assert.ok(taskToken, "task_open must return a reconnect token");
  await deleteSession(runtime.port, seedSessionId);
  seedSessionId = null;

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    let sessionId = null;
    const started = performance.now();
    try {
      sessionId = await initializeSession(runtime.port, `cycle-${cycle}`);
      const resumed = await callTool(runtime.port, sessionId, 100 + cycle, "task_open", {
        task_token: taskToken
      });
      assert.equal(resumed.data.resumed, true);
      assert.equal(resumed.data.task?.id, taskId);
      assert.equal(resumed.data.task?.primary_workspace_id, primaryWorkspaceId);
      await deleteSession(runtime.port, sessionId);
      sessionId = null;
      successes += 1;
      durations.push(performance.now() - started);
    } catch (error) {
      if (failures.length < 20) {
        failures.push({ cycle, error: error?.stack || error?.message || String(error) });
      }
      if (sessionId) await deleteSession(runtime.port, sessionId).catch(() => {});
    }
  }

  const inspectionSession = await initializeSession(runtime.port, "inspection");
  const status = await callTool(runtime.port, inspectionSession, cycles + 1000, "lca_status", {});
  assert.equal(status.data.runtime?.sessions?.active, 1, "closed reconnect sessions must not leak");
  await deleteSession(runtime.port, inspectionSession);

  const successRate = cycles > 0 ? (successes / cycles) * 100 : 0;
  const report = {
    benchmark: "lca-reconnect-stress",
    cycles,
    successes,
    failures: cycles - successes,
    success_rate_percent: round(successRate, 4),
    reconnect_p50_ms: round(percentile(durations, 50)),
    reconnect_p95_ms: round(percentile(durations, 95)),
    reconnect_p99_ms: round(percentile(durations, 99)),
    leaked_sessions: 0,
    task_id_preserved: true,
    failure_samples: failures
  };
  console.log(JSON.stringify(report, null, 2));
  assert.ok(
    successRate >= 99.9,
    `reconnect rate ${successRate.toFixed(4)}% is below 99.9%`
  );
} finally {
  if (runtime && seedSessionId) await deleteSession(runtime.port, seedSessionId).catch(() => {});
  if (runtime) await stopTestProcess(runtime.child);
  await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
  await safeRemove(context.dataDir, context, { recursive: true, force: true });
}

function parseCycles(args) {
  const raw = args.find((arg) => arg.startsWith("--cycles="))?.slice("--cycles=".length) ||
    process.env.LCA_RECONNECT_CYCLES ||
    "1000";
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100_000) {
    throw new Error("cycles must be an integer between 1 and 100000");
  }
  return value;
}

function percentile(values, percentileValue) {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index];
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

async function initializeSession(port, name) {
  const initialized = await rpc(port, {
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: `reconnect-stress-${name}`, version: "1.0.0" }
    }
  });
  assert.equal(initialized.status, 200);
  assert.ok(initialized.sessionId);
  await rpc(port, {
    sessionId: initialized.sessionId,
    method: "notifications/initialized",
    params: {}
  });
  return initialized.sessionId;
}

async function deleteSession(port, sessionId) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "DELETE",
    headers: {
      "mcp-session-id": sessionId,
      "mcp-protocol-version": PROTOCOL_VERSION
    }
  });
  assert.ok([200, 204].includes(response.status));
}

async function callTool(port, sessionId, id, name, args) {
  const response = await rpc(port, {
    id,
    sessionId,
    method: "tools/call",
    params: { name, arguments: args }
  });
  assert.equal(response.status, 200);
  const result = response.message?.result;
  const text = result?.content?.find((item) => item?.type === "text")?.text || "";
  let data = null;
  try {
    data = result?.structuredContent && typeof result.structuredContent === "object"
      ? result.structuredContent
      : JSON.parse(text);
  } catch {}
  if (result?.isError) throw new Error(`${name} failed: ${text}`);
  return { ...response, result, text, data };
}

async function rpc(port, { id, method, params, sessionId }) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId
        ? {
            "mcp-session-id": sessionId,
            "mcp-protocol-version": PROTOCOL_VERSION
          }
        : {})
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(id === undefined ? {} : { id }),
      method,
      params
    })
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id"),
    message: parseMcpResponse(buffer.toString("utf8"), response.headers.get("content-type"))
  };
}

function parseMcpResponse(body, contentType = "") {
  if (!body.trim()) return null;
  if (!contentType.includes("text/event-stream")) return JSON.parse(body);
  return body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .at(-1) || null;
}
