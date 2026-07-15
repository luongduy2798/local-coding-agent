// Local Coding Agent Review Changes integration tests
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createIsolatedTestRoot } from "../helpers/test-guard.mjs";
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
  const created = await callJson(client, "write_file", { path: "create.txt", content: "created\n" });
  check("write_file returns a change id", /^change_/.test(created.change_id || ""), JSON.stringify(created));
  check("write_file creates the file", existsSync(path.join(workspace, "create.txt")));
  const createRecord = await api(runtime.port, "GET", `/changes/${created.change_id}`);
  check("create change record is available", createRecord.status === 200 && createRecord.data.change.files[0]?.operation === "created", JSON.stringify(createRecord.data));
  await api(runtime.port, "POST", `/changes/${created.change_id}/undo`, {});
  check("undo removes a newly created file", !existsSync(path.join(workspace, "create.txt")));
  await api(runtime.port, "POST", `/changes/${created.change_id}/reapply`, {});
  check("reapply recreates a newly created file", existsSync(path.join(workspace, "create.txt")));

  await callJson(client, "write_file", { path: "replace.txt", content: "alpha\n" });
  const firstRead = await callJson(client, "read_file", { path: "replace.txt" });
  check("read_file returns a SHA-256 version", /^[a-f0-9]{64}$/.test(firstRead.version || ""), JSON.stringify(firstRead));
  const replaced = await callJson(client, "replace_in_file", { path: "replace.txt", old_text: "alpha", new_text: "beta" });
  check("replace_in_file is tracked", /^change_/.test(replaced.change_id || ""), JSON.stringify(replaced));
  const secondReplace = await callJson(client, "replace_in_file", { path: "replace.txt", old_text: "beta", new_text: "gamma" });
  check("successful mutation updates known version", /^change_/.test(secondReplace.change_id || ""));

  const beforeFailedMutation = await api(runtime.port, "GET", "/changes?limit=200");
  const failedMutation = await callRaw(client, "replace_in_file", { path: "replace.txt", old_text: "not-present", new_text: "never-written" });
  const afterFailedMutation = await api(runtime.port, "GET", "/changes?limit=200");
  check("failed mutation does not create a successful change record", failedMutation.isError && beforeFailedMutation.data.count === afterFailedMutation.data.count && /gamma/.test(await readFile(path.join(workspace, "replace.txt"), "utf8")), failedMutation.text);

  await writeFile(path.join(workspace, "replace.txt"), "external\n", "utf8");
  const stale = await callRaw(client, "replace_in_file", { path: "replace.txt", old_text: "gamma", new_text: "delta" });
  check("external edit triggers STALE_FILE", stale.isError && stale.data?.code === "STALE_FILE", stale.text);
  check("stale mutation does not overwrite external content", (await readFile(path.join(workspace, "replace.txt"), "utf8")) === "external\n");

  await callJson(client, "read_file", { path: "replace.txt" });
  const externalChange = await callJson(client, "replace_in_file", { path: "replace.txt", old_text: "external", new_text: "tracked" });
  const undoExternal = await api(runtime.port, "POST", `/changes/${externalChange.change_id}/undo`, {});
  check("HTTP undo succeeds", undoExternal.status === 200 && /external/.test(await readFile(path.join(workspace, "replace.txt"), "utf8")), JSON.stringify(undoExternal.data));
  const staleAfterUndo = await callRaw(client, "replace_in_file", { path: "replace.txt", old_text: "external", new_text: "again" });
  check("HTTP undo deliberately makes the cached read version stale", staleAfterUndo.isError && staleAfterUndo.data?.code === "STALE_FILE", staleAfterUndo.text);
  await callJson(client, "read_file", { path: "replace.txt" });
  const reapplyExternal = await api(runtime.port, "POST", `/changes/${externalChange.change_id}/reapply`, {});
  check("HTTP reapply succeeds", reapplyExternal.status === 200 && /tracked/.test(await readFile(path.join(workspace, "replace.txt"), "utf8")), JSON.stringify(reapplyExternal.data));

  await callJson(client, "write_file", { path: "rename-source.txt", content: "rename\n" });
  const moved = await callJson(client, "move_path", { from: "rename-source.txt", to: "rename-target.txt" });
  check("move_path creates one atomic change", /^change_/.test(moved.change_id || "") && !existsSync(path.join(workspace, "rename-source.txt")) && existsSync(path.join(workspace, "rename-target.txt")));
  const undoMove = await api(runtime.port, "POST", `/changes/${moved.change_id}/undo`, { paths: ["rename-source.txt"] });
  check("partial rename undo expands to the atomic group", undoMove.status === 200 && existsSync(path.join(workspace, "rename-source.txt")) && !existsSync(path.join(workspace, "rename-target.txt")), JSON.stringify(undoMove.data));
  await api(runtime.port, "POST", `/changes/${moved.change_id}/reapply`, {});
  check("rename reapply restores destination", !existsSync(path.join(workspace, "rename-source.txt")) && existsSync(path.join(workspace, "rename-target.txt")));

  await mkdir(path.join(workspace, "rename-directory", "nested"), { recursive: true });
  await writeFile(path.join(workspace, "rename-directory", "nested", "file.txt"), "directory rename\n", "utf8");
  const movedDirectory = await callJson(client, "move_path", { from: "rename-directory", to: "renamed-directory" });
  const movedDirectoryRecord = await api(runtime.port, "GET", `/changes/${movedDirectory.change_id}`);
  check("directory rename is atomic and undoable without tree snapshots", movedDirectoryRecord.data.change.files.every((file) => file.undoable === true) && existsSync(path.join(workspace, "renamed-directory", "nested", "file.txt")), JSON.stringify(movedDirectoryRecord.data));
  await api(runtime.port, "POST", `/changes/${movedDirectory.change_id}/undo`, {});
  check("directory rename undo restores the source tree", existsSync(path.join(workspace, "rename-directory", "nested", "file.txt")) && !existsSync(path.join(workspace, "renamed-directory")));
  await api(runtime.port, "POST", `/changes/${movedDirectory.change_id}/reapply`, {});
  check("directory rename reapply restores the destination tree", !existsSync(path.join(workspace, "rename-directory")) && existsSync(path.join(workspace, "renamed-directory", "nested", "file.txt")));

  await callJson(client, "write_file", { path: "multi-a.txt", content: "a1\n" });
  await callJson(client, "write_file", { path: "multi-b.txt", content: "b1\n" });
  const multi = await callJson(client, "apply_patch", {
    operations: [
      { op: "update", path: "multi-a.txt", edits: [{ old_text: "a1", new_text: "a2" }] },
      { op: "update", path: "multi-b.txt", edits: [{ old_text: "b1", new_text: "b2" }] }
    ]
  });
  const partial = await api(runtime.port, "POST", `/changes/${multi.change_id}/undo`, { paths: ["multi-a.txt"] });
  check("partial undo changes record status", partial.status === 200 && partial.data.change.status === "partially_undone", JSON.stringify(partial.data));
  check("partial undo restores only the selected path", /a1/.test(await readFile(path.join(workspace, "multi-a.txt"), "utf8")) && /b2/.test(await readFile(path.join(workspace, "multi-b.txt"), "utf8")));

  await callJson(client, "write_file", { path: "prevalidate-a.txt", content: "a1\n" });
  await callJson(client, "write_file", { path: "prevalidate-b.txt", content: "b1\n" });
  const beforeInvalidPatch = await api(runtime.port, "GET", "/changes?limit=200");
  const invalidPatch = await callRaw(client, "apply_patch", {
    operations: [
      { op: "update", path: "prevalidate-a.txt", edits: [{ old_text: "a1", new_text: "a2" }] },
      { op: "update", path: "prevalidate-b.txt", edits: [{ old_text: "missing", new_text: "b2" }] }
    ]
  });
  const afterInvalidPatch = await api(runtime.port, "GET", "/changes?limit=200");
  check("multi-file patch prevalidation prevents partial mutation", invalidPatch.isError && beforeInvalidPatch.data.count === afterInvalidPatch.data.count && /a1/.test(await readFile(path.join(workspace, "prevalidate-a.txt"), "utf8")) && /b1/.test(await readFile(path.join(workspace, "prevalidate-b.txt"), "utf8")), invalidPatch.text);

  const conflictChange = await callJson(client, "write_file", { path: "conflict.txt", content: "after\n" });
  await writeFile(path.join(workspace, "conflict.txt"), "outside\n", "utf8");
  const conflict = await api(runtime.port, "POST", `/changes/${conflictChange.change_id}/undo`, {});
  check("undo conflict returns 409 without changing filesystem", conflict.status === 409 && conflict.data.filesystemChanged === false && /outside/.test(await readFile(path.join(workspace, "conflict.txt"), "utf8")), JSON.stringify(conflict.data));

  await callJson(client, "write_file", { path: "deleted-version.txt", content: "read then delete\n" });
  await callJson(client, "read_file", { path: "deleted-version.txt" });
  await callJson(client, "delete_path", { path: "deleted-version.txt" });
  await writeFile(path.join(workspace, "deleted-version.txt"), "recreated outside\n", "utf8");
  const staleRecreated = await callRaw(client, "write_file", { path: "deleted-version.txt", content: "must not overwrite\n" });
  check("known missing version detects a file recreated after delete", staleRecreated.isError && staleRecreated.data?.code === "STALE_FILE" && /recreated outside/.test(await readFile(path.join(workspace, "deleted-version.txt"), "utf8")), staleRecreated.text);

  const largeContent = `prefix-${"x".repeat(512)}-suffix`;
  const large = await callJson(client, "write_file", { path: "large.txt", content: largeContent });
  const largeRecord = await api(runtime.port, "GET", `/changes/${large.change_id}`);
  check("large file is metadata-only and not undoable", largeRecord.data.change.files[0]?.after?.reason === "snapshot_limit" && largeRecord.data.change.files[0]?.undoable === false, JSON.stringify(largeRecord.data));
  const largeReplace = await callJson(client, "replace_in_file", { path: "large.txt", old_text: "prefix", new_text: "updated" });
  const largeReplaceRecord = await api(runtime.port, "GET", `/changes/${largeReplace.change_id}`);
  check("large text remains editable without pretending it is undoable", /updated-/.test(await readFile(path.join(workspace, "large.txt"), "utf8")) && largeReplaceRecord.data.change.files[0]?.undoable === false, JSON.stringify(largeReplaceRecord.data));

  await mkdir(path.join(workspace, "directory", "nested"), { recursive: true });
  await writeFile(path.join(workspace, "directory", "nested", "file.txt"), "dir\n", "utf8");
  const deletedDirectory = await callJson(client, "delete_path", { path: "directory", recursive: true });
  const directoryRecord = await api(runtime.port, "GET", `/changes/${deletedDirectory.change_id}`);
  check("recursive directory delete is metadata-only", directoryRecord.data.change.files[0]?.before?.type === "directory" && directoryRecord.data.change.files[0]?.undoable === false, JSON.stringify(directoryRecord.data));

  const diff = await api(runtime.port, "GET", `/changes/${multi.change_id}/diff?path=multi-b.txt`);
  check("diff API supports path filtering", diff.status === 200 && diff.data.diff.includes("multi-b.txt") && !diff.data.diff.includes("multi-a.txt"), JSON.stringify(diff.data));

  const many = await callJson(client, "read_many", { paths: ["multi-a.txt", "multi-b.txt"] });
  check("read_many returns a version for every successful file", many.files.every((file) => /^[a-f0-9]{64}$/.test(file.version || "")), JSON.stringify(many.files));

  const concurrent = await Promise.all([
    callJson(client, "write_file", { path: "concurrent-a.txt", content: "a\n" }),
    callJson(client, "write_file", { path: "concurrent-b.txt", content: "b\n" }),
    callJson(client, "write_file", { path: "concurrent-c.txt", content: "c\n" })
  ]);
  const listed = await api(runtime.port, "GET", "/changes?limit=200");
  check("serialized writes retain concurrent records", concurrent.every((item) => listed.data.changes.some((change) => change.id === item.change_id)), JSON.stringify(concurrent));

  const unknown = await api(runtime.port, "GET", "/changes/change_missing");
  check("unknown change id returns 404", unknown.status === 404 && unknown.data.code === "change_not_found", JSON.stringify(unknown.data));

  await writeFile(path.join(workspace, "binary.bin"), Buffer.from([0, 1, 2, 3, 255]));
  const binaryDelete = await callJson(client, "delete_path", { path: "binary.bin" });
  const binaryRecord = await api(runtime.port, "GET", `/changes/${binaryDelete.change_id}`);
  check("binary files are tracked as metadata-only", binaryRecord.data.change.files[0]?.before?.reason === "binary_file" && binaryRecord.data.change.files[0]?.undoable === false, JSON.stringify(binaryRecord.data));

  await callJson(client, "write_file", { path: "reapply-conflict.txt", content: "before\n" });
  const reapplyChange = await callJson(client, "replace_in_file", { path: "reapply-conflict.txt", old_text: "before", new_text: "after" });
  await api(runtime.port, "POST", `/changes/${reapplyChange.change_id}/undo`, {});
  await writeFile(path.join(workspace, "reapply-conflict.txt"), "outside\n", "utf8");
  const reapplyConflict = await api(runtime.port, "POST", `/changes/${reapplyChange.change_id}/reapply`, {});
  check("reapply conflict returns 409 without overwriting", reapplyConflict.status === 409 && reapplyConflict.data.filesystemChanged === false && /outside/.test(await readFile(path.join(workspace, "reapply-conflict.txt"), "utf8")), JSON.stringify(reapplyConflict.data));

  const sentinel = `JOURNAL_SECRET_${Date.now()}`;
  await callJson(client, "run_command", { command: `node -e "console.log('${sentinel}')"` });
  const journalText = await readTreeText(context.dataDir);
  check("command activity history omits command text, output and secrets", !journalText.includes(sentinel), "sentinel appeared in change-history data");

  await api(runtime.port, "DELETE", "/changes");
  await callJson(client, "write_file", { path: "undo-all-conflict-a.txt", content: "a\n" });
  await callJson(client, "write_file", { path: "undo-all-conflict-b.txt", content: "b\n" });
  await writeFile(path.join(workspace, "undo-all-conflict-a.txt"), "outside\n", "utf8");
  const undoAllConflict = await api(runtime.port, "POST", "/changes/undo-all", {});
  check("undo-all conflict performs no partial filesystem change", undoAllConflict.status === 409 && /outside/.test(await readFile(path.join(workspace, "undo-all-conflict-a.txt"), "utf8")) && existsSync(path.join(workspace, "undo-all-conflict-b.txt")), JSON.stringify(undoAllConflict.data));

  await api(runtime.port, "DELETE", "/changes");
  await callJson(client, "write_file", { path: "undo-all-a.txt", content: "one\n" });
  await callJson(client, "replace_in_file", { path: "undo-all-a.txt", old_text: "one", new_text: "two" });
  await callJson(client, "write_file", { path: "undo-all-b.txt", content: "b\n" });
  const undoAll = await api(runtime.port, "POST", "/changes/undo-all", {});
  check("undo-all preflights projected state and undoes newest to oldest", undoAll.status === 200 && !existsSync(path.join(workspace, "undo-all-a.txt")) && !existsSync(path.join(workspace, "undo-all-b.txt")), JSON.stringify(undoAll.data));

  const beforeClear = await api(runtime.port, "GET", "/changes?limit=200");
  const clear = await api(runtime.port, "DELETE", "/changes");
  const afterClear = await api(runtime.port, "GET", "/changes?limit=200");
  check("clear deletes change records but preserves workspace", clear.status === 200 && clear.data.deleted === beforeClear.data.count && afterClear.data.count === 0 && existsSync(path.join(workspace, "multi-b.txt")), JSON.stringify({ clear: clear.data, after: afterClear.data }));

  const authWorkspace = path.join(context.repoDir, "auth-workspace");
  const authDataDir = path.join(context.dataDir, "auth-runtime");
  await mkdir(authWorkspace, { recursive: true });
  const authRuntime = await startTestServer({
    workspace: authWorkspace,
    dataDir: authDataDir,
    runId: context.runId,
    env: { MCP_AUTH_TOKEN: "journal-test-token" }
  });
  try {
    const denied = await fetch(`http://127.0.0.1:${authRuntime.port}/changes`);
    const allowed = await fetch(`http://127.0.0.1:${authRuntime.port}/changes`, {
      headers: { authorization: "Bearer journal-test-token" }
    });
    const allowedData = await allowed.json();
    check("Changes API uses the same bearer authentication and workspace isolation", denied.status === 401 && allowed.status === 200 && allowedData.count === 0, JSON.stringify({ denied: denied.status, allowed: allowed.status, allowedData }));
  } finally {
    await stopTestProcess(authRuntime.child);
  }
} finally {
  await client.close().catch(() => {});
  await stopTestProcess(runtime.child);
}

console.log(`\n==== REVIEW CHANGES: ${pass} passed, ${fail} failed ====`);
console.log(`Fixture retained for inspection: ${context.testRoot}`);
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
