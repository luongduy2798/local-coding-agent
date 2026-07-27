// Local Coding Agent blocker guard integration test
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createIsolatedTestRoot, safeRemove } from "../helpers/test-guard.mjs";
import { startTestServer, stopTestProcess } from "../helpers/test-runtime.mjs";

const PROTOCOL_VERSION = "2025-06-18";

test("missing ChatGPT attachment stops command execution until structured resume", async () => {
  const context = await createIsolatedTestRoot({
    prefix: "lca-runtime-blocker-guard-",
    protectedPaths: [path.resolve("..")]
  });
  let runtime;
  let sessionId;
  try {
    await writeFile(path.join(context.fixtureDir, "README.md"), "# blocker fixture\n", "utf8");
    runtime = await startTestServer({
      workspace: context.fixtureDir,
      dataDir: context.dataDir,
      runId: context.runId,
      mode: "full",
      policy: "full",
      env: { LCA_TEST_RUNTIME_DIAGNOSTICS: "0" }
    });
    sessionId = await initialize(runtime.port);

    const listed = await callTool(runtime.port, sessionId, 2, "workspace_list", {});
    const workspaceId = listed.data.selected_workspace_id || listed.data.workspaces[0]?.workspace_id;
    assert.ok(workspaceId);

    const opened = await callTool(runtime.port, sessionId, 3, "task_open", {
      title: "Missing attachment blocker",
      objective: "Import an attached asset ZIP into the fixture workspace.",
      primary_workspace_id: workspaceId,
      complexity_hint: "normal"
    });
    const taskToken = opened.data.task.task_token;
    const taskId = opened.data.task.id;
    assert.ok(taskToken);

    const missing = await callTool(runtime.port, sessionId, 4, "run_command", {
      task_token: taskToken,
      workspace_id: workspaceId,
      command: "test -f /mnt/data/export.zip",
      intent: {
        purpose: "check_file_exists",
        target: "/mnt/data/export.zip",
        expected_evidence: "Determine whether the attached export.zip is available on the Local Coding Agent host.",
        idempotent: true
      }
    });
    assert.equal(missing.result?.isError, undefined);
    assert.equal(missing.data.ok, false);
    assert.equal(missing.data.exit_code, 1);
    assert.equal(missing.data.orchestration.run_state, "waiting_for_user");
    assert.equal(missing.data.orchestration.blocker.code, "missing_file");
    assert.match(missing.data.orchestration.blocker.required_action, /Copy the attachment/);
    assert.equal(missing.data.orchestration.counters.failed_calls, 1);

    const sentinel = path.join(context.fixtureDir, "must-not-run.txt");
    const stopped = await callTool(runtime.port, sessionId, 5, "run_command", {
      task_token: taskToken,
      workspace_id: workspaceId,
      command: "node -e \"require('node:fs').writeFileSync('must-not-run.txt', 'executed')\"",
      intent: {
        purpose: "write_sentinel",
        target: "must-not-run.txt",
        expected_evidence: "This command must be rejected before the handler executes."
      }
    });
    assert.equal(stopped.result?.isError, undefined);
    assert.equal(stopped.data.blocked, true);
    assert.equal(stopped.data.halt, true);
    assert.equal(stopped.data.user_update_required, true);
    assert.equal(await exists(sentinel), false, "hard-stop must reject the command before execution");

    const healthWhileBlocked = await fetch(`http://127.0.0.1:${runtime.port}/healthz/details`, {
      headers: { "x-lca-instance-nonce": context.runId }
    }).then((response) => response.json());
    const blockedTask = healthWhileBlocked.tasks.find((item) => item.task_id === taskId);
    assert.equal(blockedTask.orchestration.run_state, "waiting_for_user");
    assert.equal(blockedTask.orchestration.blocker.code, "missing_file");

    const assetsDir = path.join(context.fixtureDir, "assets");
    const localAsset = path.join(assetsDir, "export.zip");
    await mkdir(assetsDir, { recursive: true });
    await writeFile(localAsset, "fixture archive", "utf8");

    const resumed = await callTool(runtime.port, sessionId, 6, "task_open", {
      task_token: taskToken,
      resume: {
        resolved_blocker_code: "missing_file",
        new_input: { assetPath: localAsset },
        changed_targets: ["/mnt/data/export.zip", localAsset]
      }
    });
    assert.equal(resumed.data.resumed, true);
    assert.equal(resumed.data.task.orchestration.run_state, "running");
    assert.equal(resumed.data.task.orchestration.blocker, null);

    const available = await callTool(runtime.port, sessionId, 7, "run_command", {
      task_token: taskToken,
      workspace_id: workspaceId,
      command: "test -f assets/export.zip",
      intent: {
        purpose: "check_file_exists",
        target: "assets/export.zip",
        expected_evidence: "Confirm that the user-provided local asset path is now available.",
        idempotent: true
      }
    });
    assert.equal(available.data.ok, true);
    assert.equal(available.data.orchestration.run_state, "running");
  } finally {
    if (runtime && sessionId) await deleteSession(runtime.port, sessionId).catch(() => {});
    if (runtime) await stopTestProcess(runtime.child);
    await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});

async function exists(target) {
  return access(target).then(() => true).catch(() => false);
}

async function initialize(port) {
  const initialized = await rpc(port, {
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "runtime-blocker-guard-test", version: "1.0.0" }
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
  const data = result?.structuredContent && typeof result.structuredContent === "object"
    ? result.structuredContent
    : JSON.parse(text);
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
