// Local Coding Agent catalog and discovery-group tool-selection evaluation
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import path from "node:path";
import { DISCOVERY_GROUPS } from "../server/src/mcp/discovery-groups.mjs";
import { createIsolatedTestRoot, safeRemove } from "../server/tests/helpers/test-guard.mjs";
import { startTestServer, stopTestProcess } from "../server/tests/helpers/test-runtime.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const EXPECTED_FIXED_COUNT = 34;
const REMOVED_CONSOLIDATED_TOOLS = new Set(["task_state", "run_changed_tests", "notes"]);
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
  scenario("call lca and return runtime health status", "lca_status", ["workspace_info"], "workspace-management", true),
  scenario("open the Apps SDK input composer widget in PiP", "lca_input", [], "workspace-management", true),
  scenario("select a different default workspace for future conversations", "workspace_select", [], "workspace-management", true),
  scenario("inspect or rebuild a stale code index", "index_control", ["index_status"], "workspace-management", true, ["workspace_snapshot"]),
  scenario("create a persistent implementation plan with ordered steps", "task_plan", ["task_plan"], "task-planning", true),
  scenario("save progress and next steps so this same active task can resume after reconnect", "task_checkpoint", ["checkpoint", "session_report"], "task-planning", true, ["workspace_memory"]),
  scenario("remember an architecture constraint for future tasks and conversations", "workspace_memory", ["decision_log"], "task-planning", true, ["task_checkpoint"]),
  scenario("get the primary bounded repository architecture orientation snapshot", "workspace_snapshot", ["repo_overview", "repo_map", "workspace_snapshot", "important_files"], "task-investigation", true, ["project_profile"]),
  scenario("inspect only package manifests frameworks and runnable scripts", "project_profile", ["project_profile"], "task-investigation", true, ["workspace_snapshot"]),
  scenario("list files recursively under the source folder", "list_files", ["list_files"], "task-investigation"),
  scenario("read one targeted source file range", "read_file", ["read_file"], "task-investigation"),
  scenario("read several related files in one bounded concurrent request", "read_many", ["read_many"], "task-investigation"),
  scenario("find every literal or regex occurrence of a string in file contents", "search_text", ["search_text"], "task-investigation", true, ["code_query"]),
  scenario("find files by glob name and extension", "find_files", ["find_files"], "task-investigation"),
  scenario("find callers references and the type of a code symbol", "code_query", ["repo_symbols"], "task-investigation", true, ["search_text"]),
  scenario("atomically update multiple files with stale version checks", "apply_patch", ["apply_patch", "validate_patch", "preview_patch"], "task-code-change", true),
  scenario("review all staged unstaged and untracked changes in the active task", "review_diff", ["review_diff"], "task-verification", true, ["git", "change_history"]),
  scenario("inspect the diff for one journaled LCA change id and optionally undo it", "change_history", ["change_summary"], "change-management", true, ["review_diff", "git"]),
  scenario("show raw git status log or low level repository history", "git", ["git", "git_status", "git_diff"], "change-management", true, ["review_diff", "change_history"]),
  scenario("run package-aware tests impacted by changed files and persist official evidence", "verify_changes", ["run_changed_tests"], "task-verification", true, ["run_command", "run_commands"]),
  scenario("verify every required lint typecheck test and build gate", "verify_changes", ["quality_gate", "run_tests", "run_lint", "run_build"], "task-verification", true, ["run_command", "run_commands"]),
  scenario("scan changed code for secrets and unsafe security patterns", "security_scan", ["security_scan"], "task-verification", true),
  scenario("execute one bounded foreground custom shell command", "run_command", ["run_command"], "task-process", true, ["process"]),
  scenario("execute several custom shell commands sequentially or in parallel", "run_commands", ["run_commands"], "task-process", true),
  scenario("start inspect output from and stop a long running background process", "process", ["proc_start", "proc_list", "proc_output", "proc_stop"], "task-process", true, ["run_command"]),
  scenario("scan the repository for TODO FIXME HACK and XXX comments", "todo_scan", ["todo_scan"], "task-investigation"),
  scenario("list and read a named project skill before implementation", "skills", ["list_skills", "read_skill"], "task-code-change"),
  scenario("inspect Figma desktop design context and screenshot", "figma", ["figma_status", "figma_list_tools", "figma_call_tool"], "figma-workflow", true)
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
  assert.equal(fixedCatalog.length, EXPECTED_FIXED_COUNT, `Fixed catalog drifted to ${fixedCatalog.length} tools`);
  assert.equal(legacyCatalog.length, 65);
  assert.equal(
    fixedCatalog.some((tool) => REMOVED_CONSOLIDATED_TOOLS.has(tool.name)),
    false,
    "removed consolidated tools must not remain model-visible"
  );

  const fixedResult = evaluateCatalog(fixedCatalog, SCENARIOS, "fixed-34", "expectedFixed");
  const legacyScenarios = SCENARIOS.filter((item) => item.expectedLegacy.length);
  const legacyResult = evaluateCatalog(legacyCatalog, legacyScenarios, "legacy-65", "expectedLegacy");
  const groupResults = evaluateDiscoveryGroups(fixedCatalog);
  const adversarialFailures = groupResults.flatMap((group) => group.scenarios.filter((item) =>
    (item.must_top_1 && item.rank !== 1) || item.rejected_rank_before_expected
  ));
  const report = {
    eval: "lca-tool-selection-v15",
    scenarios: SCENARIOS.length,
    fixed: fixedResult,
    baseline_legacy_65: legacyResult,
    discovery_groups: groupResults,
    primary_metric: "discovery_group_top_1_accuracy",
    top_1_accuracy_delta: round(fixedResult.top_1_accuracy - legacyResult.top_1_accuracy, 4),
    gates: {
      catalog_count_34: fixedCatalog.length === EXPECTED_FIXED_COUNT,
      removed_tools_absent: [...REMOVED_CONSOLIDATED_TOOLS].every((name) => !fixedCatalog.some((tool) => tool.name === name)),
      full_catalog_top_2_not_lower_than_legacy_65: fixedResult.top_2_accuracy >= legacyResult.top_2_accuracy,
      discovery_group_all_expected_within_top_2: groupResults.every((group) => group.scenarios.every((item) => item.rank && item.rank <= 2)),
      adversarial_canonical_tools_top_1: adversarialFailures.length === 0,
      discovery_group_median_rank_at_most_1: groupResults.every((group) => group.median_rank <= 1),
      discovery_group_p95_rank_at_most_2: groupResults.every((group) => group.p95_rank <= 2)
    },
    adversarial_failures: adversarialFailures
  };
  console.log(JSON.stringify(report, null, 2));
  for (const [name, passed] of Object.entries(report.gates)) {
    assert.equal(passed, true, `tool-selection gate failed: ${name}`);
  }
} finally {
  if (runtime) await stopTestProcess(runtime.child);
  await safeRemove(context.fixtureDir, context, { recursive: true, force: true });
  await safeRemove(context.dataDir, context, { recursive: true, force: true });
}

