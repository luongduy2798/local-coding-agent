// Local Coding Agent Review Changes integration tests
// SPDX-License-Identifier: AGPL-3.0-or-later

import { chmod, readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createIsolatedTestRoot, safeRemove } from "../helpers/test-guard.mjs";
import { startTestServer, stopTestProcess } from "../helpers/test-runtime.mjs";

let pass = 0;
let fail = 0;

function check(name, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`[PASS] ${name}`);
  } else {
    fail++;
    console.error(`[FAIL] ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

async function callRaw(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text || "";
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { result, text, data, isError: Boolean(result.isError) };
}

async function callJson(client, name, args = {}) {
  const response = await callRaw(client, name, args);
  if (response.isError) throw new Error(`${name}: ${response.text}`);
  return response.data;
}

function createOperation(args) {
  return {
    op: "create",
    path: args.path,
    content: args.content,
    ...(args.expected_version ? { expected_version: args.expected_version } : {})
  };
}

function updateOperation(args) {
  return {
    op: "update",
    path: args.path,
    edits: [{ old_text: args.old_text, new_text: args.new_text }],
    ...(args.expected_version ? { expected_version: args.expected_version } : {})
  };
}

async function createTrackedFile(client, args) {
  return callJson(client, "apply_patch", { operations: [createOperation(args)] });
}

async function createTrackedFileRaw(client, args) {
  return callRaw(client, "apply_patch", { operations: [createOperation(args)] });
}

async function updateTrackedFile(client, args) {
  return callJson(client, "apply_patch", { operations: [updateOperation(args)] });
}

async function updateTrackedFileRaw(client, args) {
  return callRaw(client, "apply_patch", { operations: [updateOperation(args)] });
}

async function renameTrackedPath(client, args) {
  return callJson(client, "apply_patch", {
    operations: [{ op: "rename", path: args.from, rename_to: args.to }]
  });
}

async function deleteTrackedPath(client, args) {
  return callJson(client, "apply_patch", {
    operations: [{
      op: "delete",
      path: args.path,
      ...(args.recursive ? { recursive: true } : {}),
      ...(args.expected_version ? { expected_version: args.expected_version } : {})
    }]
  });
}

async function api(port, method, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  return { status: response.status, data };
}

const context = await createIsolatedTestRoot({
  prefix: "lca-change-journal-",
  protectedPaths: [path.resolve("..")]
});
const workspace = context.fixtureDir;
const runtime = await startTestServer({
  workspace,
  dataDir: context.dataDir,
  runId: context.runId,
  env: { AGENT_MAX_SNAPSHOT_BYTES: "128" }
});
const client = new Client({ name: "change-journal-test", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${runtime.port}/mcp`)));

