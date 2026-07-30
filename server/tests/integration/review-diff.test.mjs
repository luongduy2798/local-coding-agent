// Local Coding Agent runtime review completeness tests
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  createGitFixture,
  createIsolatedTestRoot,
  safeRemove
} from "../helpers/test-guard.mjs";
import { startTestServer, stopTestProcess } from "../helpers/test-runtime.mjs";

const PROTOCOL_VERSION = "2025-06-18";

test("review_diff aggregates task workspaces, inventories every source and paginates honestly", async () => {
  const context = await createIsolatedTestRoot({
    prefix: "lca-runtime-review-diff-",
    protectedPaths: [path.resolve("..")]
  });
  const workspaceA = (await createGitFixture(context, {
    initialFiles: {
      "src/unstaged.js": "export const unstaged = 1;\n",
      "src/staged.js": "export const staged = 1;\n",
      "src/chunk-a.txt": "a\n".repeat(1_200),
      "src/chunk-b.txt": "a\n".repeat(1_200)
    }
  })).root;
  const workspaceB = (await createGitFixture(context, {
    initialFiles: { "consumer.js": "export const consumer = 1;\n" }
  })).root;
  let runtime;
  let sessionId;
  try {
    await writeFile(path.join(workspaceA, "src/staged.js"), "export const staged = 2;\n", "utf8");
    runGit(workspaceA, ["add", "src/staged.js"]);
    await writeFile(path.join(workspaceA, "src/unstaged.js"), "export const unstaged = 2;\n", "utf8");
    await writeFile(path.join(workspaceA, "src/chunk-a.txt"), "b\n".repeat(1_200), "utf8");
    await writeFile(path.join(workspaceA, "src/chunk-b.txt"), "b\n".repeat(1_200), "utf8");
    await writeFile(path.join(workspaceA, "untracked-a.js"), "console.log('review me');\n", "utf8");
    await writeFile(path.join(workspaceB, "untracked-b.js"), "export const untracked = true;\n", "utf8");

    runtime = await startTestServer({
      workspace: workspaceA,
      dataDir: context.dataDir,
      runId: context.runId,
      mode: "full",
      policy: "full",
      env: {
        LCA_TEST_RUNTIME_DIAGNOSTICS: "0",
        AGENT_EXTRA_ROOTS_JSON: JSON.stringify([workspaceB]),
        AGENT_MAX_COMMAND_OUTPUT: "10000"
      }
    });
    sessionId = await initialize(runtime.port);
    const listed = await callTool(runtime.port, sessionId, 2, "workspace_list", {});
    const workspaceAId = listed.data.selected_workspace_id;
    assert.ok(workspaceAId);
    const registered = await callTool(runtime.port, sessionId, 3, "workspace_register", {
      root: workspaceB,
      label: "workspace-b"
    });
    const workspaceBId = registered.data.workspace.workspace_id;
    const opened = await callTool(runtime.port, sessionId, 4, "task_open", {
      title: "Review two workspaces",
      primary_workspace_id: workspaceAId,
      attached_workspace_ids: [workspaceBId]
    });
    const taskId = opened.data.task.id;

    const missingJournal = await callTool(runtime.port, sessionId, 5, "review_diff", { page_size: 1 });
    assert.equal(missingJournal.result?.isError, undefined, missingJournal.text);
    assert.equal(missingJournal.data.scope.mode, "task");
    assert.equal(missingJournal.data.complete, false);
    assert.equal(missingJournal.data.verdict, "INCOMPLETE");
    assert.ok(missingJournal.data.scope.workspaces.every((entry) =>
      entry.error === "JOURNAL_EVIDENCE_MISSING"
    ));
    assert.equal(missingJournal.data.inventory.total, 0);

    const first = await callTool(runtime.port, sessionId, 51, "review_diff", {
      scope: "workspace",
      page_size: 1
    });
    assert.equal(first.result?.isError, undefined, first.text);
    assert.equal(first.data.workspaces.length, 2);
    assert.equal(first.data.complete, true);
    assert.notEqual(first.data.verdict, "INCOMPLETE");
    assert.ok(first.data.inventory.source_counts.staged >= 1);
    assert.ok(first.data.inventory.source_counts.unstaged >= 1);
    assert.ok(first.data.inventory.source_counts.untracked >= 2);
    assert.equal(first.data.inventory.returned, 1);
    assert.equal(first.data.inventory.page_has_more, true);
    assert.ok(first.data.pagination.next_cursor);
    const primaryReview = first.data.workspaces.find((workspace) => workspace.workspace_id === workspaceAId);
    assert.equal(primaryReview.evidence.unstaged.complete, true);
    assert.equal(primaryReview.evidence.unstaged.truncated, false);
    assert.equal(primaryReview.evidence.unstaged.strategy, "path_chunks");
    assert.ok(primaryReview.evidence.unstaged.chunks >= 2);
    for (const workspace of first.data.workspaces) {
      assert.deepEqual(
        Object.keys(workspace.inventory.source_counts).sort(),
        ["staged", "unstaged", "untracked"]
      );
      assert.deepEqual(
        Object.keys(workspace.inventory.source_status).sort(),
        ["staged", "unstaged", "untracked"]
      );
    }

    const second = await callTool(runtime.port, sessionId, 6, "review_diff", {
      scope: "workspace",
      page_size: 1,
      cursor: first.data.pagination.next_cursor
    });
    assert.equal(second.result?.isError, undefined, second.text);
    assert.equal(second.data.pagination.offset, 1);
    assert.equal(second.data.evidence_revision, first.data.evidence_revision);
    assert.notDeepEqual(second.data.inventory.items, first.data.inventory.items);

    const stagedCompatibility = await callTool(runtime.port, sessionId, 7, "review_diff", {
      staged: true,
      workspace_id: workspaceAId
    });
    assert.deepEqual(stagedCompatibility.data.analyzed_sources, ["staged", "unstaged", "untracked"]);
    assert.ok(stagedCompatibility.data.inventory.source_counts.unstaged >= 1);
    assert.ok(stagedCompatibility.data.inventory.source_counts.untracked >= 1);

    await writeFile(path.join(workspaceA, "src/chunk-a.txt"), "c\n".repeat(3_000), "utf8");
    const oversizedTracked = await callTool(runtime.port, sessionId, 71, "review_diff", {
      scope: "workspace",
      workspace_id: workspaceAId
    });
    assert.equal(oversizedTracked.data.verdict, "INCOMPLETE");
    assert.equal(oversizedTracked.data.complete, false);
    assert.equal(
      oversizedTracked.data.workspaces.find((workspace) => workspace.workspace_id === workspaceAId)
        .evidence.unstaged.truncated,
      true
    );
    assert.ok(
      oversizedTracked.data.inventory.failed_paths.some((item) =>
        item.path === "src/chunk-a.txt" && item.reason === "diff_output_truncated"
      )
    );
    await writeFile(path.join(workspaceA, "src/chunk-a.txt"), "b\n".repeat(1_200), "utf8");

    const largePath = path.join(workspaceA, "large-untracked.txt");
    await writeFile(largePath, "x".repeat(210_000), "utf8");
    const truncated = await callTool(runtime.port, sessionId, 8, "review_diff", {
      scope: "workspace",
      workspace_id: workspaceAId
    });
    assert.equal(truncated.data.verdict, "INCOMPLETE");
    assert.equal(truncated.data.complete, false);
    assert.equal(truncated.data.workspaces[0].evidence.untracked.truncated, true);
    assert.ok(
      truncated.data.inventory.failed_paths.some((item) =>
        item.path === "large-untracked.txt" && item.reason === "diff_budget_exceeded"
      )
    );
    await unlink(largePath);

    const unmanagedArtifact = path.join(
      context.dataDir,
      "runtime",
      "tasks",
      taskId,
      "unmanaged-changes.json"
    );
    await mkdir(path.dirname(unmanagedArtifact), { recursive: true });
    await writeFile(unmanagedArtifact, "{ corrupt unmanaged state", "utf8");
    const unknownUnmanaged = await callTool(runtime.port, sessionId, 9, "review_diff", {
      scope: "workspace",
      workspace_id: workspaceAId
    });
    assert.equal(unknownUnmanaged.data.verdict, "INCOMPLETE");
    assert.equal(unknownUnmanaged.data.unmanaged_state_unknown, true);
    assert.ok(
      unknownUnmanaged.data.incomplete_reasons.some((entry) =>
        entry.reasons.includes("unmanaged_state_unknown")
      )
    );
  } finally {
    if (runtime && sessionId) await closeSession(runtime.port, sessionId);
    if (runtime) await stopTestProcess(runtime.child);
    await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});

test("review_diff restricts managed findings and summary to the current task paths", async () => {
  const context = await createIsolatedTestRoot({
    prefix: "lca-runtime-review-task-scope-",
    protectedPaths: [path.resolve("..")] 
  });
  const workspace = (await createGitFixture(context, {
    initialFiles: {
      "src/preexisting.js": "export const preexisting = 1;\n",
      "src/managed.js": "console.log('existing debug line');\nexport const managed = 1;\n"
    }
  })).root;
  let runtime;
  let sessionId;
  try {
    await writeFile(
      path.join(workspace, "src/preexisting.js"),
      "console.log('pre-existing dirty change');\n",
      "utf8"
    );
    runtime = await startTestServer({
      workspace,
      dataDir: context.dataDir,
      runId: context.runId,
      mode: "full",
      policy: "full",
      env: { LCA_TEST_RUNTIME_DIAGNOSTICS: "0" }
    });
    sessionId = await initialize(runtime.port);
    const listed = await callTool(runtime.port, sessionId, 100, "workspace_list", {});
    await callTool(runtime.port, sessionId, 101, "task_open", {
      title: "Scoped managed review",
      primary_workspace_id: listed.data.selected_workspace_id
    });
    const patched = await callTool(runtime.port, sessionId, 102, "apply_patch", {
      operations: [{
        op: "update",
        path: "src/managed.js",
        edits: [{ old_text: "managed = 1", new_text: "managed = 2" }]
      }]
    });
    assert.equal(patched.data.ok, true, patched.text);

    const review = await callTool(runtime.port, sessionId, 103, "review_diff", {});
    assert.equal(review.result?.isError, undefined, review.text);
    assert.equal(review.data.scope.mode, "task");
    assert.equal(review.data.scope.paths_count, 1);
    assert.equal(review.data.scope.workspaces[0].exact_journal_diff, true);
    assert.deepEqual(
      review.data.inventory.items.map((item) => item.path),
      ["src/managed.js"]
    );
    assert.deepEqual(
      review.data.summary.files.map((item) => item.path),
      ["src/managed.js"]
    );
    assert.equal(
      review.data.findings.some((item) => item.location?.path === "src/preexisting.js"),
      false
    );
    assert.equal(review.data.summary.changed_files, 1);
    assert.equal(review.data.summary.added_lines, 1);
    assert.equal(review.data.summary.deleted_lines, 1);
    assert.equal(review.data.findings_count, 0, "unchanged debug lines must not be reclassified as additions");

    const workspaceReview = await callTool(runtime.port, sessionId, 104, "review_diff", {
      scope: "workspace"
    });
    assert.equal(workspaceReview.result?.isError, undefined, workspaceReview.text);
    assert.equal(workspaceReview.data.scope.mode, "workspace");
    assert.equal(workspaceReview.data.scope.workspaces[0].exact_journal_diff, false);
    assert.deepEqual(
      workspaceReview.data.inventory.items.map((item) => item.path),
      ["src/managed.js", "src/preexisting.js"]
    );
    assert.deepEqual(
      workspaceReview.data.summary.files.map((item) => item.path),
      ["src/managed.js", "src/preexisting.js"]
    );
    assert.equal(workspaceReview.data.summary.changed_files, 2);
    assert.equal(
      workspaceReview.data.findings.some((item) => item.location?.path === "src/preexisting.js"),
      true,
      "workspace scope must include pre-existing dirty changes"
    );
    await callTool(runtime.port, sessionId, 105, "task_close", {});
  } finally {
    if (runtime && sessionId) await closeSession(runtime.port, sessionId);
    if (runtime) await stopTestProcess(runtime.child);
    await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});

test("review_diff never reports CLEAN while the transaction coordinator is in doubt", async () => {
  const context = await createIsolatedTestRoot({
    prefix: "lca-runtime-review-transaction-",
    protectedPaths: [path.resolve("..")]
  });
  const workspace = (await createGitFixture(context, {
    initialFiles: { "README.md": "clean fixture\n" }
  })).root;
  const transactionDir = path.join(
    context.dataDir,
    "runtime",
    "patch-coordinator",
    "transactions"
  );
  await mkdir(transactionDir, { recursive: true });
  // The runtime activation layer validates JSON syntax before the transaction
  // coordinator sees it. Keep the JSON syntactically valid but structurally
  // invalid so coordinator recovery owns the in-doubt classification.
  await writeFile(path.join(transactionDir, "corrupt.json"), "{}\n", "utf8");
  let runtime;
  let sessionId;
  try {
    runtime = await startTestServer({
      workspace,
      dataDir: context.dataDir,
      runId: context.runId,
      mode: "full",
      policy: "full",
      env: { LCA_TEST_RUNTIME_DIAGNOSTICS: "0" }
    });
    sessionId = await initialize(runtime.port);
    const listed = await callTool(runtime.port, sessionId, 20, "workspace_list", {});
    await callTool(runtime.port, sessionId, 21, "task_open", {
      title: "Review in-doubt transaction",
      primary_workspace_id: listed.data.selected_workspace_id
    });
    const review = await callTool(runtime.port, sessionId, 22, "review_diff", {});
    assert.equal(review.result?.isError, undefined, review.text);
    assert.equal(review.data.verdict, "INCOMPLETE");
    assert.equal(review.data.complete, false);
    assert.equal(review.data.transaction_in_doubt, true);
    assert.notEqual(review.data.verdict, "CLEAN");
    assert.ok(
      review.data.incomplete_reasons.some((entry) =>
        entry.reasons.includes("transaction_in_doubt")
      )
    );
  } finally {
    if (runtime && sessionId) await closeSession(runtime.port, sessionId);
    if (runtime) await stopTestProcess(runtime.child);
    await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  }
});

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${String(result.stderr || result.error?.message || "unknown error")}`
  );
}

async function initialize(port) {
  const initialized = await rpc(port, {
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "runtime-review-diff-test", version: "1.0.0" }
    }
  });
  assert.equal(initialized.status, 200);
  const sessionId = initialized.sessionId;
  assert.ok(sessionId);
  await rpc(port, {
    sessionId,
    method: "notifications/initialized",
    params: {}
  });
  return sessionId;
}

async function closeSession(port, sessionId) {
  await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "DELETE",
    headers: {
      "mcp-session-id": sessionId,
      "mcp-protocol-version": PROTOCOL_VERSION
    }
  }).catch(() => {});
}

async function callTool(port, sessionId, id, name, args) {
  const effectiveArgs = name === "review_diff"
    ? { response_mode: "full", ...args }
    : args;
  const response = await rpc(port, {
    id,
    sessionId,
    method: "tools/call",
    params: { name, arguments: effectiveArgs }
  });
  assert.equal(response.status, 200);
  const result = response.message?.result;
  const text = result?.content?.find((item) => item?.type === "text")?.text || "";
  let data = result?.structuredContent || null;
  if (!data) data = JSON.parse(text || "{}");
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
