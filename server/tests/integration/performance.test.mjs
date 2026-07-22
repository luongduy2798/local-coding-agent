// Local Coding Agent runtime performance/regression tests
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createGitFixture, createIsolatedTestRoot, safeRemove } from "../helpers/test-guard.mjs";
import { startTestServer, stopTestProcess } from "../helpers/test-runtime.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const MAX_TOOLS_LIST_BYTES = 25_000;
const DEFAULT_RESPONSE_BUDGET = 64 * 1024;
const HARD_RESPONSE_BUDGET = 200 * 1024;
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

function percentile(values, percentileValue) {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index];
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

function buildFixtureFiles() {
  const files = {
    "fixture/package.json": JSON.stringify({
      name: "runtime-performance-fixture",
      scripts: {
        test: "node --version",
        lint: "node --version",
        build: "node --version"
      }
    }, null, 2),
    "fixture/README.md": "# Runtime performance fixture\n",
    "fixture/data/oversized.txt": "x".repeat(260_000),
    "fixture/data/search-corpus.txt": Array.from(
      { length: 500 },
      (_, index) => `performance-budget-needle-${index} ${"y".repeat(480)}`
    ).join("\n")
  };
  for (let index = 0; index < 240; index++) {
    files[`fixture/src/module-${String(index).padStart(3, "0")}.js`] = [
      `export function changeJournalStep${index}(value) {`,
      `  return value + ${index};`,
      "}",
      `export const moduleValue${index} = changeJournalStep${index}(${index});`,
      ""
    ].join("\n");
  }
  return files;
}

const context = await createIsolatedTestRoot({
  prefix: "lca-runtime-performance-",
  protectedPaths: [path.resolve("..")]
});
const gitFixture = await createGitFixture(context, {
  initialFiles: buildFixtureFiles()
});
const workspace = gitFixture.fixtureDir;

let runtime;
let rpcClient;
let succeeded = false;
const measured = {
  toolsListBytes: null,
  trivialP95Ms: null,
  dispatchP95Ms: null,
  snapshotColdMs: null,
  snapshotWarmP95Ms: null,
  codeQueryColdMs: null,
  codeQueryWarmP95Ms: null,
  widgetAutocompleteBackendP95Ms: null,
  widgetAutocompleteEndToEndP95Ms: null,
  widgetRenderBackendP95Ms: null,
  widgetRenderEndToEndP95Ms: null,
  defaultBudgetChars: null,
  explicitBudgetChars: null
};