try {
  const workspaceList = await callJson(client, "workspace_list", {});
  await callJson(client, "task_open", {
    title: "Review Changes integration",
    primary_workspace_id: workspaceList.selected_workspace_id
  });
  const created = await createTrackedFile(client, { path: "create.txt", content: "created\n" });
  check("apply_patch create returns a change id", /^change_/.test(created.change_id || ""), JSON.stringify(created));
  check("apply_patch create writes the file", existsSync(path.join(workspace, "create.txt")));
  const initialJournalPaths = await listTreePaths(context.dataDir);
  const initialJournalText = await readTreeText(context.dataDir);
  check(
    "journal snapshots use compressed content-addressed blobs",
    initialJournalPaths.some((entry) => /\/blobs\/[a-f0-9]{2}\/[a-f0-9]{64}\.br$/.test(entry))
      && !initialJournalText.includes(Buffer.from("created\n").toString("base64")),
    JSON.stringify(initialJournalPaths)
  );
  const createRecord = await api(runtime.port, "GET", `/changes/${created.change_id}`);
  check("create change record is available", createRecord.status === 200 && createRecord.data.change.files[0]?.operation === "created", JSON.stringify(createRecord.data));
  await api(runtime.port, "POST", `/changes/${created.change_id}/undo`, {});
  check("undo removes a newly created file", !existsSync(path.join(workspace, "create.txt")));
  await api(runtime.port, "POST", `/changes/${created.change_id}/reapply`, {});
  check("reapply recreates a newly created file", existsSync(path.join(workspace, "create.txt")));

  await writeFile(path.join(workspace, "executable.sh"), "#!/bin/sh\necho before\n", "utf8");
  await chmod(path.join(workspace, "executable.sh"), 0o755);
  await callJson(client, "read_file", { path: "executable.sh" });
  const executableChange = await updateTrackedFile(client, {
    path: "executable.sh",
    old_text: "before",
    new_text: "after"
  });
  await api(runtime.port, "POST", `/changes/${executableChange.change_id}/undo`, {});
  const restoredMode = (await stat(path.join(workspace, "executable.sh"))).mode & 0o777;
  check(
    "journal restore preserves executable file mode",
    restoredMode === 0o755,
    restoredMode.toString(8)
  );

  await createTrackedFile(client, { path: "replace.txt", content: "alpha\n" });
  const firstRead = await callJson(client, "read_file", { path: "replace.txt" });
  check("read_file returns a SHA-256 version", /^[a-f0-9]{64}$/.test(firstRead.version || ""), JSON.stringify(firstRead));
  const replaced = await updateTrackedFile(client, { path: "replace.txt", old_text: "alpha", new_text: "beta" });
  check("apply_patch update is tracked", /^change_/.test(replaced.change_id || ""), JSON.stringify(replaced));
  const secondReplace = await updateTrackedFile(client, { path: "replace.txt", old_text: "beta", new_text: "gamma" });
  check("successful mutation updates known version", /^change_/.test(secondReplace.change_id || ""));

  const beforeFailedMutation = await api(runtime.port, "GET", "/changes?limit=200");
  const failedMutation = await updateTrackedFileRaw(client, { path: "replace.txt", old_text: "not-present", new_text: "never-written" });
  const afterFailedMutation = await api(runtime.port, "GET", "/changes?limit=200");
  check("failed mutation does not create a successful change record", failedMutation.isError && beforeFailedMutation.data.count === afterFailedMutation.data.count && /gamma/.test(await readFile(path.join(workspace, "replace.txt"), "utf8")), failedMutation.text);

  await writeFile(path.join(workspace, "replace.txt"), "external\n", "utf8");
  const stale = await updateTrackedFileRaw(client, { path: "replace.txt", old_text: "gamma", new_text: "delta" });
  check("external edit triggers STALE_FILE", stale.isError && stale.data?.code === "STALE_FILE", stale.text);
  check("stale mutation does not overwrite external content", (await readFile(path.join(workspace, "replace.txt"), "utf8")) === "external\n");

  await callJson(client, "read_file", { path: "replace.txt" });
  const externalChange = await updateTrackedFile(client, { path: "replace.txt", old_text: "external", new_text: "tracked" });
  const undoExternal = await api(runtime.port, "POST", `/changes/${externalChange.change_id}/undo`, {});
  check("HTTP undo succeeds", undoExternal.status === 200 && /external/.test(await readFile(path.join(workspace, "replace.txt"), "utf8")), JSON.stringify(undoExternal.data));
  const staleAfterUndo = await updateTrackedFileRaw(client, { path: "replace.txt", old_text: "external", new_text: "again" });
  check("HTTP undo deliberately makes the cached read version stale", staleAfterUndo.isError && staleAfterUndo.data?.code === "STALE_FILE", staleAfterUndo.text);
  await callJson(client, "read_file", { path: "replace.txt" });
  const reapplyExternal = await api(runtime.port, "POST", `/changes/${externalChange.change_id}/reapply`, {});
  check("HTTP reapply succeeds", reapplyExternal.status === 200 && /tracked/.test(await readFile(path.join(workspace, "replace.txt"), "utf8")), JSON.stringify(reapplyExternal.data));

  await createTrackedFile(client, { path: "rename-source.txt", content: "rename\n" });
  const moved = await renameTrackedPath(client, { from: "rename-source.txt", to: "rename-target.txt" });
  check("apply_patch rename creates one atomic change", /^change_/.test(moved.change_id || "") && !existsSync(path.join(workspace, "rename-source.txt")) && existsSync(path.join(workspace, "rename-target.txt")));
  const undoMove = await api(runtime.port, "POST", `/changes/${moved.change_id}/undo`, { paths: ["rename-source.txt"] });
  check("partial rename undo expands to the atomic group", undoMove.status === 200 && existsSync(path.join(workspace, "rename-source.txt")) && !existsSync(path.join(workspace, "rename-target.txt")), JSON.stringify(undoMove.data));
  await api(runtime.port, "POST", `/changes/${moved.change_id}/reapply`, {});
  check("rename reapply restores destination", !existsSync(path.join(workspace, "rename-source.txt")) && existsSync(path.join(workspace, "rename-target.txt")));

  await mkdir(path.join(workspace, "rename-directory", "nested"), { recursive: true });
  await writeFile(path.join(workspace, "rename-directory", "nested", "file.txt"), "directory rename\n", "utf8");
  const movedDirectory = await renameTrackedPath(client, { from: "rename-directory", to: "renamed-directory" });
  const movedDirectoryRecord = await api(runtime.port, "GET", `/changes/${movedDirectory.change_id}`);
  check("directory rename is atomic and undoable without tree snapshots", movedDirectoryRecord.data.change.files.every((file) => file.undoable === true) && existsSync(path.join(workspace, "renamed-directory", "nested", "file.txt")), JSON.stringify(movedDirectoryRecord.data));
  await api(runtime.port, "POST", `/changes/${movedDirectory.change_id}/undo`, {});
  check("directory rename undo restores the source tree", existsSync(path.join(workspace, "rename-directory", "nested", "file.txt")) && !existsSync(path.join(workspace, "renamed-directory")));
  await api(runtime.port, "POST", `/changes/${movedDirectory.change_id}/reapply`, {});
  check("directory rename reapply restores the destination tree", !existsSync(path.join(workspace, "rename-directory")) && existsSync(path.join(workspace, "renamed-directory", "nested", "file.txt")));

  await createTrackedFile(client, { path: "multi-a.txt", content: "a1\n" });
  await createTrackedFile(client, { path: "multi-b.txt", content: "b1\n" });
  const multi = await callJson(client, "apply_patch", {
    operations: [
      { op: "update", path: "multi-a.txt", edits: [{ old_text: "a1", new_text: "a2" }] },
      { op: "update", path: "multi-b.txt", edits: [{ old_text: "b1", new_text: "b2" }] }
    ]
  });
  const partial = await api(runtime.port, "POST", `/changes/${multi.change_id}/undo`, { paths: ["multi-a.txt"] });
  check("partial undo changes record status", partial.status === 200 && partial.data.change.status === "partially_undone", JSON.stringify(partial.data));
  check("partial undo restores only the selected path", /a1/.test(await readFile(path.join(workspace, "multi-a.txt"), "utf8")) && /b2/.test(await readFile(path.join(workspace, "multi-b.txt"), "utf8")));

  await createTrackedFile(client, { path: "prevalidate-a.txt", content: "a1\n" });
  await createTrackedFile(client, { path: "prevalidate-b.txt", content: "b1\n" });
  const beforeInvalidPatch = await api(runtime.port, "GET", "/changes?limit=200");
  const invalidPatch = await callRaw(client, "apply_patch", {
    operations: [
      { op: "update", path: "prevalidate-a.txt", edits: [{ old_text: "a1", new_text: "a2" }] },
      { op: "update", path: "prevalidate-b.txt", edits: [{ old_text: "missing", new_text: "b2" }] }
    ]
  });
  const afterInvalidPatch = await api(runtime.port, "GET", "/changes?limit=200");
  check("multi-file patch prevalidation prevents partial mutation", invalidPatch.isError && beforeInvalidPatch.data.count === afterInvalidPatch.data.count && /a1/.test(await readFile(path.join(workspace, "prevalidate-a.txt"), "utf8")) && /b1/.test(await readFile(path.join(workspace, "prevalidate-b.txt"), "utf8")), invalidPatch.text);

  const conflictChange = await createTrackedFile(client, { path: "conflict.txt", content: "after\n" });
  await writeFile(path.join(workspace, "conflict.txt"), "outside\n", "utf8");
  const conflict = await api(runtime.port, "POST", `/changes/${conflictChange.change_id}/undo`, {});
  check("undo conflict returns 409 without changing filesystem", conflict.status === 409 && conflict.data.filesystemChanged === false && /outside/.test(await readFile(path.join(workspace, "conflict.txt"), "utf8")), JSON.stringify(conflict.data));

  await createTrackedFile(client, { path: "deleted-version.txt", content: "read then delete\n" });
  const deletedVersionRead = await callJson(client, "read_file", { path: "deleted-version.txt" });
  await deleteTrackedPath(client, {
    path: "deleted-version.txt",
    expected_version: deletedVersionRead.version
  });
  await writeFile(path.join(workspace, "deleted-version.txt"), "recreated outside\n", "utf8");
  const staleRecreated = await createTrackedFileRaw(client, {
    path: "deleted-version.txt",
    content: "must not overwrite\n",
    expected_version: "missing"
  });
  check("known missing version detects a file recreated after delete", staleRecreated.isError && staleRecreated.data?.code === "STALE_FILE" && /recreated outside/.test(await readFile(path.join(workspace, "deleted-version.txt"), "utf8")), staleRecreated.text);

  const largeContent = `prefix-${"x".repeat(512)}-suffix`;
  const large = await createTrackedFile(client, { path: "large.txt", content: largeContent });
  const largeRecord = await api(runtime.port, "GET", `/changes/${large.change_id}`);
  check("large file is metadata-only and not undoable", largeRecord.data.change.files[0]?.after?.reason === "snapshot_limit" && largeRecord.data.change.files[0]?.undoable === false, JSON.stringify(largeRecord.data));
  const largeReplace = await updateTrackedFile(client, { path: "large.txt", old_text: "prefix", new_text: "updated" });
  const largeReplaceRecord = await api(runtime.port, "GET", `/changes/${largeReplace.change_id}`);
  check("large text remains editable without pretending it is undoable", /updated-/.test(await readFile(path.join(workspace, "large.txt"), "utf8")) && largeReplaceRecord.data.change.files[0]?.undoable === false, JSON.stringify(largeReplaceRecord.data));

  await mkdir(path.join(workspace, "directory", "nested"), { recursive: true });
  await writeFile(path.join(workspace, "directory", "nested", "file.txt"), "dir\n", "utf8");
  const deletedDirectory = await deleteTrackedPath(client, { path: "directory", recursive: true });
  const directoryRecord = await api(runtime.port, "GET", `/changes/${deletedDirectory.change_id}`);
  check("recursive directory delete is metadata-only", directoryRecord.data.change.files[0]?.before?.type === "directory" && directoryRecord.data.change.files[0]?.undoable === false, JSON.stringify(directoryRecord.data));

  const diff = await api(runtime.port, "GET", `/changes/${multi.change_id}/diff?path=multi-b.txt`);
  check("diff API supports path filtering", diff.status === 200 && diff.data.diff.includes("multi-b.txt") && !diff.data.diff.includes("multi-a.txt"), JSON.stringify(diff.data));

  const many = await callJson(client, "read_many", { paths: ["multi-a.txt", "multi-b.txt"] });
  check("read_many returns a version for every successful file", many.files.every((file) => /^[a-f0-9]{64}$/.test(file.version || "")), JSON.stringify(many.files));

  const concurrent = await Promise.all([
    createTrackedFile(client, { path: "concurrent-a.txt", content: "a\n" }),
    createTrackedFile(client, { path: "concurrent-b.txt", content: "b\n" }),
    createTrackedFile(client, { path: "concurrent-c.txt", content: "c\n" })
  ]);
  const listed = await api(runtime.port, "GET", "/changes?limit=200");
  const concurrentTask = listed.data.changes.find((change) => change.id === concurrent[0].task_id);
  check(
    "serialized writes retain concurrent operations in one task change set",
    concurrent.every((item) => item.task_id === concurrent[0].task_id && concurrentTask?.operationIds?.includes(item.change_id))
      && concurrentTask?.operationCount >= concurrent.length,
    JSON.stringify({ concurrent, concurrentTask })
  );

  const unknown = await api(runtime.port, "GET", "/changes/change_missing");
  check("unknown change id returns 404", unknown.status === 404 && unknown.data.code === "change_not_found", JSON.stringify(unknown.data));

  await writeFile(path.join(workspace, "binary.bin"), Buffer.from([0, 1, 2, 3, 255]));
  const binaryDelete = await deleteTrackedPath(client, { path: "binary.bin" });
  const binaryRecord = await api(runtime.port, "GET", `/changes/${binaryDelete.change_id}`);
  check("binary files are tracked as metadata-only", binaryRecord.data.change.files[0]?.before?.reason === "binary_file" && binaryRecord.data.change.files[0]?.undoable === false, JSON.stringify(binaryRecord.data));

  await createTrackedFile(client, { path: "reapply-conflict.txt", content: "before\n" });
  const reapplyChange = await updateTrackedFile(client, { path: "reapply-conflict.txt", old_text: "before", new_text: "after" });
  await api(runtime.port, "POST", `/changes/${reapplyChange.change_id}/undo`, {});
  await writeFile(path.join(workspace, "reapply-conflict.txt"), "outside\n", "utf8");
  const reapplyConflict = await api(runtime.port, "POST", `/changes/${reapplyChange.change_id}/reapply`, {});
  check("reapply conflict returns 409 without overwriting", reapplyConflict.status === 409 && reapplyConflict.data.filesystemChanged === false && /outside/.test(await readFile(path.join(workspace, "reapply-conflict.txt"), "utf8")), JSON.stringify(reapplyConflict.data));

  const sentinel = `JOURNAL_SECRET_${Date.now()}`;
  await callJson(client, "run_command", { command: `node -e "console.log('${sentinel}')"` });
  const journalText = await readTreeText(context.dataDir);
  check("command activity history omits command text, output and secrets", !journalText.includes(sentinel), "sentinel appeared in change-history data");

  await api(runtime.port, "DELETE", "/changes");
  await createTrackedFile(client, { path: "undo-all-conflict-a.txt", content: "a\n" });
  await createTrackedFile(client, { path: "undo-all-conflict-b.txt", content: "b\n" });
  await writeFile(path.join(workspace, "undo-all-conflict-a.txt"), "outside\n", "utf8");
  const undoAllConflict = await api(runtime.port, "POST", "/changes/undo-all", {});
  check("undo-all conflict performs no partial filesystem change", undoAllConflict.status === 409 && /outside/.test(await readFile(path.join(workspace, "undo-all-conflict-a.txt"), "utf8")) && existsSync(path.join(workspace, "undo-all-conflict-b.txt")), JSON.stringify(undoAllConflict.data));

  await api(runtime.port, "DELETE", "/changes");
  await createTrackedFile(client, { path: "undo-all-a.txt", content: "one\n" });
  await updateTrackedFile(client, { path: "undo-all-a.txt", old_text: "one", new_text: "two" });
  await createTrackedFile(client, { path: "undo-all-b.txt", content: "b\n" });
  const undoAll = await api(runtime.port, "POST", "/changes/undo-all", {});
  check("undo-all preflights projected state and undoes newest to oldest", undoAll.status === 200 && !existsSync(path.join(workspace, "undo-all-a.txt")) && !existsSync(path.join(workspace, "undo-all-b.txt")), JSON.stringify(undoAll.data));

  const beforeClear = await api(runtime.port, "GET", "/changes?limit=200");
  const clear = await api(runtime.port, "DELETE", "/changes");
  const afterClear = await api(runtime.port, "GET", "/changes?limit=200");
  check("clear deletes change records but preserves workspace", clear.status === 200 && clear.data.deleted === beforeClear.data.count && afterClear.data.count === 0 && existsSync(path.join(workspace, "multi-b.txt")), JSON.stringify({ clear: clear.data, after: afterClear.data }));

  await callJson(client, "task_close", {
    task_token: multi.task_token,
    status: "incomplete"
  });
  await writeFile(path.join(workspace, "task-source.txt"), "original\n", "utf8");
  const openedRenameTask = await callJson(client, "task_open", {
    title: "Rename and refine the task file"
  });
  await callJson(client, "task_plan", {
    goal: "Rename and refine the task file",
    steps: ["Rename the file", "Update its content"]
  });
  const taskRename = await callJson(client, "apply_patch", {
    operations: [{ op: "rename", path: "task-source.txt", rename_to: "task-target.txt" }]
  });
  const taskEdit = await callJson(client, "apply_patch", {
    operations: [{ op: "update", path: "task-target.txt", edits: [{ old_text: "original", new_text: "final" }] }]
  });
  const activeTaskList = await api(runtime.port, "GET", "/changes?limit=10");
  const activeTask = activeTaskList.data.changes[0];
  check(
    "multiple patches from one user task produce one active Review Changes card",
    activeTaskList.data.count === 1
      && taskRename.task_id === taskEdit.task_id
      && activeTask.id === taskRename.task_id
      && activeTask.taskStatus === "active"
      && activeTask.title === "Rename and refine the task file"
      && activeTask.operationCount === 2,
    JSON.stringify(activeTaskList.data)
  );
  const taskAfterContent = await api(runtime.port, "GET", `/changes/${taskRename.task_id}/content?path=task-target.txt&side=after`);
  check("task aggregate exposes the final content after all patches", taskAfterContent.status === 200 && taskAfterContent.data.content === "final\n", JSON.stringify(taskAfterContent.data));

  const taskReport = await callJson(client, "task_close", {
    task_token: openedRenameTask.task.task_token,
    status: "incomplete"
  });
  const completedTaskList = await api(runtime.port, "GET", "/changes?limit=10");
  const completedTask = completedTaskList.data.changes[0];
  check(
    "task_close closes the active task change set",
    taskReport.review_changes_tasks?.[0]?.task?.id === taskRename.task_id
      && completedTask.taskStatus === "completed"
      && completedTask.operationCount === 2,
    JSON.stringify({ taskReport, completedTask })
  );

  const undoTask = await api(runtime.port, "POST", `/changes/${taskRename.task_id}/undo`, {});
  check(
    "task undo replays operations newest to oldest across rename plus edit",
    undoTask.status === 200
      && existsSync(path.join(workspace, "task-source.txt"))
      && !existsSync(path.join(workspace, "task-target.txt"))
      && (await readFile(path.join(workspace, "task-source.txt"), "utf8")) === "original\n",
    JSON.stringify(undoTask.data)
  );
  const reapplyTask = await api(runtime.port, "POST", `/changes/${taskRename.task_id}/reapply`, {});
  check(
    "task reapply replays operations oldest to newest and restores final content",
    reapplyTask.status === 200
      && !existsSync(path.join(workspace, "task-source.txt"))
      && (await readFile(path.join(workspace, "task-target.txt"), "utf8")) === "final\n",
    JSON.stringify(reapplyTask.data)
  );

  const nextTask = await callJson(client, "apply_patch", {
    operations: [{ op: "create", path: "next-task.txt", content: "next\n" }]
  });
  const nextTaskList = await api(runtime.port, "GET", "/changes?limit=10");
  check(
    "the first mutation after completion starts a new Review Changes task",
    nextTask.task_id !== taskRename.task_id
      && nextTaskList.data.changes[0]?.id === nextTask.task_id
      && nextTaskList.data.changes[1]?.id === taskRename.task_id,
    JSON.stringify(nextTaskList.data)
  );
  await api(runtime.port, "DELETE", "/changes");

  const titledFirst = await callJson(client, "apply_patch", {
    task_title: "First explicit task",
    operations: [{ op: "create", path: "first-explicit-task.txt", content: "first\n" }]
  });
  await callJson(client, "task_close", {
    task_token: titledFirst.task_token,
    status: "incomplete"
  });
  const titledSecond = await callJson(client, "apply_patch", {
    task_title: "Second explicit task",
    operations: [{ op: "create", path: "second-explicit-task.txt", content: "second\n" }]
  });
  const titledTasks = await api(runtime.port, "GET", "/changes?limit=10");
  check(
    "a closed task is followed by a separately titled task",
    titledFirst.task_id !== titledSecond.task_id
      && titledTasks.data.changes[0]?.id === titledSecond.task_id
      && titledTasks.data.changes[0]?.title === "Second explicit task"
      && titledTasks.data.changes[0]?.taskStatus === "active"
      && titledTasks.data.changes[1]?.id === titledFirst.task_id
      && titledTasks.data.changes[1]?.title === "First explicit task"
      && titledTasks.data.changes[1]?.taskStatus === "completed",
    JSON.stringify(titledTasks.data)
  );
  await api(runtime.port, "DELETE", "/changes");

  const authWorkspace = path.join(context.fixtureDir, "auth-workspace");
  const authDataDir = path.join(context.dataDir, "auth-runtime");
  await mkdir(authWorkspace, { recursive: true });
  const authRuntime = await startTestServer({
    workspace: authWorkspace,
    dataDir: authDataDir,
    runId: context.runId,
    env: {
      MCP_AUTH_TOKEN: "journal-test-token",
      LCA_TEST_RUNTIME_DIAGNOSTICS: "0"
    }
  });
  try {
    const denied = await fetch(`http://127.0.0.1:${authRuntime.port}/changes`);
    const bearerOnly = await fetch(`http://127.0.0.1:${authRuntime.port}/changes`, {
      headers: { authorization: "Bearer journal-test-token" }
    });
    const allowed = await fetch(`http://127.0.0.1:${authRuntime.port}/changes`, {
      headers: { "x-lca-instance-nonce": context.runId }
    });
    const allowedData = await allowed.json();
    check(
      "Changes API requires the local instance nonce and rejects tunnel bearer authority",
      denied.status === 401 && bearerOnly.status === 401 && allowed.status === 200 && allowedData.count === 0,
      JSON.stringify({ denied: denied.status, bearerOnly: bearerOnly.status, allowed: allowed.status, allowedData })
    );
  } finally {
    await stopTestProcess(authRuntime.child);
  }
} finally {
  await client.close().catch(() => {});
  await stopTestProcess(runtime.child);
  await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
  await safeRemove(context.dataDir, context, { recursive: true, force: true });
}

console.log(`\n==== REVIEW CHANGES: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);

async function readTreeText(root) {
  const chunks = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) chunks.push(await readTreeText(fullPath));
    else chunks.push(await readFile(fullPath, "utf8").catch(() => ""));
  }
  return chunks.join("\n");
}

async function listTreePaths(root, base = root) {
  const paths = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) paths.push(...await listTreePaths(fullPath, base));
    else paths.push(`/${path.relative(base, fullPath).split(path.sep).join("/")}`);
  }
  return paths;
}
