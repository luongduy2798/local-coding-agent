// Local Coding Agent runtime task completion guard integration tests
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGitFixture, createIsolatedTestRoot, safeRemove } from "../helpers/test-guard.mjs";
import { startTestServer, stopTestProcess } from "../helpers/test-runtime.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const context = await createIsolatedTestRoot({
  prefix: "lca-runtime-task-close-",
  protectedPaths: [path.resolve("..")]
});
let runtime;
let sessionId;

try {
  const fixture = await createGitFixture(context, {
    initialFiles: {
      "package.json": `${JSON.stringify({
        name: "runtime-task-close-guard",
        private: true,
        scripts: {
          lint: "node -e \"process.exit(0)\"",
          typecheck: "node -e \"process.exit(0)\"",
          test: "node -e \"process.exit(0)\"",
          build: "node -e \"process.exit(0)\""
        }
      })}\n`,
      "src/value.js": "export const value = 1;\n"
    }
  });
  const secondaryFixture = await createGitFixture(context, {
    initialFiles: {
      "package.json": `${JSON.stringify({
        name: "runtime-task-close-secondary",
        private: true,
        scripts: {
          lint: "node -e \"process.exit(0)\"",
          typecheck: "node -e \"process.exit(0)\"",
          test: "node -e \"process.exit(0)\"",
          build: "node -e \"process.exit(0)\""
        }
      })}\n`,
      "src/consumer.js": "export const consumer = 1;\n"
    }
  });
  const closeDelayReadyPath = path.join(context.dataDir, "task-close-delay-ready");
  runtime = await startTestServer({
    workspace: fixture.root,
    dataDir: context.dataDir,
    runId: context.runId,
    mode: "full",
    policy: "full",
    env: {
      LCA_TEST_RUNTIME_DIAGNOSTICS: "0",
      AGENT_EXTRA_ROOTS_JSON: JSON.stringify([secondaryFixture.root]),
      LCA_TEST_TASK_CLOSE_DELAY_TITLE: "Close race",
      LCA_TEST_TASK_CLOSE_DELAY_MS: "400",
      LCA_TEST_TASK_CLOSE_DELAY_READY_PATH: closeDelayReadyPath,
      LCA_TEST_TASK_CLOSE_CORRUPT_WORKSPACE_TASK: "1"
    }
  });
  const initialized = await rpc(runtime.port, {
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "runtime-task-close-guard-test", version: "1.0.0" }
    }
  });
  sessionId = initialized.sessionId;
  assert.ok(sessionId);
  await rpc(runtime.port, {
    sessionId,
    method: "notifications/initialized",
    params: {}
  });

  const missingEvidenceTask = await openTask(runtime.port, sessionId, 2, "Missing evidence");
  const missingEvidenceClose = await callTool(runtime.port, sessionId, 3, "task_close", {
    task_token: missingEvidenceTask.task_token
  });
  assert.equal(missingEvidenceClose.data.ok, true);
  assert.equal(missingEvidenceClose.data.status, "incomplete");
  assert.equal(missingEvidenceClose.data.requested_status, "complete");
  assert.equal(missingEvidenceClose.data.auto_downgraded, true);
  assert.ok(missingEvidenceClose.data.completion_guard.incomplete_reasons.includes("VERIFICATION_EVIDENCE_MISSING"));
  assert.equal(missingEvidenceClose.data.task.status, "closed");

  const verifiedTask = await openTask(runtime.port, sessionId, 4, "Verified close");
  const cleanVerification = await callTool(runtime.port, sessionId, 5, "verify_changes", {
    task_token: verifiedTask.task_token
  });
  assert.equal(cleanVerification.data.status, "PASS");
  assert.equal(cleanVerification.data.verification_evidence.persisted, true);
  const cleanClose = await callTool(runtime.port, sessionId, 6, "task_close", {
    task_token: verifiedTask.task_token
  });
  assert.equal(cleanClose.data.ok, true, JSON.stringify(cleanClose.data));
  assert.equal(cleanClose.data.status, "complete");
  assert.equal(cleanClose.data.auto_downgraded, false);
  assert.equal(cleanClose.data.task.status, "closed");

  const closeRaceTask = await openTask(runtime.port, sessionId, 69, "Close race");
  assert.equal((await callTool(runtime.port, sessionId, 70, "verify_changes", {
    task_token: closeRaceTask.task_token
  })).data.status, "PASS");
  const closeInProgress = callTool(runtime.port, sessionId, 71, "task_close", {
    task_token: closeRaceTask.task_token
  });
  await waitForFile(closeDelayReadyPath);
  const closeRaceError = await callToolExpectError(runtime.port, sessionId, 72, "apply_patch", {
    task_token: closeRaceTask.task_token,
    operations: [{ op: "create", path: "src/must-not-race.js", content: "export default false;\n" }]
  });
  assert.equal(closeRaceError.code, "TASK_CLOSE_IN_PROGRESS");
  assert.equal((await closeInProgress).data.ok, true);

  const busyTask = await openTask(runtime.port, sessionId, 73, "Foreground operation race");
  const commandReadyPath = path.join(context.dataDir, "task-command-ready");
  const commandSource = `require('node:fs').writeFileSync(${JSON.stringify(commandReadyPath)}, 'ready'); setTimeout(() => {}, 500);`;
  const runningCommand = callTool(runtime.port, sessionId, 74, "run_command", {
    task_token: busyTask.task_token,
    command: `node -e ${JSON.stringify(commandSource)}`,
    timeout_ms: 5_000
  });
  await waitForFile(commandReadyPath);
  const busyError = await callToolExpectError(runtime.port, sessionId, 75, "task_close", {
    task_token: busyTask.task_token
  });
  assert.equal(busyError.code, "TASK_BUSY");
  assert.equal((await runningCommand).data.ok, true);
  assert.equal((await callTool(runtime.port, sessionId, 76, "verify_changes", {
    task_token: busyTask.task_token
  })).data.status, "PASS");
  assert.equal((await callTool(runtime.port, sessionId, 77, "task_close", {
    task_token: busyTask.task_token
  })).data.ok, true);

  const explicitlyIncompleteTask = await openTask(runtime.port, sessionId, 61, "Explicit incomplete close");
  const explicitlyIncompleteClose = await callTool(runtime.port, sessionId, 62, "task_close", {
    task_token: explicitlyIncompleteTask.task_token,
    status: "incomplete"
  });
  assert.equal(explicitlyIncompleteClose.data.ok, true);
  assert.equal(explicitlyIncompleteClose.data.status, "incomplete");
  assert.equal(explicitlyIncompleteClose.data.completion_guard.status, "INCOMPLETE");
  assert.ok(explicitlyIncompleteClose.data.completion_guard.incomplete_reasons.includes("VERIFICATION_EVIDENCE_MISSING"));

  const staleTask = await openTask(runtime.port, sessionId, 7, "Stale verification");
  await callTool(runtime.port, sessionId, 8, "apply_patch", {
    task_token: staleTask.task_token,
    operations: [{
      op: "update",
      path: "src/value.js",
      edits: [{ old_text: "value = 1", new_text: "value = 2" }]
    }]
  });
  const verifiedChange = await callTool(runtime.port, sessionId, 9, "verify_changes", {
    task_token: staleTask.task_token
  });
  assert.equal(verifiedChange.data.status, "PASS");
  await writeFile(path.join(fixture.root, "src/value.js"), "export const value = 3;\n", "utf8");
  const staleClose = await callTool(runtime.port, sessionId, 10, "task_close", {
    task_token: staleTask.task_token
  });
  assert.equal(staleClose.data.ok, false);
  assert.ok(staleClose.data.incomplete_reasons.includes("VERIFICATION_EVIDENCE_STALE"));
  assert.equal((await callTool(runtime.port, sessionId, 11, "task_state", {
    task_token: staleTask.task_token
  })).data.task.status, "open");
  assert.equal((await callTool(runtime.port, sessionId, 12, "verify_changes", {
    task_token: staleTask.task_token
  })).data.status, "PASS");
  assert.equal((await callTool(runtime.port, sessionId, 13, "task_close", {
    task_token: staleTask.task_token
  })).data.ok, true);

  const processTask = await openTask(runtime.port, sessionId, 14, "Running process");
  assert.equal((await callTool(runtime.port, sessionId, 15, "verify_changes", {
    task_token: processTask.task_token
  })).data.status, "PASS");
  const started = await callTool(runtime.port, sessionId, 16, "process", {
    action: "start",
    task_token: processTask.task_token,
    command: "node -e \"setInterval(() => {}, 1000)\""
  });
  const processBlocked = await callTool(runtime.port, sessionId, 17, "task_close", {
    task_token: processTask.task_token
  });
  assert.equal(processBlocked.data.ok, false);
  assert.ok(processBlocked.data.incomplete_reasons.includes("TASK_PROCESS_RUNNING"));
  await callTool(runtime.port, sessionId, 18, "process", {
    action: "stop",
    id: started.data.id,
    task_token: processTask.task_token
  });
  assert.equal((await callTool(runtime.port, sessionId, 19, "task_close", {
    task_token: processTask.task_token
  })).data.ok, true);

  const unmanagedTask = await openTask(runtime.port, sessionId, 20, "Unmanaged changes");
  await callTool(runtime.port, sessionId, 21, "run_command", {
    task_token: unmanagedTask.task_token,
    command: "node -e \"require('node:fs').appendFileSync('src/value.js', '// unmanaged\\n')\""
  });
  const unmanagedClose = await callTool(runtime.port, sessionId, 22, "task_close", {
    task_token: unmanagedTask.task_token
  });
  assert.equal(unmanagedClose.data.ok, false);
  assert.ok(unmanagedClose.data.incomplete_reasons.includes("UNMANAGED_CHANGES"));
  const adoptedVerification = await callTool(runtime.port, sessionId, 23, "verify_changes", {
    task_token: unmanagedTask.task_token,
    adopt_unmanaged: true
  });
  assert.equal(adoptedVerification.data.status, "PASS");
  assert.equal((await callTool(runtime.port, sessionId, 24, "task_close", {
    task_token: unmanagedTask.task_token
  })).data.ok, true);

  const newFileTask = await openTask(runtime.port, sessionId, 25, "Untracked file verification");
  await callTool(runtime.port, sessionId, 26, "apply_patch", {
    task_token: newFileTask.task_token,
    operations: [{
      op: "create",
      path: "src/new-file.js",
      content: "export const createdByPatch = true;\n"
    }]
  });
  const newFileVerification = await callTool(runtime.port, sessionId, 27, "verify_changes", {
    task_token: newFileTask.task_token
  });
  assert.equal(newFileVerification.data.status, "PASS");
  assert.equal(newFileVerification.data.review.evidence.untracked.complete, true);
  assert.equal((await callTool(runtime.port, sessionId, 28, "task_close", {
    task_token: newFileTask.task_token
  })).data.ok, true);

  const committedTask = await openTask(runtime.port, sessionId, 63, "Committed baseline delta");
  await callTool(runtime.port, sessionId, 68, "read_file", {
    task_token: committedTask.task_token,
    path: "src/value.js"
  });
  await callTool(runtime.port, sessionId, 64, "apply_patch", {
    task_token: committedTask.task_token,
    operations: [{
      op: "update",
      path: "src/value.js",
      edits: [{ old_text: "value = 3", new_text: "value = 5" }]
    }]
  });
  await callTool(runtime.port, sessionId, 65, "run_command", {
    task_token: committedTask.task_token,
    command: "git add src/value.js && git commit -m task-baseline-delta"
  });
  const committedVerification = await callTool(runtime.port, sessionId, 66, "verify_changes", {
    task_token: committedTask.task_token,
    adopt_unmanaged: true
  });
  assert.equal(committedVerification.data.status, "PASS");
  assert.equal(committedVerification.data.verification.changes.head_changed, true);
  assert.ok(committedVerification.data.verification.changes.files.some((entry) =>
    entry.location.path === "src/value.js" && entry.committed === true
  ));
  const committedClose = await callTool(runtime.port, sessionId, 67, "task_close", {
    task_token: committedTask.task_token
  });
  assert.equal(committedClose.data.ok, true);
  assert.equal(committedClose.data.completion_guard.workspaces[0].verification.head_changed, true);

  const journalTask = await openTask(runtime.port, sessionId, 29, "Journal failure");
  const journalApply = await callTool(runtime.port, sessionId, 30, "apply_patch", {
    task_token: journalTask.task_token,
    operations: [{
      op: "update",
      path: "src/value.js",
      edits: [{ old_text: "value = 5", new_text: "value = 6" }]
    }]
  });
  assert.equal(journalApply.data.journal_complete, true, JSON.stringify(journalApply.data));
  assert.equal(journalApply.data.changes.length, 1, JSON.stringify(journalApply.data));
  assert.equal((await callTool(runtime.port, sessionId, 31, "verify_changes", {
    task_token: journalTask.task_token
  })).data.status, "PASS");
  const journalIndexPath = path.join(
    context.dataDir,
    "runtime",
    "workspaces",
    journalTask.primary_workspace_id,
    "changes",
    "index.json"
  );
  await writeFile(journalIndexPath, "{ corrupt journal index", "utf8");
  const journalRecovered = await callTool(runtime.port, sessionId, 32, "task_close", {
    task_token: journalTask.task_token
  });
  assert.equal(journalRecovered.data.ok, true, JSON.stringify(journalRecovered.data));
  assert.equal(journalRecovered.data.task.status, "closed");
  assert.ok((await readdir(path.dirname(journalIndexPath))).some((entry) =>
    entry.startsWith("index.corrupt-")
  ));

  const workspaceList = await callTool(runtime.port, sessionId, 78, "workspace_list", {});
  const primaryWorkspaceId = workspaceList.data.selected_workspace_id;
  const secondaryRegistration = await callTool(runtime.port, sessionId, 79, "workspace_register", {
    root: secondaryFixture.root,
    label: "task-close-secondary"
  });
  const secondaryWorkspaceId = secondaryRegistration.data.workspace.workspace_id;
  const multiWorkspaceTask = (await callTool(runtime.port, sessionId, 80, "task_open", {
    title: "Multi-workspace journal rollback",
    primary_workspace_id: primaryWorkspaceId,
    attached_workspace_ids: [secondaryWorkspaceId]
  })).data.task;
  const multiApply = await callTool(runtime.port, sessionId, 81, "apply_patch", {
    task_token: multiWorkspaceTask.task_token,
    operations: [
      {
        workspace_id: primaryWorkspaceId,
        op: "update",
        path: "src/value.js",
        edits: [{ old_text: "value = 6", new_text: "value = 7" }]
      },
      {
        workspace_id: secondaryWorkspaceId,
        op: "update",
        path: "src/consumer.js",
        edits: [{ old_text: "consumer = 1", new_text: "consumer = 2" }]
      }
    ]
  });
  assert.equal(multiApply.data.journal_complete, true, JSON.stringify(multiApply.data));
  assert.equal(multiApply.data.changes.length, 2, JSON.stringify(multiApply.data));
  assert.equal((await callTool(runtime.port, sessionId, 82, "verify_changes", {
    task_token: multiWorkspaceTask.task_token
  })).data.status, "PASS");

  const primaryChangesDir = path.join(
    context.dataDir,
    "runtime",
    "workspaces",
    primaryWorkspaceId,
    "changes"
  );
  const secondaryChangesDir = path.join(
    context.dataDir,
    "runtime",
    "workspaces",
    secondaryWorkspaceId,
    "changes"
  );
  const primaryJournalTaskPath = path.join(primaryChangesDir, "tasks", `${multiWorkspaceTask.id}.json`);
  const secondaryJournalTaskPath = path.join(secondaryChangesDir, "tasks", `${multiWorkspaceTask.id}.json`);
  const secondaryJournalTaskBefore = await readFile(secondaryJournalTaskPath, "utf8");
  const multiCloseBlocked = await callTool(runtime.port, sessionId, 83, "task_close", {
    task_token: multiWorkspaceTask.task_token
  });
  assert.equal(multiCloseBlocked.data.ok, false, JSON.stringify(multiCloseBlocked.data));
  assert.ok(multiCloseBlocked.data.incomplete_reasons.includes("JOURNAL_FINALIZATION_FAILED"));
  assert.equal((await callTool(runtime.port, sessionId, 84, "task_state", {
    task_token: multiWorkspaceTask.task_token
  })).data.task.status, "open");

  const primaryJournalTask = JSON.parse(await readFile(primaryJournalTaskPath, "utf8"));
  assert.equal(primaryJournalTask.status, "active");
  assert.equal(primaryJournalTask.completedAt, null);
  await assert.rejects(
    readFile(secondaryJournalTaskPath, "utf8").then(JSON.parse),
    SyntaxError
  );

  const closeIntentPath = path.join(
    context.dataDir,
    "runtime",
    "tasks",
    multiWorkspaceTask.id,
    "close-intent.json"
  );
  const rolledBackIntent = JSON.parse(await readFile(closeIntentPath, "utf8"));
  assert.equal(rolledBackIntent.status, "rolled_back");
  assert.deepEqual(rolledBackIntent.completed_workspace_ids, [primaryWorkspaceId]);
  assert.deepEqual(rolledBackIntent.rollback_failed_workspace_ids, []);

  await writeFile(secondaryJournalTaskPath, secondaryJournalTaskBefore, "utf8");
  const multiCloseRetried = await callTool(runtime.port, sessionId, 85, "task_close", {
    task_token: multiWorkspaceTask.task_token
  });
  assert.equal(multiCloseRetried.data.ok, true, JSON.stringify(multiCloseRetried.data));
  assert.equal(multiCloseRetried.data.task.status, "closed");
  assert.equal(JSON.parse(await readFile(primaryJournalTaskPath, "utf8")).status, "completed");
  assert.equal(JSON.parse(await readFile(secondaryJournalTaskPath, "utf8")).status, "completed");

  console.log("runtime task-close completion guard tests passed");
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

async function openTask(port, currentSessionId, id, title) {
  const response = await callTool(port, currentSessionId, id, "task_open", { title });
  return response.data.task;
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
  let data = null;
  try {
    data = result?.structuredContent && typeof result.structuredContent === "object"
      ? result.structuredContent
      : JSON.parse(text);
  } catch {}
  if (result?.isError) throw new Error(`${name} failed: ${text}`);
  return { ...response, result, text, data };
}

async function callToolExpectError(port, currentSessionId, id, name, args) {
  const response = await rpc(port, {
    id,
    sessionId: currentSessionId,
    method: "tools/call",
    params: { name, arguments: args }
  });
  assert.equal(response.status, 200);
  const result = response.message?.result;
  const text = result?.content?.find((item) => item?.type === "text")?.text || "";
  assert.equal(result?.isError, true, `${name} unexpectedly succeeded: ${text}`);
  return JSON.parse(text);
}

async function waitForFile(filePath, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(filePath);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for isolated test signal: ${path.basename(filePath)}`);
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