try {
  runtime = await startTestServer({
    workspace,
    dataDir: context.dataDir,
    runId: context.runId,
    mode: "safe",
    policy: "full",
    env: {
      LCA_TEST_RUNTIME_DIAGNOSTICS: "0",
      AGENT_DEFAULT_RESPONSE_CHARS: String(DEFAULT_RESPONSE_BUDGET),
      AGENT_MAX_RESPONSE_CHARS: String(HARD_RESPONSE_BUDGET),
      AGENT_MAX_READ_CHARS: "400000",
      AGENT_READ_DEFAULT: "12000",
      AGENT_READ_MANY_FILE_DEFAULT: "16000",
      AGENT_MAX_BATCH_READ_CHARS: "100000",
      AGENT_SEARCH_OUTPUT_DEFAULT: "15000",
      // Keep the complete measured sample while still forcing at least one
      // rotation. The runtime retains five generations, so a tiny 8 KiB file
      // would legitimately evict the beginning of this benchmark.
      AGENT_AUDIT_ROTATE_BYTES: "32768"
    }
  });
  rpcClient = await createRpcClient(runtime.port);

  const listed = await rpcClient.rpc("tools/list", {});
  const tools = listed.message?.result?.tools || [];
  const names = tools.map((tool) => tool.name);
  measured.toolsListBytes = listed.bytes;
  check(
    "Runtime production catalog exposes exactly 35 fixed tools",
    names.length === 35 && [...names].sort().join("\n") === [...EXPECTED_TOOLS].sort().join("\n"),
    `count=${names.length}; names=${names.join(",")}`
  );
  check(
    "tools/list stays below the 25 KB raw budget",
    listed.bytes < MAX_TOOLS_LIST_BYTES,
    `bytes=${listed.bytes}`
  );

  const initialStatus = (await rpcClient.callTool("lca_status")).data;
  check(
    "lca_status reports Runtime catalog and configured response budgets",
    initialStatus.catalog_version === 5 &&
      initialStatus.tool_catalog === "fixed" &&
      initialStatus.limits?.response_default_chars === DEFAULT_RESPONSE_BUDGET &&
      initialStatus.limits?.response_hard_max_chars === HARD_RESPONSE_BUDGET,
    JSON.stringify(initialStatus.limits)
  );
  check(
    "runtime telemetry exposes session, memory, event-loop and tool counters",
    initialStatus.runtime?.sessions?.active === 1 &&
      initialStatus.runtime?.memory?.rss > 0 &&
      initialStatus.runtime?.event_loop_delay_ms &&
      Number.isInteger(initialStatus.runtime?.tools?.calls),
    JSON.stringify(initialStatus.runtime)
  );

  for (let index = 0; index < 5; index++) await rpcClient.callTool("lca_status");
  // A p95 computed from 30 requests is dominated by only two samples and is
  // unstable when the audit stream rotates or V8 performs an ordinary minor
  // collection. Keep this long enough to include those periodic costs in a
  // representative percentile instead of accidentally treating one as p95.
  const trivialDurations = [];
  for (let index = 0; index < 120; index++) {
    const response = await rpcClient.callTool("lca_status");
    trivialDurations.push(response.durationMs);
  }
  measured.trivialP95Ms = round(percentile(trivialDurations, 95));
  check(
    "loopback client round-trip remains bounded",
    measured.trivialP95Ms < 75,
    `p95=${measured.trivialP95Ms}ms`
  );

  const sessionStatus = (await rpcClient.callTool("lca_status")).data;
  measured.dispatchP95Ms = sessionStatus.runtime?.sessions?.stateful_dispatch?.p95_ms ?? null;
  check(
    "repeated POST requests reuse one stateful MCP session",
    sessionStatus.runtime?.sessions?.active === 1 &&
      sessionStatus.runtime?.sessions?.total_requests >= trivialDurations.length + 5,
    JSON.stringify(sessionStatus.runtime?.sessions)
  );
  check(
    "stateful MCP dispatch p95 stays below 0.5 ms",
    sessionStatus.runtime?.sessions?.stateful_dispatch?.sample_size >= trivialDurations.length &&
      sessionStatus.runtime.sessions.stateful_dispatch.p95_ms < 0.5,
    JSON.stringify(sessionStatus.runtime?.sessions?.stateful_dispatch)
  );

  const openedTaskResponse = (await rpcClient.callTool("task_open", {
    title: "Runtime performance task"
  })).data;
  const openedTask = openedTaskResponse.task;
  check(
    "coding tools are bound to an explicit stateful task",
    openedTask.id?.startsWith("task_") &&
      openedTask.primary_workspace_id &&
      openedTask.workspace_set_frozen === false,
    JSON.stringify(openedTask)
  );

  const coldSnapshot = await rpcClient.callTool("workspace_snapshot", {
    focus: "changeJournalStep42",
    include_matches: true,
    include_snippets: true,
    max_entries: 160,
    max_output_chars: 60_000,
    refresh: true
  });
  measured.snapshotColdMs = round(coldSnapshot.durationMs);
  check(
    "workspace_snapshot cold pass builds bounded graph evidence",
    coldSnapshot.data.kind === "workspace_snapshot" &&
      coldSnapshot.data.graph?.coverage?.indexed_files >= 240 &&
      coldSnapshot.data.evidence?.count > 0 &&
      coldSnapshot.data.tree?.entries?.length <= 160,
    JSON.stringify({
      graph: coldSnapshot.data.graph,
      evidence: coldSnapshot.data.evidence,
      treeEntries: coldSnapshot.data.tree?.entries?.length
    })
  );

  const snapshotDurations = [];
  for (let index = 0; index < 6; index++) {
    const response = await rpcClient.callTool("workspace_snapshot", {
      max_entries: 160,
      max_output_chars: 60_000
    });
    snapshotDurations.push(response.durationMs);
  }
  measured.snapshotWarmP95Ms = round(percentile(snapshotDurations, 95));
  check(
    "warm workspace_snapshot on the CI fixture remains bounded",
    measured.snapshotWarmP95Ms < 750,
    `p95=${measured.snapshotWarmP95Ms}ms`
  );

  const coldQuery = await rpcClient.callTool("code_query", {
    query: "changeJournalStep42",
    mode: "symbol",
    depth: "fast",
    limit: 20
  });
  measured.codeQueryColdMs = round(coldQuery.durationMs);
  check(
    "code_query returns fast-first metadata and workspace-qualified results",
    coldQuery.data.count > 0 &&
      coldQuery.data.engine === "lexical" &&
      coldQuery.data.freshness &&
      coldQuery.data.completeness &&
      Number.isFinite(coldQuery.data.confidence) &&
      coldQuery.data.results?.every((result) =>
        result.location?.workspace_id && !path.isAbsolute(result.location?.path || "")
      ),
    JSON.stringify(coldQuery.data)
  );

  const queryDurations = [];
  for (let index = 0; index < 12; index++) {
    const response = await rpcClient.callTool("code_query", {
      query: `changeJournalStep${index}`,
      mode: "definition",
      depth: "fast",
      limit: 5
    });
    queryDurations.push(response.durationMs);
  }
  measured.codeQueryWarmP95Ms = round(percentile(queryDurations, 95));
  check(
    "warm fast code_query remains below its local CI bound",
    measured.codeQueryWarmP95Ms < 400,
    `p95=${measured.codeQueryWarmP95Ms}ms`
  );

  // Exercise the fixed-catalog calls used by the compact ChatGPT widget.
  // The widget composes prompts locally; its backend work is bounded file and
  // symbol autocomplete plus the small lca_input render payload.
  const widgetContext = {
    task_token: openedTask.task_token,
    workspace_id: openedTask.primary_workspace_id
  };
  for (let index = 0; index < 5; index++) {
    await Promise.all([
      rpcClient.callTool("find_files", {
        glob: `*module-${String(index).padStart(3, "0")}*`,
        limit: 24,
        ...widgetContext
      }),
      rpcClient.callTool("code_query", {
        query: `changeJournalStep${index}`,
        mode: "symbol",
        depth: "fast",
        limit: 12,
        ...widgetContext
      })
    ]);
  }
  const widgetAutocompleteDurations = [];
  for (let index = 0; index < 30; index++) {
    const moduleIndex = index % 24;
    const startedAt = performance.now();
    const [files, symbols] = await Promise.all([
      rpcClient.callTool("find_files", {
        glob: `*module-${String(moduleIndex).padStart(3, "0")}*`,
        limit: 24,
        ...widgetContext
      }),
      rpcClient.callTool("code_query", {
        query: `changeJournalStep${moduleIndex}`,
        mode: "symbol",
        depth: "fast",
        limit: 12,
        ...widgetContext
      })
    ]);
    widgetAutocompleteDurations.push(performance.now() - startedAt);
    check(
      `widget autocomplete stays workspace-qualified ${index}`,
      files.data.workspace_id === openedTask.primary_workspace_id &&
        files.data.files?.every((entry) => entry.workspace_id === openedTask.primary_workspace_id && !path.isAbsolute(entry.path)) &&
        symbols.data.results?.every((entry) => entry.location?.workspace_id === openedTask.primary_workspace_id && !path.isAbsolute(entry.location?.path || "")),
      JSON.stringify({ files: files.data, symbols: symbols.data })
    );
  }
  measured.widgetAutocompleteEndToEndP95Ms = round(percentile(widgetAutocompleteDurations, 95));
  check(
    "widget autocomplete end-to-end p95 stays below 300 ms",
    measured.widgetAutocompleteEndToEndP95Ms < 300,
    `p95=${measured.widgetAutocompleteEndToEndP95Ms}ms`
  );

  const widgetRenderDurations = [];
  for (let index = 0; index < 30; index++) {
    const response = await rpcClient.callTool("lca_input", {
      initial_input: `/implement update module ${index}`
    });
    widgetRenderDurations.push(response.durationMs);
    check(
      `widget render preserves task/workspace ${index}`,
      response.data.task_id === openedTask.id &&
        response.data.workspace?.workspace_id === openedTask.primary_workspace_id &&
        response.data.initial_input === `/implement update module ${index}`,
      JSON.stringify(response.data)
    );
  }
  measured.widgetRenderEndToEndP95Ms = round(percentile(widgetRenderDurations, 95));
  check(
    "widget render end-to-end p95 stays below 300 ms",
    measured.widgetRenderEndToEndP95Ms < 300,
    `p95=${measured.widgetRenderEndToEndP95Ms}ms`
  );

  const oversizedRead = await rpcClient.callTool("read_file", {
    path: "fixture/data/oversized.txt",
    max_chars: 300_000
  });
  measured.defaultBudgetChars = oversizedRead.text.length;
  check(
    "default 64 KB response budget returns a truncation envelope",
    oversizedRead.data.response_truncated === true &&
      oversizedRead.data.max_chars === DEFAULT_RESPONSE_BUDGET &&
      oversizedRead.bytes <= DEFAULT_RESPONSE_BUDGET,
    JSON.stringify({
      httpBytes: oversizedRead.bytes,
      textChars: oversizedRead.text.length,
      responseTruncated: oversizedRead.data.response_truncated,
      maxChars: oversizedRead.data.max_chars
    })
  );

  const explicitBudget = await rpcClient.callTool("search_text", {
    query: "performance-budget-needle",
    path: "fixture/data/search-corpus.txt",
    limit: 500,
    max_output_chars: 200_000
  });
  measured.explicitBudgetChars = explicitBudget.text.length;
  check(
    "explicit large response remains under the hard 200 KB budget",
    explicitBudget.bytes <= HARD_RESPONSE_BUDGET &&
      (
        (
          explicitBudget.data.returned <= explicitBudget.data.count &&
          typeof explicitBudget.data.truncated === "boolean"
        ) ||
        (
          explicitBudget.data.response_truncated === true &&
          explicitBudget.data.max_chars === 200_000
        )
      ),
    JSON.stringify({
      httpBytes: explicitBudget.bytes,
      textChars: explicitBudget.text.length,
      returned: explicitBudget.data.returned,
      count: explicitBudget.data.count,
      truncated: explicitBudget.data.truncated
    })
  );

  const finalStatus = (await rpcClient.callTool("lca_status")).data;
  check(
    "tool telemetry accumulates calls and largest-output metrics",
    finalStatus.runtime?.tools?.calls >= 50 &&
      finalStatus.runtime?.tools?.outputChars > 0 &&
      finalStatus.runtime?.tools?.largestOutputChars > 0 &&
      typeof finalStatus.runtime?.tools?.largestOutputTool === "string",
    JSON.stringify(finalStatus.runtime?.tools)
  );

  succeeded = fail === 0;
} finally {
  if (rpcClient) await rpcClient.close().catch(() => {});
  if (runtime) await stopTestProcess(runtime.child);
  try {
    const auditDir = path.join(context.dataDir, "runtime");
    const auditFiles = (await readdir(auditDir))
      .filter((name) => /^audit\.log(?:\.\d+)?$/.test(name))
      .sort();
    const audit = (await Promise.all(auditFiles.map((name) =>
      readFile(path.join(auditDir, name), "utf8")
    ))).join("");
    const entries = audit
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const statefulRequests = entries.filter(
      (entry) => entry.kind === "mcp_request" && entry.sessionMode === "stateful"
    );
    const statusRequests = statefulRequests.filter(
      (entry) => entry.tool === "lca_status" && Number.isFinite(entry.handlerMs)
    );
    const widgetFileRequests = statefulRequests.filter(
      (entry) => entry.tool === "find_files" && Number.isFinite(entry.handlerMs)
    );
    const widgetSymbolRequests = statefulRequests.filter(
      (entry) => entry.tool === "code_query" && Number.isFinite(entry.handlerMs)
    );
    const widgetAutocompleteRequests = [...widgetFileRequests, ...widgetSymbolRequests];
    const widgetRenderRequests = statefulRequests.filter(
      (entry) => entry.tool === "lca_input" && Number.isFinite(entry.handlerMs)
    );
    const handlerP95 = percentile(statusRequests.map((entry) => entry.handlerMs), 95);
    const serverTotalP95 = percentile(statusRequests.map((entry) => entry.httpTotalMs), 95);
    const widgetAutocompleteHandlerP95 = percentile(widgetAutocompleteRequests.map((entry) => entry.handlerMs), 95);
    const widgetRenderHandlerP95 = percentile(widgetRenderRequests.map((entry) => entry.handlerMs), 95);
    measured.widgetAutocompleteBackendP95Ms = round(widgetAutocompleteHandlerP95);
    measured.widgetRenderBackendP95Ms = round(widgetRenderHandlerP95);
    check(
      "audit records correlated stateful request telemetry",
      statefulRequests.some((entry) =>
        entry.requestId &&
        Number.isFinite(entry.setupMs) &&
        Number.isFinite(entry.bodyParseMs) &&
        Number.isFinite(entry.transportMs) &&
        Number.isFinite(entry.httpTotalMs)
      ),
      audit.slice(-4000)
    );
    check(
      "audit records handler and serialization timing for tool calls",
      statusRequests.length >= 30 &&
        Number.isFinite(handlerP95) &&
        entries.some((entry) =>
          entry.kind === "mcp_request" &&
          entry.tool === "code_query" &&
          Number.isFinite(entry.handlerMs) &&
          Number.isFinite(entry.serializationMs)
        ),
      `statusRequests=${statusRequests.length}; handlerP95=${round(handlerP95)}ms`
    );
    check(
      "warm lca_status handler p95 stays below 5 ms",
      statusRequests.length >= 30 && Number.isFinite(handlerP95) && handlerP95 < 5,
      `statusRequests=${statusRequests.length}; handlerP95=${round(handlerP95)}ms`
    );
    check(
      "warm stateful lca_status server total p95 stays below 5 ms",
      statusRequests.length >= 30 && Number.isFinite(serverTotalP95) && serverTotalP95 < 5,
      `statusRequests=${statusRequests.length}; serverTotalP95=${round(serverTotalP95)}ms`
    );
    check(
      "widget autocomplete backend p95 stays below 50 ms",
      widgetFileRequests.length >= 30 &&
        widgetSymbolRequests.length >= 30 &&
        Number.isFinite(widgetAutocompleteHandlerP95) &&
        widgetAutocompleteHandlerP95 < 50,
      `files=${widgetFileRequests.length}; symbols=${widgetSymbolRequests.length}; p95=${round(widgetAutocompleteHandlerP95)}ms`
    );
    check(
      "widget render backend p95 stays below 50 ms",
      widgetRenderRequests.length >= 30 &&
        Number.isFinite(widgetRenderHandlerP95) &&
        widgetRenderHandlerP95 < 50,
      `requests=${widgetRenderRequests.length}; p95=${round(widgetRenderHandlerP95)}ms`
    );
    check(
      "audit rotates during runtime without dropping the telemetry stream",
      auditFiles.includes("audit.log.1") &&
        entries.filter((entry) => entry.kind === "tool").length >= 50 &&
        entries.some((entry) => entry.kind === "mcp_session" && entry.action === "close"),
      `files=${auditFiles.join(",")}; entries=${entries.length}`
    );
    console.log(
      `[MEASURE] lca_status handler p95=${round(handlerP95)}ms; ` +
      `server-total p95=${round(serverTotalP95)}ms; ` +
      `widget-autocomplete handler p95=${round(widgetAutocompleteHandlerP95)}ms; ` +
      `widget-render handler p95=${round(widgetRenderHandlerP95)}ms`
    );
  } catch (error) {
    check("audit file is readable", false, error?.message || String(error));
  }

  if (succeeded && fail === 0) {
    await safeRemove(workspace, context, { recursive: true, force: true });
    await safeRemove(context.dataDir, context, { recursive: true, force: true });
  } else {
    console.log(`Performance fixture retained for inspection: ${context.testRoot}`);
  }
}

