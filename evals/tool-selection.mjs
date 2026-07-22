// Local Coding Agent fixed-catalog/tool-selection golden evaluation
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import path from "node:path";
import { createIsolatedTestRoot, safeRemove } from "../server/tests/helpers/test-guard.mjs";
import { startTestServer, stopTestProcess } from "../server/tests/helpers/test-runtime.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "one", "all", "then", "this", "that", "into", "from", "only", "under", "current"
]);
const FROZEN_LEGACY_65 = new Set([
  "figma_status", "figma_list_tools", "figma_call_tool",
  "list_skills", "read_skill", "create_skill", "delete_skill",
  "workspace_info", "save_note", "list_notes", "checkpoint", "resume",
  "list_files", "read_file", "stat_path", "search_text", "find_files", "read_many",
  "repo_overview", "write_file", "replace_in_file", "apply_patch", "make_dir", "move_path", "delete_path",
  "run_command", "run_commands", "proc_start", "proc_list", "proc_output", "proc_stop",
  "git", "git_status", "git_diff", "workspace_doctor", "workspace_snapshot", "project_profile",
  "important_files", "repo_map", "repo_symbols", "index_status", "preview_patch", "validate_patch",
  "quality_gate", "detect_test_commands", "run_tests", "run_build", "run_lint", "run_changed_tests",
  "session_report", "review_diff", "security_scan", "todo_scan", "change_summary",
  "task_plan", "task_state", "decision_log", "policy_status", "explain_risk",
  "request_approval", "request_approval_batch", "approve_request", "deny_request",
  "profile_status", "reload_profile"
]);

const SCENARIOS = [
  scenario("call lca", ["lca_status"], ["workspace_info"]),
  scenario("open the input composer widget in PiP", ["lca_input"], []),
  scenario("return LCA health status, active sessions and current policy", ["lca_status"], ["workspace_info", "workspace_doctor", "policy_status"]),
  scenario("create a concrete implementation plan with ordered steps", ["task_plan"], ["task_plan"]),
  scenario("save a resumable checkpoint with progress and next steps", ["task_checkpoint"], ["checkpoint", "session_report"]),
  scenario("list files recursively under the source folder", ["list_files"], ["list_files"]),
  scenario("read one source file with line numbers", ["read_file"], ["read_file"]),
  scenario("read several related files in one bounded request", ["read_many"], ["read_many"]),
  scenario("search exact text and regex matches across the repository", ["search_text"], ["search_text"]),
  scenario("find files by glob name and extension", ["find_files"], ["find_files"]),
  scenario("get a compact repository architecture snapshot and important files", ["workspace_snapshot"], ["repo_overview", "repo_map", "workspace_snapshot", "important_files"]),
  scenario("detect project languages manifests packages and scripts", ["project_profile"], ["project_profile"]),
  scenario("find a symbol definition references callers and type", ["code_query"], ["repo_symbols"]),
  scenario("atomically update multiple files with stale version checks", ["apply_patch"], ["apply_patch", "validate_patch", "preview_patch"]),
  scenario("execute one foreground shell command in the workspace", ["run_command"], ["run_command"]),
  scenario("execute several independent shell commands as one request", ["run_commands"], ["run_commands"]),
  scenario("start inspect output and stop a background process", ["process"], ["proc_start", "proc_list", "proc_output", "proc_stop"]),
  scenario("show git status and diff then run a safe git operation", ["git"], ["git", "git_status", "git_diff"]),
  scenario("run only tests impacted by changed files", ["run_changed_tests"], ["run_changed_tests"]),
  scenario("verify every required test lint typecheck and build quality gate", ["verify_changes"], ["quality_gate", "run_tests", "run_lint", "run_build"]),
  scenario("review the current diff for correctness and blockers", ["review_diff"], ["review_diff"]),
  scenario("scan changed code for security vulnerabilities and secrets", ["security_scan"], ["security_scan"]),
  scenario("scan the repository for TODO FIXME and unfinished work", ["todo_scan"], ["todo_scan"]),
  scenario("list and read a project skill before implementing", ["skills"], ["list_skills", "read_skill"]),
  scenario("save and list durable workspace notes", ["notes"], ["save_note", "list_notes"]),
  scenario("inspect Figma desktop design context through the integration", ["figma"], ["figma_status", "figma_list_tools", "figma_call_tool"]),
  scenario("inspect change history and summarize tracked edits", ["change_history"], ["change_summary"])
];

assert.equal(FROZEN_LEGACY_65.size, 65, "the comparison baseline must remain the frozen 65-tool catalog");

const context = await createIsolatedTestRoot({
  prefix: "lca-tool-selection-eval-",
  protectedPaths: [path.resolve("..")]
});
let runtime = null;

