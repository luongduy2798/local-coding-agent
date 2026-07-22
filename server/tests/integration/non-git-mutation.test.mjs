// Local Coding Agent runtime non-Git mutation detection tests
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createIsolatedTestRoot, safeRemove } from "../helpers/test-guard.mjs";
import { startTestServer, stopTestProcess } from "../helpers/test-runtime.mjs";

const PROTOCOL_VERSION = "2025-06-18";

test("non-Git shell mutation fingerprint ignores reads and detects same-size source edits", async () => {
  const context = await createIsolatedTestRoot({
    prefix: "lca-runtime-non-git-mutation-",
    protectedPaths: [path.resolve("..")]
  });
  const sourcePath = path.join(context.fixtureDir, "source.js");
  let runtime;
  let sessionId;
  try {
    await writeFile(sourcePath, "export const value = 1;\n", "utf8");
    runtime = await startTestServer({
      workspace: context.fixtureDir,
      dataDir: context.dataDir,
      runId: context.runId,
      mode: "full",
      policy: "full",
      env: { LCA_TEST_RUNTIME_DIAGNOSTICS: "0" }
    });
    sessionId = await initialize(runtime.port);

    const opened = await callTool(runtime.port, sessionId, 2, "task_open", {
      title: "Non-Git mutation detection"
    });
    const taskToken = opened.data.task.task_token;

    const readOnly = await callTool(runtime.port, sessionId, 3, "run_command", {
      task_token: taskToken,
      command: "node -e \"process.stdout.write('read-only')\""
    });
    assert.equal(readOnly.data.ok, true);
    assert.equal(readOnly.data.unmanaged_changes, false);

    const sourceEdit = await callTool(runtime.port, sessionId, 4, "run_command", {
      task_token: taskToken,
      command: "node -e \"require('node:fs').writeFileSync('source.js', 'export const value = 2;\\n')\""
    });
    assert.equal(sourceEdit.data.ok, true);
    assert.equal(sourceEdit.data.unmanaged_changes, true);
    assert.equal((await readFile(sourcePath, "utf8")).length, "export const value = 1;\n".length);

    const blocked = await callTool(runtime.port, sessionId, 5, "verify_changes", {
      task_token: taskToken
    });
    assert.notEqual(blocked.data.status, "PASS");
    assert.ok(blocked.data.incomplete_reasons.includes("UNMANAGED_CHANGES"));

    const adopted = await callTool(runtime.port, sessionId, 6, "verify_changes", {
      task_token: taskToken,
      adopt_unmanaged: true
    });
    assert.equal(adopted.data.unmanaged_changes.adopted, true);
    assert.equal(adopted.data.incomplete_reasons.includes("UNMANAGED_CHANGES"), false);
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
    if (runtime) await stopTestProcess(runtime.child);
    await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});

async function initialize(port) {
  const initialized = await rpc(port, {
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "runtime-non-git-mutation-test", version: "1.0.0" }
    }
  });
  const currentSessionId = initialized.sessionId;
  assert.ok(currentSessionId);
  await rpc(port, {
    sessionId: currentSessionId,
    method: "notifications/initialized",
    params: {}
  });
  return currentSessionId;
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
  const data = result?.structuredContent && typeof result.structuredContent === "object"
    ? result.structuredContent
    : JSON.parse(text);
  assert.notEqual(result?.isError, true, `${name} failed: ${text}`);
  return { ...response, result, text, data };
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
  const messages = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return messages.at(-1) || null;
}
