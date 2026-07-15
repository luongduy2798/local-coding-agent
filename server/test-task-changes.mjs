// Local Coding Agent task change-set regression tests
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SERVER = path.resolve("server.mjs");
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port, stderrRef) {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error(`Server did not become ready.\n${stderrRef.value}`);
}

async function startServer(workspace) {
  const port = await getFreePort();
  const stderrRef = { value: "" };
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      PORT: String(port),
      AGENT_WORKSPACE: workspace,
      AGENT_MODE: "full",
      AGENT_POLICY: "full",
      AGENT_EXTRA_ROOTS_JSON: "[]",
      MCP_AUTH_TOKEN: "",
      AGENT_AUDIT: "0"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stderr.on("data", (chunk) => {
    stderrRef.value += chunk;
  });
  await waitForHealth(port, stderrRef);
  return { child, port };
}

async function stopServer(child) {
  if (!child?.pid) return;
  child.kill("SIGTERM");
  await wait(250);
}

async function connect(port) {
  const client = new Client({ name: "task-change-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  return client;
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content?.[0]?.text || `${name} failed`);
  if (result.structuredContent) return result.structuredContent;
  return JSON.parse(result.content?.[0]?.text || "{}");
}

const workspace = await mkdtemp(path.join(os.tmpdir(), "lca-task-change-"));
let server;
let client;
try {
  await mkdir(path.join(workspace, "src"), { recursive: true });
  git(["init"], workspace);
  git(["config", "user.email", "test@example.com"], workspace);
  git(["config", "user.name", "Test User"], workspace);
  await writeFile(path.join(workspace, "src", "feature.js"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(workspace, "preexisting.txt"), "base\n", "utf8");
  git(["add", "."], workspace);
  git(["commit", "-m", "initial"], workspace);

  await writeFile(path.join(workspace, "preexisting.txt"), "dirty before task\n", "utf8");
  await writeFile(path.join(workspace, "staged-before.txt"), "staged before task\n", "utf8");
  git(["add", "staged-before.txt"], workspace);

  server = await startServer(workspace);
  client = await connect(server.port);

  const tools = await client.listTools();
  const beginTool = tools.tools.find((tool) => tool.name === "task_begin");
  const finishTool = tools.tools.find((tool) => tool.name === "task_finish");
  const getTool = tools.tools.find((tool) => tool.name === "task_get");
  const diffTool = tools.tools.find((tool) => tool.name === "task_diff");
  const undoTool = tools.tools.find((tool) => tool.name === "task_undo");
  const reapplyTool = tools.tools.find((tool) => tool.name === "task_reapply");
  check("task tools are registered", Boolean(beginTool && finishTool && getTool && diffTool && undoTool && reapplyTool));
  check("task_begin accepts path-scoped snapshots", Boolean(beginTool?.inputSchema?.properties?.paths), JSON.stringify(beginTool?.inputSchema));
  check("task_diff is visible to app", diffTool?._meta?.ui?.visibility?.includes("app"), JSON.stringify(diffTool?._meta));
  check("task_get is visible to app", getTool?._meta?.ui?.visibility?.includes("app"), JSON.stringify(getTool?._meta));
  check("task_get owns task widget template", getTool?._meta?.["openai/outputTemplate"] === "ui://widget/lca-task-card-v4.html", JSON.stringify(getTool?._meta));
  check("task_get uses standard task widget resource URI", getTool?._meta?.ui?.resourceUri === "ui://widget/lca-task-card-v4.html", JSON.stringify(getTool?._meta));
  check("task_finish is model-only and data-only", JSON.stringify(finishTool?._meta?.ui?.visibility) === JSON.stringify(["model"]) && !finishTool?._meta?.ui?.resourceUri && !finishTool?._meta?.["openai/outputTemplate"], JSON.stringify(finishTool?._meta));
  check("task_get is the sole task widget render tool", getTool?._meta?.["openai/outputTemplate"] === "ui://widget/lca-task-card-v4.html" && getTool?._meta?.ui?.visibility?.includes("app"), JSON.stringify(getTool?._meta));
  check("task_undo is model-only and data-only", JSON.stringify(undoTool?._meta?.ui?.visibility) === JSON.stringify(["model"]) && !undoTool?._meta?.ui?.resourceUri && !undoTool?._meta?.["openai/outputTemplate"], JSON.stringify(undoTool?._meta));
  check("task_reapply is model-only and data-only", JSON.stringify(reapplyTool?._meta?.ui?.visibility) === JSON.stringify(["model"]) && !reapplyTool?._meta?.ui?.resourceUri && !reapplyTool?._meta?.["openai/outputTemplate"], JSON.stringify(reapplyTool?._meta));

  const resources = await client.listResources();
  check("task widget resource is listed", resources.resources.some((resource) => resource.uri === "ui://widget/lca-task-card-v4.html"));
  const widgetResource = await client.readResource({ uri: "ui://widget/lca-task-card-v4.html" });
  check("task widget template is preloaded and non-empty", Boolean(widgetResource.contents?.[0]?.text?.trim()));
  const widgetHtml = widgetResource.contents?.[0]?.text || "";
  check("task widget uses standard bridge", widgetHtml.includes("'ui/message'") && widgetHtml.includes("'tools/call'"));
  check("task widget never calls mutation tool directly", !/callTool\(\s*['\"]task_(undo|reapply)/.test(widgetHtml));
  check("task widget colors added and deleted diff lines", widgetHtml.includes(".diff-line.added") && widgetHtml.includes(".diff-line.deleted") && widgetHtml.includes("renderDiff(result.diff)"));
  check("task widget gives actions distinct semantic colors", widgetHtml.includes('class="button info"') && widgetHtml.includes('class="button danger"') && widgetHtml.includes('class="button success"'));
  check("task widget omits AI Review action", !widgetHtml.includes('AI Review') && !widgetHtml.includes("requestAction('review')") && !widgetHtml.includes('id="review"'));
  const widgetScript = widgetHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
  let scriptError = "";
  try {
    new Script(widgetScript);
  } catch (error) {
    scriptError = error instanceof Error ? error.message : String(error);
  }
  check("task widget script compiles", Boolean(widgetScript) && !scriptError, scriptError);

  const begun = await call(client, "task_begin", {
    title: "Change feature",
    description: "Task scoped test",
    paths: ["src/feature.js", "src/new-file.js"]
  });
  const taskId = begun.task.id;
  check("task_begin creates active task", begun.task.status === "active" && taskId.startsWith("task_"), JSON.stringify(begun));
  check("task_begin stores compact path scope", begun.task.scope?.mode === "paths" && JSON.stringify(begun.task.scope.paths) === JSON.stringify(["src/feature.js", "src/new-file.js"]), JSON.stringify(begun.task.scope));

  await call(client, "write_file", { path: "src/feature.js", content: "export const value = 2;\n" });
  await call(client, "write_file", { path: "src/new-file.js", content: "export const added = true;\n" });
  await call(client, "write_file", { path: "outside-scope.txt", content: "not part of this task\n" });

  const finished = await call(client, "task_finish", { task_id: taskId, summary: "Updated feature and added a file" });
  check("task_finish applies task", finished.task.status === "applied", JSON.stringify(finished));
  check("task_finish reports two changed files", finished.task.stats.filesChanged === 2, JSON.stringify(finished.task));
  check("pre-existing dirty file excluded", !finished.task.files.some((file) => file.path === "preexisting.txt"), JSON.stringify(finished.task.files));
  check("pre-existing staged file excluded", !finished.task.files.some((file) => file.path === "staged-before.txt"), JSON.stringify(finished.task.files));
  check("mutation outside declared path scope is excluded", !finished.task.files.some((file) => file.path === "outside-scope.txt"), JSON.stringify(finished.task.files));
  check("temporary snapshot index preserves real staging", git(["diff", "--cached", "--name-only"], workspace).trim() === "staged-before.txt");
  const taskDir = path.join(workspace, ".git", "lca", "tasks", taskId);
  let reversePatchExists = true;
  try { await access(path.join(taskDir, "reverse.patch")); } catch { reversePatchExists = false; }
  check("task stores only forward patch", reversePatchExists === false);
  check("task stores forward patch", Boolean(await readFile(path.join(taskDir, "forward.patch"), "utf8")));
  git(["update-ref", "-d", `refs/lca/tasks/${taskId}/before`], workspace);
  git(["update-ref", "-d", `refs/lca/tasks/${taskId}/after`], workspace);

  const taskDiff = await call(client, "task_diff", { task_id: taskId, mode: "unified" });
  check("task_diff contains task change", taskDiff.diff.includes("value = 2") && taskDiff.diff.includes("new-file.js"), taskDiff.diff);
  check("task_diff excludes earlier dirty change", !taskDiff.diff.includes("dirty before task"), taskDiff.diff);
  const filteredTaskDiff = await call(client, "task_diff", { task_id: taskId, path: "src/feature.js", mode: "unified" });
  check("task_diff filters stored patch by path", filteredTaskDiff.diff.includes("src/feature.js") && !filteredTaskDiff.diff.includes("src/new-file.js"), filteredTaskDiff.diff);

  const undone = await call(client, "task_undo", { task_id: taskId });
  check("task_undo changes status", undone.ok === true && undone.task.status === "undone", JSON.stringify(undone));
  check("task_undo restores modified file", (await readFile(path.join(workspace, "src", "feature.js"), "utf8")) === "export const value = 1;\n");
  let newFileExists = true;
  try { await access(path.join(workspace, "src", "new-file.js")); } catch { newFileExists = false; }
  check("task_undo removes task-created file", newFileExists === false);
  check("task_undo preserves pre-existing dirty change", (await readFile(path.join(workspace, "preexisting.txt"), "utf8")) === "dirty before task\n");
  check("task_undo preserves mutation outside declared scope", (await readFile(path.join(workspace, "outside-scope.txt"), "utf8")) === "not part of this task\n");

  const undoAgain = await call(client, "task_undo", { task_id: taskId });
  check("task_undo is idempotent", undoAgain.operation.noOp === true && undoAgain.task.status === "undone", JSON.stringify(undoAgain));

  const reapplied = await call(client, "task_reapply", { task_id: taskId });
  check("task_reapply changes status", reapplied.ok === true && reapplied.task.status === "applied", JSON.stringify(reapplied));
  check("task_reapply restores task content", (await readFile(path.join(workspace, "src", "feature.js"), "utf8")) === "export const value = 2;\n");

  await writeFile(path.join(workspace, "src", "feature.js"), "export const value = 999;\n", "utf8");
  const conflicted = await call(client, "task_undo", { task_id: taskId });
  check("conflicting undo fails safely", conflicted.ok === false && conflicted.error?.code === "task_patch_conflict", JSON.stringify(conflicted));
  check("conflicting undo leaves task applied", conflicted.task.status === "applied", JSON.stringify(conflicted.task));
  check("conflicting undo does not overwrite later edit", (await readFile(path.join(workspace, "src", "feature.js"), "utf8")) === "export const value = 999;\n");

  const listed = await call(client, "task_list", { limit: 10 });
  check("task_list returns task", listed.tasks.some((item) => item.id === taskId));

  const renameTask = await call(client, "task_begin", { title: "Rename and delete files" });
  check("task_begin falls back to repository scope", renameTask.task.scope?.mode === "repository", JSON.stringify(renameTask.task.scope));
  await call(client, "move_path", { from: "src/feature.js", to: "src/renamed-feature.js" });
  await call(client, "delete_path", { path: "src/new-file.js" });
  const renameFinished = await call(client, "task_finish", { task_id: renameTask.task.id, summary: "Renamed feature and removed generated file" });
  check("task summary recognizes rename", renameFinished.task.files.some((file) => file.operation === "renamed" && file.previousPath === "src/feature.js" && file.path === "src/renamed-feature.js"), JSON.stringify(renameFinished.task.files));
  check("task summary recognizes delete", renameFinished.task.files.some((file) => file.operation === "deleted" && file.path === "src/new-file.js"), JSON.stringify(renameFinished.task.files));
  await call(client, "task_undo", { task_id: renameTask.task.id });
  check("undo restores rename source", (await readFile(path.join(workspace, "src", "feature.js"), "utf8")) === "export const value = 999;\n");
  check("undo restores deleted file", (await readFile(path.join(workspace, "src", "new-file.js"), "utf8")) === "export const added = true;\n");
  let renamedExistsAfterUndo = true;
  try { await access(path.join(workspace, "src", "renamed-feature.js")); } catch { renamedExistsAfterUndo = false; }
  check("undo removes rename destination", renamedExistsAfterUndo === false);
  await call(client, "task_reapply", { task_id: renameTask.task.id });
  check("reapply restores rename destination", (await readFile(path.join(workspace, "src", "renamed-feature.js"), "utf8")) === "export const value = 999;\n");
  let deletedExistsAfterReapply = true;
  try { await access(path.join(workspace, "src", "new-file.js")); } catch { deletedExistsAfterReapply = false; }
  check("reapply removes deleted file again", deletedExistsAfterReapply === false);

  const outsidePathTask = await client.callTool({
    name: "task_begin",
    arguments: { title: "Reject outside task path", paths: ["../outside-task-path.txt"] }
  });
  check("task_begin rejects paths outside repository", outsidePathTask.isError === true && /outside/i.test(outsidePathTask.content?.[0]?.text || ""), outsidePathTask.content?.[0]?.text || "");

  if (process.platform !== "win32") {
    const protectedOutsideFile = path.join(os.tmpdir(), `lca-task-symlink-${Date.now()}.patch`);
    await writeFile(protectedOutsideFile, "sentinel\n", "utf8");
    try {
      const guardedTask = await call(client, "task_begin", { title: "Reject task patch symlink escape", paths: ["src/symlink-check.js"] });
      const guardedTaskDir = path.join(workspace, ".git", "lca", "tasks", guardedTask.task.id);
      await symlink(protectedOutsideFile, path.join(guardedTaskDir, "forward.patch"));
      await call(client, "write_file", { path: "src/symlink-check.js", content: "export const safe = true;\n" });
      const blockedFinish = await client.callTool({
        name: "task_finish",
        arguments: { task_id: guardedTask.task.id, summary: "Must not follow patch symlink" }
      });
      check("task patch file symlink cannot escape workspace root", blockedFinish.isError === true && /outside the allowed roots/i.test(blockedFinish.content?.[0]?.text || ""), blockedFinish.content?.[0]?.text || "");
      check("task patch symlink escape does not overwrite outside file", (await readFile(protectedOutsideFile, "utf8")) === "sentinel\n");
    } finally {
      await rm(protectedOutsideFile, { force: true });
    }
  }

  const outer = await mkdtemp(path.join(os.tmpdir(), "lca-task-outside-root-"));
  let nestedServer;
  let nestedClient;
  try {
    git(["init"], outer);
    git(["config", "user.email", "test@example.com"], outer);
    git(["config", "user.name", "Test User"], outer);
    await writeFile(path.join(outer, "root.txt"), "root\n", "utf8");
    git(["add", "."], outer);
    git(["commit", "-m", "outer"], outer);
    const nestedRoot = path.join(outer, "allowed-subdir");
    await mkdir(nestedRoot, { recursive: true });
    nestedServer = await startServer(nestedRoot);
    nestedClient = await connect(nestedServer.port);
    const blocked = await nestedClient.callTool({ name: "task_begin", arguments: { title: "Must stay confined" } });
    check("task repository root cannot escape configured workspace root", blocked.isError === true && /outside the allowed roots/i.test(blocked.content?.[0]?.text || ""), blocked.content?.[0]?.text || "");
  } finally {
    if (nestedClient) await nestedClient.close().catch(() => {});
    if (nestedServer) await stopServer(nestedServer.child);
    await rm(outer, { recursive: true, force: true });
  }
} finally {
  if (client) await client.close().catch(() => {});
  if (server) await stopServer(server.child);
  await rm(workspace, { recursive: true, force: true });
}

console.log(`\n==== TASK CHANGE RESULT: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