function scenario(prompt, expectedFixed, expectedLegacy, group, mustTop1 = false, rejected = []) {
  return {
    prompt,
    expectedFixed: [expectedFixed],
    expectedLegacy,
    group,
    mustTop1,
    rejected
  };
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
  await rpc(runtime.port, { sessionId, method: "notifications/initialized", params: {} });
  const listed = await rpc(runtime.port, { id: 2, sessionId, method: "tools/list", params: {} });
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

function evaluateDiscoveryGroups(catalog) {
  const byName = new Map(catalog.map((tool) => [tool.name, tool]));
  return Object.entries(DISCOVERY_GROUPS).map(([group, names]) => {
    const subset = names.map((name) => byName.get(name)).filter(Boolean);
    assert.equal(subset.length, names.length, `${group} contains a missing model tool`);
    const scenarios = SCENARIOS.filter((item) => item.group === group).map((item) => {
      const ranked = rankCatalog(subset, item.prompt);
      const rank = ranked.findIndex((entry) => item.expectedFixed.includes(entry.name)) + 1;
      const expectedRank = rank || null;
      const rejectedRanks = item.rejected
        .map((name) => ({ name, rank: ranked.findIndex((entry) => entry.name === name) + 1 }))
        .filter((entry) => entry.rank > 0);
      return {
        prompt: item.prompt,
        expected: item.expectedFixed,
        rank: expectedRank,
        must_top_1: item.mustTop1,
        rejected_rank_before_expected: rejectedRanks.some((entry) => !expectedRank || entry.rank < expectedRank),
        rejected_ranks: rejectedRanks,
        top_3: ranked.slice(0, 3).map(({ name, score }) => ({ name, score: round(score) }))
      };
    });
    const ranks = scenarios.map((item) => item.rank || subset.length + 1);
    return {
      group,
      catalog_size: subset.length,
      scenarios,
      top_1_accuracy: scenarios.length ? round(ranks.filter((rank) => rank === 1).length / ranks.length, 4) : null,
      median_rank: scenarios.length ? percentile(ranks, 50) : 0,
      p95_rank: scenarios.length ? percentile(ranks, 95) : 0
    };
  });
}

function evaluateCatalog(catalog, scenarios, label, expectedKey) {
  const rankedScenarios = scenarios.map((item) => {
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
