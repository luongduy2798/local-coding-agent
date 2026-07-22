// Local Coding Agent runtime production catalog integration tests
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { brotliCompressSync } from "node:zlib";
import { createGitFixture, createIsolatedTestRoot, safeRemove } from "../helpers/test-guard.mjs";
import { startTestServer, stopTestProcess } from "../helpers/test-runtime.mjs";

const EXPECTED_TOOLS = [
  "lca_status",
  "workspace_list",
  "workspace_register",
  "workspace_select",
  "workspace_attach",
  "workspace_detach",
  "task_open",
  "task_state",
  "task_plan",
  "task_checkpoint",
  "task_close",
  "workspace_snapshot",
  "code_query",
  "search_text",
  "find_files",
  "list_files",
  "read_file",
  "read_many",
  "project_profile",
  "index_control",
  "apply_patch",
  "change_history",
  "git",
  "run_command",
  "run_commands",
  "process",
  "run_changed_tests",
  "verify_changes",
  "review_diff",
  "security_scan",
  "todo_scan",
  "skills",
  "notes",
  "figma",
  "lca_input"
];

const EXPECTED_CATALOG_HASH = createHash("sha256")
  .update([...EXPECTED_TOOLS].sort().join("\n"))
  .digest("hex")
  .slice(0, 16);
const MAX_TOOLS_LIST_BYTES = 25_000;
const PROTOCOL_VERSION = "2025-06-18";

const context = await createIsolatedTestRoot({
  prefix: "lca-runtime-catalog-",
  protectedPaths: [path.resolve("..")]
});
let runtime;
let sessionId;
const workspaceA = path.join(context.fixtureDir, "workspace-a");
let workspaceB;

