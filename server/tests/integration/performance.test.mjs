// Local Coding Agent performance/workflow regression tests
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createGitFixture, createIsolatedTestRoot, safeRemove } from "../helpers/test-guard.mjs";
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

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text || "";
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  const data = result.structuredContent && typeof result.structuredContent === "object"
    ? result.structuredContent
    : JSON.parse(text);
  return { result, text, data };
}

const context = await createIsolatedTestRoot({ prefix: "lca-performance-", protectedPaths: [path.resolve("..")] });
const largeSource = Array.from({ length: 1800 }, (_, index) =>
  index % 30 === 0
    ? `export function changeJournalStep${index}(){ return "change journal performance"; }`
    : `export const value${index} = ${index};`
).join("\n") + "\n";
const gitFixture = await createGitFixture(context, {
  initialFiles: {
    "fixture/src/large.js": largeSource,
    "fixture/package.json": JSON.stringify({
      name: "performance-fixture",
      scripts: { test: "node --version", lint: "node --version", build: "node --version" }
    }, null, 2),
    "fixture/README.md": "# Performance fixture\n"
  }
});
const workspace = gitFixture.fixtureDir;
let runtime;
let client;
let succeeded = false;
try {
  runtime = await startTestServer({
    workspace,
    dataDir: context.dataDir,
    runId: context.runId,
    mode: "safe",
    policy: "full",
    env: {
      LCA_TEST_EXPOSE_REDUNDANT_TOOLS: "0",
      AGENT_READ_DEFAULT: "12000",
      AGENT_READ_MANY_FILE_DEFAULT: "16000",
      AGENT_MAX_BATCH_READ_CHARS: "100000",
      AGENT_SEARCH_OUTPUT_DEFAULT: "15000"
    }
  });
  client = new Client({ name: "performance-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${runtime.port}/mcp`)));

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  check("stable catalog keeps specialized capabilities", ["lca", "workspace_snapshot", "workspace_doctor", "repo_map", "repo_symbols", "preview_patch", "run_changed_tests", "security_scan", "todo_scan", "project_profile", "profile_status", "figma_get_figjam", "create_skill", "save_note"].every((name) => names.includes(name)), names.join(","));
  check("stable catalog hides only redundant tools", ["ping", "workspace_info", "repo_overview", "write_file", "replace_in_file", "move_path", "delete_path", "validate_patch", "detect_test_commands", "run_tests", "run_build", "run_lint"].every((name) => !names.includes(name)), names.join(","));
  check("stable catalog remains smaller than legacy full catalog", names.length === 65, `count=${names.length}`);
  check("stable catalog keeps app-only companion backends", ["workspace_search", "slash_commands", "compose_prompt"].every((name) => names.includes(name)), names.join(","));
  const workspaceSearchTool = tools.tools.find((tool) => tool.name === "workspace_search");
  check("companion search is app-only", workspaceSearchTool?._meta?.ui?.visibility?.length === 1 && workspaceSearchTool._meta.ui.visibility[0] === "app", JSON.stringify(workspaceSearchTool?._meta));

  const info = (await call(client, "lca")).data;
  check("lca reports stable catalog and output defaults", info.tool_catalog === "stable" && info.limits?.read_default_chars === 12000 && info.limits?.max_batch_read_chars === 100000, JSON.stringify(info));

  const firstRead = await call(client, "read_file", { path: "src/large.js" });
  check("read_file default output is capped", firstRead.data.truncated === true && firstRead.data.content.length <= 12000 && firstRead.data.returned_chars <= 12000, JSON.stringify({ chars: firstRead.data.content?.length, returned: firstRead.data.returned_chars }));
  const repeatedRead = await call(client, "read_file", { path: "src/large.js", known_version: firstRead.data.version, skip_if_unchanged: true });
  check("read_file omits unchanged repeated content", repeatedRead.data.unchanged === true && repeatedRead.data.content_omitted === true && repeatedRead.data.content === undefined, JSON.stringify(repeatedRead.data));

  const many = await call(client, "read_many", {
    requests: [
      { path: "src/large.js", known_version: firstRead.data.version, skip_if_unchanged: true },
      { path: "README.md" }
    ]
  });
  check("read_many supports safe version dedup", many.data.files?.[0]?.unchanged === true && many.data.files?.[0]?.content === undefined, JSON.stringify(many.data.files?.[0]));
  check("read_many respects compact total budget", many.data.chars_returned <= 100000, JSON.stringify(many.data));

  const search = await call(client, "search_text", { query: "change journal", path: "src", context: 2, limit: 200, max_output_chars: 2500 });
  check("search_text reports truncation metadata", search.data.returned <= search.data.count && typeof search.data.truncated === "boolean", JSON.stringify(search.data));
  check("search_text keeps model-visible payload bounded", search.text.length < 6000, `chars=${search.text.length}`);

  const snapshot = await call(client, "workspace_snapshot", {
    focus: "change journal performance",
    include_matches: true,
    include_snippets: true,
    max_output_chars: 5000,
    refresh: true
  });
  check("focused snapshot returns evidence in one call", snapshot.data.evidence?.returned > 0 && snapshot.data.evidence.matches?.some((match) => /large\.js$/.test(match.path)), JSON.stringify(snapshot.data.evidence));
  check("snapshot uses bounded tree default", snapshot.data.tree?.entries?.length <= 180, `entries=${snapshot.data.tree?.entries?.length}`);

  await writeFile(path.join(workspace, "src", "large.js"), largeSource.replace("value1 = 1", "value1 = 999"), "utf8");
  const report = await call(client, "session_report", { include_review: true, include_change_summary: true });
  check("session_report consolidates change summary", report.data.change_summary?.changed_files === 1, JSON.stringify(report.data.change_summary));
  check("session_report consolidates review", ["PASS", "WARN", "BLOCK"].includes(report.data.review?.verdict), JSON.stringify(report.data.review));
  check("session_report exposes process-scoped output metrics", report.data.tool_runtime?.scope === "process" && Number.isInteger(report.data.tool_runtime?.calls) && report.data.tool_runtime.calls > 0, JSON.stringify(report.data.tool_runtime));

  const appResult = await client.callTool({ name: "workspace_search", arguments: { query: "large", limit: 5 } });
  check("app-only result avoids duplicated JSON text", Boolean(appResult.structuredContent) && (appResult.content?.[0]?.text || "").length < 100, JSON.stringify(appResult.content));

  succeeded = fail === 0;
} finally {
  if (client) await client.close().catch(() => {});
  if (runtime) await stopTestProcess(runtime.child);
  try {
    const audit = await readFile(path.join(context.dataDir, "audit.log"), "utf8");
    const entries = audit.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    check("audit includes request-level telemetry", entries.some((entry) => entry.kind === "mcp_request" && entry.tool === "read_file" && Number.isFinite(entry.httpTotalMs)), audit.slice(-4000));
    check("audit correlates tool and request ids", entries.some((entry) => entry.kind === "tool" && entry.requestId && entry.tool === "read_file"), audit.slice(-4000));
  } catch (error) {
    check("audit file is readable", false, error?.message || String(error));
  }
  if (succeeded && fail === 0) await safeRemove(workspace, context, { recursive: true, force: true });
  else console.log(`Performance fixture retained for inspection: ${context.testRoot}`);
}

console.log(`\n==== PERFORMANCE RESULT: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