try {
  const fixedCatalog = await readCatalog();
  const legacyCatalog = [...FROZEN_LEGACY_65].map(frozenLegacyTool);
  assert.equal(fixedCatalog.length, 35, `Fixed catalog drifted to ${fixedCatalog.length} tools`);
  assert.equal(legacyCatalog.length, 65);

  const fixedResult = evaluateCatalog(fixedCatalog, "fixed-35", "expectedFixed");
  const legacyResult = evaluateCatalog(legacyCatalog, "legacy-65", "expectedLegacy");
  const report = {
    eval: "lca-tool-selection",
    scenarios: SCENARIOS.length,
    fixed: fixedResult,
    baseline_legacy_65: legacyResult,
    primary_metric: "top_2_accuracy",
    top_1_accuracy_delta: round(fixedResult.top_1_accuracy - legacyResult.top_1_accuracy, 4),
    gates: {
      top_2_accuracy_not_lower_than_legacy_65: fixedResult.top_2_accuracy >= legacyResult.top_2_accuracy,
      median_discovery_calls_at_most_2: fixedResult.median_discovery_calls <= 2
    }
  };
  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.gates.top_2_accuracy_not_lower_than_legacy_65, true);
  assert.equal(report.gates.median_discovery_calls_at_most_2, true);
} finally {
  if (runtime) await stopTestProcess(runtime.child);
  await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
  await safeRemove(context.dataDir, context, { recursive: true, force: true });
}

function scenario(prompt, expectedFixed, expectedLegacy) {
  return { prompt, expectedFixed, expectedLegacy };
}

function frozenLegacyTool(name) {
  const words = name.replace(/_/g, " ");
  return {
    name,
    title: words,
    description: `Legacy tool for ${words}.`,
    inputSchema: { type: "object", properties: {} }
  };
}

async function readCatalog() {
  runtime = await startTestServer({
    workspace: context.fixtureDir,
    dataDir: context.dataDir,
    runId: context.runId,
    mode: "safe",
    policy: "full",
    env: { LCA_TEST_RUNTIME_DIAGNOSTICS: "0" }
  });
  const initialized = await rpc(runtime.port, {
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "tool-selection-eval", version: "1.0.0" }
    }
  });
  const sessionId = initialized.sessionId;
  assert.ok(sessionId);
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
  await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
    method: "DELETE",
    headers: {
      "mcp-session-id": sessionId,
      "mcp-protocol-version": PROTOCOL_VERSION
    }
  });
  const tools = listed.message?.result?.tools || [];
  await stopTestProcess(runtime.child);
  runtime = null;
  return tools;
}

function evaluateCatalog(catalog, label, expectedKey) {
  const rankedScenarios = SCENARIOS.map((item) => {
    const ranked = rankCatalog(catalog, item.prompt);
    const accepted = new Set(item[expectedKey]);
    const rank = ranked.findIndex((entry) => accepted.has(entry.name)) + 1;
    return {
      prompt: item.prompt,
      accepted: [...accepted],
      rank: rank || null,
      top_3: ranked.slice(0, 3).map(({ name, score }) => ({ name, score: round(score) }))
    };
  });
  const ranks = rankedScenarios.map((item) => item.rank || catalog.length + 1);
  return {
    label,
    catalog_size: catalog.length,
    top_1_accuracy: round(ranks.filter((rank) => rank <= 1).length / ranks.length, 4),
    top_2_accuracy: round(ranks.filter((rank) => rank <= 2).length / ranks.length, 4),
    median_discovery_calls: percentile(ranks, 50),
    p95_discovery_calls: percentile(ranks, 95),
    failures_outside_top_1: rankedScenarios.filter((item) => !item.rank || item.rank > 1),
    failures_outside_top_2: rankedScenarios.filter((item) => !item.rank || item.rank > 2)
  };
}

function rankCatalog(catalog, prompt) {
  const promptTokens = tokenize(prompt);
  const documentFrequency = new Map();
  const prepared = catalog.map((tool) => {
    const nameTokens = tokenize(String(tool.name || "").replace(/_/g, " "));
    const titleTokens = tokenize(tool.title || tool.annotations?.title || "");
    const descriptionTokens = tokenize(tool.description || "");
    const schemaTokens = tokenize(JSON.stringify(tool.inputSchema || {}));
    const allTokens = new Set([...nameTokens, ...titleTokens, ...descriptionTokens, ...schemaTokens]);
    for (const token of allTokens) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    return { tool, nameTokens, titleTokens, descriptionTokens, schemaTokens };
  });
  const normalizedPrompt = prompt.toLowerCase();
  return prepared
    .map((entry) => {
      let score = 0;
      for (const token of promptTokens) {
        const idf = Math.log((catalog.length + 1) / ((documentFrequency.get(token) || 0) + 1)) + 1;
        if (entry.nameTokens.includes(token)) score += 9 * idf;
        if (entry.titleTokens.includes(token)) score += 5 * idf;
        score += Math.min(3, entry.descriptionTokens.filter((value) => value === token).length) * 2.5 * idf;
        if (entry.schemaTokens.includes(token)) score += 0.75 * idf;
      }
      const normalizedName = String(entry.tool.name || "").replace(/_/g, " ").toLowerCase();
      if (normalizedPrompt.includes(normalizedName)) score += 20;
      return { name: entry.tool.name, score };
    })
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .map(stem)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function stem(token) {
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index];
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
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
  assert.ok([200, 202].includes(response.status), buffer.toString("utf8"));
  return {
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