try {
  await mkdir(workspaceA, { recursive: true });
  workspaceB = (await createGitFixture(context, {
    initialFiles: {
      "package.json": `${JSON.stringify({
        name: "runtime-catalog-fixture",
        private: true,
        scripts: { test: "node --test" }
      })}\n`,
      "src/math.js": "export const add = (left, right) => left + right;\n",
      "src/math.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './math.js';\ntest('add', () => assert.equal(add(1, 2), 3));\n",
      "staged-secret.json": "{}\n",
      "unstaged-secret.js": "export const safe = true;\n"
    }
  })).root;
  runtime = await startTestServer({
    workspace: workspaceA,
    dataDir: context.dataDir,
    runId: context.runId,
    mode: "full",
    policy: "full",
    env: {
      LCA_TEST_RUNTIME_DIAGNOSTICS: "0",
      AGENT_EXTRA_ROOTS_JSON: JSON.stringify([workspaceB])
    }
  });

  const initialized = await rpc(runtime.port, {
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "runtime-catalog-test", version: "1.0.0" }
    }
  });
  assert.equal(initialized.status, 200);
  sessionId = initialized.sessionId;
  assert.ok(sessionId, "initialize must create a stateful MCP session");
  const instructions = String(initialized.message?.result?.instructions || "");
  assert.match(instructions, /task_open/);
  assert.match(instructions, /workspace_set|workspace set/i);
  assert.doesNotMatch(instructions, /\bworkspace_doctor\b|\brepo_symbols\b|\bsession_report\b|\brequest_approval\b/);

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
  assert.equal(listed.status, 200);
  const tools = listed.message?.result?.tools;
  assert.ok(Array.isArray(tools), "tools/list must return a tools array");
  const names = tools.map((tool) => tool.name);
  assert.equal(names.length, 35, `expected 35 production tools, received ${names.length}`);
  assert.deepEqual([...names].sort(), [...EXPECTED_TOOLS].sort());
  assert.ok(
    listed.bytes < MAX_TOOLS_LIST_BYTES,
    `tools/list raw payload is ${listed.bytes} bytes; budget is < ${MAX_TOOLS_LIST_BYTES} bytes`
  );
  const compressedCatalogBytes = brotliCompressSync(Buffer.from(JSON.stringify(listed.message))).byteLength;
  assert.ok(
    compressedCatalogBytes < 6_000,
    `tools/list compressed payload is ${compressedCatalogBytes} bytes; budget is < 6000 bytes`
  );

  const statusResponse = await rpc(runtime.port, {
    id: 3,
    sessionId,
    method: "tools/call",
    params: { name: "lca_status", arguments: {} }
  });
  assert.equal(statusResponse.status, 200);
  const toolResult = statusResponse.message?.result;
  assert.equal(toolResult?.isError, undefined, toolResult?.content?.[0]?.text || "lca_status failed");
  const status = JSON.parse(toolResult?.content?.[0]?.text || "{}");
  assert.equal(status.tool_catalog, "fixed");
  assert.equal(status.catalog_version, 5);
  assert.equal(status.catalog_hash, EXPECTED_CATALOG_HASH);
  assert.equal(status.multi_workspace.evicting_runtime_count, 0);
  assert.equal(
    statusResponse.message?.result?.content?.[0]?.text?.includes(context.fixtureDir),
    false,
    "model-visible lca_status must not contain absolute workspace roots"
  );

  const publicHealth = await fetch(`http://127.0.0.1:${runtime.port}/healthz`);
  const publicHealthText = await publicHealth.text();
  assert.equal(publicHealth.status, 200);
  assert.equal(publicHealthText.includes(context.fixtureDir), false);
  const deniedDetails = await fetch(`http://127.0.0.1:${runtime.port}/healthz/details`);
  assert.equal(deniedDetails.status, 401);
  const detailedHealth = await fetch(`http://127.0.0.1:${runtime.port}/healthz/details`, {
    headers: { "x-lca-instance-nonce": context.runId }
  });
  assert.equal(detailedHealth.status, 200);
  const detailedHealthBody = await detailedHealth.json();
  assert.equal(detailedHealthBody.workspace, workspaceA);
  assert.match(detailedHealthBody.runtime_id, /^[a-f0-9-]{36}$/i);
  assert.equal(detailedHealthBody.audit.enabled, true);
  assert.equal(detailedHealthBody.audit.path, path.join(context.dataDir, "runtime", "audit.log"));
  assert.ok(Array.isArray(detailedHealthBody.workspaces));
  assert.ok(detailedHealthBody.workspaces.every((workspace) => workspace.registration_state === "active"));
  assert.ok(Array.isArray(detailedHealthBody.tasks));
  assert.ok(Array.isArray(detailedHealthBody.processes));

  const missingTask = await callTool(runtime.port, sessionId, 4, "workspace_snapshot", {});
  assert.equal(missingTask.result?.isError, true);
  assert.equal(JSON.parse(missingTask.text).code, "TASK_CONTEXT_REQUIRED");

  const removedStatusAlias = await callTool(runtime.port, sessionId, 5, "workspace_info", {});
  assert.equal(removedStatusAlias.result?.isError, true);
  assert.match(removedStatusAlias.text, /unknown tool|not found/i);

  const registered = await callTool(runtime.port, sessionId, 6, "workspace_register", {
    root: workspaceB,
    label: "Workspace B"
  });
  assert.equal(registered.data.workspace.root.path, ".");
  assert.equal(registered.data.workspace.git_repository, true);
  assert.match(registered.data.workspace.git_identity, /^git_[a-f0-9]{32}$/);
  const workspaceBId = registered.data.workspace.workspace_id;
  const statusAfterRegister = await callTool(runtime.port, sessionId, 61, "lca_status", {});
  assert.ok(
    statusAfterRegister.data.workspaces.some((workspace) =>
      workspace.workspace_id === workspaceBId && workspace.label === "Workspace B"
    ),
    "lca_status must invalidate its warm control-plane cache after workspace registration"
  );
  const allWorkspaceEvent = await firstSseEvent(
    runtime.port,
    "/changes/events?workspace_id=all",
    { "x-lca-instance-nonce": context.runId }
  );
  assert.equal(allWorkspaceEvent.event, "revision");
  assert.equal(allWorkspaceEvent.data.workspace_id, "all");
  assert.equal(allWorkspaceEvent.data.workspace_revisions.length, 2);
  assert.ok(allWorkspaceEvent.data.workspace_revisions.some((item) => item.workspace_id === workspaceBId));

  const opened = await callTool(runtime.port, sessionId, 7, "task_open", {
    title: "Catalog isolation task",
    primary_workspace_id: workspaceBId
  });
  assert.equal(opened.data.task.primary_workspace_id, workspaceBId);
  const openedBaseline = opened.data.task.workspace_state[0];
  assert.equal(openedBaseline.workspace_id, workspaceBId);
  assert.equal(openedBaseline.baseline_known, true);
  assert.match(openedBaseline.captured_at, /^\d{4}-\d{2}-\d{2}T/);
  const patchPreview = await callTool(runtime.port, sessionId, 701, "apply_patch", {
    action: "preview",
    workspace_id: workspaceBId,
    operations: [{
      op: "update",
      path: "src/math.js",
      content: "export const add = () => 99;\n"
    }]
  });
  assert.equal(patchPreview.data.status, "validated");
  assert.equal(patchPreview.data.mutation_performed, false);
  assert.equal(patchPreview.data.workspace_set_frozen, false);
  assert.match(await readFile(path.join(workspaceB, "src", "math.js"), "utf8"), /left \+ right/);
  const patchValidation = await callTool(runtime.port, sessionId, 702, "apply_patch", {
    action: "validate",
    workspace_id: workspaceBId,
    operations: [{ op: "create", path: "validate-only.txt", content: "never written\n" }]
  });
  assert.equal(patchValidation.data.status, "validated");
  assert.equal(existsSync(path.join(workspaceB, "validate-only.txt")), false);
  const taskAfterPatchPreview = await callTool(runtime.port, sessionId, 703, "task_state", {});
  assert.equal(taskAfterPatchPreview.data.task.workspace_set_frozen, false);
  const indexStatus = await callTool(runtime.port, sessionId, 76, "index_control", {
    action: "status",
    workspace_id: workspaceBId
  });
  assert.equal(indexStatus.data.semantic.available, true);
  assert.equal(indexStatus.data.semantic.unavailable_reason, null);
  assert.ok(indexStatus.data.semantic.adapters.some((adapter) =>
    adapter.engine === "builtin-structural-ast-v1" &&
    adapter.languages.includes("python") &&
    adapter.languages.includes("rust") &&
    adapter.hard_preemptible === true
  ));
  assert.equal(indexStatus.data.semantic.typescript_search_scope, "<workspace>/node_modules/typescript");
  assert.equal(indexStatus.data.semantic.installs_packages, false);
  const [evictedIndex, reopenedSnapshot] = await Promise.all([
    callTool(runtime.port, sessionId, 760, "index_control", {
      action: "evict",
      workspace_id: workspaceBId
    }),
    callTool(runtime.port, sessionId, 761, "workspace_snapshot", {
      workspace_id: workspaceBId,
      max_entries: 20
    })
  ]);
  assert.equal(evictedIndex.data.evicted, true);
  assert.equal(reopenedSnapshot.result?.isError, undefined);
  assert.equal(reopenedSnapshot.data.workspace_id, workspaceBId);
  const runtimeStatusAfterEviction = await callTool(runtime.port, sessionId, 762, "lca_status", {});
  assert.equal(runtimeStatusAfterEviction.data.multi_workspace.evicting_runtime_count, 0);
  const gitRootResult = await callTool(runtime.port, sessionId, 77, "git", {
    workspace_id: workspaceBId,
    args: ["rev-parse", "--show-toplevel"]
  });
  assert.deepEqual(gitRootResult.data.cwd, { workspace_id: workspaceBId, path: "." });
  assert.equal(gitRootResult.data.stdout.trim(), ".");
  assert.equal(JSON.stringify(gitRootResult.data).includes(workspaceB), false);
  const rejectedAbsolutePath = await callTool(runtime.port, sessionId, 70, "read_file", {
    workspace_id: workspaceBId,
    path: context.fixtureDir
  });
  assert.equal(rejectedAbsolutePath.result?.isError, true);
  assert.equal(
    rejectedAbsolutePath.text.includes(context.fixtureDir),
    false,
    "production tool errors must not expose absolute local paths"
  );
  const multiPatternSearch = await callTool(runtime.port, sessionId, 73, "search_text", {
    workspace_id: workspaceBId,
    query: "export const add",
    patterns: ["test('add'"],
    limit: 2
  });
  assert.equal(multiPatternSearch.data.patterns.length, 2);
  assert.equal(multiPatternSearch.data.matches.length, 2);
  assert.ok(multiPatternSearch.data.matches.every((match) => match.workspace_id === workspaceBId));
  const firstSearchPage = await callTool(runtime.port, sessionId, 731, "search_text", {
    workspace_id: workspaceBId,
    query: "export",
    limit: 1
  });
  assert.equal(firstSearchPage.data.matches.length, 1);
  assert.ok(firstSearchPage.data.pagination.next_cursor);
  const secondSearchPage = await callTool(runtime.port, sessionId, 732, "search_text", {
    workspace_id: workspaceBId,
    query: "export",
    limit: 1,
    cursor: firstSearchPage.data.pagination.next_cursor
  });
  assert.equal(secondSearchPage.data.pagination.offset, 1);
  assert.notDeepEqual(secondSearchPage.data.matches[0], firstSearchPage.data.matches[0]);
  const firstFilePage = await callTool(runtime.port, sessionId, 733, "find_files", {
    workspace_id: workspaceBId,
    glob: "*.js",
    limit: 1
  });
  assert.ok(firstFilePage.data.pagination.next_cursor);
  const secondFilePage = await callTool(runtime.port, sessionId, 734, "find_files", {
    workspace_id: workspaceBId,
    glob: "*.js",
    limit: 1,
    cursor: firstFilePage.data.pagination.next_cursor
  });
  assert.notEqual(secondFilePage.data.files[0].path, firstFilePage.data.files[0].path);
  const firstListPage = await callTool(runtime.port, sessionId, 735, "list_files", {
    workspace_id: workspaceBId,
    path: ".",
    recursive: true,
    limit: 1
  });
  assert.ok(firstListPage.data.pagination.next_cursor);
  const secondListPage = await callTool(runtime.port, sessionId, 736, "list_files", {
    workspace_id: workspaceBId,
    path: ".",
    recursive: true,
    limit: 1,
    cursor: firstListPage.data.pagination.next_cursor
  });
  assert.notEqual(secondListPage.data.entries[0].path, firstListPage.data.entries[0].path);
  const firstQueryPage = await callTool(runtime.port, sessionId, 737, "code_query", {
    workspace_id: workspaceBId,
    query: "add",
    mode: "references",
    depth: "fast",
    limit: 1
  });
  assert.ok(firstQueryPage.data.pagination.next_cursor);
  const secondQueryPage = await callTool(runtime.port, sessionId, 738, "code_query", {
    workspace_id: workspaceBId,
    query: "add",
    mode: "references",
    depth: "fast",
    limit: 1,
    cursor: firstQueryPage.data.pagination.next_cursor
  });
  assert.notDeepEqual(secondQueryPage.data.results[0].location, firstQueryPage.data.results[0].location);
  const mismatchedCursor = await callTool(runtime.port, sessionId, 739, "search_text", {
    workspace_id: workspaceBId,
    query: "different query",
    limit: 1,
    cursor: firstSearchPage.data.pagination.next_cursor
  });
  assert.equal(mismatchedCursor.result?.isError, true);
  assert.equal(JSON.parse(mismatchedCursor.text).code, "INVALID_CURSOR");
  for (const removedTool of ["workspace_search", "slash_commands", "compose_prompt"]) {
    const removed = await callTool(runtime.port, sessionId, 74, removedTool, {});
    assert.equal(removed.result?.isError, true);
    assert.match(removed.text, /unknown tool|not found/i);
  }

  const removedWriteAlias = await callTool(runtime.port, sessionId, 704, "write_file", {
    workspace_id: workspaceBId,
    path: "legacy-alias.txt",
    content: "migrated safely\n"
  });
  assert.equal(removedWriteAlias.result?.isError, true);
  assert.match(removedWriteAlias.text, /unknown tool|not found/i);
  assert.equal(existsSync(path.join(workspaceB, "legacy-alias.txt")), false);

  const command = await callTool(runtime.port, sessionId, 8, "run_command", {
    command: `node -e "process.stdout.write(process.env.AGENT_WORKSPACE || '')"`,
    workspace_id: workspaceBId
  });
  assert.equal(command.data.stdout, workspaceB);

  const savedNote = await callTool(runtime.port, sessionId, 9, "notes", {
    action: "save",
    workspace_id: workspaceBId,
    title: "Scoped note",
    body: "workspace B only"
  });
  assert.equal(savedNote.data.note.workspace_id, workspaceBId);
  const listedNotes = await callTool(runtime.port, sessionId, 10, "notes", {
    action: "list",
    workspace_id: workspaceBId
  });
  assert.equal(listedNotes.data.count, 1);
  assert.equal(listedNotes.data.notes[0].task_id, opened.data.task.id);

  const createdSkill = await callTool(runtime.port, sessionId, 11, "skills", {
    action: "create",
    workspace_id: workspaceBId,
    name: "catalog-skill",
    description: "Catalog isolation fixture",
    body: "Use only inside the selected task."
  });
  assert.equal(createdSkill.result?.isError, undefined, createdSkill.text);
  assert.equal(createdSkill.data.transaction.ok, true);
  assert.match(
    await readFile(path.join(workspaceB, ".claude", "skills", "catalog-skill", "SKILL.md"), "utf8"),
    /Catalog isolation fixture/
  );

  const structuredBudget = await callTool(runtime.port, sessionId, 12, "lca_input", {
    initial_input: "漢".repeat(30_000)
  });
  assert.equal(structuredBudget.data.response_truncated, true);
  assert.ok(structuredBudget.bytes <= 64 * 1024, `budgeted MCP response was ${structuredBudget.bytes} bytes`);

  const stagedValue = `staged-${"x".repeat(24)}`;
  const unstagedValue = `unstaged-${"y".repeat(24)}`;
  const privateKeyMarker = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  await writeFile(
    path.join(workspaceB, "staged-secret.json"),
    `${JSON.stringify({ api_key: stagedValue })}\n`,
    "utf8"
  );
  runGit(workspaceB, ["add", "staged-secret.json"]);
  await Promise.all([
    writeFile(
      path.join(workspaceB, "unstaged-secret.js"),
      `const token = ${JSON.stringify(unstagedValue)};\n`,
      "utf8"
    ),
    writeFile(path.join(workspaceB, "untracked-secret.pem"), `${privateKeyMarker}\n`, "utf8")
  ]);
  const changedSnapshot = await callTool(runtime.port, sessionId, 78, "workspace_snapshot", {
    workspace_id: workspaceBId,
    max_entries: 80
  });
  assert.ok(changedSnapshot.data.git.files.length >= 3);
  assert.ok(changedSnapshot.data.git.files.every((file) =>
    file.path?.workspace_id === workspaceBId && typeof file.path?.path === "string"
  ));
  assert.equal(JSON.stringify(changedSnapshot.data).includes(workspaceB), false);
  const changedSecurity = await callTool(runtime.port, sessionId, 13, "security_scan", {
    changed_only: true,
    workspace_id: workspaceBId
  });
  assert.equal(changedSecurity.data.verdict, "FAIL");
  assert.equal(changedSecurity.data.complete, true);
  assert.equal(changedSecurity.data.ok, false);
  assert.ok(changedSecurity.data.source_counts.staged >= 1);
  assert.ok(changedSecurity.data.source_counts.unstaged >= 1);
  assert.ok(changedSecurity.data.source_counts.untracked >= 1);
  const hitPaths = new Set(changedSecurity.data.hits.map((hit) => hit.path));
  assert.ok(hitPaths.has("staged-secret.json"), "security_scan must inspect staged content");
  assert.ok(hitPaths.has("unstaged-secret.js"), "security_scan must inspect unstaged content");
  assert.ok(hitPaths.has("untracked-secret.pem"), "security_scan must inspect untracked content");
  assert.equal(JSON.stringify(changedSecurity.data).includes(stagedValue), false, "security result must not echo secret values");
  assert.equal(JSON.stringify(changedSecurity.data).includes(unstagedValue), false, "security result must not echo secret values");
  const impactedTestPlan = await callTool(runtime.port, sessionId, 72, "run_changed_tests", {
    workspace_id: workspaceBId,
    dry_run: true
  });
  assert.equal(impactedTestPlan.data.status, "DRY_RUN");
  assert.equal(impactedTestPlan.data.strategy, "package_impacted_tests");
  assert.ok(
    impactedTestPlan.data.test_files.some((location) => location.path === "src/math.test.js"),
    "impacted-test planning must return workspace-qualified tests"
  );
  assert.ok(impactedTestPlan.data.plan.changes.summary.staged >= 1);
  assert.ok(impactedTestPlan.data.plan.changes.summary.unstaged >= 1);
  assert.ok(impactedTestPlan.data.plan.changes.summary.untracked >= 1);
  const resumedAfterChanges = await callTool(runtime.port, sessionId, 76, "task_open", {
    task_token: opened.data.task.task_token
  });
  assert.equal(resumedAfterChanges.data.resumed, true);
  assert.deepEqual(
    resumedAfterChanges.data.task.workspace_state[0],
    openedBaseline,
    "task resume must preserve the original HEAD/dirty baseline"
  );

  const listedWorkspaces = await callTool(runtime.port, sessionId, 14, "workspace_list", {});
  const workspaceAId = listedWorkspaces.data.workspaces.find((workspace) => workspace.label === "workspace-a")?.workspace_id;
  assert.ok(workspaceAId, "startup workspace must remain registered");
  await callTool(runtime.port, sessionId, 15, "task_close", {
    task_token: opened.data.task.task_token
  });
  const multiWorkspaceTask = await callTool(runtime.port, sessionId, 16, "task_open", {
    title: "HTTP history atomicity",
    primary_workspace_id: workspaceBId,
    attached_workspace_ids: [workspaceAId]
  });
  const unavailableSecurity = await callTool(runtime.port, sessionId, 17, "security_scan", {
    changed_only: true,
    workspace_id: workspaceAId
  });
  assert.equal(unavailableSecurity.data.verdict, "INCOMPLETE");
  assert.equal(unavailableSecurity.data.complete, false);
  assert.equal(unavailableSecurity.data.ok, false);
  assert.ok(unavailableSecurity.data.incomplete_reasons.includes("git_repository_unavailable"));
  const incompleteVerification = await callTool(runtime.port, sessionId, 71, "verify_changes", {
    workspace_id: workspaceAId
  });
  assert.equal(incompleteVerification.data.status, "INCOMPLETE");
  assert.equal(incompleteVerification.data.review.verdict, "INCOMPLETE");

  const multiWorkspaceChange = await callTool(runtime.port, sessionId, 18, "apply_patch", {
    operations: [{
      workspace_id: workspaceBId,
      op: "create",
      path: "history-atomicity.txt",
      content: "must remain\n"
    }]
  });
  const taskId = multiWorkspaceTask.data.task.id;
  const historyQuery = `workspace_id=${encodeURIComponent(workspaceBId)}&task_id=${encodeURIComponent(taskId)}`;
  const historyHeaders = {
    "content-type": "application/json",
    "x-lca-instance-nonce": context.runId
  };
  const mutationRequests = [
    ["POST", `/changes/${encodeURIComponent(multiWorkspaceChange.data.change_id)}/undo?${historyQuery}`, {}],
    ["POST", `/changes/${encodeURIComponent(multiWorkspaceChange.data.change_id)}/reapply?${historyQuery}`, {}],
    ["POST", `/changes/undo-all?${historyQuery}`, {}],
    ["DELETE", `/changes?${historyQuery}`, undefined]
  ];
  for (const [method, pathname, body] of mutationRequests) {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${pathname}`, {
      method,
      headers: historyHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const data = await response.json();
    assert.equal(response.status, 409, `${method} ${pathname} must reject multi-workspace history mutation`);
    assert.equal(data.code, "CROSS_WORKSPACE_HISTORY_ATOMICITY_REQUIRED");
    assert.equal(data.task_id, taskId);
    assert.equal("workspace_ids" in data, false, "history rejection must not leak attached workspace IDs");
    assert.equal(JSON.stringify(data).includes(context.fixtureDir), false, "history rejection must not leak absolute roots");
  }
  assert.equal(existsSync(path.join(workspaceB, "history-atomicity.txt")), true);

  const unmanagedArtifact = path.join(
    context.dataDir,
    "runtime",
    "tasks",
    taskId,
    "unmanaged-changes.json"
  );
  await mkdir(path.dirname(unmanagedArtifact), { recursive: true });
  await writeFile(unmanagedArtifact, "{ corrupt unmanaged state", "utf8");
  const corruptUnmanagedVerification = await callTool(runtime.port, sessionId, 19, "verify_changes", {
    workspace_id: workspaceBId,
    dry_run: true
  });
  assert.equal(corruptUnmanagedVerification.data.status, "DRY_RUN");
  assert.equal(corruptUnmanagedVerification.data.plan.status, "INCOMPLETE");
  assert.ok(corruptUnmanagedVerification.data.plan.reasons.includes("UNMANAGED_STATE_UNKNOWN"));

  console.log(`runtime catalog tests passed (tools=${names.length}, tools/list=${listed.bytes} bytes raw/${compressedCatalogBytes} compressed, hash=${status.catalog_hash})`);
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

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${String(result.stderr || result.error?.message || "unknown error")}`
  );
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
    bytes: buffer.byteLength,
    message: parseMcpResponse(buffer.toString("utf8"), response.headers.get("content-type"))
  };
}

async function firstSseEvent(port, pathname, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  let reader;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      headers: { accept: "text/event-stream", ...headers },
      signal: controller.signal
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/event-stream/i);
    assert.ok(response.body, "SSE response must have a readable body");
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!buffer.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    }
    const boundary = buffer.indexOf("\n\n");
    assert.ok(boundary >= 0, "SSE endpoint must emit a complete event");
    const block = buffer.slice(0, boundary);
    const event = block.match(/^event:\s*(.+)$/m)?.[1] || "message";
    const dataText = block.match(/^data:\s*(.+)$/m)?.[1] || "{}";
    return { event, data: JSON.parse(dataText) };
  } finally {
    clearTimeout(timeout);
    await reader?.cancel().catch(() => {});
    controller.abort();
  }
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
