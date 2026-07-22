// Local Coding Agent runtime policy approval contract tests
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createIsolatedTestRoot,
  safeRemove
} from "../helpers/test-guard.mjs";
import { startTestServer, stopTestProcess } from "../helpers/test-runtime.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const CLI_PATH = fileURLToPath(new URL("../../../scripts/local-coding-agent.mjs", import.meta.url));
const context = await createIsolatedTestRoot({
  prefix: "lca-runtime-policy-contract-",
  protectedPaths: [path.resolve("..")]
});
const workspace = path.join(context.fixtureDir, "workspace");
let runtime;
let sessionId;
let secondSessionId;

try {
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", "utf8");
  runtime = await startTestServer({
    workspace,
    dataDir: context.dataDir,
    runId: context.runId,
    mode: "full",
    policy: "balanced",
    env: {
      LCA_TEST_RUNTIME_DIAGNOSTICS: "0",
      AGENT_APPROVAL_TOKEN: "local-policy-test-token"
    }
  });

  const initialized = await rpc(runtime.port, {
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "runtime-policy-compat-test", version: "1.0.0" }
    }
  });
  sessionId = initialized.sessionId;
  assert.ok(sessionId);
  assert.match(String(initialized.message?.result?.instructions || ""), /Approval required|local approval/i);
  await rpc(runtime.port, {
    sessionId,
    method: "notifications/initialized",
    params: {}
  });

  const listed = await rpc(runtime.port, {
    id: 2,
    sessionId,
    method: "tools/list",
    params: {}
  });
  const names = listed.message?.result?.tools?.map((tool) => tool.name) || [];
  assert.equal(names.length, 35);
  assert.equal(names.includes("request_approval"), false);
  assert.equal(names.includes("approve_request"), false);

  const workspaces = await callTool(runtime.port, sessionId, 3, "workspace_list", {});
  const workspaceId = workspaces.data.workspaces[0].workspace_id;
  const opened = await callTool(runtime.port, sessionId, 4, "task_open", {
    title: "Balanced policy task A",
    primary_workspace_id: workspaceId
  });
  const blocked = await callTool(runtime.port, sessionId, 5, "apply_patch", {
    task_token: opened.data.task.task_token,
    operations: [{ workspace_id: workspaceId, op: "delete", path: "fixture.txt" }]
  });
  assert.equal(blocked.result?.isError, true);
  assert.equal(blocked.data.code, "APPROVAL_REQUIRED");
  const requestId = blocked.data.details.request_id;
  assert.match(requestId, /^[0-9a-f-]{36}$/i);

  const approved = spawnSync(process.execPath, [CLI_PATH, "approval", "approve", requestId], {
    cwd: workspace,
    env: { ...process.env, AGENT_DATA_DIR: context.dataDir },
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(approved.status, 0, approved.stderr);
  assert.match(approved.stdout, /approved/);

  const secondInitialized = await rpc(runtime.port, {
    id: 20,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "runtime-policy-scope-test", version: "1.0.0" }
    }
  });
  secondSessionId = secondInitialized.sessionId;
  await rpc(runtime.port, {
    sessionId: secondSessionId,
    method: "notifications/initialized",
    params: {}
  });
  const secondTask = await callTool(runtime.port, secondSessionId, 21, "task_open", {
    title: "Balanced policy task B",
    primary_workspace_id: workspaceId
  });
  const crossTaskAttempt = await callTool(runtime.port, secondSessionId, 22, "apply_patch", {
    task_token: secondTask.data.task.task_token,
    operations: [{ workspace_id: workspaceId, op: "delete", path: "fixture.txt" }]
  });
  assert.equal(crossTaskAttempt.result?.isError, true);
  assert.equal(crossTaskAttempt.data.code, "APPROVAL_REQUIRED");
  assert.notEqual(crossTaskAttempt.data.details.request_id, requestId);

  const approvedDelete = await callTool(runtime.port, sessionId, 6, "apply_patch", {
    task_token: opened.data.task.task_token,
    operations: [{ workspace_id: workspaceId, op: "delete", path: "fixture.txt" }]
  });
  assert.equal(approvedDelete.result?.isError, undefined);

  const denied = spawnSync(process.execPath, [
    CLI_PATH,
    "approval",
    "deny",
    crossTaskAttempt.data.details.request_id
  ], {
    cwd: workspace,
    env: { ...process.env, AGENT_DATA_DIR: context.dataDir },
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(denied.status, 0, denied.stderr);
  assert.match(denied.stdout, /denied/);

  console.log("runtime balanced-policy approval contract tests passed");
} finally {
  if (runtime && sessionId) {
    await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
      method: "DELETE",
      headers: {
        "mcp-session-id": sessionId,
        "mcp-protocol-version": PROTOCOL_VERSION
      }
    }).catch(() => {});
  }
  if (runtime && secondSessionId) {
    await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
      method: "DELETE",
      headers: {
        "mcp-session-id": secondSessionId,
        "mcp-protocol-version": PROTOCOL_VERSION
      }
    }).catch(() => {});
  }
  if (runtime) await stopTestProcess(runtime.child);
  await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
  await safeRemove(context.dataDir, context, { recursive: true, force: true });
}

async function callTool(port, currentSessionId, id, name, args) {
  const response = await rpc(port, {
    id,
    sessionId: currentSessionId,
    method: "tools/call",
    params: { name, arguments: args }
  });
  assert.equal(response.status, 200);
  const result = response.message?.result;
  const text = result?.content?.find((item) => item?.type === "text")?.text || "";
  let data = result?.structuredContent || null;
  if (!data) data = JSON.parse(text || "{}");
  return { result, data };
}

async function rpc(port, { id, method, params, sessionId: currentSessionId }) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(currentSessionId
        ? {
            "mcp-session-id": currentSessionId,
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
  const body = await response.text();
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id"),
    message: parseMcpResponse(body, response.headers.get("content-type"))
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
