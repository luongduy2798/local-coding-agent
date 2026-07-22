// Local Coding Agent Pro regression tests
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createGitFixture,
  createIsolatedTestRoot,
  registerDisposableRoot,
  safeRemove
} from "../helpers/test-guard.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(TEST_DIR, "../..", "server.mjs");
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
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error(`Server did not become ready on port ${port}\n${stderrRef.value}`);
}

async function startServer(workspace) {
  await mkdir(workspace, { recursive: true });
  const port = await getFreePort();
  const stderrRef = { value: "" };
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      PORT: String(port),
      AGENT_WORKSPACE: workspace,
      AGENT_DATA_DIR: testContext.dataDir,
      LCA_TEST_RUN_ID: testContext.runId,
      AGENT_MODE: "safe",
      AGENT_POLICY: "full",
      AGENT_EXTRA_ROOTS_JSON: "[]",
      MCP_AUTH_TOKEN: "",
      AGENT_AUDIT: "0",
      LCA_TEST_RUNTIME_DIAGNOSTICS: "1"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", (chunk) => (stderrRef.value += chunk));
  await waitForHealth(port, stderrRef);
  return { child, port };
}

async function stopServer(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
  await wait(300);
}

async function connect(port) {
  const client = new Client({ name: "agent-pro-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  return client;
}

function runLocal(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function callJson(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  return JSON.parse(text);
}

const testContext = await createIsolatedTestRoot({ prefix: "lca-pro-", protectedPaths: [path.resolve("..")] });
const testFixture = await createGitFixture(testContext, {
  initialFiles: {
    "package.json": JSON.stringify({
      scripts: {
        test: "node --version",
        build: "node --version",
        lint: "node --version",
        typecheck: "node --version"
      },
      dependencies: { express: "^4.0.0" }
    }, null, 2),
    "README.md": "# Pro workspace\n",
    "src/index.js": "export function hello(){ return 'pro'; }\n"
  }
});
const base = testFixture.root;
await runLocal("git", ["add", "."], base);
await runLocal("git", ["commit", "-m", "initial pro state"], base);
let server;
let client;
try {
  server = await startServer(base);
  client = await connect(server.port);

  const info = await callJson(client, "lca_status");
  check("lca_status exposes pro tier", info.tier === "pro", `tier=${info.tier}`);
  check("lca_status exposes fixed catalog metadata", info.tool_catalog === "fixed" && info.catalog_version === 5 && typeof info.catalog_hash === "string", JSON.stringify(info));
  check("lca_status exposes policy", typeof info.policy === "string" && info.policy.length > 0);

  const workspaceList = await callJson(client, "workspace_list");
  const workspaceId = workspaceList.workspaces?.[0]?.workspace_id;
  check("workspace_list exposes one trusted fixture", workspaceList.count === 1 && Boolean(workspaceId) && workspaceList.workspaces[0].trusted === true, JSON.stringify(workspaceList));
  const opened = await callJson(client, "task_open", {
    title: "Pro fixed-catalog regression",
    primary_workspace_id: workspaceId
  });
  const taskToken = opened.task?.task_token;
  check("task_open binds a resumable task", Boolean(taskToken) && opened.task?.primary_workspace_id === workspaceId, JSON.stringify(opened));

  const snap = await callJson(client, "workspace_snapshot", {
    depth: 3,
    max_entries: 120,
    include_symbols: true,
    refresh: true,
    task_token: taskToken
  });
  check("snapshot kind is workspace_snapshot", snap.kind === "workspace_snapshot");
  check("snapshot is pro", snap.pro === true && snap.tier === "pro");
  check("snapshot version is 5.0.0-pro", snap.version === "5.0.0-pro", `version=${snap.version}`);
  check("snapshot includes safety model", snap.safety?.file_tools_root_confined === true && snap.safety?.command_os_sandbox === false);
  check("snapshot detects javascript", snap.profile?.languages?.includes("javascript"), JSON.stringify(snap.profile));
  check("snapshot omits fast-workflow commands", snap.commands === undefined, JSON.stringify(snap.commands));
  check("snapshot includes ripgrep status", typeof snap.ripgrep?.available === "boolean", JSON.stringify(snap.ripgrep));
  check("snapshot includes coverage-aware cache status", typeof snap.cache?.hit === "boolean" && snap.cache.freshness?.authoritative === true, JSON.stringify(snap.cache));
  check("snapshot includes important files", snap.important_files?.some((f) => f.path === "README.md"));
  check("snapshot includes workspace-qualified tree entries", snap.tree?.entries?.some((entry) => entry.workspace_id === snap.workspace_id && entry.path === "src/index.js"));
  check("snapshot includes symbols when requested", snap.symbols?.some((s) => s.name === "hello"), JSON.stringify(snap.symbols?.slice(0, 10)));
  check("snapshot includes recommended reads", snap.recommended_reads?.some((f) => f.path === "README.md"), JSON.stringify(snap.recommended_reads));
  check("snapshot workflow hints skip automatic tests", snap.workflow_hints?.some((h) => /explicitly requested/.test(h)), JSON.stringify(snap.workflow_hints));
  check("snapshot omits metrics", snap.metrics === undefined && snap.health === undefined);
  check("snapshot includes next actions", Array.isArray(snap.next_best_actions) && snap.next_best_actions.length > 0);
  check("snapshot next actions avoid quality gates", !snap.next_best_actions.join("\n").match(/quality_gate|run_tests|run_changed_tests|build|lint/), JSON.stringify(snap.next_best_actions));
  const focusedSnap = await callJson(client, "workspace_snapshot", {
    focus: "hello function",
    include_matches: true,
    max_output_chars: 5000,
    task_token: taskToken
  });
  check("snapshot supports focused evidence", focusedSnap.evidence?.count > 0, JSON.stringify(focusedSnap));
  await callJson(client, "apply_patch", {
    task_token: taskToken,
    operations: [{
      op: "create",
      path: "src/deep/a/b/c/feature.js",
      content: "export function deepFeature(){ return true; }\n"
    }]
  });
  const deepFiles = await callJson(client, "find_files", {
    glob: "*feature.js",
    task_token: taskToken,
    limit: 20
  });
  check("find_files locates deep context without a separate repo-map tool", deepFiles.files?.some((entry) => entry.path === "src/deep/a/b/c/feature.js"), JSON.stringify(deepFiles));
  const deepSymbols = await callJson(client, "code_query", {
    query: "deepFeature",
    mode: "symbol",
    depth: "fast",
    task_token: taskToken,
    refresh: true
  });
  check("code_query expands cached symbol coverage", deepSymbols.results?.some((result) => result.symbol === "deepFeature" || result.name === "deepFeature"), JSON.stringify(deepSymbols));

  const profile = await callJson(client, "project_profile", { task_token: taskToken, refresh: true });
  check("project_profile retains language and script discovery", profile.languages?.includes("javascript") && profile.scripts?.test === "node --version", JSON.stringify(profile));

  const companionPage = await fetch(`http://127.0.0.1:${server.port}/companion`);
  check("companion standalone HTTP page is not exposed", companionPage.status === 404, `status=${companionPage.status}`);

  const tools = await client.listTools();
  const toolNames = tools.tools?.map((tool) => tool.name) || [];
  check("model catalog contains exactly 35 tools", toolNames.length === 35, JSON.stringify(toolNames));
  check(
    "legacy aliases and app-only backend aliases are absent",
    ["lca", "workspace_info", "repo_map", "repo_symbols", "workspace_search", "slash_commands", "compose_prompt", "session_report"].every((name) => !toolNames.includes(name)),
    JSON.stringify(toolNames)
  );
  const staleLcaAlias = await client.callTool({ name: "lca", arguments: {} });
  check("legacy lca alias is not callable", staleLcaAlias.isError === true && /Tool lca not found/.test(staleLcaAlias.content?.[0]?.text || ""), JSON.stringify(staleLcaAlias));
  const lcaInputTool = tools.tools?.find((t) => t.name === "lca_input");
  check("planner tools remain available", ["task_plan", "task_state", "task_checkpoint", "task_close"].every((name) => toolNames.includes(name)), JSON.stringify(toolNames));
  check("Apps SDK lca_input tool is listed", Boolean(lcaInputTool), JSON.stringify(toolNames));
  check("Apps SDK render tool has output template", lcaInputTool?._meta?.["openai/outputTemplate"] === "ui://widget/lca-compact-input-v2.html", JSON.stringify({ lcaInput: lcaInputTool?._meta }));
  const resources = await client.listResources();
  check("Apps SDK companion widget resource is listed", resources.resources?.some((r) => r.uri === "ui://widget/lca-compact-input-v2.html"), JSON.stringify(resources.resources));
  const widgetResource = await client.readResource({ uri: "ui://widget/lca-compact-input-v2.html" });
  const widgetHtml = widgetResource.contents?.[0]?.text || "";
  check("Apps SDK companion widget resource is html", widgetResource.contents?.[0]?.mimeType === "text/html;profile=mcp-app" && widgetHtml.includes("sendFollowUpMessage") && widgetHtml.includes("find_files") && widgetHtml.includes("code_query") && widgetHtml.includes("suggestions.scrollTop = 0") && !widgetHtml.includes("Prompt output"), JSON.stringify(widgetResource.contents?.[0]));
  check(
    "Apps SDK widget fences task/workspace context before search and send",
    widgetHtml.includes("contextTaskId") &&
      widgetHtml.includes("workspace_set_version") &&
      widgetHtml.includes("responseMatchesContext"),
    "missing widget task/workspace fencing"
  );
  const removedWidgetIdentifiers = [
    ["task", "toggle"].join("-"),
    ["task", "mode"].join("_")
  ];
  check(
    "Apps SDK widget keeps only the Plan lifecycle control",
    widgetHtml.includes("plan-toggle") && removedWidgetIdentifiers.every((identifier) => !widgetHtml.includes(identifier)),
    "unexpected removed lifecycle widget content"
  );
  const widgetScript = widgetHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
  let widgetScriptError = "";
  try {
    new Script(widgetScript);
  } catch (error) {
    widgetScriptError = error instanceof Error ? error.message : String(error);
  }
  check("Apps SDK companion widget script compiles", Boolean(widgetScript) && !widgetScriptError, widgetScriptError || "inline script missing");
  check("Apps SDK companion widget requests PiP from a user action", /id\s*=\s*(['\"])pip\1/.test(widgetHtml) && /pipButton\.addEventListener\(\s*(['\"])click\1\s*,\s*requestPipMode\s*\)/.test(widgetScript) && /requestDisplayMode\(\{\s*mode:\s*(['\"])pip\1\s*\}\)/.test(widgetScript), "PiP button, click handler, or requestDisplayMode({ mode: 'pip' }) missing");
  check(
    "Apps SDK widget fences duplicate sends before the first await",
    /async function sendCurrentTask\(\)\s*\{\s*if \(sendPending\) return;\s*sendPending = true;\s*sendButton\.disabled = true;/.test(widgetScript) &&
      (widgetScript.match(/sendButton\.addEventListener\(\s*(['\"])click\1\s*,\s*sendCurrentTask\s*\)/g) || []).length === 1,
    "synchronous send lock or unique click binding missing"
  );
  check(
    "Apps SDK widget clears selected context when task/workspace revision changes",
    /if \(contextChanged\)\s*\{[\s\S]*?selected\.length = 0;[\s\S]*?suggestionCache\.clear\(\);[\s\S]*?searchSeq \+= 1;/.test(widgetScript),
    "revision-bound selected-context reset missing"
  );
  const lcaInput = await client.callTool({ name: "lca_input", arguments: { initial_input: "fix @deepFeature" } });
  check("lca_input returns task-bound widget payload", lcaInput.structuredContent?.initial_input === "fix @deepFeature" && lcaInput.structuredContent?.task_id === opened.task.id && lcaInput.structuredContent?.workspace?.workspace_id === workspaceId && lcaInput.structuredContent?.shortcuts?.length === 1 && lcaInput.structuredContent.shortcuts[0]?.name === "plan" && /LCA input is ready/.test(lcaInput.content?.[0]?.text || ""), JSON.stringify(lcaInput));
  check("widget composes prompts locally against the stable tools", widgetScript.includes("Start with workspace_snapshot or code_query") && widgetScript.includes("use apply_patch for filesystem mutation") && !widgetScript.includes("compose_prompt"), "stable prompt composer missing");

  await runLocal("git", ["add", "."], base);
  await runLocal("git", ["commit", "-m", "add deep feature"], base);
  await callJson(client, "apply_patch", {
    task_token: taskToken,
    operations: [{
      op: "update",
      path: "src/index.js",
      content: "export function hello(){ console.log('debug'); return 'pro'; }\n"
    }]
  });
  const review = await callJson(client, "review_diff", { task_token: taskToken });
  check("review_diff returns summary", review.summary?.changed_files >= 1 && review.summary?.source_files >= 1, JSON.stringify(review.summary));
  check("review_diff returns heuristic findings", review.findings?.some((f) => /console\.log|corresponding test/.test(f.issue)), JSON.stringify(review.findings));

  const gatePlan = await callJson(client, "verify_changes", { task_token: taskToken, dry_run: true });
  check("verify_changes dry run plans every required gate", gatePlan.status === "DRY_RUN" && gatePlan.plan?.gates?.some((gate) => gate.kind === "test"), JSON.stringify(gatePlan));
  const history = await callJson(client, "change_history", { action: "list", task_token: taskToken });
  check("change_history replaces session-level mutation summaries", history.changes?.length >= 1 && history.changes[0]?.operationCount >= 2, JSON.stringify(history));

  const report = await callJson(client, "lca_status", {});
  check("lca_status exposes process-scoped tool runtime metrics", report.runtime?.tools?.scope === "process" && Number.isInteger(report.runtime?.tools?.calls) && report.runtime.tools.calls > 0, JSON.stringify(report.runtime?.tools));
  check("lca_status omits legacy report fields", report.metrics === undefined && report.health === undefined && report.recent_errors === undefined);
} finally {
  if (client) await client.close().catch(() => {});
  if (server) await stopServer(server.child);
  const rootEntries = await readdir(base, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.name === ".git") continue;
    const target = path.join(base, entry.name);
    await registerDisposableRoot(testContext, target);
    await safeRemove(target, testContext, { recursive: entry.isDirectory(), force: true });
  }
  await safeRemove(testContext.dataDir, testContext, { recursive: true, force: true });
}

console.log(`\n==== PRO RESULT: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