console.log(
  `[MEASURE] tools/list=${measured.toolsListBytes}B; ` +
  `dispatch p95=${measured.dispatchP95Ms}ms; lca_status p95=${measured.trivialP95Ms}ms; ` +
  `snapshot cold=${measured.snapshotColdMs}ms warm-p95=${measured.snapshotWarmP95Ms}ms; ` +
  `code_query cold=${measured.codeQueryColdMs}ms warm-p95=${measured.codeQueryWarmP95Ms}ms; ` +
  `widget autocomplete backend/e2e p95=${measured.widgetAutocompleteBackendP95Ms}/${measured.widgetAutocompleteEndToEndP95Ms}ms; ` +
  `widget render backend/e2e p95=${measured.widgetRenderBackendP95Ms}/${measured.widgetRenderEndToEndP95Ms}ms; ` +
  `responses default=${measured.defaultBudgetChars} chars explicit=${measured.explicitBudgetChars} chars`
);
console.log(`\n==== Runtime PERFORMANCE RESULT: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);

async function createRpcClient(port) {
  let nextId = 1;
  let sessionId = null;

  const rpc = async (method, params = {}, { notification = false } = {}) => {
    const started = performance.now();
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
        ...(notification ? {} : { id: nextId++ }),
        method,
        params
      })
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const returnedSessionId = response.headers.get("mcp-session-id");
    if (returnedSessionId) sessionId = returnedSessionId;
    const message = parseMcpResponse(
      buffer.toString("utf8"),
      response.headers.get("content-type")
    );
    if (!response.ok || message?.error) {
      throw new Error(
        `${method} failed (${response.status}): ${JSON.stringify(message?.error || buffer.toString("utf8"))}`
      );
    }
    return {
      status: response.status,
      bytes: buffer.byteLength,
      durationMs: performance.now() - started,
      message
    };
  };

  const initialized = await rpc("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "runtime-performance-test", version: "1.0.0" }
  });
  if (!sessionId) throw new Error(`initialize did not return an MCP session: ${JSON.stringify(initialized.message)}`);
  await rpc("notifications/initialized", {}, { notification: true });

  return {
    get sessionId() {
      return sessionId;
    },
    rpc,
    async callTool(name, args = {}) {
      const response = await rpc("tools/call", { name, arguments: args });
      const result = response.message?.result;
      const text = result?.content?.find((item) => item?.type === "text")?.text || "";
      if (result?.isError) throw new Error(`${name} failed: ${text}`);
      let data;
      try {
        data = result?.structuredContent && typeof result.structuredContent === "object"
          ? result.structuredContent
          : JSON.parse(text);
      } catch (error) {
        throw new Error(`${name} returned invalid JSON: ${error?.message || error}; text=${text.slice(0, 500)}`);
      }
      return { ...response, result, text, data };
    },
    async close() {
      if (!sessionId) return;
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "DELETE",
        headers: {
          "mcp-session-id": sessionId,
          "mcp-protocol-version": PROTOCOL_VERSION
        }
      });
      if (![200, 204].includes(response.status)) {
        throw new Error(`session close failed: HTTP ${response.status}`);
      }
      sessionId = null;
    }
  };
}

function parseMcpResponse(body, contentType = "") {
  if (!body.trim()) return null;
  if (!String(contentType || "").includes("text/event-stream")) return JSON.parse(body);
  const messages = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return messages.at(-1) || null;
}
