// Local Coding Agent runtime reconnect/restart integration test
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { createIsolatedTestRoot, safeRemove } from "../helpers/test-guard.mjs";
import { startTestServer, stopTestProcess } from "../helpers/test-runtime.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const context = await createIsolatedTestRoot({
  prefix: "lca-runtime-reconnect-",
  protectedPaths: [path.resolve("..")]
});
await writeFile(path.join(context.fixtureDir, "README.md"), "# reconnect fixture\n", "utf8");

let firstRuntime = null;
let secondRuntime = null;
let firstSessionId = null;
let secondSessionId = null;

try {
  firstRuntime = await startTestServer({
    workspace: context.fixtureDir,
    dataDir: context.dataDir,
    runId: context.runId,
    mode: "safe",
    policy: "full",
    env: { LCA_TEST_RUNTIME_DIAGNOSTICS: "0" }
  });
  firstSessionId = await initializeSession(firstRuntime.port, "before-restart");

  const listed = await callTool(firstRuntime.port, firstSessionId, 10, "workspace_list", {});
  const primaryWorkspaceId = listed.data.workspaces[0]?.workspace_id;
  assert.ok(primaryWorkspaceId);
  const opened = await callTool(firstRuntime.port, firstSessionId, 11, "task_open", {
    title: "Reconnect after restart",
    primary_workspace_id: primaryWorkspaceId
  });
  assert.equal(opened.result?.isError, undefined);
  const originalTask = opened.data.task;
  assert.ok(originalTask.id?.startsWith("task_"));
  assert.ok(originalTask.task_token || opened.data.task_token);
  const taskToken = originalTask.task_token || opened.data.task_token;

  const planned = await callTool(firstRuntime.port, firstSessionId, 12, "task_plan", {
    goal: "Persisted restart plan",
    steps: ["resume after restart"]
  });
  assert.equal(planned.result?.isError, undefined);

  await stopTestProcess(firstRuntime.child);
  assert.notEqual(firstRuntime.child.exitCode, null, "the first runtime must exit before restart");
  firstSessionId = null;
  firstRuntime = null;

  secondRuntime = await startTestServer({
    workspace: context.fixtureDir,
    dataDir: context.dataDir,
    runId: context.runId,
    mode: "safe",
    policy: "full",
    env: { LCA_TEST_RUNTIME_DIAGNOSTICS: "0" }
  });
  secondSessionId = await initializeSession(secondRuntime.port, "after-restart");

  const missingContext = await callTool(secondRuntime.port, secondSessionId, 20, "read_file", {
    path: "README.md"
  });
  assert.equal(missingContext.result?.isError, true);
  assert.equal(missingContext.data.code, "TASK_CONTEXT_REQUIRED");

  const invalidResume = await callTool(secondRuntime.port, secondSessionId, 21, "task_open", {
    task_token: `${taskToken}-stale`
  });
  assert.equal(invalidResume.result?.isError, true);
  assert.ok(
    ["TASK_TOKEN_INVALID", "TASK_NOT_FOUND", "TASK_CONTEXT_REQUIRED"].includes(invalidResume.data.code),
    JSON.stringify(invalidResume.data)
  );

  const resumed = await callTool(secondRuntime.port, secondSessionId, 22, "task_open", {
    task_token: taskToken
  });
  assert.equal(resumed.result?.isError, undefined);
  assert.equal(resumed.data.resumed, true);
  assert.equal(resumed.data.task.id, originalTask.id);
  assert.equal(resumed.data.task.primary_workspace_id, primaryWorkspaceId);

  const state = await callTool(secondRuntime.port, secondSessionId, 23, "task_state", {});
  assert.equal(state.result?.isError, undefined);
  assert.equal(state.data.task.id, originalTask.id);
  assert.equal(state.data.plan.goal, "Persisted restart plan");

  const read = await callTool(secondRuntime.port, secondSessionId, 24, "read_file", {
    workspace_id: primaryWorkspaceId,
    path: "README.md"
  });
  assert.equal(read.result?.isError, undefined);
  assert.match(read.data.content, /reconnect fixture/);

  console.log("runtime reconnect-after-restart test passed");
} finally {
  if (firstRuntime && firstSessionId) await deleteSession(firstRuntime.port, firstSessionId).catch(() => {});
  if (secondRuntime && secondSessionId) await deleteSession(secondRuntime.port, secondSessionId).catch(() => {});
  if (firstRuntime) await stopTestProcess(firstRuntime.child);
  if (secondRuntime) await stopTestProcess(secondRuntime.child);
  await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
  await safeRemove(context.dataDir, context, { recursive: true, force: true });
}

async function initializeSession(port, name) {
  const initialized = await rpc(port, {
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: `runtime-reconnect-${name}`, version: "1.0.0" }
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
