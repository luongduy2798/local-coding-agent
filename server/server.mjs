// Local Coding Agent
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
  rename,
  rm,
  appendFile,
  access,
  copyFile,
  cp
} from "node:fs/promises";
import { createWriteStream, readFileSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { summarizeArgs } from "./core/redaction.mjs";
import {
  VERSION,
  PRODUCT_TIER,
  COMPANION_WIDGET_URI,
  DEFAULT_ACCESS_MODE,
  DEFAULT_POLICY,
  DEFAULT_WORKFLOW_MODE,
  EXPLICIT_VERIFICATION_INSTRUCTION,
  CODE_MUTATION_TOOLS,
  POTENTIAL_CODE_MUTATION_TOOLS,
  BACKGROUND_CODE_ACTIVITY_TOOLS,
  toolCanAffectCode,
  collectMutationPaths,
  mutationTouchesCode,
  isCodePath
} from "./core/constants.mjs";
import { buildChildEnv } from "./core/child-env.mjs";
import { createTaskRuntime } from "./core/task-runtime.mjs";
import { createAtomicMutationEngine } from "./core/atomic-mutation.mjs";
import { discoverInstructionChain, buildProjectGraph } from "./core/repo-intelligence.mjs";
import { createHookManager, HOOK_EVENTS } from "./core/hooks.mjs";
import { wrapSpawnSpec, boundaryStatus } from "./core/execution-boundary.mjs";
  DEFAULT_FIGMA_DESKTOP_MCP_URL,
  callFigmaDesktopTool,
  figmaDesktopStatus,
  listFigmaDesktopTools,
  parseFigmaNodeReference
} from "./figma-desktop.mjs";

// ----------------------------------------------------------------------------
// Configuration (all overridable via environment variables)
// ----------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 8789);
// Bind to loopback by default. The local OpenAI tunnel-client forwards to this,
// so we never need to listen on 0.0.0.0 (which would expose a shell to the LAN).
const HOST = process.env.AGENT_HOST || "127.0.0.1";

const CONFIG_ID = String(process.env.AGENT_CONFIG_ID || "");

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPANION_WIDGET_PATH = path.join(APP_DIR, "lca-compact-input-v2.html");
const DEFAULT_WORKSPACE = path.resolve(APP_DIR, "..", "agent-workspace");
const PRIMARY_ROOT = path.resolve(process.env.AGENT_WORKSPACE || DEFAULT_WORKSPACE);
const STARTUP_PROFILE = (() => {
  try {
    return JSON.parse(readFileSync(path.join(PRIMARY_ROOT, ".agent", "profile.json"), "utf8"));
  } catch {
    return null;
  }
})();
const EXTRA_ROOTS = parseExtraRoots();
const ROOTS = dedupe([PRIMARY_ROOT, ...EXTRA_ROOTS]);

// Access defaults to full for trusted local development. Safe and balanced
// remain available for users who explicitly select them.
const ACCESS_MODE = (() => {
  const raw = String(
    process.env.AGENT_ACCESS_MODE ||
    process.env.AGENT_MODE ||
    STARTUP_PROFILE?.accessMode ||
    STARTUP_PROFILE?.mode ||
    DEFAULT_ACCESS_MODE
  ).toLowerCase();
  return raw === "safe" || raw === "balanced" ? raw : "full";
})();
const MODE = ACCESS_MODE === "full" ? "full" : "safe";
const WORKFLOW_MODE = (() => {
  const raw = String(process.env.AGENT_WORKFLOW_MODE || STARTUP_PROFILE?.workflowMode || DEFAULT_WORKFLOW_MODE).toLowerCase();
  return raw === "fast" || raw === "plan" ? raw : "auto";
})();
const ALLOW_DANGEROUS = process.env.AGENT_ALLOW_DANGEROUS === "1";
const CHILD_ENV_EXCLUDE = Array.isArray(STARTUP_PROFILE?.excludedCommandEnv)
  ? STARTUP_PROFILE.excludedCommandEnv.map(String)
  : [];

// Optional defense-in-depth bearer token. If set, every /mcp request must send
// Authorization: Bearer <token>. Leave empty when relying on the
// OpenAI Secure MCP Tunnel, whose channel is already private to your account.
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const APPROVAL_TOKEN = process.env.AGENT_APPROVAL_TOKEN || "";
const ALLOWED_ORIGINS = new Set(
  String(process.env.MCP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const DATA_DIR = path.resolve(APP_DIR, "data");
const WORKSPACE_ID = createHash("sha256").update(comparePath(PRIMARY_ROOT)).digest("hex").slice(0, 16);
const WORKSPACE_DATA_DIR = path.join(DATA_DIR, "workspaces", WORKSPACE_ID);
const NOTES_PATH = path.resolve(WORKSPACE_DATA_DIR, "notes.json");
const CHECKPOINT_PATH = path.resolve(WORKSPACE_DATA_DIR, "checkpoint.json");
const AUDIT_PATH = path.resolve(DATA_DIR, "audit.log");
const AUDIT_ENABLED = process.env.AGENT_AUDIT !== "0";
const AUDIT_ARGS = process.env.AGENT_AUDIT_ARGS !== "0";
const HTTP_LOG = process.env.AGENT_HTTP_LOG === "1";

// Figma Desktop exposes a local MCP server after the user enables it in Dev Mode.
// LCA acts as an MCP client and forwards results without managing Figma tokens.
const FIGMA_DESKTOP_MCP_URL = String(process.env.FIGMA_DESKTOP_MCP_URL || DEFAULT_FIGMA_DESKTOP_MCP_URL).trim();
const FIGMA_DESKTOP_TIMEOUT_MS = boundedNumber(process.env.FIGMA_DESKTOP_TIMEOUT_MS, 30_000, 1_000, 120_000);
const FIGMA_DESKTOP_READ_ONLY_TOOLS = new Set([
  "get_code_connect_map",
  "get_code_connect_suggestions",
  "get_design_context",
  "get_figjam",
  "get_metadata",
  "get_screenshot",
  "get_shader_effect",
  "get_shader_fill",
  "get_variable_defs",
  "list_shader_effects",
  "list_shader_fills"
]);

// v2.1 Repo index cache
const INDEX_PATH = path.resolve(WORKSPACE_DATA_DIR, "index.json");

// v2.2 Patch history
const PATCH_HISTORY_PATH = path.resolve(WORKSPACE_DATA_DIR, "patch-history.json");
const BACKUPS_DIR = path.resolve(WORKSPACE_DATA_DIR, "backups");
const WORKTREES_DIR = path.resolve(WORKSPACE_DATA_DIR, "worktrees");
const WORKTREES_STATE_PATH = path.resolve(WORKSPACE_DATA_DIR, "worktrees.json");
const PROCESS_STATE_PATH = path.resolve(WORKSPACE_DATA_DIR, "processes.json");

// v2.5 Planner state
const AGENT_STATE_DIR = path.join(PRIMARY_ROOT, ".agent", "state");
const TASK_PLAN_PATH = path.join(AGENT_STATE_DIR, "current-task.json");
const DECISIONS_PATH = path.join(AGENT_STATE_DIR, "decisions.md");
const TASK_RUNTIME = createTaskRuntime({
  dataDir: WORKSPACE_DATA_DIR,
  root: PRIMARY_ROOT,
  defaultAccessMode: ACCESS_MODE,
  defaultWorkflowMode: WORKFLOW_MODE,
  version: VERSION
});
let MUTATION_ENGINE = null;
const HOOK_MANAGER = createHookManager({ root: PRIMARY_ROOT, excludedEnv: CHILD_ENV_EXCLUDE, accessMode: ACCESS_MODE });

// v2.6 Approvals
const APPROVALS_DIR = path.resolve(WORKSPACE_DATA_DIR, "approvals");
const APPROVAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPROVAL_TTL_MINUTES = boundedNumber(process.env.AGENT_APPROVAL_TTL_MINUTES, 10, 1, 30);

// v2.6 Policy
const AGENT_POLICY = (() => {
  const accessDefault = ACCESS_MODE === "full" ? DEFAULT_POLICY : ACCESS_MODE === "balanced" ? "balanced" : "strict";
  const p = String(process.env.AGENT_POLICY || STARTUP_PROFILE?.policy || accessDefault).toLowerCase();
  if (p === "strict" || p === "full") return p;
  return "balanced";
})();

// v2.8 Profile
let WORKSPACE_PROFILE = STARTUP_PROFILE;

// Skills: reusable playbooks the agent can load on demand (Claude-style).
// Discovered from: AGENT_SKILLS_DIR (env), the repo's shipped skills/, and each
// workspace root's .claude/skills and .agent/skills.
const SKILLS_DIRS = dedupe([
  ...(process.env.AGENT_SKILLS_DIR ? [path.resolve(process.env.AGENT_SKILLS_DIR)] : []),
  path.resolve(APP_DIR, "..", "skills"),
  ...ROOTS.flatMap((r) => [path.join(r, ".claude", "skills"), path.join(r, ".agent", "skills")])
]);

const MAX_READ_CHARS = Number(process.env.AGENT_MAX_READ_CHARS || 200_000);
// Default (not max) chars returned by read_file — keeps payloads small so the
// ChatGPT UI does not choke on huge file dumps. Callers can raise via max_chars.
const READ_DEFAULT = Number(process.env.AGENT_READ_DEFAULT || 30_000);
const CMD_OUTPUT_DEFAULT = Number(process.env.AGENT_CMD_OUTPUT_DEFAULT || 20_000);
const MAX_COMMAND_OUTPUT = Number(process.env.AGENT_MAX_COMMAND_OUTPUT || 200_000);
const MAX_BATCH_READ_CHARS = boundedNumber(process.env.AGENT_MAX_BATCH_READ_CHARS, 500_000, 10_000, 2_000_000);
const MAX_BODY_BYTES = Number(process.env.AGENT_MAX_BODY_BYTES || 16 * 1024 * 1024);
const DEFAULT_CMD_TIMEOUT = 60_000;
const MAX_PROCS = 24;
const PROC_BUFFER = 200_000;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".venv",
  "__pycache__",
  ...((Array.isArray(STARTUP_PROFILE?.ignoredDirs) ? STARTUP_PROFILE.ignoredDirs : []).map(String))
]);

// Always blocked, even in full mode, unless AGENT_ALLOW_DANGEROUS=1.
// These can brick the OS or wipe disks regardless of working directory.
const CATASTROPHIC = [
  // Disk format command only (e.g. "format C:", "format /fs:ntfs D:").
  // Must NOT match PowerShell's Format-Table / Format-List / -f format operator.
  /(^|[;&|]\s*)format(\.com)?\s+(\/|[a-z]:)/i,
  /\bdiskpart\b/i,
  /\bmkfs\b/i,
  /\bfdisk\b/i,
  /\bshutdown\b/i,
  /\brestart-computer\b/i,
  /\bstop-computer\b/i,
  /\bremove-item\b[^\n]*\b(c:\\\\|c:\/|\$env:systemroot|system32|windows\\\\)/i,
  /\b(rd|rmdir)\b\s+\/s[^\n]*\bc:\\\\/i,
  /\bdel\b[^\n]*\/s[^\n]*\bc:\\\\/i,
  /\bcipher\b\s+\/w/i,
  /\b(reg)\b\s+delete\s+hk(lm|ey_local_machine)/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, // fork bomb
  // --- Unix / macOS / Linux ---
  /\brm\s+-[rRfile]*\s+(--no-preserve-root\s+)?\/(\s|$|\*)/i, // rm -rf /
  /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd)/i, // overwrite a disk
  /\bmkfs\.[a-z0-9]+\b/i,
  /\b(reboot|halt|poweroff|init\s+0)\b/i,
  /\bchmod\s+-R\s*0*\s+\//i,
  />\s*\/dev\/(sd|nvme|disk|hd)[a-z0-9]/i // write to raw disk
];

// Extra blocks that only apply in "safe" mode.
const SAFE_MODE_BLOCKS = [
  /\b(del|erase|rmdir|rd|remove-item|rm|format|shutdown|restart-computer|stop-computer|diskpart)\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\breg\s+delete\b/i,
  /\btakeown\b/i,
  /\bicacls\b/i,
  /[a-z]:\\/i,
  /(^|\s)~[\\/]/i
];

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------
const processes = new Map(); // id -> { id, name, command, child, status, exitCode, startedAt, stdout, stderr }
let approvalLock = Promise.resolve();
let auditStream = null;

// ----------------------------------------------------------------------------
// Bootstrap
// ----------------------------------------------------------------------------
await mkdir(DATA_DIR, { recursive: true });
await mkdir(WORKSPACE_DATA_DIR, { recursive: true });
await mkdir(PRIMARY_ROOT, { recursive: true });
await mkdir(BACKUPS_DIR, { recursive: true });
await mkdir(APPROVALS_DIR, { recursive: true });
await mkdir(AGENT_STATE_DIR, { recursive: true });
MUTATION_ENGINE = createAtomicMutationEngine({
  dataDir: WORKSPACE_DATA_DIR,
  resolvePath,
  toRel,
  maxHistory: 100
});
await MUTATION_ENGINE.cleanupOrphans();
await restoreProcessState();
await HOOK_MANAGER.run("SessionStart", {
  version: VERSION,
  accessMode: ACCESS_MODE,
  workflowMode: WORKFLOW_MODE,
  root: PRIMARY_ROOT
}).catch(() => {});
if (AUDIT_ENABLED) {
  auditStream = createWriteStream(AUDIT_PATH, { flags: "a" });
  auditStream.on("error", () => {});
}

// v2.8 Load workspace profile on startup
await loadWorkspaceProfile();

// Detect ripgrep once at startup — the fastest search engine when present.
const RG_BIN = await detectRg();
if (RG_BIN) console.log("ripgrep detected: search_text/find_files will use rg");

function detectRg() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("rg", ["--version"], { windowsHide: true });
    } catch {
      return resolve(null);
    }
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? "rg" : null));
  });
}

const httpServer = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || HOST}`);
    if (HTTP_LOG) log(`${req.method} ${requestUrl.pathname} ua=${req.headers["user-agent"] || ""}`);
    if (!originAllowed(req)) {
      return sendJson(res, 403, { error: "browser_origin_not_allowed" });
    }
    setCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = requestUrl;
    if (req.method === "GET" && url.pathname === "/") {
      return sendJson(res, 200, {
        status: "ok",
        version: VERSION,
        mode: MODE,
        access_mode: ACCESS_MODE,
        workflow_mode: WORKFLOW_MODE,
        policy: AGENT_POLICY,
        verification: { tests: "explicit", lint: "explicit", build: "explicit" },
        dashboard: { show_on_code_change: true, all_modes: true },
        roots: ROOTS,
        mcp_endpoint: `http://${HOST}:${PORT}/mcp`
      });
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, {
        status: "ok",
        version: VERSION,
        tier: PRODUCT_TIER,
        pid: process.pid,
        mode: MODE,
        access_mode: ACCESS_MODE,
        workflow_mode: WORKFLOW_MODE,
        policy: AGENT_POLICY,
        verification: { tests: "explicit", lint: "explicit", build: "explicit" },
        dashboard: { show_on_code_change: true, all_modes: true },
        allow_dangerous: ALLOW_DANGEROUS,
        auth: AUTH_TOKEN ? "bearer" : "none",
        config_id: CONFIG_ID || null,
        roots: ROOTS,
        workspace: PRIMARY_ROOT,
        mcp_endpoint: `http://${HOST}:${PORT}/mcp`
      });
    }
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
      return sendJson(res, 200, oauthProtectedResourceMetadata());
    }
    if (url.pathname === "/mcp") {
      if (!checkAuth(req, url)) {
        return sendJson(res, 401, {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized." },
          id: null
        });
      }
      return await handleMcp(req, res);
    }
    return sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    if (!res.headersSent && !res.destroyed) {
      return sendJson(res, error?.statusCode || 500, { error: error?.message || "Internal Server Error" });
    }
  }
});

httpServer.on("error", (err) => {
  if (err?.code === "EADDRINUSE") {
    console.error(`FATAL: MCP port ${PORT} is already in use — another server instance is likely running. Exiting.`);
    process.exit(1);
  }
  log(`httpServer error: ${err?.message || err}`);
});

httpServer.listen(PORT, HOST, () => {
  console.log(`Local Coding Agent v${VERSION} listening on http://${HOST}:${PORT}`);
  console.log(`Mode: ${MODE}${ALLOW_DANGEROUS ? " (+dangerous)" : ""}  Auth: ${AUTH_TOKEN ? "bearer" : "none (tunnel-only)"}`);
  console.log(`Roots:\n${ROOTS.map((r) => `  - ${r}`).join("\n")}`);
  console.log(`MCP endpoint: http://${HOST}:${PORT}/mcp`);
});

// Never let a single bad request take the whole server down.
process.on("uncaughtException", (err) => log(`uncaughtException: ${err?.stack || err}`));
process.on("unhandledRejection", (err) => log(`unhandledRejection: ${err?.stack || err}`));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`${sig} received, shutting down`);
    for (const proc of processes.values()) killProcessTree(proc);
    try { auditStream?.end(); } catch {}
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

// ----------------------------------------------------------------------------
// Auth + transport
// ----------------------------------------------------------------------------
function checkAuth(req, url) {
  if (!AUTH_TOKEN) return true;
  const header = req.headers["authorization"] || "";
  const fromHeader = header.startsWith("Bearer ") ? header.slice(7) : "";
  return safeEqual(fromHeader, AUTH_TOKEN);
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function handleMcp(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null
    });
  }
  const len = Number(req.headers["content-length"] || 0);
  if (len > MAX_BODY_BYTES) {
    return sendJson(res, 413, {
      jsonrpc: "2.0",
      error: { code: -32002, message: "Payload too large." },
      id: null
    });
  }
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  await transport.handleRequest(req, res, body);
}

const SERVER_INSTRUCTIONS = [
  "Local Coding Agent Pro MCP: tool calls cross a tunnel, so start with workspace_snapshot or workspace_doctor, then use read_many/search_text/run_commands to batch work; prefer dedicated tools over run_command. Access defaults to full, while balanced/safe remain configurable. File tools are root-confined, but commands are not an OS sandbox in full mode.",
  `WORKFLOW: access_mode=${ACCESS_MODE}, workflow_mode=${WORKFLOW_MODE}. Use fast execution for simple work, structured plans for difficult work, and task_prepare_implementation after the user presses Implement. Every successful code mutation returns the Apps SDK task dashboard in every access/workflow mode. ${EXPLICIT_VERIFICATION_INSTRUCTION}`,
  "WORKFLOW DETAILS: (1) Start with workspace_snapshot for repo/git/policy in one call; use workspace_doctor when you need operational readiness. (2) Use read_many/search_text/repo_symbols to gather context in batches. (3) Use preview_patch/validate_patch before apply_patch for large edits. (4) Before marking 'done', call review_diff and session_report; never claim tests/build/lint passed when they were not explicitly requested. (5) For multi-step tasks, use task_create/plan_create or task_plan + decision_log to maintain state across chats.",
  "POLICY: Check policy_status if you are unsure whether an action is allowed. In balanced policy, risky operations (delete, install, network, mutating git, risky processes) require one-time approval with request_approval/request_approval_batch followed by approve_request using AGENT_APPROVAL_TOKEN.",
  "FIGMA: LCA bridges the official Figma Desktop MCP server at 127.0.0.1:3845. For a Figma URL or current desktop selection, prefer figma_get_design_context; also call figma_get_screenshot when visual fidelity matters. Use figma_status when the bridge is unavailable and figma_list_tools/figma_call_tool for newer upstream tools.",
  "Use the DEDICATED tools instead of run_command for these — they are faster and cheaper:",
  "- Find files by name -> find_files (NOT dir/ls/Get-ChildItem/where).",
  "- Search file contents -> search_text with context= (NOT grep/findstr/Select-String).",
  "- Read files -> read_many for several or targeted ranges, read_file for one (NOT type/cat/Get-Content).",
  "- Map a repo -> workspace_snapshot first, repo_map for deeper tree detail; use workspace_doctor for readiness checks.",
  "- Create/edit files -> write_file / apply_patch (with a unified `diff` for many edits) (NOT echo>/Set-Content).",
  "- Symbol search -> repo_symbols for function/class definitions.",
  "Reserve run_command for explicit user-requested builds, tests, installs, running programs, and git. When you do use it:",
  "- Pass the `cwd` argument instead of cd/pushd.",
  "- Combine multiple steps into ONE command (&& on cmd/bash, ; on PowerShell).",
  "- Keep output small with tail_lines/head_lines/max_output_chars.",
  "Keep the conversation light: do NOT re-read a file you already read; read only the line range you need; never dump a whole large file or large command output unless asked.",
  "When the conversation grows long or feels slow, call checkpoint() with a compact summary + next steps, then tell the user to open a NEW chat; in that fresh chat call resume() first. This resets the heavy context (faster) while keeping your progress.",
  "If a task matches an available skill, call list_skills first, then read_skill(name) to load its instructions before doing the work.",
  "For ChatGPT UI companion flows, call lca_input to render the Apps SDK widget in ChatGPT; the widget uses workspace_search for @ file/folder/symbol search, slash_commands for / workflow/mode/skill suggestions, and compose_prompt to turn sidebar input into a ready prompt. If the user only says 'lca' in a fresh chat, call the lca tool for workspace_info-style status.",
  "Prefer a few large, well-targeted calls over many tiny ones."
].join("\n");

function createMcpServer() {
  const mcp = new McpServer({ name: "Local Coding Agent", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  registerCompanionAppResources(mcp);
  registerBasicTools(mcp);
  registerFigmaDesktopTools(mcp);
  registerFsReadTools(mcp);
  registerFsWriteTools(mcp);
  registerExecTools(mcp);
  registerProcessTools(mcp);
  registerGitTool(mcp);
  registerWorktreeTools(mcp);     // v5.0 — task-isolated Git worktrees
  registerSkillTools(mcp);
  registerRepoIntelTools(mcp);    // v2.1 + v5 project graph/instructions
  registerCompanionTools(mcp);    // v2.9 — @ context + / workflow UI helpers
  registerPatchEngineTools(mcp);  // v2.2
  registerTestRunnerTools(mcp);   // v2.3
  registerReviewTools(mcp);       // v2.4
  registerPlannerTools(mcp);      // v2.5
  registerTaskRuntimeTools(mcp);  // v5.0 — persistent tasks/plans/dashboard
  registerHookTools(mcp);         // v5.3 — explicit lifecycle hooks
  registerPolicyTools(mcp);       // v2.6
  registerProfileTools(mcp);      // v2.8
  return mcp;
}


function registerFigmaDesktopTools(mcp) {
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };

  reg(
    mcp,
    "figma_status",
    {
      title: "Figma Desktop status",
      description: "Check whether the official Figma Desktop MCP server is enabled and list its available tools.",
      annotations: readOnly,
      inputSchema: {}
    },
    async () => jsonResult(await figmaDesktopStatus({ endpoint: FIGMA_DESKTOP_MCP_URL, timeoutMs: FIGMA_DESKTOP_TIMEOUT_MS }))
  );

  reg(
    mcp,
    "figma_list_tools",
    {
      title: "List Figma Desktop tools",
      description: "List the live tools and JSON schemas exposed by the official Figma Desktop MCP server.",
      annotations: readOnly,
      inputSchema: {}
    },
    async () => {
      const result = await listFigmaDesktopTools({ endpoint: FIGMA_DESKTOP_MCP_URL, timeoutMs: FIGMA_DESKTOP_TIMEOUT_MS });
      return jsonResult({ endpoint: FIGMA_DESKTOP_MCP_URL, count: result.tools.length, tools: result.tools });
    }
  );

  reg(
    mcp,
    "figma_call_tool",
    {
      title: "Call Figma Desktop tool",
      description: "Forward a call to any tool currently exposed by Figma Desktop MCP. Use figma_list_tools first for its exact schema.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      inputSchema: {
        tool: z.string().min(1).describe("Exact upstream Figma MCP tool name."),
        arguments: z.record(z.any()).optional().describe("Arguments matching the upstream tool JSON schema.")
      }
    },
    async ({ tool, arguments: args = {} }) => callFigmaDesktopTool(tool, args, { endpoint: FIGMA_DESKTOP_MCP_URL, timeoutMs: FIGMA_DESKTOP_TIMEOUT_MS })
  );

  registerFigmaReadWrapper(mcp, "figma_get_design_context", "get_design_context", "Get implementation-oriented design context for a Figma URL, node ID, or the current desktop selection.");
  registerFigmaReadWrapper(mcp, "figma_get_screenshot", "get_screenshot", "Get a screenshot of a Figma URL, node ID, or the current desktop selection.");
  registerFigmaReadWrapper(mcp, "figma_get_metadata", "get_metadata", "Get sparse layer metadata for a Figma URL, node ID, page, or current selection.");
  registerFigmaReadWrapper(mcp, "figma_get_variable_defs", "get_variable_defs", "Get variables and styles used by a Figma URL, node ID, or current selection.");
  registerFigmaReadWrapper(mcp, "figma_get_code_connect_map", "get_code_connect_map", "Get Code Connect mappings for a Figma URL, node ID, or current selection.");
  registerFigmaReadWrapper(mcp, "figma_get_figjam", "get_figjam", "Get XML context for a FigJam URL, node ID, or current selection.");
}

function registerFigmaReadWrapper(mcp, lcaName, upstreamName, description) {
  reg(
    mcp,
    lcaName,
    {
      title: upstreamName.replaceAll("_", " "),
      description,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        url: z.string().url().optional().describe("Optional Figma node/frame URL. The node-id is extracted automatically."),
        node_id: z.string().optional().describe("Optional node ID such as 123:456 or 123-456. Omit to use the current Figma desktop selection."),
        client_languages: z.array(z.string()).optional().describe("Languages used by the target codebase, forwarded as clientLanguages."),
        client_frameworks: z.array(z.string()).optional().describe("Frameworks or Code Connect labels, forwarded as clientFrameworks."),
        force_code: z.boolean().optional().describe("Forwarded as forceCode when supported by the upstream tool."),
        enable_base64_response: z.boolean().optional().describe("Forwarded as enableBase64Response when supported, mainly for screenshots."),
        arguments: z.record(z.any()).optional().describe("Additional or overriding upstream arguments for forward compatibility.")
      }
    },
    async (input) => {
      const args = buildFigmaDesktopArguments(input);
      return callFigmaDesktopTool(upstreamName, args, { endpoint: FIGMA_DESKTOP_MCP_URL, timeoutMs: FIGMA_DESKTOP_TIMEOUT_MS });
    }
  );
}

function buildFigmaDesktopArguments({
  url,
  node_id,
  client_languages,
  client_frameworks,
  force_code,
  enable_base64_response,
  arguments: extra = {}
} = {}) {
  const args = { ...(extra || {}) };
  const reference = parseFigmaNodeReference(url || node_id || "");
  if (reference.nodeId && args.nodeId === undefined) args.nodeId = reference.nodeId;
  if (client_languages?.length && args.clientLanguages === undefined) args.clientLanguages = client_languages;
  if (client_frameworks?.length && args.clientFrameworks === undefined) args.clientFrameworks = client_frameworks;
  if (force_code !== undefined && args.forceCode === undefined) args.forceCode = force_code;
  if (enable_base64_response !== undefined && args.enableBase64Response === undefined) args.enableBase64Response = enable_base64_response;
  return args;
}

function registerSkillTools(mcp) {
  reg(
    mcp,
    "list_skills",
    {
      title: "List skills",
      description: "List reusable skills (playbooks) available to load. Call this when a task might match a skill; it is cheap (names + descriptions only).",
      inputSchema: {}
    },
    async () => {
      const skills = await discoverSkills();
      return jsonResult({
        count: skills.length,
        skills: skills.map((s) => ({ name: s.name, description: s.description }))
      });
    }
  );

  reg(
    mcp,
    "read_skill",
    {
      title: "Read skill",
      description: "Load a skill's full instructions (SKILL.md) and its bundled file list. Call before doing work the skill covers.",
      inputSchema: { name: z.string().min(1).describe("Skill name from list_skills.") }
    },
    async ({ name }) => {
      const skills = await discoverSkills();
      const skill = skills.find((s) => s.name.toLowerCase() === String(name).toLowerCase());
      if (!skill) throw new Error(`No skill named "${name}". Use list_skills to see available skills.`);
      const body = await readFile(skill.skillFile, "utf8");
      let files = [];
      try {
        files = (await readdir(skill.dir)).filter((f) => f.toLowerCase() !== "skill.md");
      } catch {
        /* ignore */
      }
      return jsonResult({ name: skill.name, dir: skill.dir, files, content: body.slice(0, MAX_READ_CHARS) });
    }
  );

  reg(
    mcp,
    "create_skill",
    {
      title: "Create skill",
      description: "Author a reusable skill: writes <skillsdir>/<name>/SKILL.md with YAML frontmatter (name, description) plus your body. Default skillsdir is <PRIMARY_ROOT>/.claude/skills. After this, list_skills will show it.",
      inputSchema: {
        name: z.string().min(1).describe("Skill name (folder + frontmatter name), e.g. \"deploy-web\"."),
        description: z.string().min(1).describe("One-line description shown by list_skills."),
        body: z.string().describe("Markdown body of the skill (instructions). Written below the frontmatter."),
        dir: z.string().optional().describe("Skills directory to write into (must be inside a root). Default <PRIMARY_ROOT>/.claude/skills.")
      }
    },
    async ({ name, description, body, dir }) => {
      const folderName = sanitizeSkillName(name);
      if (!folderName) throw new Error("Invalid skill name. Use letters, digits, dot, dash or underscore.");
      const skillsDir = resolvePath(dir || defaultSkillsDir());
      const skillFolder = path.join(skillsDir, folderName);
      // Keep writes within a recognised skills dir (defense in depth).
      if (!isWithinSkillsDir(skillFolder)) {
        throw new Error("Refusing to write outside a skills directory.");
      }
      const skillFile = path.join(skillFolder, "SKILL.md");
      const frontName = String(name).replace(/"/g, '\\"');
      const frontDesc = String(description).replace(/\r?\n/g, " ").replace(/"/g, '\\"');
      const content = `---\nname: "${frontName}"\ndescription: "${frontDesc}"\n---\n\n${body || ""}${body && !body.endsWith("\n") ? "\n" : ""}`;
      await mkdir(skillFolder, { recursive: true });
      await writeFile(skillFile, content, "utf8");
      return jsonResult({ ok: true, name: folderName, dir: skillFolder, skill_file: skillFile });
    }
  );

  reg(
    mcp,
    "delete_skill",
    {
      title: "Delete skill",
      description: "Delete a skill folder (the directory holding its SKILL.md). Only removes folders located inside a skills directory.",
      inputSchema: {
        name: z.string().min(1).describe("Skill name from list_skills."),
        dir: z.string().optional().describe("Skills directory to look in (must be inside a root). Default <PRIMARY_ROOT>/.claude/skills.")
      }
    },
    async ({ name, dir }) => {
      const skills = await discoverSkills();
      let target = null;
      const hit = skills.find((s) => s.name.toLowerCase() === String(name).toLowerCase());
      if (hit) {
        target = hit.dir;
      } else {
        const folderName = sanitizeSkillName(name);
        if (folderName) target = path.join(resolvePath(dir || defaultSkillsDir()), folderName);
      }
      if (!target) throw new Error(`No skill named "${name}".`);
      const resolved = resolvePath(target);
      if (!isWithinSkillsDir(resolved)) {
        throw new Error("Refusing to delete a folder that is not inside a skills directory.");
      }
      if (!existsSync(resolved)) throw new Error(`No skill folder at ${resolved}.`);
      await rm(resolved, { recursive: true, force: true });
      return jsonResult({ ok: true, deleted: resolved });
    }
  );
}

// First workspace skills dir for authoring: <PRIMARY_ROOT>/.claude/skills.
function defaultSkillsDir() {
  return path.join(PRIMARY_ROOT, ".claude", "skills");
}

// Skill folder names: keep them simple path segments (no separators / traversal).
function sanitizeSkillName(name) {
  const s = String(name || "").trim();
  if (!s || s === "." || s === "..") return "";
  if (/[\\/]/.test(s) || !/^[\w.-]+$/.test(s)) return "";
  return s;
}

// A path is "inside a skills directory" if any segment of its parent chain is a
// known skills dir (from SKILLS_DIRS) or matches the .claude/skills | .agent/skills
// convention under a root. Used to confine create/delete to skills areas.
function isWithinSkillsDir(p) {
  const parent = path.dirname(p);
  const candidates = new Set(SKILLS_DIRS.map((d) => path.resolve(d)));
  candidates.add(path.resolve(defaultSkillsDir()));
  for (const root of ROOTS) {
    candidates.add(path.resolve(path.join(root, ".claude", "skills")));
    candidates.add(path.resolve(path.join(root, ".agent", "skills")));
  }
  return candidates.has(path.resolve(parent));
}


// ----------------------------------------------------------------------------
// Companion UI tools: @ context picker and / workflow command palette
// ----------------------------------------------------------------------------
const COMPANION_QUICK_ACTIONS = new Set(["plan"]);

const WORKFLOW_COMMANDS = [
  {
    name: "plan",
    type: "mode",
    command: "/plan",
    label: "Plan mode",
    description: "Inspect context, persist a versioned plan, and wait for the Apps SDK Implement button.",
    prompt: "Use plan mode. Do not edit files yet. Create a persistent task with task_create, inspect targeted context and AGENTS instructions, then call plan_create so the Apps SDK Plan card shows an Implement button. Tests/build/lint stay disabled unless explicitly selected."
  },
  {
    name: "implement",
    type: "workflow",
    command: "/implement",
    label: "Implement",
    description: "Apply a requested or accepted plan with focused edits; every code mutation opens the task dashboard.",
    prompt: "Implement the requested change using LCA tools. When a task/plan id is present, load and validate it first. Keep edits focused, preserve existing behavior, and do not run tests/build/lint unless explicitly requested. Every code mutation will render the dashboard automatically."
  },
  {
    name: "debug",
    type: "workflow",
    command: "/debug",
    label: "Debug",
    description: "Reproduce/inspect a problem, find the likely cause, then propose or apply a fix.",
    prompt: "Use debug workflow. Gather evidence first, isolate the likely cause, then propose a fix. Avoid guessing when a targeted read/search can verify it."
  },
  {
    name: "review",
    type: "workflow",
    command: "/review",
    label: "Review",
    description: "Review code or a diff for bugs, risks, and missing verification.",
    prompt: "Use review workflow. Call review_prepare with the requested scope, include untracked files when relevant, then focus on correctness, security, edge cases, compatibility, and missing verification. Return prioritized findings and concrete fixes."
  },
  {
    name: "refactor",
    type: "workflow",
    command: "/refactor",
    label: "Refactor",
    description: "Improve structure without changing intended behavior.",
    prompt: "Use refactor workflow. Preserve behavior, keep changes incremental, and call out any risk before editing."
  },
  {
    name: "release",
    type: "workflow",
    command: "/release",
    label: "Release",
    description: "Prepare/check a release: changelog, tests, versioning, packaging, and rollout notes.",
    prompt: "Use release workflow. Check repo state, versioning, release notes, and verification steps before suggesting a release."
  },
  {
    name: "setup",
    type: "workflow",
    command: "/setup",
    label: "Setup",
    description: "Diagnose or improve local setup/onboarding flows.",
    prompt: "Use setup workflow. Review install/setup docs, scripts, platform-specific paths, and first-run failure modes."
  },
  {
    name: "context",
    type: "workflow",
    command: "/context",
    label: "Context pack",
    description: "Gather a compact workspace context pack before deciding what to do.",
    prompt: "Gather workspace context first using workspace_snapshot/workspace_search, then ask only for genuinely missing information."
  }
];

function registerCompanionAppResources(mcp) {
  mcp.registerResource("lca-companion-widget", COMPANION_WIDGET_URI, {}, async () => ({
    contents: [
      {
        uri: COMPANION_WIDGET_URI,
        mimeType: "text/html;profile=mcp-app",
        text: await readFile(COMPANION_WIDGET_PATH, "utf8"),
        _meta: {
          ui: {
            prefersBorder: true,
            csp: { connectDomains: [], resourceDomains: [] }
          },
          "openai/widgetDescription": "LCA composer and task dashboard. It provides @ context, / workflows, versioned Plan→Implement, automatic dashboard rendering after every code mutation in every mode, changes/activity/verification/undo, terminal sessions, PiP, and fullscreen.",
          "openai/widgetPrefersBorder": true,
          "openai/widgetCSP": { connect_domains: [], resource_domains: [] }
        }
      }
    ]
  }));
}

function registerCompanionTools(mcp) {
  reg(
    mcp,
    "workspace_search",
    {
      title: "Workspace @ search",
      description: "Autocomplete backend for @ file/folder/symbol/skill search in a ChatGPT companion UI. Use this when the user mentions @... or wants to pick workspace context without copying paths.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        query: z.string().optional().describe("Search text, usually what the user typed after @. @/ or empty returns top-level context."),
        path: z.string().optional().describe("Root dir to search. Defaults to the active workspace root."),
        include: z.array(z.enum(["file", "folder", "symbol", "skill"])).optional().describe("Context kinds to include."),
        limit: z.number().int().min(1).max(100).optional()
      }
    },
    async ({ query = "", path: rel = ".", include, limit = 30 }) => {
      const rootDir = resolvePath(rel);
      const result = await workspaceSearchData(rootDir, query, { include, limit });
      return structuredJsonResult(result);
    }
  );

  reg(
    mcp,
    "slash_commands",
    {
      title: "Slash commands",
      description: "Autocomplete backend for / workflow commands, mode tags, and skill shortcuts. Use this for /plan, /debug, /review, /skill:<name>, etc.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        query: z.string().optional().describe("Search text, usually what the user typed after /."),
        include: z.array(z.enum(["workflow", "mode", "skill"])).optional(),
        limit: z.number().int().min(1).max(100).optional()
      }
    },
    async ({ query = "", include, limit = 30 }) => {
      const result = await slashCommandData(query, { include, limit });
      return structuredJsonResult(result);
    }
  );

  reg(
    mcp,
    "compose_prompt",
    {
      title: "Compose LCA prompt",
      description: "Parse sidebar-style input containing @ context and / workflow commands, resolve selected paths, and return a ready-to-send prompt for ChatGPT.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        input: z.string().min(1).describe("User task text, may include @mentions and /commands."),
        path: z.string().optional().describe("Workspace root to resolve @mentions against."),
        mode: z.enum(WORKFLOW_COMMANDS.map((c) => c.name)).optional().describe("Workflow/mode override."),
        selected_context: z.array(z.string().min(1)).optional().describe("Already-selected file/folder paths from the UI."),
        include_context_pack: z.boolean().optional().describe("Ask ChatGPT to call workspace_snapshot/context tools first.")
      }
    },
    async ({ input, path: rel = ".", mode, selected_context = [], include_context_pack = true }) => {
      const rootDir = resolvePath(rel);
      const result = await composeLcaPrompt(input, rootDir, { mode, selectedContext: selected_context, includeContextPack: include_context_pack });
      return structuredJsonResult(result);
    }
  );

  registerLcaInputTool(mcp, "lca_input", "LCA input", "Render the LCA Apps SDK input widget inside ChatGPT. The widget lets the user request PiP so the composer can stay visible while the conversation continues.");
}

function registerLcaInputTool(mcp, name, title, description) {
  reg(
    mcp,
    name,
    {
      title,
      description,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        initial_input: z.string().optional().describe("Optional text to prefill in the companion composer.")
      },
      _meta: {
        ui: { resourceUri: COMPANION_WIDGET_URI, visibility: ["model", "app"] },
        "openai/outputTemplate": COMPANION_WIDGET_URI,
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Opening LCA input…",
        "openai/toolInvocation/invoked": "LCA input ready."
      }
    },
    async ({ initial_input = "" }) => {
      const payload = {
        initial_input,
        workspace: PRIMARY_ROOT,
        shortcuts: WORKFLOW_COMMANDS
          .filter(({ name }) => COMPANION_QUICK_ACTIONS.has(name))
          .map(({ command, label, description, type, name }) => ({ command, label, description, type, name }))
      };
      return {
        structuredContent: payload,
        content: [{ type: "text", text: "LCA input is ready. Request PiP to keep it visible when supported, use @ for context, / for workflows or skills, or the Plan quick action." }]
      };
    }
  );
}

function normalizePickerQuery(value, prefix = "@") {
  let text = String(value || "").trim();
  if (prefix && text.startsWith(prefix)) text = text.slice(prefix.length);
  if (text === "/" || text === "./") return "";
  if (text.startsWith("/") && prefix === "@") text = text.slice(1);
  return text.trim();
}

function tokenizeSearch(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[\s\\/_.:-]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function scoreSearchCandidate(rawQuery, fields, { base = 0, emptyScore = 1 } = {}) {
  const query = String(rawQuery || "").trim().toLowerCase();
  if (!query) return emptyScore + base;
  const tokens = tokenizeSearch(query);
  if (!tokens.length) return emptyScore + base;
  const haystack = fields.filter(Boolean).join(" ").toLowerCase();
  const words = haystack.split(/[\s\\/_.:-]+/).filter(Boolean);
  const compactHaystack = haystack.replace(/[\s\\/_.:-]+/g, "");
  const compactQuery = query.replace(/[\s\\/_.:-]+/g, "");
  let score = base;

  if (haystack === query) score += 120;
  if (words.some((word) => word === query)) score += 90;
  if (haystack.includes(query)) score += 65;
  if (compactQuery && compactHaystack.includes(compactQuery)) score += 45;

  for (const token of tokens) {
    if (words.some((word) => word === token)) score += 36;
    if (words.some((word) => word.startsWith(token))) score += 26;
    if (haystack.includes(token)) score += 18;
    const fuzzy = bestFuzzyWordScore(token, words);
    score += fuzzy;
  }
  return score;
}

function bestFuzzyWordScore(token, words) {
  if (!token || token.length < 3) return 0;
  let best = 0;
  for (const word of words) {
    if (!word || Math.abs(word.length - token.length) > 2) continue;
    const distance = boundedEditDistance(token, word, token.length <= 5 ? 1 : 2);
    if (distance === 0) best = Math.max(best, 28);
    else if (distance === 1) best = Math.max(best, 16);
    else if (distance === 2 && token.length >= 6) best = Math.max(best, 9);
  }
  return best;
}

function boundedEditDistance(a, b, maxDistance) {
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      rowMin = Math.min(rowMin, curr[j]);
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function pathDepth(rel) {
  if (!rel || rel === ".") return 0;
  return rel.split(/[\\/]+/).filter(Boolean).length;
}

function normalizeInclude(include, fallback) {
  return new Set(Array.isArray(include) && include.length ? include : fallback);
}

async function workspaceSearchData(rootDir, query, { include, limit = 30 } = {}) {
  const q = normalizePickerQuery(query, "@");
  const wanted = normalizeInclude(include, ["file", "folder", "symbol", "skill"]);
  const candidates = [];
  const maxList = Math.max(4000, limit * 120);
  const listed = await listRepoFilesFast(rootDir, maxList);

  if (wanted.has("file")) {
    for (const abs of listed.files) {
      const rel = toRel(abs);
      const base = path.basename(rel);
      const score = scoreSearchCandidate(q, [rel, base], { emptyScore: 20 - pathDepth(rel) });
      if (q && score <= 0) continue;
      candidates.push({ type: "file", path: rel, label: rel, detail: `file · ${path.dirname(rel) === "." ? "root" : path.dirname(rel)}`, score });
    }
  }

  if (wanted.has("folder")) {
    const dirs = new Set();
    for (const abs of listed.files) {
      const rel = path.relative(rootDir, abs).split(path.sep).join("/");
      const parts = rel.split("/").filter(Boolean);
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    for (const rel of dirs) {
      const label = `${rel}/`;
      const score = scoreSearchCandidate(q, [rel, label, path.basename(rel)], { base: 4, emptyScore: 24 - pathDepth(rel) });
      if (q && score <= 0) continue;
      candidates.push({ type: "folder", path: rel, label, detail: "folder", score });
    }
  }

  if (wanted.has("symbol")) {
    const symbols = await scanSymbols(rootDir, { maxFiles: 600, maxMatches: 2000 });
    for (const sym of symbols) {
      const score = scoreSearchCandidate(q, [sym.name, sym.kind, sym.path], { base: 8, emptyScore: 0 });
      if (!q || score <= 8) continue;
      candidates.push({
        type: "symbol",
        path: sym.path,
        line: sym.line,
        symbol: sym.name,
        kind: sym.kind,
        label: `${sym.name} — ${sym.path}:${sym.line}`,
        detail: `${sym.kind} symbol`,
        score
      });
    }
  }

  if (wanted.has("skill")) {
    const skills = await discoverSkills();
    for (const skill of skills) {
      const score = scoreSearchCandidate(q, [skill.name, skill.description], { base: 6, emptyScore: 0 });
      if (!q || score <= 6) continue;
      candidates.push({
        type: "skill",
        skill: skill.name,
        path: toRel(skill.skillFile),
        label: `skill:${skill.name}`,
        detail: skill.description || "skill",
        score
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  const results = candidates.slice(0, limit).map((item) => ({ ...item, score: Math.round(item.score * 100) / 100 }));
  return { query, normalized_query: q, root: toRel(rootDir), engine: listed.engine, count: results.length, results };
}

async function slashCommandData(query, { include, limit = 30 } = {}) {
  const q = normalizePickerQuery(query, "/").replace(/^#/, "");
  const wanted = normalizeInclude(include, ["workflow", "mode", "skill"]);
  const items = [];
  for (const cmd of WORKFLOW_COMMANDS) {
    if (cmd.name === "plan") continue;
    const group = cmd.type === "mode" ? "mode" : "workflow";
    if (!wanted.has(group)) continue;
    const score = scoreSearchCandidate(q, [cmd.command, cmd.name, cmd.label, cmd.description], { base: group === "mode" ? 6 : 4, emptyScore: 20 });
    if (q && score <= 0) continue;
    items.push({ type: group, command: cmd.command, name: cmd.name, label: cmd.label, description: cmd.description, score });
  }
  if (wanted.has("skill")) {
    const skills = await discoverSkills();
    for (const skill of skills) {
      const score = scoreSearchCandidate(q, [skill.name, skill.description, `/skill ${skill.name}`], { base: 3, emptyScore: 0 });
      if (q && score <= 3) continue;
      items.push({ type: "skill", command: `/skill:${skill.name}`, name: skill.name, label: `Use skill: ${skill.name}`, description: skill.description, score });
    }
  }
  items.sort((a, b) => b.score - a.score || a.command.localeCompare(b.command));
  const commands = items.slice(0, limit).map((item) => ({ ...item, score: Math.round(item.score * 100) / 100 }));
  return { query, normalized_query: q, count: commands.length, commands };
}

function extractSlashTokens(input) {
  const tokens = [];
  const re = /(^|\s)\/([a-z][a-z0-9_-]*(?::[a-z0-9_.-]+)?)/gi;
  let match;
  while ((match = re.exec(input))) tokens.push(match[2]);
  return tokens;
}

function extractMentionTokens(input) {
  const tokens = [];
  const re = /(^|\s)@([^\s]+)/g;
  let match;
  while ((match = re.exec(input))) {
    const raw = match[2].replace(/[,.!?;:]+$/g, "");
    if (raw) tokens.push(raw);
  }
  return tokens;
}

function stripPromptControlTokens(input) {
  return String(input || "")
    .replace(/(^|\s)\/[a-z][a-z0-9_-]*(?::[a-z0-9_.-]+)?/gi, " ")
    .replace(/(^|\s)@[^\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function workflowByName(name) {
  const key = String(name || "").replace(/^\//, "").toLowerCase();
  return WORKFLOW_COMMANDS.find((cmd) => cmd.name === key || cmd.command.slice(1) === key) || null;
}

async function composeLcaPrompt(input, rootDir, { mode, selectedContext = [], includeContextPack = true } = {}) {
  const slashTokens = extractSlashTokens(input);
  const mentionTokens = extractMentionTokens(input);
  const explicitMode = slashTokens.map((token) => token.split(":")[0]).find((token) => workflowByName(token)) || mode;
  const workflow = workflowByName(explicitMode) || null;
  const skillTokens = slashTokens
    .map((token) => token.match(/^skill:(.+)$/i)?.[1])
    .filter(Boolean);
  const resolved = [];
  const unresolved = [];

  for (const item of selectedContext) {
    try {
      const abs = resolvePath(item);
      const info = await stat(abs).catch(() => null);
      resolved.push({ type: info?.isDirectory() ? "folder" : "file", path: toRel(abs), label: toRel(abs) });
    } catch {
      unresolved.push(item);
    }
  }

  for (const token of mentionTokens) {
    const search = await workspaceSearchData(rootDir, token, { include: ["file", "folder", "symbol", "skill"], limit: 1 });
    if (search.results.length) resolved.push(search.results[0]);
    else unresolved.push(`@${token}`);
  }

  const deduped = [];
  const seen = new Set();
  for (const item of resolved) {
    const key = `${item.type}:${item.path || item.skill || item.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  const task = stripPromptControlTokens(input) || input.trim();
  await HOOK_MANAGER.run("UserPromptSubmit", { task, rawInput: input.slice(0, 10000) });
  const targetForInstructions = deduped.find((item) => item.path)?.path || ".";
  const [instructionChain, taskAnalysis] = await Promise.all([
    discoverInstructionChain(PRIMARY_ROOT, targetForInstructions, { maxChars: 18000 }),
    TASK_RUNTIME.analyzeTask(task)
  ]);
  const effectiveWorkflow = workflow?.name || (WORKFLOW_MODE === "auto" ? taskAnalysis.recommendedWorkflow : WORKFLOW_MODE);
  const lines = [];
  if (workflow) {
    lines.push(`Use LCA ${workflow.label}.`);
    lines.push(workflow.prompt);
  } else if (effectiveWorkflow === "plan") {
    lines.push("Use LCA Plan workflow: create a persistent task and structured plan, render the Plan card, and do not modify code until the user presses Implement.");
  } else {
    lines.push("Use LCA Fast workflow: gather only targeted context and implement directly. Any code mutation will automatically render the task dashboard.");
  }
  lines.push(`Access mode: ${ACCESS_MODE}. Workflow mode: ${effectiveWorkflow}. ${EXPLICIT_VERIFICATION_INSTRUCTION}`);
  if (includeContextPack) {
    lines.push("Start by calling workspace_snapshot or workspace_search if more context is needed; do not ask me to copy file paths unless the @ context is ambiguous.");
  }
  if (instructionChain.instructions.length) {
    lines.push("", "Applicable repository instructions (later/nested overrides have higher priority):");
    for (const instruction of instructionChain.instructions) {
      lines.push(`\n--- ${instruction.path} [scope=${instruction.scope}${instruction.override ? ", override" : ""}] ---`);
      lines.push(instruction.content);
    }
  }
  if (skillTokens.length) {
    lines.push("", "Requested skills:");
    for (const skill of skillTokens) lines.push(`- ${skill}`);
    lines.push("Call read_skill for each requested skill before editing or reviewing.");
  }
  if (deduped.length) {
    lines.push("", "Selected context:");
    for (const item of deduped) {
      const loc = item.line ? `${item.path}:${item.line}` : item.path || item.skill || item.label;
      lines.push(`- ${item.type}: ${loc}`);
    }
  }
  if (unresolved.length) {
    lines.push("", "Unresolved @ mentions:");
    for (const item of unresolved) lines.push(`- ${item}`);
  }
  lines.push("", "Task:", task);

  const suggested = effectiveWorkflow === "plan"
    ? ["workspace_snapshot", "task_create", "plan_create", "instruction_chain"]
    : workflow?.name === "review"
      ? ["workspace_snapshot", "review_diff", "read_many"]
      : ["workspace_snapshot", "workspace_search", "read_many", "apply_patch"];

  return {
    mode: effectiveWorkflow,
    access_mode: ACCESS_MODE,
    workflow_mode: WORKFLOW_MODE,
    complexity: taskAnalysis,
    instruction_chain: instructionChain.instructions.map(({ content, ...meta }) => meta),
    slash_commands: slashTokens.map((token) => `/${token}`),
    skills: skillTokens,
    mentions: mentionTokens.map((token) => `@${token}`),
    selected_context: deduped,
    unresolved_mentions: unresolved,
    task,
    suggested_tools: suggested,
    prompt: lines.join("\n")
  };
}

// ----------------------------------------------------------------------------
// Tool registration helper: audit + uniform error handling
// ----------------------------------------------------------------------------
const VERIFICATION_TOOL_KIND = new Map([
  ["run_tests", "tests"],
  ["run_changed_tests", "tests"],
  ["run_lint", "lint"],
  ["run_build", "build"]
]);

function mutationToolDefinition(name, def) {
  if (!toolCanAffectCode(name)) return def;
  return {
    ...def,
    _meta: {
      ...(def._meta || {}),
      ui: { resourceUri: COMPANION_WIDGET_URI, visibility: ["model", "app"], ...(def._meta?.ui || {}) },
      "openai/outputTemplate": COMPANION_WIDGET_URI,
      "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": def._meta?.["openai/toolInvocation/invoking"] || "Updating code…",
      "openai/toolInvocation/invoked": def._meta?.["openai/toolInvocation/invoked"] || "Code updated — dashboard ready."
    }
  };
}

function resultObject(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result?.content?.find?.((item) => item?.type === "text")?.text;
  if (typeof text !== "string") return null;
  try { return JSON.parse(text); } catch { return { message: text }; }
}

async function captureWorkspaceMutationState() {
  const [status, head] = await Promise.all([
    spawnCapture("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], PRIMARY_ROOT, DEFAULT_CMD_TIMEOUT),
    spawnCapture("git", ["rev-parse", "HEAD"], PRIMARY_ROOT, DEFAULT_CMD_TIMEOUT)
  ]);
  if (status.exit_code !== 0) return { supported: false, fingerprint: null, paths: [] };
  const records = (status.stdout || "").split("\0").filter(Boolean);
  const paths = [];
  const codeStatus = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const rel = record.slice(3);
    if (rel) {
      paths.push(rel);
      if (isCodePath(rel)) codeStatus.push(`${code}:${rel}`);
    }
    // In -z mode rename/copy records are followed by the old path.
    if (/[RC]/.test(code) && records[index + 1]) index += 1;
  }
  const codePaths = [...new Set(paths.filter(isCodePath))].sort().slice(0, 1000);
  const states = [];
  for (const rel of codePaths) {
    try {
      const content = await readFile(resolvePath(rel));
      states.push(`${rel}:file:${createHash("sha256").update(content).digest("hex")}`);
    } catch {
      states.push(`${rel}:missing`);
    }
  }
  return {
    supported: true,
    fingerprint: createHash("sha256").update([String(head.stdout || "").trim(), ...codeStatus.sort(), ...states].join("\n")).digest("hex"),
    paths: codePaths
  };
}

async function attachMutationDashboard(name, args, result, detectedPaths = null) {
  const operation = resultObject(result);
  const transactionId = operation?.transaction_id || operation?.transactionId || operation?.id || null;
  const paths = detectedPaths?.length ? detectedPaths : collectMutationPaths(name, args);
  const dashboard = await TASK_RUNTIME.recordMutation({
    tool: name,
    paths,
    transactionId,
    taskId: args.task_id || null,
    accessMode: ACCESS_MODE,
    workflowMode: WORKFLOW_MODE,
    summary: operation?.summary || `${name} changed code`
  });
  return {
    ...result,
    structuredContent: {
      kind: "lca_code_mutation",
      operation,
      dashboard
    }
  };
}

async function attachActivityDashboard(name, args, result) {
  const operation = resultObject(result);
  const dashboard = await TASK_RUNTIME.recordActivity({
    tool: name,
    type: "command_session",
    accessMode: ACCESS_MODE,
    workflowMode: WORKFLOW_MODE,
    message: operation?.summary || `${name} started; dashboard remains visible for code changes from this session`,
    metadata: { sessionId: operation?.session_id || operation?.id || null }
  });
  return {
    ...result,
    structuredContent: {
      kind: "lca_task_dashboard",
      operation,
      dashboard
    }
  };
}

function reg(mcp, name, def, handler) {
  mcp.registerTool(name, mutationToolDefinition(name, def), async (args, extra) => {
    const startedAt = isoNow();
    const startedMs = performance.now();
    const argSummary = AUDIT_ENABLED && AUDIT_ARGS ? summarizeArgs(args) : "";
    const inChars = argSummary.length;
    let result;
    let ok = true;
    try {
      await enforceToolPolicy(name, args ?? {});
      const toolArgs = args ?? {};
      const directMutation = mutationTouchesCode(name, toolArgs);
      const potentialMutation = POTENTIAL_CODE_MUTATION_TOOLS.has(name);
      const backgroundActivity = BACKGROUND_CODE_ACTIVITY_TOOLS.has(name);
      const verificationKind = VERIFICATION_TOOL_KIND.get(name) || null;
      const beforeState = potentialMutation ? await captureWorkspaceMutationState() : null;
      await HOOK_MANAGER.run("BeforeTool", { tool: name, args: summarizeArgs(toolArgs) });
      if (directMutation) await HOOK_MANAGER.run("BeforeMutation", { tool: name, paths: collectMutationPaths(name, toolArgs) });
      if (verificationKind) await HOOK_MANAGER.run("BeforeVerification", { tool: name, kind: verificationKind, taskId: toolArgs.task_id || null });
      result = await handler(toolArgs, extra);
      if (!result?.isError) {
        let changed = directMutation;
        let changedPaths = directMutation ? collectMutationPaths(name, toolArgs) : [];
        if (potentialMutation) {
          const afterState = await captureWorkspaceMutationState();
          changed = Boolean(beforeState?.supported && afterState.supported && beforeState.fingerprint !== afterState.fingerprint);
          changedPaths = [...new Set([...(beforeState?.paths || []), ...(afterState.paths || [])])];
        }
        let verificationDashboard = null;
        if (verificationKind) {
          verificationDashboard = await TASK_RUNTIME.recordVerification({
            taskId: toolArgs.task_id || null,
            kind: verificationKind,
            result: resultObject(result)
          });
          await HOOK_MANAGER.run("AfterVerification", { tool: name, kind: verificationKind, taskId: verificationDashboard?.task?.id || null, result: resultObject(result) });
        }
        if (changed) {
          result = await attachMutationDashboard(name, toolArgs, result, changedPaths);
          await HOOK_MANAGER.run("AfterMutation", { tool: name, paths: changedPaths, result: resultObject(result) });
        } else if (verificationDashboard) {
          result = {
            ...result,
            structuredContent: {
              kind: "lca_task_dashboard",
              operation: resultObject(result),
              dashboard: verificationDashboard
            }
          };
        } else if (backgroundActivity || potentialMutation) {
          result = await attachActivityDashboard(name, toolArgs, result);
        }
      }
      await HOOK_MANAGER.run("AfterTool", { tool: name, ok: !result?.isError });
    } catch (err) {
      ok = false;
      await HOOK_MANAGER.run("AfterTool", { tool: name, ok: false, error: String(err?.message || err) }).catch(() => {});
      result = { content: [{ type: "text", text: `ERROR: ${err?.message || err}` }], isError: true };
    }
    const success = ok && !result?.isError;
    const outChars = resultLen(result);
    const durationMs = Math.max(0, Math.round((performance.now() - startedMs) * 10) / 10);
    const errText = success ? null : firstText(result).slice(0, 200);
    audit({ ts: startedAt, tool: name, ok: success, durationMs, inChars, outChars, error: errText || undefined, args: argSummary || undefined });
    return result;
  });
}

// ----------------------------------------------------------------------------
// Basic tools
// ----------------------------------------------------------------------------
function workspaceInfoPayload() {
  return {
    status: "ok",
    version: VERSION,
    tier: PRODUCT_TIER,
    mode: MODE,
    access_mode: ACCESS_MODE,
    workflow_mode: WORKFLOW_MODE,
    policy: AGENT_POLICY,
    verification: { tests: "explicit", lint: "explicit", build: "explicit" },
    dashboard: { show_on_code_change: true, all_modes: true, auto_open_fullscreen_on_complete: false },
    allow_dangerous: ALLOW_DANGEROUS,
    auth: AUTH_TOKEN ? "bearer" : "none",
    roots: ROOTS,
    primary_root: PRIMARY_ROOT,
    host: { platform: os.platform(), release: os.release(), hostname: os.hostname(), cwd: process.cwd(), node: process.version },
    limits: {
      max_read_chars: MAX_READ_CHARS,
      max_batch_read_chars: MAX_BATCH_READ_CHARS,
      max_command_output: MAX_COMMAND_OUTPUT,
      max_procs: MAX_PROCS
    },
    running_processes: [...processes.values()].filter((p) => p.status === "running").length,
    execution_boundary: boundaryStatus(ACCESS_MODE, PRIMARY_ROOT),
    safety:
      ACCESS_MODE === "full"
        ? ["File tools are root-confined; full command execution runs directly without OS sandbox.", "Catastrophic system commands stay blocked unless AGENT_ALLOW_DANGEROUS=1.", "Paths outside the roots are rejected by file tools."]
        : ["File tools are root-confined and command cwd is root-confined.", `Command boundary: ${boundaryStatus(ACCESS_MODE, PRIMARY_ROOT).adapter} (${boundaryStatus(ACCESS_MODE, PRIMARY_ROOT).active ? "active" : "policy-only"}).`, "Safe/balanced policy and approvals remain enabled according to the selected mode."]
  };
}

function registerBasicTools(mcp) {
  reg(
    mcp,
    "ping",
    {
      title: "Ping",
      description: "Check whether the local coding agent is reachable.",
      inputSchema: { message: z.string().optional().describe("Optional message to echo back.") }
    },
    async ({ message }) => textResult(`Local coding agent online (mode=${MODE}).${message ? ` Echo: ${message}` : ""}`)
  );

  reg(
    mcp,
    "workspace_info",
    {
      title: "Workspace info",
      description: "Return roots, mode, limits, host info, and safety rules.",
      inputSchema: {}
    },
    async () => jsonResult(workspaceInfoPayload())
  );

  reg(
    mcp,
    "lca",
    {
      title: "LCA status",
      description: "Short alias for workspace_info. Use this when the user says only 'lca' in a fresh chat to check the active LCA workspace.",
      inputSchema: {}
    },
    async () => jsonResult(workspaceInfoPayload())
  );

  reg(
    mcp,
    "save_note",
    {
      title: "Save note",
      description: "Save a note on the local machine for later retrieval.",
      inputSchema: { title: z.string().min(1), body: z.string().min(1) }
    },
    async ({ title, body }) => {
      const notes = await readNotes();
      const note = { id: randomUUID(), title, body, created_at: isoNow() };
      notes.unshift(note);
      await writeNotes(notes);
      return textResult(`Saved note "${title}" (${note.id}).`);
    }
  );

  reg(
    mcp,
    "list_notes",
    {
      title: "List notes",
      description: "List previously saved notes.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional() }
    },
    async ({ limit = 10 }) => {
      const notes = (await readNotes()).slice(0, limit);
      if (!notes.length) return textResult("No notes saved yet.");
      return textResult(notes.map((n) => `- ${n.title} (${n.id})\n  ${n.body}`).join("\n"));
    }
  );

  reg(
    mcp,
    "checkpoint",
    {
      title: "Save a progress checkpoint",
      description: "Save a COMPACT summary of progress so the user can start a fresh, fast chat and you can continue. Call this when the conversation gets long/slow, then tell the user to open a new chat and you will call resume().",
      inputSchema: {
        summary: z.string().min(1).describe("What has been done so far, the goal, and current state — concise."),
        next_steps: z.array(z.string()).optional().describe("Ordered remaining steps."),
        files_touched: z.array(z.string()).optional().describe("Key files involved.")
      }
    },
    async ({ summary, next_steps = [], files_touched = [] }) => {
      await HOOK_MANAGER.run("BeforeCheckpoint", { summary, next_steps, files_touched });
      try {
        const cpStateDir = path.join(AGENT_STATE_DIR, "checkpoints");
        await mkdir(cpStateDir, { recursive: true });
        if (existsSync(TASK_PLAN_PATH)) {
          const taskPlan = await readFile(TASK_PLAN_PATH, "utf8");
          await writeFile(path.join(cpStateDir, `task-${Date.now()}.json`), taskPlan, "utf8");
        }
      } catch { /* best-effort */ }
      const [headResult, diffResult, statusResult, dashboard, transactions] = await Promise.all([
        spawnCapture("git", ["rev-parse", "HEAD"], PRIMARY_ROOT, DEFAULT_CMD_TIMEOUT),
        spawnCapture("git", ["diff", "--binary"], PRIMARY_ROOT, DEFAULT_CMD_TIMEOUT),
        spawnCapture("git", ["status", "--short"], PRIMARY_ROOT, DEFAULT_CMD_TIMEOUT),
        TASK_RUNTIME.getDashboard(),
        MUTATION_ENGINE.list(50)
      ]);
      const runningProcesses = [...processes.values()]
        .filter((proc) => proc.status === "running")
        .map((proc) => ({ id: proc.id, name: proc.name, command: proc.command, cwd: proc.cwd, started_at: proc.startedAt }));
      const cp = {
        saved_at: isoNow(),
        summary,
        next_steps,
        files_touched,
        git_head: (headResult.stdout || "").trim() || null,
        git_status: (statusResult.stdout || "").trim().split(/\r?\n/).filter(Boolean),
        diff_sha256: createHash("sha256").update(diffResult.stdout || "").digest("hex"),
        task: dashboard?.task || null,
        plan_id: dashboard?.task?.planId || null,
        changes: dashboard?.changes || [],
        transactions: transactions.map((tx) => ({ id: tx.id, status: tx.status, label: tx.label, updatedAt: tx.updatedAt })),
        verification: dashboard?.verification || { tests: { status: "not_requested" }, lint: { status: "not_requested" }, build: { status: "not_requested" } },
        running_processes: runningProcesses
      };
      await mkdir(path.dirname(CHECKPOINT_PATH), { recursive: true });
      await writeFile(CHECKPOINT_PATH, `${JSON.stringify(cp, null, 2)}\n`, "utf8");
      await HOOK_MANAGER.run("AfterCheckpoint", { checkpoint: cp });
      return jsonResult({ ok: true, checkpoint: cp, message: "Checkpoint saved. A fresh chat can call resume without losing task, diff, transaction, or process context." });
    }
  );

  reg(
    mcp,
    "resume",
    {
      title: "Resume from last checkpoint",
      description: "Load the last checkpoint saved by checkpoint(). Call this FIRST in a fresh chat to continue prior work without the old heavy context.",
      inputSchema: {}
    },
    async () => {
      try {
        const cp = JSON.parse(await readFile(CHECKPOINT_PATH, "utf8"));
        const [headResult, diffResult] = await Promise.all([
          spawnCapture("git", ["rev-parse", "HEAD"], PRIMARY_ROOT, DEFAULT_CMD_TIMEOUT),
          spawnCapture("git", ["diff", "--binary"], PRIMARY_ROOT, DEFAULT_CMD_TIMEOUT)
        ]);
        const currentHead = (headResult.stdout || "").trim() || null;
        const currentDiffHash = createHash("sha256").update(diffResult.stdout || "").digest("hex");
        return jsonResult({
          ...cp,
          stale: Boolean((cp.git_head && currentHead && cp.git_head !== currentHead) || (cp.diff_sha256 && cp.diff_sha256 !== currentDiffHash)),
          current_git_head: currentHead,
          current_diff_sha256: currentDiffHash,
          dashboard: await TASK_RUNTIME.getDashboard(cp.task?.id)
        });
      } catch {
        return textResult("No checkpoint saved yet.");
      }
    }
  );
}

// ----------------------------------------------------------------------------
// Filesystem read tools
// ----------------------------------------------------------------------------
function registerFsReadTools(mcp) {
  reg(
    mcp,
    "list_files",
    {
      title: "List files",
      description: "List files and folders under a root (or absolute path inside a root).",
      inputSchema: {
        path: z.string().optional().describe("Directory path. Relative paths resolve against the primary root."),
        recursive: z.boolean().optional(),
        limit: z.number().int().min(1).max(2000).optional()
      }
    },
    async ({ path: rel = ".", recursive = false, limit = 200 }) => {
      const dir = resolvePath(rel);
      const entries = await listEntries(dir, { recursive, limit });
      return jsonResult({ path: toRel(dir), count: entries.length, entries });
    }
  );

  reg(
    mcp,
    "read_file",
    {
      title: "Read file",
      description: "Read ONE UTF-8 text file (supports line ranges). If you need several files, call read_many ONCE instead of calling this repeatedly — it is far faster over the network. For large files, pass start_line/line_count to read only the part you need.",
      inputSchema: {
        path: z.string().min(1),
        start_line: z.number().int().min(1).optional().describe("1-based first line to return."),
        line_count: z.number().int().min(1).max(20000).optional().describe("Number of lines to return from start_line."),
        max_chars: z.number().int().min(1).max(MAX_READ_CHARS).optional().describe(`Max chars to return (default ${READ_DEFAULT}).`)
      }
    },
    async ({ path: rel, start_line, line_count, max_chars = READ_DEFAULT }) => {
      const filePath = resolvePath(rel);
      const content = await readFile(filePath, "utf8");
      const allLines = content.split(/\r?\n/);
      if (start_line || line_count) {
        const from = (start_line || 1) - 1;
        const to = line_count ? from + line_count : allLines.length;
        const slice = allLines.slice(from, to).join("\n");
        return jsonResult({
          path: toRel(filePath),
          total_lines: allLines.length,
          start_line: from + 1,
          returned_lines: Math.min(to, allLines.length) - from,
          content: slice.length > max_chars ? slice.slice(0, max_chars) : slice,
          truncated: slice.length > max_chars
        });
      }
      const truncated = content.length > max_chars;
      return jsonResult({
        path: toRel(filePath),
        total_lines: allLines.length,
        chars: content.length,
        truncated,
        content: truncated ? content.slice(0, max_chars) : content
      });
    }
  );

  reg(
    mcp,
    "stat_path",
    {
      title: "Stat path",
      description: "Return metadata about a file or directory.",
      inputSchema: { path: z.string().min(1) }
    },
    async ({ path: rel }) => {
      const target = resolvePath(rel);
      const info = await stat(target);
      return jsonResult({
        path: toRel(target),
        type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
        size: info.size,
        modified: info.mtime.toISOString(),
        created: info.birthtime.toISOString()
      });
    }
  );

  reg(
    mcp,
    "search_text",
    {
      title: "Search text",
      description: "Search text under a path (ripgrep > git grep > file scan, picked automatically). Prefer this over reading many files. Pass context>0 to get surrounding lines so you usually do NOT need a follow-up read_file. Pass glob (e.g. \"*.ts\") to limit file types.",
      inputSchema: {
        query: z.string().min(1),
        path: z.string().optional(),
        regex: z.boolean().optional(),
        glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts".'),
        context: z.number().int().min(0).max(10).optional().describe("Lines of context before/after each match."),
        limit: z.number().int().min(1).max(500).optional()
      }
    },
    async ({ query, path: rel = ".", regex = false, glob, context = 0, limit = 100 }) => {
      const start = resolvePath(rel);
      // Tolerate a broken regex: fall back to a literal substring search instead
      // of erroring out.
      let useRegex = regex;
      let regexFallback = false;
      if (regex) {
        try {
          new RegExp(query);
        } catch {
          useRegex = false;
          regexFallback = true;
        }
      }
      let engine = "scan";
      let matches = null;
      const info = await stat(start).catch(() => null);
      const isDir = info && info.isDirectory();
      if (isDir && RG_BIN) {
        matches = await ripgrepGrep(start, query, { regex: useRegex, limit, glob });
        if (matches) engine = "ripgrep";
      }
      if (matches === null && isDir) {
        matches = await gitGrep(start, query, { regex: useRegex, limit, glob });
        if (matches) engine = "git";
      }
      if (matches === null) matches = await searchTree(start, query, { regex: useRegex, limit, glob });
      if (context > 0 && matches.length) await attachContext(matches, context);
      return jsonResult({ query, regex: useRegex, regex_fallback: regexFallback, engine, context, count: matches.length, matches });
    }
  );

  reg(
    mcp,
    "find_files",
    {
      title: "Find files",
      description: "List file paths matching a name glob (ripgrep > git ls-files > scan). Fast way to locate files (e.g. glob \"*.config.ts\") instead of listing directories one by one.",
      inputSchema: {
        glob: z.string().min(1).describe('Name glob, e.g. "*.ts" or "**/Dockerfile".'),
        path: z.string().optional().describe("Directory to search under."),
        limit: z.number().int().min(1).max(2000).optional()
      }
    },
    async ({ glob, path: rel = ".", limit = 300 }) => {
      const start = resolvePath(rel);
      const { files, engine } = await findFiles(start, glob, limit);
      return jsonResult({ glob, engine, count: files.length, files });
    }
  );

  reg(
    mcp,
    "read_many",
    {
      title: "Read many files",
      description: "Read up to 100 files or targeted line ranges in ONE call. Reads run concurrently with a bounded worker pool and a total output cap, cutting tunnel round-trips without flooding context.",
      inputSchema: {
        paths: z.array(z.string().min(1)).min(1).max(100).optional().describe("Simple file paths to read."),
        requests: z.array(z.object({
          path: z.string().min(1),
          start_line: z.number().int().min(1).optional(),
          line_count: z.number().int().min(1).max(10000).optional(),
          max_chars: z.number().int().min(1).max(MAX_READ_CHARS).optional()
        })).min(1).max(100).optional().describe("Structured reads with optional line ranges. Use either paths or requests."),
        max_chars_per_file: z.number().int().min(1).max(MAX_READ_CHARS).optional(),
        concurrency: z.number().int().min(1).max(16).optional().describe("Concurrent local reads (default 8).")
      }
    },
    async ({ paths, requests, max_chars_per_file = 40_000, concurrency = 8 }) => {
      if (paths?.length && requests?.length) throw new Error("Use either paths or requests, not both.");
      const items = requests?.length ? requests : (paths || []).map((p) => ({ path: p }));
      if (!items.length) throw new Error("Provide at least one path or read request.");

      const files = new Array(items.length);
      let cursor = 0;
      const worker = async () => {
        while (true) {
          const index = cursor++;
          if (index >= items.length) return;
          const request = items[index];
          try {
            const fp = resolvePath(request.path);
            const content = await readFile(fp, "utf8");
            const maxChars = request.max_chars || max_chars_per_file;
            if (request.start_line || request.line_count) {
              const lines = content.split(/\r?\n/);
              const start = request.start_line || 1;
              const count = request.line_count || lines.length;
              const selected = lines.slice(start - 1, start - 1 + count).join("\n");
              files[index] = {
                path: toRel(fp),
                total_lines: lines.length,
                start_line: start,
                returned_lines: Math.min(count, Math.max(0, lines.length - start + 1)),
                chars: selected.length,
                truncated: selected.length > maxChars,
                content: selected.slice(0, maxChars)
              };
              continue;
            }
            files[index] = {
              path: toRel(fp),
              chars: content.length,
              truncated: content.length > maxChars,
              content: content.slice(0, maxChars)
            };
          } catch (err) {
            files[index] = { path: request.path, error: String(err?.message || err) };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));

      let remaining = MAX_BATCH_READ_CHARS;
      let batchTruncated = false;
      for (const file of files) {
        if (typeof file.content !== "string") continue;
        if (file.content.length > remaining) {
          file.content = file.content.slice(0, Math.max(0, remaining));
          file.truncated = true;
          file.batch_truncated = true;
          batchTruncated = true;
        }
        remaining = Math.max(0, remaining - file.content.length);
      }
      return jsonResult({
        count: files.length,
        failed: files.filter((f) => f.error).length,
        chars_returned: MAX_BATCH_READ_CHARS - remaining,
        max_batch_chars: MAX_BATCH_READ_CHARS,
        batch_truncated: batchTruncated,
        files
      });
    }
  );

  reg(
    mcp,
    "repo_overview",
    {
      title: "Repo overview",
      description: "One call: a compact directory tree plus detected manifest/config files. Start here to map a repo instead of probing file-by-file.",
      inputSchema: {
        path: z.string().optional().describe("Directory to map. Defaults to the primary root."),
        depth: z.number().int().min(1).max(6).optional().describe("Tree depth (default 3)."),
        max_entries: z.number().int().min(10).max(4000).optional().describe("Max tree entries (default 800).")
      }
    },
    async ({ path: rel = ".", depth = 3, max_entries = 800 }) => {
      const start = resolvePath(rel);
      const { tree, dirs, files } = await buildTree(start, depth, max_entries);
      const manifests = files.filter((f) => MANIFEST_NAMES.has(path.basename(f).toLowerCase()));
      return jsonResult({
        root: toRel(start),
        depth,
        dirs: dirs.length,
        files: files.length,
        truncated: tree.length >= max_entries,
        manifests: manifests.map(toRel).slice(0, 100),
        tree: tree.map(toRel)
      });
    }
  );
}

const MANIFEST_NAMES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "tsconfig.json",
  "pubspec.yaml",
  "go.mod",
  "cargo.toml",
  "pom.xml",
  "build.gradle",
  "requirements.txt",
  "pyproject.toml",
  "gemfile",
  "composer.json",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "makefile",
  "readme.md",
  ".env.example"
]);

async function buildTree(start, maxDepth, maxEntries) {
  const tree = [];
  const dirs = [];
  const files = [];
  async function walk(current, depth) {
    if (tree.length >= maxEntries || depth > maxDepth) return;
    let items;
    try {
      items = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    // directories first, then files, alphabetical — predictable for the model
    items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const item of items) {
      if (tree.length >= maxEntries) return;
      if (SKIP_DIRS.has(item.name)) continue;
      const abs = path.join(current, item.name);
      tree.push(item.isDirectory() ? abs + path.sep : abs);
      if (item.isDirectory()) {
        dirs.push(abs);
        await walk(abs, depth + 1);
      } else {
        files.push(abs);
      }
    }
  }
  await walk(start, 1);
  return { tree, dirs, files };
}

async function buildTreeFast(start, maxDepth, maxEntries) {
  const listed = await listRepoFilesFast(start, Math.max(maxEntries * 4, 4000));
  if (listed.engine === "scan") return { ...(await buildTree(start, maxDepth, maxEntries)), engine: "scan" };
  const tree = [];
  const dirs = new Set();
  const files = [];
  const seen = new Set();
  const addEntry = (entry) => {
    if (tree.length >= maxEntries || seen.has(entry)) return;
    seen.add(entry);
    tree.push(entry);
  };
  for (const abs of listed.files) {
    const rel = path.relative(start, abs).split(path.sep).join("/");
    const parts = rel.split("/").filter(Boolean);
    for (let i = 1; i < parts.length && i <= maxDepth; i++) {
      const dirAbs = path.resolve(start, ...parts.slice(0, i));
      dirs.add(dirAbs);
      addEntry(`${dirAbs}${path.sep}`);
    }
    if (parts.length <= maxDepth) {
      files.push(abs);
      addEntry(abs);
    }
    if (tree.length >= maxEntries) break;
  }
  return { tree, dirs: [...dirs], files, engine: listed.engine };
}

// ----------------------------------------------------------------------------
// Filesystem write tools
// ----------------------------------------------------------------------------
function registerFsWriteTools(mcp) {
  reg(
    mcp,
    "write_file",
    {
      title: "Write file",
      description: "Create or overwrite a UTF-8 text file.",
      inputSchema: { path: z.string().min(1), content: z.string() }
    },
    async ({ path: rel, content }) => {
      const result = await MUTATION_ENGINE.applyOperations(
        [{ op: "create", path: rel, content, overwrite: true }],
        { label: "write_file" }
      );
      return jsonResult({ ...result, path: rel, bytes: Buffer.byteLength(content) });
    }
  );

  reg(
    mcp,
    "replace_in_file",
    {
      title: "Replace in file",
      description: "Replace exact text in ONE file. If you are making several edits (in one or many files), call apply_patch ONCE with all of them instead of calling this repeatedly — fewer round trips, much faster.",
      inputSchema: {
        path: z.string().min(1),
        old_text: z.string().min(1),
        new_text: z.string(),
        replace_all: z.boolean().optional(),
        expected_occurrences: z.number().int().min(1).optional(),
        expected_sha256: z.string().optional()
      }
    },
    async ({ path: rel, old_text, new_text, replace_all = false, expected_occurrences, expected_sha256 }) => {
      const result = await MUTATION_ENGINE.applyOperations([
        {
          op: "update",
          path: rel,
          expected_sha256,
          edits: [{ old_text, new_text, replace_all, expected_occurrences }]
        }
      ], { label: "replace_in_file" });
      return jsonResult({ ...result, path: rel });
    }
  );

  reg(
    mcp,
    "apply_patch",
    {
      title: "Apply patch",
      description: "Apply MANY edits in ONE call. Two modes: (a) `diff` = a standard unified diff covering one or more files (preferred for multi-file edits), or (b) `operations` = structured create/update/delete/rename. Use this instead of many replace_in_file calls.",
      inputSchema: {
        diff: z.string().optional().describe("A unified diff (---/+++/@@). Applies by matching context, ignoring line numbers."),
        operations: z
          .array(
            z.object({
              op: z.enum(["create", "update", "delete", "rename"]),
              path: z.string().min(1),
              content: z.string().optional().describe("For create: full file content."),
              rename_to: z.string().optional().describe("For rename: destination path."),
              recursive: z.boolean().optional().describe("For delete of a directory."),
              overwrite: z.boolean().optional().describe("Explicitly allow create/rename destination overwrite."),
              expected_sha256: z.string().optional().describe("Fail if the file changed since it was read."),
              edits: z
                .array(z.object({
                  old_text: z.string().min(1),
                  new_text: z.string(),
                  replace_all: z.boolean().optional(),
                  expected_occurrences: z.number().int().min(1).optional(),
                  near_line: z.number().int().min(1).optional()
                }))
                .optional()
                .describe("For update: ordered text replacements.")
            })
          )
          .optional()
      }
    },
    async ({ diff, operations }) => {
      if (diff && diff.trim()) {
        return jsonResult({ mode: "diff", ...(await MUTATION_ENGINE.applyDiff(diff, { label: "apply_patch_diff" })) });
      }
      if (!operations || !operations.length) throw new Error("Provide either `diff` or a non-empty `operations` array.");
      return jsonResult({ mode: "operations", ...(await MUTATION_ENGINE.applyOperations(operations, { label: "apply_patch_ops" })) });
    }
  );

  reg(
    mcp,
    "make_dir",
    {
      title: "Make directory",
      description: "Create a directory (recursive).",
      inputSchema: { path: z.string().min(1) }
    },
    async ({ path: rel }) => {
      const dir = resolvePath(rel);
      await mkdir(dir, { recursive: true });
      return jsonResult({ ok: true, path: toRel(dir) });
    }
  );

  reg(
    mcp,
    "move_path",
    {
      title: "Move / rename",
      description: "Move or rename a file or directory. Both ends must be inside the roots.",
      inputSchema: { from: z.string().min(1), to: z.string().min(1) }
    },
    async ({ from, to }) => jsonResult(await MUTATION_ENGINE.applyOperations(
      [{ op: "rename", path: from, rename_to: to }],
      { label: "move_path" }
    ))
  );

  reg(
    mcp,
    "delete_path",
    {
      title: "Delete path",
      description: "Delete a file or directory inside the roots. Directories require recursive=true.",
      inputSchema: { path: z.string().min(1), recursive: z.boolean().optional() }
    },
    async ({ path: rel, recursive = false }) => {
      const target = resolvePath(rel);
      if (target === PRIMARY_ROOT || ROOTS.includes(target)) throw new Error("Refusing to delete a configured root.");
      return jsonResult(await MUTATION_ENGINE.applyOperations(
        [{ op: "delete", path: rel, recursive }],
        { label: "delete_path" }
      ));
    }
  );
}

// Apply a unified diff by CONTENT matching (ignores the @@ line numbers, which
// models often get wrong). Each hunk's context+removed lines must appear in the
// file; they are replaced by its context+added lines.
async function applyUnifiedDiff(diffText) {
  const results = [];
  const lines = diffText.split(/\r?\n/);
  const fileChunks = [];
  let current = null;

  const stripPrefix = (p) => p.replace(/^["']|["']$/g, "").replace(/^[ab]\//, "").trim();

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.startsWith("--- ")) {
      const next = lines[i + 1] || "";
      const minus = stripPrefix(ln.slice(4));
      const plus = next.startsWith("+++ ") ? stripPrefix(next.slice(4)) : "";
      current = { minus, plus, hunks: [], hunk: null };
      fileChunks.push(current);
      if (next.startsWith("+++ ")) i++;
      continue;
    }
    if (!current) continue;
    if (ln.startsWith("@@")) {
      current.hunk = { before: [], after: [] };
      current.hunks.push(current.hunk);
      continue;
    }
    if (!current.hunk) continue;
    const tag = ln[0];
    const body = ln.slice(1);
    if (tag === " ") {
      current.hunk.before.push(body);
      current.hunk.after.push(body);
    } else if (tag === "-") {
      current.hunk.before.push(body);
    } else if (tag === "+") {
      current.hunk.after.push(body);
    } else if (ln === "\\ No newline at end of file") {
      // ignore
    }
  }

  for (const fc of fileChunks) {
    const isNew = fc.minus === "/dev/null";
    const isDelete = fc.plus === "/dev/null";
    const relPath = isNew ? fc.plus : fc.minus || fc.plus;
    try {
      const target = resolvePath(relPath);
      if (isDelete) {
        await rm(target, { force: true });
        results.push({ path: toRel(target), ok: true, action: "delete" });
        continue;
      }
      if (isNew) {
        const content = fc.hunks.flatMap((h) => h.after).join("\n");
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content.endsWith("\n") ? content : content + "\n", "utf8");
        results.push({ path: toRel(target), ok: true, action: "create" });
        continue;
      }
      let content = await readFile(target, "utf8");
      let applied = 0;
      for (const h of fc.hunks) {
        const before = h.before.join("\n");
        const after = h.after.join("\n");
        if (before === after) continue;
        if (before && content.includes(before)) {
          content = content.replace(before, after);
          applied++;
        } else if (!before) {
          content += (content.endsWith("\n") ? "" : "\n") + after;
          applied++;
        } else {
          throw new Error(`hunk context not found in ${toRel(target)}`);
        }
      }
      await writeFile(target, content, "utf8");
      results.push({ path: toRel(target), ok: true, action: "update", hunks: applied });
    } catch (err) {
      results.push({ path: relPath, ok: false, error: String(err?.message || err) });
      break;
    }
  }
  if (!fileChunks.length) throw new Error("No file sections found in diff (need ---/+++ headers).");
  return results;
}

async function applyOne(op) {
  const target = resolvePath(op.path);
  if (op.op === "create") {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, op.content ?? "", "utf8");
    return { op: "create", path: toRel(target), ok: true, bytes: Buffer.byteLength(op.content ?? "") };
  }
  if (op.op === "update") {
    let content = await readFile(target, "utf8");
    let count = 0;
    for (const edit of op.edits || []) {
      if (!content.includes(edit.old_text)) throw new Error(`old_text not found in ${target}`);
      if (edit.replace_all) {
        count += content.split(edit.old_text).length - 1;
        content = content.split(edit.old_text).join(edit.new_text);
      } else {
        content = content.replace(edit.old_text, edit.new_text);
        count += 1;
      }
    }
    await writeFile(target, content, "utf8");
    return { op: "update", path: toRel(target), ok: true, replacements: count };
  }
  if (op.op === "delete") {
    if (target === PRIMARY_ROOT || ROOTS.includes(target)) throw new Error("Refusing to delete a configured root.");
    await rm(target, { recursive: Boolean(op.recursive), force: false });
    return { op: "delete", path: toRel(target), ok: true };
  }
  if (op.op === "rename") {
    if (!op.rename_to) throw new Error("rename requires rename_to");
    const dst = resolvePath(op.rename_to);
    await mkdir(path.dirname(dst), { recursive: true });
    await rename(target, dst);
    return { op: "rename", path: toRel(target), to: toRel(dst), ok: true };
  }
  throw new Error(`Unknown op: ${op.op}`);
}

// ----------------------------------------------------------------------------
// Command execution
// ----------------------------------------------------------------------------
function registerExecTools(mcp) {
  reg(
    mcp,
    "run_command",
    {
      title: "Run command",
      description: "Run a command and wait for it to finish. Use proc_start for long-running servers. Output is trimmed to keep payloads small — use tail_lines/head_lines or max_output_chars to control it.",
      inputSchema: {
        command: z.string().min(1),
        cwd: z.string().optional().describe("Working directory inside a root."),
        shell: z.enum(["cmd", "powershell", "bash", "sh", "zsh"]).optional().describe("Shell to use (default cmd on Windows, bash/sh on macOS/Linux)."),
        timeout_ms: z.number().int().min(1000).max(600000).optional(),
        tail_lines: z.number().int().min(1).max(5000).optional().describe("Return only the last N lines of output."),
        head_lines: z.number().int().min(1).max(5000).optional().describe("Return only the first N lines of output."),
        max_output_chars: z.number().int().min(500).max(MAX_COMMAND_OUTPUT).optional().describe(`Cap stdout/stderr chars (default ${CMD_OUTPUT_DEFAULT}).`)
      }
    },
    async ({ command, cwd = ".", shell, timeout_ms = DEFAULT_CMD_TIMEOUT, tail_lines, head_lines, max_output_chars = CMD_OUTPUT_DEFAULT }) => {
      assertCommandAllowed(command);
      const workdir = resolvePath(cwd);
      const result = await runShellCommand(command, workdir, shell, timeout_ms);
      const trim = (s) => trimOutput(s, { tail_lines, head_lines, max_chars: max_output_chars });
      const stdout = trim(result.stdout);
      const stderr = trim(result.stderr);
      return jsonResult({
        cwd: workdir,
        command,
        shell: shell || defaultShell(),
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        stdout_truncated: stdout.length < result.stdout.length,
        stderr_truncated: stderr.length < result.stderr.length,
        stdout,
        stderr
      });
    }
  );

  reg(
    mcp,
    "run_commands",
    {
      title: "Run command batch",
      description: "Run up to 12 bounded commands in one MCP call. Sequential is the safe default; set parallel=true only for independent checks. Each command still passes mode, policy, root, timeout, and output guards.",
      inputSchema: {
        commands: z.array(z.object({
          command: z.string().min(1),
          cwd: z.string().optional(),
          shell: z.enum(["cmd", "powershell", "bash", "sh", "zsh"]).optional(),
          timeout_ms: z.number().int().min(1000).max(600000).optional(),
          max_output_chars: z.number().int().min(500).max(50_000).optional()
        })).min(1).max(12),
        parallel: z.boolean().optional().describe("Run independent commands concurrently (default false)."),
        max_concurrency: z.number().int().min(1).max(4).optional(),
        stop_on_failure: z.boolean().optional().describe("Sequential mode only; default true.")
      }
    },
    async ({ commands, parallel = false, max_concurrency = 4, stop_on_failure = true }) => {
      const results = new Array(commands.length);
      const runOne = async (item, index) => {
        assertCommandAllowed(item.command);
        const workdir = resolvePath(item.cwd || ".");
        const result = await runShellCommand(item.command, workdir, item.shell, item.timeout_ms || DEFAULT_CMD_TIMEOUT);
        const maxChars = item.max_output_chars || 10_000;
        const stdout = trimOutput(result.stdout, { max_chars: maxChars });
        const stderr = trimOutput(result.stderr, { max_chars: maxChars });
        results[index] = {
          index,
          cwd: workdir,
          command: item.command,
          shell: item.shell || defaultShell(),
          exit_code: result.exit_code,
          timed_out: result.timed_out,
          stdout_truncated: stdout.length < result.stdout.length,
          stderr_truncated: stderr.length < result.stderr.length,
          stdout,
          stderr
        };
      };

      if (parallel) {
        let cursor = 0;
        const worker = async () => {
          while (true) {
            const index = cursor++;
            if (index >= commands.length) return;
            await runOne(commands[index], index);
          }
        };
        await Promise.all(Array.from({ length: Math.min(max_concurrency, commands.length) }, () => worker()));
      } else {
        for (let index = 0; index < commands.length; index++) {
          await runOne(commands[index], index);
          if (stop_on_failure && results[index].exit_code !== 0) break;
        }
      }

      const completed = results.filter(Boolean);
      return jsonResult({
        ok: completed.length === commands.length && completed.every((result) => result.exit_code === 0),
        parallel,
        requested: commands.length,
        completed: completed.length,
        stopped_early: completed.length < commands.length,
        results: completed
      });
    }
  );
}

function registerProcessTools(mcp) {
  reg(
    mcp,
    "proc_start",
    {
      title: "Start background process",
      description: "Start a long-running process (dev server, watcher). Returns an id to poll.",
      inputSchema: {
        command: z.string().min(1),
        cwd: z.string().optional(),
        shell: z.enum(["cmd", "powershell", "bash", "sh", "zsh"]).optional(),
        name: z.string().optional()
      }
    },
    async ({ command, cwd = ".", shell, name }) => {
      assertCommandAllowed(command);
      const running = [...processes.values()].filter((p) => p.status === "running").length;
      if (running >= MAX_PROCS) throw new Error(`Too many running processes (max ${MAX_PROCS}). Stop some first.`);
      const workdir = resolvePath(cwd);
      const proc = startBackground(command, workdir, shell, name);
      return jsonResult({ ok: true, id: proc.id, name: proc.name, command, cwd: workdir, pid: proc.child.pid });
    }
  );

  reg(
    mcp,
    "proc_list",
    {
      title: "List background processes",
      description: "List background processes started by this agent.",
      inputSchema: {}
    },
    async () =>
      jsonResult({
        processes: [...processes.values()].map((p) => ({
          id: p.id,
          name: p.name,
          command: p.command,
          status: p.status,
          exit_code: p.exitCode,
          pid: p.child?.pid,
          started_at: p.startedAt
        }))
      })
  );

  reg(
    mcp,
    "proc_output",
    {
      title: "Read process output",
      description: "Return buffered stdout/stderr of a background process.",
      inputSchema: { id: z.string().min(1), tail_chars: z.number().int().min(1).max(PROC_BUFFER).optional() }
    },
    async ({ id, tail_chars }) => {
      const proc = processes.get(id);
      if (!proc) throw new Error(`No process with id ${id}`);
      const tail = (s) => (tail_chars && s.length > tail_chars ? s.slice(-tail_chars) : s);
      return jsonResult({
        id,
        status: proc.status,
        exit_code: proc.exitCode,
        stdout: tail(proc.stdout),
        stderr: tail(proc.stderr)
      });
    }
  );

  reg(
    mcp,
    "proc_stop",
    {
      title: "Stop background process",
      description: "Terminate a background process (and its child tree).",
      inputSchema: { id: z.string().min(1) }
    },
    async ({ id }) => {
      const proc = processes.get(id);
      if (!proc) throw new Error(`No process with id ${id}`);
      killProcessTree(proc);
      return jsonResult({ ok: true, id, status: proc.status });
    }
  );

  reg(
    mcp,
    "exec_start",
    {
      title: "Start terminal session",
      description: "Start an interactive-capable command session associated with a task/worktree. stdin and cursor reads are supported; native PTY activates only when a future adapter is installed.",
      inputSchema: {
        command: z.string().min(1),
        cwd: z.string().optional(),
        shell: z.enum(["cmd", "powershell", "bash", "sh", "zsh"]).optional(),
        name: z.string().optional(),
        task_id: z.string().optional(),
        worktree_id: z.string().optional(),
        pty: z.boolean().optional()
      }
    },
    async ({ command, cwd = ".", shell, name, task_id, worktree_id, pty = true }) => {
      assertCommandAllowed(command);
      const running = [...processes.values()].filter((p) => p.status === "running").length;
      if (running >= MAX_PROCS) throw new Error(`Too many running processes (max ${MAX_PROCS}).`);
      const workdir = resolvePath(cwd);
      const proc = startBackground(command, workdir, shell, name, { taskId: task_id, worktreeId: worktree_id, pty });
      return jsonResult({
        ok: true,
        session_id: proc.id,
        pid: proc.child.pid,
        task_id: proc.taskId,
        worktree_id: proc.worktreeId,
        pty_requested: proc.ptyRequested,
        pty_active: proc.ptyActive,
        pty_adapter: proc.ptyAdapter || null,
        stdin_supported: Boolean(proc.child.stdin),
        resize_supported: proc.resizeSupported,
        cursor: proc.cursorBase
      });
    }
  );

  reg(
    mcp,
    "exec_read",
    {
      title: "Read terminal session",
      description: "Read terminal output after a cursor without resending the complete buffer.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        session_id: z.string().min(1),
        cursor: z.number().int().min(0).optional(),
        max_chars: z.number().int().min(100).max(PROC_BUFFER).optional()
      }
    },
    async ({ session_id, cursor = 0, max_chars = 20000 }) => {
      const proc = processes.get(session_id);
      if (!proc) throw new Error(`No process with id ${session_id}`);
      const availableStart = proc.cursorBase;
      const effective = Math.max(cursor, availableStart);
      const offset = Math.max(0, effective - availableStart);
      const chunk = proc.output.slice(offset, offset + max_chars);
      return jsonResult({
        session_id,
        status: proc.status,
        exit_code: proc.exitCode,
        cursor_requested: cursor,
        cursor_reset: cursor < availableStart,
        cursor_start: effective,
        next_cursor: effective + chunk.length,
        output: chunk,
        has_more: offset + chunk.length < proc.output.length,
        pty_active: proc.ptyActive
      });
    }
  );

  reg(
    mcp,
    "exec_write",
    {
      title: "Write terminal input",
      description: "Write stdin to a running terminal session.",
      inputSchema: { session_id: z.string().min(1), input: z.string(), end: z.boolean().optional() }
    },
    async ({ session_id, input, end = false }) => {
      const proc = processes.get(session_id);
      if (!proc) throw new Error(`No process with id ${session_id}`);
      if (proc.status !== "running" || !proc.child.stdin?.writable) throw new Error("Process stdin is not writable.");
      if (end) proc.child.stdin.end(input);
      else proc.child.stdin.write(input);
      return jsonResult({ ok: true, session_id, bytes: Buffer.byteLength(input), ended: end });
    }
  );

  reg(
    mcp,
    "exec_resize",
    {
      title: "Resize terminal session",
      description: "Request terminal resize. Script-based PTY adapters report unsupported rather than pretending success.",
      inputSchema: { session_id: z.string().min(1), cols: z.number().int().min(20).max(1000), rows: z.number().int().min(5).max(500) }
    },
    async ({ session_id, cols, rows }) => {
      const proc = processes.get(session_id);
      if (!proc) throw new Error(`No process with id ${session_id}`);
      if (!proc.resizeSupported) return jsonResult({ ok: false, session_id, cols, rows, supported: false, pty_active: proc.ptyActive, adapter: proc.ptyAdapter || null });
      return jsonResult({ ok: true, session_id, cols, rows, supported: true });
    }
  );

  reg(
    mcp,
    "exec_signal",
    {
      title: "Signal terminal session",
      description: "Send a supported signal to a running command session.",
      inputSchema: { session_id: z.string().min(1), signal: z.enum(["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"]).optional() }
    },
    async ({ session_id, signal = "SIGINT" }) => {
      const proc = processes.get(session_id);
      if (!proc) throw new Error(`No process with id ${session_id}`);
      if (process.platform === "win32" && signal !== "SIGTERM" && signal !== "SIGKILL") {
        proc.child.stdin?.write("\u0003");
      } else {
        proc.child.kill(signal);
      }
      return jsonResult({ ok: true, session_id, signal });
    }
  );

  reg(
    mcp,
    "exec_cancel",
    {
      title: "Cancel terminal session",
      description: "Terminate one session and its process tree.",
      inputSchema: { session_id: z.string().min(1) }
    },
    async ({ session_id }) => {
      const proc = processes.get(session_id);
      if (!proc) throw new Error(`No process with id ${session_id}`);
      killProcessTree(proc);
      return jsonResult({ ok: true, session_id, status: proc.status });
    }
  );

  reg(
    mcp,
    "exec_list",
    {
      title: "List terminal sessions",
      description: "List terminal sessions with task/worktree association and terminal capabilities.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { task_id: z.string().optional() }
    },
    async ({ task_id }) => jsonResult({
      sessions: [...processes.values()]
        .filter((proc) => !task_id || proc.taskId === task_id)
        .map((proc) => ({
          session_id: proc.id,
          name: proc.name,
          command: proc.command,
          cwd: proc.cwd,
          status: proc.status,
          exit_code: proc.exitCode,
          pid: proc.child?.pid,
          task_id: proc.taskId,
          worktree_id: proc.worktreeId,
          pty_active: proc.ptyActive,
          pty_adapter: proc.ptyAdapter || null,
          stdin_supported: Boolean(proc.child?.stdin),
          started_at: proc.startedAt,
          next_cursor: proc.cursorBase + proc.output.length
        }))
    })
  );
}

// Git flags blocked on the raw `git` tool (any mode): they can write arbitrary
// files, run external programs, or operate outside the resolved repo.
const BAD_GIT_FLAGS = [
  /^-c$/, /^-C$/,
  /^--git-dir(=|$)/i, /^--work-tree(=|$)/i,
  /^--output(=|$)/i, /^--no-index$/i, /^--ext-diff$/i,
  /^--exec-path(=|$)/i, /^--upload-pack(=|$)/i, /^--receive-pack(=|$)/i
];

// Read-only git subcommands allowed in safe mode (mutating ones need full mode).
const GIT_READONLY = new Set([
  "status", "diff", "log", "show", "ls-files", "ls-tree", "rev-parse", "blame",
  "grep", "cat-file", "describe", "shortlog", "reflog", "whatchanged", "name-rev",
  "merge-base", "symbolic-ref", "for-each-ref", "count-objects", "version", "help"
]);

function registerGitTool(mcp) {
  reg(
    mcp,
    "git",
    {
      title: "Git",
      description: "Run a git command. Pass args as an array, e.g. [\"status\",\"--short\"].",
      inputSchema: {
        args: z.array(z.string()).min(1).describe('Git arguments, e.g. ["log","--oneline","-n","10"].'),
        cwd: z.string().optional().describe("Repository directory inside a root.")
      }
    },
    async ({ args, cwd = "." }) => {
      // Always block flags that can write files, run external programs, or escape
      // the repo — even on "read" subcommands (e.g. `git diff --output=../x`,
      // `-c core.pager=...`, `--ext-diff`, `--git-dir`/`--work-tree`).
      if (args.some((a) => BAD_GIT_FLAGS.some((re) => re.test(a)))) {
        throw new Error("That git flag is blocked (can write files, run external programs, or escape the repo).");
      }
      if (ACCESS_MODE === "safe") {
        // safe mode: only allow read-only git subcommands. Balanced mutations
        // are handled by the approval policy; full runs directly.
        const sub = (args.find((a) => !a.startsWith("-")) || "").toLowerCase();
        const infoFlag = args.some((a) => /^(--version|--help)$/i.test(a) || /^-[vh]$/.test(a));
        if (!infoFlag && !GIT_READONLY.has(sub)) {
          throw new Error(
            `Git "${sub || args[0] || ""}" is blocked in safe mode (only read-only git is allowed). Use git_status/git_diff, or select balanced/full access.`
          );
        }
      }
      const workdir = resolvePath(cwd);
      const result = await spawnCapture("git", args, workdir, DEFAULT_CMD_TIMEOUT);
      return jsonResult({ cwd: workdir, args, ...result });
    }
  );

  reg(
    mcp,
    "git_status",
    {
      title: "Git status",
      description: "Parsed working-tree status (git status --porcelain) for a repo inside a root. Returns a structured list of changed files with their index/worktree codes.",
      inputSchema: {
        cwd: z.string().optional().describe("Repository directory inside a root (default the primary root).")
      }
    },
    async ({ cwd = "." }) => {
      const workdir = resolvePath(cwd);
      const result = await spawnCapture("git", ["status", "--porcelain"], workdir, DEFAULT_CMD_TIMEOUT);
      if (result.exit_code !== 0) {
        // Not a git repo (or git error) — don't pretend it's "clean".
        return jsonResult({
          cwd: workdir,
          is_git_repo: false,
          clean: null,
          error: (result.stderr || "git error").split(/\r?\n/)[0]
        });
      }
      const branchRes = await spawnCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"], workdir, DEFAULT_CMD_TIMEOUT);
      const files = parsePorcelain(result.stdout || "");
      return jsonResult({
        cwd: workdir,
        is_git_repo: true,
        branch: (branchRes.stdout || "").trim() || null,
        clean: files.length === 0,
        count: files.length,
        files
      });
    }
  );

  reg(
    mcp,
    "git_diff",
    {
      title: "Git diff",
      description: "Show a git diff for a repo inside a root. Optionally limit to a path; pass staged:true to diff the index against HEAD.",
      inputSchema: {
        path: z.string().optional().describe("Limit the diff to this file or directory."),
        staged: z.boolean().optional().describe("Diff staged changes (--staged) instead of the working tree."),
        cwd: z.string().optional().describe("Repository directory inside a root (default the primary root).")
      }
    },
    async ({ path: rel, staged = false, cwd = "." }) => {
      const workdir = resolvePath(cwd);
      const args = ["diff"];
      if (staged) args.push("--staged");
      if (rel) {
        // Confine the diff path to a root as well.
        const target = resolvePath(rel);
        args.push("--", target);
      }
      const result = await spawnCapture("git", args, workdir, DEFAULT_CMD_TIMEOUT);
      if (result.exit_code !== 0) {
        return jsonResult({
          cwd: workdir,
          is_git_repo: false,
          error: (result.stderr || "git error").split(/\r?\n/)[0]
        });
      }
      return jsonResult({
        cwd: workdir,
        is_git_repo: true,
        staged,
        path: rel || null,
        diff: result.stdout || "",
        empty: !(result.stdout || "").trim()
      });
    }
  );
}

async function readWorktreeState() {
  try { return JSON.parse(await readFile(WORKTREES_STATE_PATH, "utf8")); } catch { return []; }
}

async function writeWorktreeState(items) {
  await mkdir(path.dirname(WORKTREES_STATE_PATH), { recursive: true });
  await writeFile(WORKTREES_STATE_PATH, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

function safeTaskSlug(value) {
  const slug = String(value || randomUUID()).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return slug || randomUUID();
}

async function createTaskWorktreeRecord(taskId, { base = "HEAD", branch } = {}) {
  const task = await TASK_RUNTIME.getTask(taskId);
  const state = await readWorktreeState();
  const existing = [...state].reverse().find((item) => item.taskId === task.id && item.status === "active" && existsSync(item.path));
  if (existing) return { created: false, worktree: existing };
  const slug = safeTaskSlug(taskId);
  let worktreePath = path.join(WORKTREES_DIR, slug);
  if (existsSync(worktreePath)) worktreePath = path.join(WORKTREES_DIR, `${slug}-${Date.now()}`);
  await mkdir(WORKTREES_DIR, { recursive: true });
  const branchName = branch || `lca/${slug}-${Date.now().toString(36)}`;
  const result = await spawnCapture("git", ["worktree", "add", "-b", branchName, worktreePath, base], PRIMARY_ROOT, 120_000);
  if (result.exit_code !== 0) throw new Error(result.stderr || "git worktree add failed");
  const record = { id: `wt-${randomUUID()}`, taskId: task.id, path: worktreePath, branch: branchName, base, status: "active", createdAt: isoNow(), updatedAt: isoNow() };
  state.push(record);
  await writeWorktreeState(state);
  await TASK_RUNTIME.updateTask(task.id, { activityType: "worktree_created", activityMessage: `Worktree ${branchName} created` });
  return { created: true, worktree: record };
}

async function worktreeRecommendation(task, requestedMode = "when-needed") {
  const mode = requestedMode || STARTUP_PROFILE?.worktree?.mode || "when-needed";
  const state = await readWorktreeState();
  const activeForTask = [...state].reverse().find((item) => item.taskId === task.id && item.status === "active" && existsSync(item.path));
  if (activeForTask) return { mode, useWorktree: true, reason: "existing_task_worktree", existing: activeForTask };
  if (mode === "never") return { mode, useWorktree: false, reason: "configured_never" };
  if (mode === "always") return { mode, useWorktree: true, reason: "configured_always" };
  const [status, tasks] = await Promise.all([
    spawnCapture("git", ["status", "--porcelain"], PRIMARY_ROOT, DEFAULT_CMD_TIMEOUT),
    TASK_RUNTIME.listTasks(100)
  ]);
  const dirty = parsePorcelain(status.stdout || "");
  const otherActiveTasks = tasks.filter((item) => item.id !== task.id && ["analyzing", "planned", "implementing", "verifying", "changed"].includes(item.status));
  if (otherActiveTasks.length > 0) return { mode, useWorktree: true, reason: "parallel_active_task", otherTaskIds: otherActiveTasks.map((item) => item.id), dirty };
  if (dirty.length > 0 && task.complexity === "complex") return { mode, useWorktree: true, reason: "complex_task_with_dirty_checkout", dirty };
  return { mode, useWorktree: false, reason: dirty.length ? "dirty_but_direct_task" : "single_task_clean_checkout", dirty };
}

function registerWorktreeTools(mcp) {
  reg(
    mcp,
    "task_create_worktree",
    {
      title: "Create task worktree",
      description: "Create an isolated Git worktree for a task. Worktrees are opt-in/when-needed, not created for every task.",
      inputSchema: {
        task_id: z.string().min(1),
        base: z.string().optional(),
        branch: z.string().optional()
      }
    },
    async ({ task_id, base = "HEAD", branch }) => jsonResult({ ok: true, ...(await createTaskWorktreeRecord(task_id, { base, branch })) })
  );

  reg(
    mcp,
    "task_prepare_workspace",
    {
      title: "Prepare task workspace",
      description: "Choose direct checkout or a task worktree using when-needed rules. Can create the recommended worktree in one call.",
      inputSchema: {
        task_id: z.string().min(1),
        mode: z.enum(["when-needed", "always", "never"]).optional(),
        create: z.boolean().optional(),
        base: z.string().optional()
      }
    },
    async ({ task_id, mode = STARTUP_PROFILE?.worktree?.mode || "when-needed", create = true, base = "HEAD" }) => {
      const task = await TASK_RUNTIME.getTask(task_id);
      const recommendation = await worktreeRecommendation(task, mode);
      if (!recommendation.useWorktree) {
        await TASK_RUNTIME.updateTask(task_id, { activityType: "workspace_selected", activityMessage: `Using primary checkout (${recommendation.reason})` });
        return jsonResult({ ok: true, task_id, workspace: PRIMARY_ROOT, worktree: null, recommendation });
      }
      if (recommendation.existing) return jsonResult({ ok: true, task_id, workspace: recommendation.existing.path, worktree: recommendation.existing, recommendation });
      if (!create) return jsonResult({ ok: true, task_id, workspace: PRIMARY_ROOT, worktree: null, recommendation, creation_required: true });
      const result = await createTaskWorktreeRecord(task_id, { base });
      return jsonResult({ ok: true, task_id, workspace: result.worktree.path, ...result, recommendation });
    }
  );

  reg(
    mcp,
    "task_worktree_list",
    {
      title: "List task worktrees",
      description: "List LCA-managed task worktrees.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { task_id: z.string().optional() }
    },
    async ({ task_id }) => {
      const state = await readWorktreeState();
      return jsonResult({ worktrees: state.filter((item) => !task_id || item.taskId === task_id) });
    }
  );

  reg(
    mcp,
    "task_diff",
    {
      title: "Task worktree diff",
      description: "Collect tracked and untracked changes from a task worktree.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { task_id: z.string().min(1), max_chars: z.number().int().min(1000).max(500000).optional() }
    },
    async ({ task_id, max_chars = 250000 }) => {
      const state = await readWorktreeState();
      const worktree = [...state].reverse().find((item) => item.taskId === task_id && item.status === "active");
      if (!worktree) throw new Error(`No active worktree for task ${task_id}`);
      const tracked = await spawnCapture("git", ["diff", "--binary", "HEAD"], worktree.path, DEFAULT_CMD_TIMEOUT);
      const extra = await untrackedDiff(worktree.path);
      const diff = `${tracked.stdout || ""}${tracked.stdout && extra.diff ? "\n" : ""}${extra.diff || ""}`;
      return jsonResult({ ok: tracked.exit_code === 0, task_id, worktree, untracked: extra.files, diff: diff.slice(0, max_chars), truncated: diff.length > max_chars });
    }
  );

  reg(
    mcp,
    "task_apply_to_main",
    {
      title: "Apply task worktree changes",
      description: "Apply a task worktree's tracked and untracked patch to the primary checkout after a complete git apply --check.",
      inputSchema: { task_id: z.string().min(1) }
    },
    async ({ task_id }) => {
      const state = await readWorktreeState();
      const worktree = [...state].reverse().find((item) => item.taskId === task_id && item.status === "active");
      if (!worktree) throw new Error(`No active worktree for task ${task_id}`);
      const tracked = await spawnCapture("git", ["diff", "--binary", "HEAD"], worktree.path, DEFAULT_CMD_TIMEOUT);
      if (tracked.exit_code !== 0) throw new Error(tracked.stderr || "Could not collect task diff");
      const extra = await untrackedDiff(worktree.path);
      const diff = `${tracked.stdout || ""}${tracked.stdout && extra.diff ? "\n" : ""}${extra.diff || ""}`;
      if (!diff.trim()) return jsonResult({ ok: true, task_id, applied: false, message: "Task worktree has no changes." });
      const patchFile = path.join(WORKSPACE_DATA_DIR, `apply-${safeTaskSlug(task_id)}-${Date.now()}.patch`);
      await writeFile(patchFile, diff, "utf8");
      try {
        const check = await spawnCapture("git", ["apply", "--check", "--whitespace=nowarn", patchFile], PRIMARY_ROOT, DEFAULT_CMD_TIMEOUT);
        if (check.exit_code !== 0) throw new Error(`WORKTREE_APPLY_CONFLICT: ${check.stderr || check.stdout}`);
        const apply = await spawnCapture("git", ["apply", "--whitespace=nowarn", patchFile], PRIMARY_ROOT, DEFAULT_CMD_TIMEOUT);
        if (apply.exit_code !== 0) throw new Error(apply.stderr || "git apply failed");
        worktree.updatedAt = isoNow();
        worktree.lastAppliedAt = isoNow();
        await writeWorktreeState(state);
        await TASK_RUNTIME.updateTask(task_id, { status: "changed", activityType: "worktree_applied", activityMessage: "Worktree changes applied to primary checkout" });
        return jsonResult({ ok: true, task_id, worktree_id: worktree.id, applied: true, untracked: extra.files });
      } finally {
        await rm(patchFile, { force: true }).catch(() => {});
      }
    }
  );

  reg(
    mcp,
    "task_discard_worktree",
    {
      title: "Discard task worktree",
      description: "Remove a task worktree and optionally delete its local task branch.",
      inputSchema: { task_id: z.string().min(1), delete_branch: z.boolean().optional() }
    },
    async ({ task_id, delete_branch = true }) => {
      const state = await readWorktreeState();
      const index = state.findLastIndex((item) => item.taskId === task_id && item.status === "active");
      if (index < 0) throw new Error(`No active worktree for task ${task_id}`);
      const worktree = state[index];
      const remove = await spawnCapture("git", ["worktree", "remove", "--force", worktree.path], PRIMARY_ROOT, 120_000);
      if (remove.exit_code !== 0) throw new Error(remove.stderr || "git worktree remove failed");
      if (delete_branch) await spawnCapture("git", ["branch", "-D", worktree.branch], PRIMARY_ROOT, DEFAULT_CMD_TIMEOUT);
      worktree.status = "discarded";
      worktree.updatedAt = isoNow();
      await writeWorktreeState(state);
      await TASK_RUNTIME.updateTask(task_id, { activityType: "worktree_discarded", activityMessage: `Worktree ${worktree.branch} discarded` });
      return jsonResult({ ok: true, worktree });
    }
  );
}

// Parse `git status --porcelain` into structured entries. Each line is
// "XY <path>" (or "XY <old> -> <new>" for renames) where X is the index code
// and Y the worktree code.
function parsePorcelain(out) {
  const files = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    const index = line[0];
    const worktree = line[1];
    let rest = line.slice(3);
    let from = null;
    let to = rest;
    const arrow = rest.indexOf(" -> ");
    if (arrow !== -1) {
      from = rest.slice(0, arrow);
      to = rest.slice(arrow + 4);
    }
    files.push({
      index: index === " " ? null : index,
      worktree: worktree === " " ? null : worktree,
      path: to,
      from,
      staged: index !== " " && index !== "?",
      untracked: index === "?" && worktree === "?"
    });
  }
  return files;
}

// ----------------------------------------------------------------------------
// Path safety
// ----------------------------------------------------------------------------
// Canonical (symlink/junction-resolved) form of the roots, computed once.
const REAL_ROOTS = ROOTS.map((r) => {
  try {
    return realpathSync(r);
  } catch {
    return r;
  }
});

// Resolve the longest existing ancestor with realpath, then re-append the
// not-yet-existing tail. This canonicalizes symlinks/junctions even for files
// that don't exist yet (e.g. write_file targets).
function canonicalize(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  return path.resolve(p);
}

function resolvePath(input = ".") {
  const raw = String(input ?? ".").trim();
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(PRIMARY_ROOT, raw);
  // Validate the canonical path. Besides blocking symlink/junction escapes,
  // this avoids false rejections on case-insensitive macOS volumes when the
  // caller uses different path casing than the filesystem stores.
  const canon = canonicalize(resolved);
  if (!isWithinRoots(canon, REAL_ROOTS)) {
    throw new Error(`Path is outside the allowed roots or resolves outside via a link: ${input}`);
  }
  return resolved;
}

function isWithinRoots(p, roots = ROOTS) {
  return roots.some((root) => {
    const target = comparePath(p);
    const base = comparePath(root);
    const withSep = base.endsWith(path.sep) ? base : base + path.sep;
    return target === base || target.startsWith(withSep);
  });
}

// Shorten output paths: relative to the primary root (posix slashes) when the
// file lives under it, otherwise the absolute path. Round-trips back through
// resolvePath() because relative inputs resolve against the primary root.
function toRel(abs) {
  if (comparePath(abs) === comparePath(PRIMARY_ROOT)) return ".";
  const withSep = PRIMARY_ROOT.endsWith(path.sep) ? PRIMARY_ROOT : PRIMARY_ROOT + path.sep;
  if (comparePath(abs).startsWith(comparePath(withSep))) return abs.slice(withSep.length).split(path.sep).join("/");
  return abs;
}

// ----------------------------------------------------------------------------
// Listing / search
// ----------------------------------------------------------------------------
async function listEntries(dir, { recursive, limit }) {
  const out = [];
  async function walk(current) {
    let items;
    try {
      items = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (out.length >= limit) return;
      if (SKIP_DIRS.has(item.name)) continue;
      const abs = path.join(current, item.name);
      let info;
      try {
        info = await stat(abs);
      } catch {
        continue;
      }
      out.push({
        path: toRel(abs),
        type: item.isDirectory() ? "directory" : "file",
        size: info.size,
        modified: info.mtime.toISOString()
      });
      if (recursive && item.isDirectory()) await walk(abs);
    }
  }
  await walk(dir);
  return out;
}

// Parse "path:line:text" grep-style output into match objects.
function parseGrepOutput(out, dir, limit) {
  const matches = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    const m = line.match(/^(.*?):(\d+):(.*)$/);
    if (!m) continue;
    const abs = path.resolve(dir, m[1]);
    matches.push({ path: toRel(abs), line: Number(m[2]), text: m[3].slice(0, 500) });
    if (matches.length >= limit) break;
  }
  return matches;
}

// Fastest path: ripgrep. Respects .gitignore, works in any folder. null on miss.
function ripgrepGrep(dir, query, { regex, limit, glob }) {
  if (!RG_BIN) return Promise.resolve(null);
  // NOTE: no -I here — in ripgrep -I means --no-filename (grep/git use it for
  // "ignore binary"). ripgrep skips binary files by default.
  const args = ["--no-heading", "--with-filename", "-n", "-S", "--color", "never"];
  if (!regex) args.push("-F");
  if (glob) args.push("-g", glob);
  args.push("-e", query, "--", ".");
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(RG_BIN, args, { cwd: dir, windowsHide: true });
    } catch {
      return resolve(null);
    }
    child.stdout?.on("data", (c) => {
      if (out.length < 8_000_000) out += c.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0 && code !== 1) return resolve(null);
      resolve(parseGrepOutput(out, dir, limit));
    });
  });
}

// Fast path: `git grep` inside a git work tree. Returns null when not a git repo
// / git unavailable / errored, so the caller can fall back to a JS scan.
function gitGrep(dir, query, { regex, limit, glob }) {
  return new Promise((resolve) => {
    const args = ["-C", dir, "grep", "--no-color", "-n", "-I", "-i", "--untracked"];
    args.push(regex ? "-E" : "-F", "-e", query, "--", glob ? glob : ".");
    let out = "";
    let child;
    try {
      child = spawn("git", args, { windowsHide: true });
    } catch {
      return resolve(null);
    }
    child.stdout?.on("data", (c) => {
      if (out.length < 8_000_000) out += c.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code === 128) return resolve(null); // not a git repo
      if (code !== 0 && code !== 1) return resolve(null); // 1 = no matches
      resolve(parseGrepOutput(out, dir, limit));
    });
  });
}

// Attach a few lines of context to each match by reading files locally (no extra
// round trips to the model). Files are read once and cached for this call.
async function attachContext(matches, ctx) {
  const cache = new Map();
  for (const m of matches) {
    const abs = path.isAbsolute(m.path) ? m.path : path.resolve(PRIMARY_ROOT, m.path);
    let lines = cache.get(abs);
    if (!lines) {
      try {
        lines = (await readFile(abs, "utf8")).split(/\r?\n/);
      } catch {
        lines = null;
      }
      cache.set(abs, lines);
    }
    if (!lines) continue;
    const from = Math.max(1, m.line - ctx);
    const to = Math.min(lines.length, m.line + ctx);
    const snippet = [];
    for (let i = from; i <= to; i++) snippet.push(`${i}| ${lines[i - 1]}`);
    m.snippet = snippet.join("\n");
  }
}

// Convert a simple glob (*, **, ?) to a RegExp for the scan fallback.
function globToRegex(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += ".";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp("^" + out + "$", "i");
}

// Find files by name glob: ripgrep --files > git ls-files > JS walk.
async function findFiles(start, glob, limit) {
  // ripgrep
  if (RG_BIN) {
    const out = await spawnFilesList(RG_BIN, ["--files", "-g", glob], start);
    if (out !== null) return { engine: "ripgrep", files: out.slice(0, limit).map((p) => toRel(path.resolve(start, p))) };
  }
  // git ls-files
  const gitOut = await spawnFilesList("git", ["-C", start, "ls-files", "--cached", "--others", "--exclude-standard"], null);
  if (gitOut !== null) {
    const rx = globToRegex(glob);
    const hasSlash = glob.includes("/");
    const hit = gitOut.filter((p) => rx.test(hasSlash ? p : path.basename(p)));
    if (hit.length || gitOut.length) return { engine: "git", files: hit.slice(0, limit).map((p) => toRel(path.resolve(start, p))) };
  }
  // JS walk fallback
  const rx = globToRegex(glob);
  const hasSlash = glob.includes("/");
  const all = await listEntries(start, { recursive: true, limit: 20000 });
  const files = all
    .filter((e) => e.type === "file")
    .map((e) => e.path)
    .filter((p) => rx.test(hasSlash ? p.split(path.sep).join("/") : path.basename(p)))
    .slice(0, limit);
  return { engine: "scan", files };
}

async function listRepoFilesFast(start, limit = 4000) {
  if (RG_BIN) {
    const out = await spawnFilesList(RG_BIN, ["--files"], start);
    if (out !== null) {
      return { engine: "ripgrep", files: out.slice(0, limit).map((p) => path.resolve(start, p)) };
    }
  }
  const gitOut = await spawnFilesList("git", ["-C", start, "ls-files", "--cached", "--others", "--exclude-standard"], null);
  if (gitOut !== null) {
    return { engine: "git", files: gitOut.slice(0, limit).map((p) => path.resolve(start, p)) };
  }
  const all = await listEntries(start, { recursive: true, limit });
  return { engine: "scan", files: all.filter((e) => e.type === "file").map((e) => resolvePath(e.path)) };
}

function spawnFilesList(file, args, cwd) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(file, args, cwd ? { cwd, windowsHide: true } : { windowsHide: true });
    } catch {
      return resolve(null);
    }
    child.stdout?.on("data", (c) => {
      if (out.length < 8_000_000) out += c.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0 && code !== 1) return resolve(null);
      resolve(out.split(/\r?\n/).filter(Boolean));
    });
  });
}

async function searchTree(start, query, { regex, limit, glob }) {
  const pattern = regex ? new RegExp(query, "i") : null;
  const needle = query.toLowerCase();
  const globRx = glob ? globToRegex(glob) : null;
  const globHasSlash = glob ? glob.includes("/") : false;
  const matches = [];
  const files = [];

  async function collect(current) {
    let info;
    try {
      info = await stat(current);
    } catch {
      return;
    }
    if (info.isFile()) {
      files.push(current);
      return;
    }
    let items;
    try {
      items = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (SKIP_DIRS.has(item.name)) continue;
      if (files.length > 50000) return;
      await collect(path.join(current, item.name));
    }
  }

  await collect(start);
  for (const file of files) {
    if (matches.length >= limit) break;
    if (globRx) {
      const rel = toRel(file);
      const target = globHasSlash ? rel : path.basename(file);
      if (!globRx.test(target)) continue;
    }
    let content;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const found = regex ? pattern.test(line) : line.toLowerCase().includes(needle);
      if (!found) continue;
      matches.push({ path: toRel(file), line: i + 1, text: line.slice(0, 500) });
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

// ----------------------------------------------------------------------------
// Command policy + execution
// ----------------------------------------------------------------------------
function assertCommandAllowed(command) {
  const cmd = String(command);
  if (!ALLOW_DANGEROUS && CATASTROPHIC.some((re) => re.test(cmd))) {
    throw new Error("Command blocked: catastrophic system operation (set AGENT_ALLOW_DANGEROUS=1 to override).");
  }
  if (ACCESS_MODE === "safe" && SAFE_MODE_BLOCKS.some((re) => re.test(cmd))) {
    throw new Error("Command blocked by safe mode. Switch to balanced/full for broader command access.");
  }
}

function defaultShell() {
  if (process.platform === "win32") return "cmd";
  return hasCommand("bash") ? "bash" : "sh";
}

function shellQuotePosix(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildPtySpawn(command, shell) {
  if (process.platform === "win32" || !hasCommand("script")) return null;
  const selected = shell || defaultShell();
  const shellFile = selected === "powershell" ? (hasCommand("pwsh") ? "pwsh" : "powershell") : selected;
  if (process.platform === "darwin") {
    return { file: "/usr/bin/script", args: ["-q", "/dev/null", shellFile, "-lc", command], opts: {}, ptyAdapter: "bsd-script" };
  }
  const wrappedCommand = `${shellFile} -lc ${shellQuotePosix(command)}`;
  return { file: hasCommand("script") ? "script" : "/usr/bin/script", args: ["-qefc", wrappedCommand, "/dev/null"], opts: {}, ptyAdapter: "util-linux-script" };
}

function buildSpawn(command, shell) {
  const s = shell || defaultShell();
  if (s === "powershell") {
    const file = process.platform === "win32" ? "powershell.exe" : hasCommand("pwsh") ? "pwsh" : "powershell";
    return { file, args: ["-NoProfile", "-NonInteractive", "-Command", command], opts: {} };
  }
  if (s === "bash") {
    return { file: "bash", args: ["-lc", command], opts: {} };
  }
  if (s === "sh") {
    return { file: "sh", args: ["-c", command], opts: {} };
  }
  if (s === "zsh") {
    return { file: "zsh", args: ["-lc", command], opts: {} };
  }
  // cmd / default: rely on the OS shell so pipes/redirects work.
  return { file: command, args: [], opts: { shell: true } };
}

function spawnOptions(cwd, opts = {}, env = buildChildEnv(process.env, { AGENT_WORKSPACE: PRIMARY_ROOT }, { exclude: CHILD_ENV_EXCLUDE })) {
  return {
    cwd,
    windowsHide: true,
    detached: process.platform !== "win32",
    env,
    ...opts
  };
}

function terminateChildTree(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

function runShellCommand(command, cwd, shell, timeoutMs) {
  const base = buildSpawn(command, shell);
  const { file, args, opts } = wrapSpawnSpec(base, cwd, ACCESS_MODE);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(file, args, spawnOptions(cwd, opts));
    } catch (err) {
      resolve({ exit_code: null, timed_out: false, stdout: "", stderr: String(err?.message || err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildTree(child, "SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", (c) => (stdout = appendLimited(stdout, c.toString(), MAX_COMMAND_OUTPUT)));
    child.stderr?.on("data", (c) => (stderr = appendLimited(stderr, c.toString(), MAX_COMMAND_OUTPUT)));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exit_code: null, timed_out: timedOut, stdout, stderr: stderr + String(err?.message || err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exit_code: code, timed_out: timedOut, stdout, stderr });
    });
  });
}

function spawnCapture(file, args, cwd, timeoutMs) {
  const wrapped = wrapSpawnSpec({ file, args, opts: {} }, cwd, ACCESS_MODE);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(wrapped.file, wrapped.args, spawnOptions(cwd, wrapped.opts));
    } catch (err) {
      resolve({ exit_code: null, timed_out: false, stdout: "", stderr: String(err?.message || err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildTree(child, "SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", (c) => (stdout = appendLimited(stdout, c.toString(), MAX_COMMAND_OUTPUT)));
    child.stderr?.on("data", (c) => (stderr = appendLimited(stderr, c.toString(), MAX_COMMAND_OUTPUT)));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exit_code: null, timed_out: timedOut, stdout, stderr: stderr + String(err?.message || err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exit_code: code, timed_out: timedOut, stdout, stderr });
    });
  });
}

async function persistProcessState() {
  const rows = [...processes.values()].map((proc) => ({
    id: proc.id,
    name: proc.name,
    command: proc.command,
    cwd: proc.cwd,
    shell: proc.shell,
    status: proc.status,
    exitCode: proc.exitCode,
    pid: proc.child?.pid || null,
    startedAt: proc.startedAt,
    taskId: proc.taskId || null,
    worktreeId: proc.worktreeId || null,
    ptyRequested: Boolean(proc.ptyRequested),
    ptyActive: Boolean(proc.ptyActive),
    ptyAdapter: proc.ptyAdapter || null,
    boundary: proc.boundary || null,
    cursorBase: proc.cursorBase || 0,
    output: String(proc.output || "").slice(-20000),
    stdout: String(proc.stdout || "").slice(-10000),
    stderr: String(proc.stderr || "").slice(-10000)
  }));
  await mkdir(path.dirname(PROCESS_STATE_PATH), { recursive: true });
  await writeFile(PROCESS_STATE_PATH, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

async function restoreProcessState() {
  let rows;
  try { rows = JSON.parse(await readFile(PROCESS_STATE_PATH, "utf8")); } catch { return; }
  for (const row of Array.isArray(rows) ? rows : []) {
    const alive = row.status === "running" && pidAlive(row.pid);
    const child = row.pid ? {
      pid: row.pid,
      stdin: null,
      kill(signal = "SIGTERM") { try { process.kill(Number(row.pid), signal); } catch {} }
    } : null;
    processes.set(row.id, {
      ...row,
      child,
      status: alive ? "running" : (row.status === "running" ? "orphaned" : row.status),
      stdout: row.stdout || "",
      stderr: row.stderr || "",
      output: row.output || "",
      cursorBase: Number(row.cursorBase || 0),
      ptyActive: Boolean(row.ptyActive),
      ptyAdapter: row.ptyAdapter || null,
      resizeSupported: false,
      restored: true
    });
  }
}

function startBackground(command, cwd, shell, name, metadata = {}) {
  const ptySpec = metadata.pty ? buildPtySpawn(command, shell) : null;
  const base = ptySpec || buildSpawn(command, shell);
  const { file, args, opts, boundary } = wrapSpawnSpec(base, cwd, ACCESS_MODE);
  const child = spawn(file, args, spawnOptions(cwd, opts));
  const proc = {
    id: randomUUID(),
    name: name || command.slice(0, 40),
    command,
    child,
    status: "running",
    exitCode: null,
    startedAt: isoNow(),
    cwd,
    shell: shell || defaultShell(),
    taskId: metadata.taskId || null,
    worktreeId: metadata.worktreeId || null,
    boundary,
    ptyRequested: Boolean(metadata.pty),
    ptyActive: Boolean(ptySpec),
    ptyAdapter: ptySpec?.ptyAdapter || null,
    resizeSupported: false,
    stdout: "",
    stderr: "",
    output: "",
    cursorBase: 0
  };
  const appendProcessOutput = (stream, chunk) => {
    const text = chunk.toString();
    proc[stream] = appendLimited(proc[stream], text, PROC_BUFFER);
    const next = appendLimited(proc.output, text, PROC_BUFFER);
    if (next.length < proc.output.length + text.length) proc.cursorBase += proc.output.length + text.length - next.length;
    proc.output = next;
  };
  child.stdout?.on("data", (c) => appendProcessOutput("stdout", c));
  child.stderr?.on("data", (c) => appendProcessOutput("stderr", c));
  child.on("error", (err) => {
    proc.status = "error";
    proc.stderr = appendLimited(proc.stderr, String(err?.message || err), PROC_BUFFER);
    persistProcessState().catch(() => {});
  });
  child.on("close", (code) => {
    proc.status = "exited";
    proc.exitCode = code;
    persistProcessState().catch(() => {});
  });
  processes.set(proc.id, proc);
  persistProcessState().catch(() => {});
  return proc;
}

function killProcessTree(proc) {
  if (!proc?.child || proc.status !== "running") {
    if (proc) proc.status = proc.status === "running" ? "stopped" : proc.status;
    return;
  }
  const pid = proc.child.pid;
  try {
    if (pid) terminateChildTree(proc.child, "SIGTERM");
  } catch {}
  proc.status = "stopped";
  persistProcessState().catch(() => {});
}

// ----------------------------------------------------------------------------
// Notes
// ----------------------------------------------------------------------------
async function readNotes() {
  try {
    return JSON.parse(await readFile(NOTES_PATH, "utf8"));
  } catch {
    return [];
  }
}

async function writeNotes(notes) {
  await mkdir(path.dirname(NOTES_PATH), { recursive: true });
  await writeFile(NOTES_PATH, `${JSON.stringify(notes, null, 2)}\n`, "utf8");
}

// ----------------------------------------------------------------------------
// Skills (Claude-style on-demand playbooks)
// ----------------------------------------------------------------------------
async function discoverSkills() {
  const found = [];
  const seen = new Set();
  for (const base of SKILLS_DIRS) {
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      continue; // dir doesn't exist
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(base, e.name);
      let skillFile = null;
      try {
        const files = await readdir(dir);
        const hit = files.find((f) => f.toLowerCase() === "skill.md");
        if (hit) skillFile = path.join(dir, hit);
      } catch {
        continue;
      }
      if (!skillFile) continue;
      let meta;
      try {
        meta = parseSkillMeta(await readFile(skillFile, "utf8"), e.name);
      } catch {
        meta = { name: e.name, description: "" };
      }
      const key = meta.name.toLowerCase();
      if (seen.has(key)) continue; // first source wins
      seen.add(key);
      found.push({ name: meta.name, description: meta.description, dir, skillFile });
    }
  }
  return found;
}

function parseSkillMeta(text, fallbackName) {
  text = text.replace(/^﻿/, ""); // strip UTF-8 BOM (some Windows editors add it)
  let name = fallbackName;
  let description = "";
  const fm = text.match(/^---\s*[\r\n]([\s\S]*?)[\r\n]---/);
  if (fm) {
    const block = fm[1];
    const n = block.match(/^\s*name\s*:\s*(.+?)\s*$/im);
    const d = block.match(/^\s*description\s*:\s*(.+?)\s*$/im);
    if (n) name = n[1].replace(/^["']|["']$/g, "").trim();
    if (d) description = d[1].replace(/^["']|["']$/g, "").trim();
  }
  if (!description) {
    const body = fm ? text.slice(fm[0].length) : text;
    const firstLine = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    if (firstLine) description = firstLine.slice(0, 200);
  }
  return { name, description };
}

function resultLen(result) {
  try {
    let n = 0;
    for (const c of result?.content || []) n += (c?.text || "").length;
    return n;
  } catch {
    return 0;
  }
}

function firstText(result) {
  try {
    return result?.content?.[0]?.text || "";
  } catch {
    return "";
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function dedupe(arr) {
  return [...new Set(arr)];
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function boundedNumber(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function parseExtraRoots() {
  const json = process.env.AGENT_EXTRA_ROOTS_JSON;
  if (json && json.trim()) {
    try {
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== "string")) {
        throw new Error("AGENT_EXTRA_ROOTS_JSON must be a JSON string array.");
      }
      return dedupe([...parsed, ...(Array.isArray(STARTUP_PROFILE?.extraRoots) ? STARTUP_PROFILE.extraRoots : [])]).map((p) => path.resolve(p));
    } catch (err) {
      console.warn(`Invalid AGENT_EXTRA_ROOTS_JSON ignored: ${err?.message || err}`);
    }
  }
  return dedupe([
    ...(process.env.AGENT_EXTRA_ROOTS || "").split(";"),
    ...(Array.isArray(STARTUP_PROFILE?.extraRoots) ? STARTUP_PROFILE.extraRoots : [])
  ])
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
}

function hasCommand(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore", windowsHide: true });
  return !result.error;
}

function comparePath(p) {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isoNow() {
  return new Date().toISOString();
}

function appendLimited(current, next, max) {
  const combined = current + next;
  if (combined.length <= max) return combined;
  return combined.slice(combined.length - max);
}

// Trim command output for display: prefer line slicing (head/tail), else cap chars.
function trimOutput(s, { tail_lines, head_lines, max_chars }) {
  if (!s) return s;
  if (head_lines || tail_lines) {
    const lines = s.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop(); // drop trailing newline's empty line
    const picked = head_lines ? lines.slice(0, head_lines) : lines.slice(-tail_lines);
    const out = picked.join("\n");
    return out.length > max_chars ? out.slice(0, max_chars) : out;
  }
  return s.length > max_chars ? s.slice(0, max_chars) : s;
}

function log(message) {
  console.log(`${isoNow()} ${message}`);
}

function audit(entry) {
  if (!AUDIT_ENABLED) return;
  const line = `${JSON.stringify(entry)}\n`;
  if (auditStream && !auditStream.destroyed) {
    auditStream.write(line);
    return;
  }
  appendFile(AUDIT_PATH, line, "utf8").catch(() => {});
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

// Compact JSON keeps payloads (and the tokens ChatGPT must read) small, which
// is the main lever for perceived speed over the tunnel.
function jsonResult(value) {
  return textResult(JSON.stringify(value));
}

function structuredJsonResult(value) {
  return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] };
}

function localBrowserOrigins() {
  return new Set([
    `http://${HOST}:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
    `http://[::1]:${PORT}`
  ]);
}

function originAllowed(req) {
  const origin = String(req.headers.origin || "");
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin) || localBrowserOrigins().has(origin);
}

function setCors(req, res) {
  const origin = String(req.headers.origin || "");
  if (origin && (ALLOWED_ORIGINS.has(origin) || localBrowserOrigins().has(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, mcp-session-id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflow = false;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        overflow = true;
        return;
      }
      if (!overflow) chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflow) {
        reject(Object.assign(new Error("Payload too large."), { statusCode: 413 }));
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, value) {
  const json = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}

function oauthProtectedResourceMetadata() {
  const resource = `http://${HOST}:${PORT}/mcp`;
  return {
    resource,
    bearer_methods_supported: ["header"],
    scopes_supported: [],
    resource_name: "Local Coding Agent MCP",
    resource_documentation: `http://${HOST}:${PORT}/`
  };
}

// ============================================================================
// v2.1 — Repo Intelligence
// ============================================================================

const REPO_INDEX_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function readRepoIndex() {
  try {
    const raw = await readFile(INDEX_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeRepoIndex(data) {
  await mkdir(path.dirname(INDEX_PATH), { recursive: true });
  await writeFile(INDEX_PATH, JSON.stringify(data, null, 2), "utf8");
}

function indexFresh(idx) {
  if (!idx || !idx.ts) return false;
  return Date.now() - new Date(idx.ts).getTime() < REPO_INDEX_TTL_MS;
}

function indexMatches(idx, rootDir) {
  return Boolean(idx && idx.rootDir === rootDir && indexFresh(idx));
}

function treeCovers(idx, { depth, maxEntries }) {
  const tree = idx?.tree;
  if (!tree || Number(tree.depth || 0) < depth) return false;
  if (tree.truncated && Number(tree.max_entries || tree.entries?.length || 0) < maxEntries) return false;
  return true;
}

function symbolsCover(idx, { maxFiles, maxMatches }) {
  const meta = idx?.symbols_meta;
  return Array.isArray(idx?.symbols) &&
    Number(meta?.max_files || 0) >= maxFiles &&
    Number(meta?.max_matches || 0) >= maxMatches;
}

function relEntriesToAbs(rootDir, entries = []) {
  return entries.filter((entry) => !entry.endsWith("/")).map((entry) => path.resolve(rootDir, entry));
}

async function buildRepoIndex(rootDir, { depth = 3, maxEntries = 800, includeSymbols = false, symbolMaxFiles = 500, symbolMaxMatches = 2000, refresh = false } = {}) {
  const cached = await readRepoIndex();
  if (!refresh && indexMatches(cached, rootDir) && treeCovers(cached, { depth, maxEntries })) {
    if (includeSymbols && !symbolsCover(cached, { maxFiles: symbolMaxFiles, maxMatches: symbolMaxMatches })) {
      const seeded = relEntriesToAbs(rootDir, cached.tree?.entries || []);
      cached.symbols = await scanSymbols(rootDir, { files: seeded, maxFiles: symbolMaxFiles, maxMatches: symbolMaxMatches }).catch(() => []);
      cached.symbols_meta = { max_files: symbolMaxFiles, max_matches: symbolMaxMatches };
      cached.ts = isoNow();
      cached.generated_at = cached.ts;
      await writeRepoIndex(cached);
    }
    return { ...cached, cached: true };
  }

  const [profile, treePack, importantFiles, git] = await Promise.all([
    detectProjectProfile(rootDir).catch(() => ({ languages: [], frameworks: [], packageManagers: [], manifests: [], scripts: {} })),
    buildTreeFast(rootDir, depth, maxEntries),
    collectImportantFiles(rootDir).catch(() => []),
    compactGitStatus(rootDir)
  ]);
  const treeEntries = treePack.tree.map(toRel).slice(0, maxEntries);
  const symbols = includeSymbols
    ? await scanSymbols(rootDir, { files: treePack.files, maxFiles: symbolMaxFiles, maxMatches: symbolMaxMatches }).catch(() => [])
    : undefined;
  const ts = isoNow();
  const next = {
    ts,
    generated_at: ts,
    rootDir,
    ttl_ms: REPO_INDEX_TTL_MS,
    profile: { rootDir, ...profile },
    tree: {
      depth,
      max_entries: maxEntries,
      engine: treePack.engine || "scan",
      dirs: treePack.dirs.length,
      files: treePack.files.length,
      truncated: treePack.tree.length >= maxEntries,
      entries: treeEntries
    },
    important_files: importantFiles.slice(0, 120),
    git,
    ripgrep_status: { available: Boolean(RG_BIN), bin: RG_BIN || null },
    symbols,
    symbols_meta: includeSymbols ? { max_files: symbolMaxFiles, max_matches: symbolMaxMatches } : undefined
  };
  await writeRepoIndex(next);
  return { ...next, cached: false };
}

async function detectProjectProfile(rootDir) {
  const profile = { languages: [], frameworks: [], packageManagers: [], scripts: {}, manifests: [] };

  async function tryRead(rel) {
    try {
      return await readFile(path.join(rootDir, rel), "utf8");
    } catch {
      return null;
    }
  }

  // Node / JavaScript / TypeScript
  const pkgJson = await tryRead("package.json");
  if (pkgJson) {
    profile.manifests.push("package.json");
    try {
      const pkg = JSON.parse(pkgJson);
      profile.languages.push("javascript");
      profile.packageManagers.push("npm");
      if (existsSync(path.join(rootDir, "yarn.lock"))) profile.packageManagers.push("yarn");
      if (existsSync(path.join(rootDir, "pnpm-lock.yaml"))) profile.packageManagers.push("pnpm");
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps["typescript"] || existsSync(path.join(rootDir, "tsconfig.json"))) profile.languages.push("typescript");
      if (deps["react"] || deps["react-dom"]) profile.frameworks.push("react");
      if (deps["next"]) profile.frameworks.push("next.js");
      if (deps["express"]) profile.frameworks.push("express");
      if (deps["@nestjs/core"]) profile.frameworks.push("nestjs");
      if (deps["vite"]) profile.frameworks.push("vite");
      if (deps["vue"]) profile.frameworks.push("vue");
      if (deps["svelte"]) profile.frameworks.push("svelte");
      if (pkg.scripts) profile.scripts = pkg.scripts;
    } catch {
      // invalid json
    }
  }

  // Flutter / Dart
  const pubspec = await tryRead("pubspec.yaml");
  if (pubspec) {
    profile.manifests.push("pubspec.yaml");
    profile.languages.push("dart");
    profile.frameworks.push("flutter");
    profile.packageManagers.push("pub");
  }

  // Python
  const reqTxt = await tryRead("requirements.txt");
  const pyproject = await tryRead("pyproject.toml");
  if (reqTxt || pyproject) {
    profile.languages.push("python");
    if (pyproject) {
      profile.manifests.push("pyproject.toml");
      profile.packageManagers.push("pip");
      if (pyproject.includes("[tool.poetry]")) profile.packageManagers.push("poetry");
      if (pyproject.includes("[tool.rye]")) profile.packageManagers.push("rye");
    }
    if (reqTxt) {
      profile.manifests.push("requirements.txt");
      if (!profile.packageManagers.includes("pip")) profile.packageManagers.push("pip");
    }
    const hasTests = existsSync(path.join(rootDir, "pytest.ini")) || existsSync(path.join(rootDir, "setup.cfg"));
    if (hasTests) profile.frameworks.push("pytest");
  }

  // Go
  const goMod = await tryRead("go.mod");
  if (goMod) {
    profile.manifests.push("go.mod");
    profile.languages.push("go");
    profile.packageManagers.push("go modules");
  }

  // Rust
  const cargoToml = await tryRead("Cargo.toml");
  if (cargoToml) {
    profile.manifests.push("Cargo.toml");
    profile.languages.push("rust");
    profile.packageManagers.push("cargo");
  }

  // .NET
  let items;
  try {
    items = await readdir(rootDir);
  } catch {
    items = [];
  }
  const csproj = items.find((f) => f.endsWith(".csproj"));
  const sln = items.find((f) => f.endsWith(".sln"));
  if (csproj || sln) {
    if (csproj) profile.manifests.push(csproj);
    if (sln) profile.manifests.push(sln);
    profile.languages.push("csharp");
    profile.packageManagers.push("dotnet");
    profile.frameworks.push(".NET");
  }

  // Java / Gradle / Maven
  const pomXml = await tryRead("pom.xml");
  const buildGradle = await tryRead("build.gradle");
  if (pomXml) {
    profile.manifests.push("pom.xml");
    profile.languages.push("java");
    profile.packageManagers.push("maven");
  }
  if (buildGradle) {
    profile.manifests.push("build.gradle");
    if (!profile.languages.includes("java")) profile.languages.push("java");
    profile.packageManagers.push("gradle");
  }

  // Deduplicate
  profile.languages = [...new Set(profile.languages)];
  profile.frameworks = [...new Set(profile.frameworks)];
  profile.packageManagers = [...new Set(profile.packageManagers)];

  return profile;
}

// Scan source files for symbol definitions
async function scanSymbols(rootDir, { maxFiles = 500, maxMatches = 2000, files: seededFiles = null } = {}) {
  const symbols = [];
  const files = [];
  const exts = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".cs"]);
  const preferredDirs = new Map([
    ["src", 0],
    ["app", 1],
    ["lib", 2],
    ["server", 3],
    ["scripts", 4],
    ["test", 5],
    ["tests", 5],
    ["evals", 6],
    ["skills", 7],
    ["experiments", 50]
  ]);

  const jsPatterns = [
    { re: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/, kind: "function" },
    { re: /^(?:export\s+)?class\s+(\w+)(?:\s|{)/, kind: "class" },
    { re: /^(?:export\s+)?const\s+(\w+)\s*=/, kind: "const" },
    { re: /^\s{0,4}(\w+)\s*\([^)]*\)\s*\{/, kind: "method" },
    { re: /router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)/, kind: "route" }
  ];
  const pyPatterns = [
    { re: /^def\s+(\w+)\s*\(/, kind: "function" },
    { re: /^class\s+(\w+)(?:\s|:)/, kind: "class" },
    { re: /^\s{4}def\s+(\w+)\s*\(/, kind: "method" }
  ];
  const csPatterns = [
    { re: /^\s*(?:public|private|protected|internal)?\s*(?:sealed\s+|partial\s+|static\s+)?(?:class|record|struct|interface)\s+(\w+)/, kind: "class" },
    { re: /^\s*(?:public|private|protected|internal)\s+(?:static\s+|async\s+)?[\w<>\[\],?\s]+\s+(\w+)\s*\(/, kind: "method" }
  ];

  function entryRank(entry) {
    if (!entry.isDirectory()) return 100;
    return preferredDirs.get(entry.name) ?? 20;
  }

  function symbolRank(symbol) {
    const rel = symbol.path.split(path.sep).join("/");
    const first = rel.split("/")[0] || "";
    const firstRank = preferredDirs.get(first) ?? 20;
    const depth = rel.split("/").length;
    const kindRank = { route: 0, function: 1, class: 2, const: 3, method: 4 }[symbol.kind] ?? 5;
    return firstRank * 1000 + depth * 20 + kindRank;
  }

  async function collectFiles(dir, depth) {
    if (depth > 6 || files.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => entryRank(a) - entryRank(b) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await collectFiles(abs, depth + 1);
      } else if (exts.has(path.extname(entry.name).toLowerCase())) {
        files.push(abs);
      }
    }
  }

  if (Array.isArray(seededFiles) && seededFiles.length) {
    files.push(...seededFiles.map((f) => path.isAbsolute(f) ? f : path.resolve(rootDir, f)).filter((f) => exts.has(path.extname(f).toLowerCase())).slice(0, maxFiles));
  } else {
    await collectFiles(rootDir, 1);
  }

  for (const abs of files) {
    if (symbols.length >= maxMatches) break;
    let content;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    const ext = path.extname(abs).toLowerCase();
    const patterns = ext === ".py" ? pyPatterns : ext === ".cs" ? csPatterns : jsPatterns;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length && symbols.length < maxMatches; i++) {
      for (const pattern of patterns) {
        const match = lines[i].match(pattern.re);
        if (!match) continue;
        let name = match[1];
        if (pattern.kind === "route") name = `${match[1].toUpperCase()} ${match[2]}`;
        if (name && name.length < 60) {
          symbols.push({ path: toRel(abs), line: i + 1, kind: pattern.kind, name });
          break;
        }
      }
    }
  }

  return symbols.sort((a, b) => symbolRank(a) - symbolRank(b) || a.path.localeCompare(b.path) || a.line - b.line);
}

async function collectImportantFiles(rootDir) {
  const IMPORTANT_GLOBS = [
    /^readme(\.\w+)?$/i,
    /^agents\.md$/i,
    /^package\.json$/i,
    /^package-lock\.json$/i,
    /^tsconfig.*\.json$/i,
    /^\.env\.example$/i,
    /^dockerfile$/i,
    /^docker-compose.*\.(yml|yaml)$/i,
    /^pubspec\.yaml$/i,
    /^makefile$/i,
    /^cargo\.toml$/i,
    /^go\.mod$/i,
    /^pyproject\.toml$/i,
    /^requirements.*\.txt$/i,
    /^\.eslintrc.*$/i,
    /^\.prettierrc.*$/i,
    /^\.gitignore$/i,
    /^changelog\.md$/i,
    /^security\.md$/i,
    /^license$/i,
    /^license\..*$/i
  ];
  const result = [];

  let rootItems;
  try {
    rootItems = await readdir(rootDir, { withFileTypes: true });
  } catch {
    rootItems = [];
  }
  for (const e of rootItems) {
    if (!e.isFile()) continue;
    if (IMPORTANT_GLOBS.some((re) => re.test(e.name))) {
      const abs = path.join(rootDir, e.name);
      try {
        const info = await stat(abs);
        result.push({ path: toRel(abs), size: info.size });
      } catch { /* skip */ }
    }
  }

  const ghDir = path.join(rootDir, ".github", "workflows");
  try {
    const wfItems = await readdir(ghDir, { withFileTypes: true });
    for (const e of wfItems) {
      if (e.isFile() && /\.(yml|yaml)$/i.test(e.name)) {
        const abs = path.join(ghDir, e.name);
        try {
          const info = await stat(abs);
          result.push({ path: toRel(abs), size: info.size });
        } catch { /* skip */ }
      }
    }
  } catch { /* no .github/workflows */ }

  return result.sort((a, b) => a.path.localeCompare(b.path));
}

async function compactGitStatus(rootDir) {
  const status = await spawnCapture("git", ["status", "--porcelain"], rootDir, DEFAULT_CMD_TIMEOUT);
  if (status.exit_code !== 0) {
    return {
      is_git_repo: false,
      clean: null,
      error: (status.stderr || "not a git repository").split(/\r?\n/)[0]
    };
  }
  const branchRes = await spawnCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"], rootDir, DEFAULT_CMD_TIMEOUT);
  const files = parsePorcelain(status.stdout || "");
  const counts = {};
  for (const f of files) {
    const key = `${f.index || " "}${f.worktree || " "}`.trim() || "changed";
    counts[key] = (counts[key] || 0) + 1;
  }
  return {
    is_git_repo: true,
    branch: (branchRes.stdout || "").trim() || null,
    clean: files.length === 0,
    count: files.length,
    counts,
    files: files.slice(0, 60)
  };
}

function recommendNextActions({ profile, git, truncated }) {
  const actions = [];
  if (git?.is_git_repo && git.count > 0) {
    actions.push("Review current changes with review_diff or git_diff before large edits.");
  }
  if (truncated) {
    actions.push("Call repo_map with a narrower path/depth if you need more tree detail.");
  }
  if ((profile?.languages || []).length) {
    actions.push(`Detected stack: ${(profile.languages || []).join(", ")}${profile.frameworks?.length ? ` / ${(profile.frameworks || []).join(", ")}` : ""}.`);
  }
  actions.push("Use recommended_reads with read_many to gather context in one call.");
  actions.push("Use search_text and repo_symbols before opening many files.");
  actions.push("Prefer apply_patch batches to keep MCP tunnel round-trips low.");
  return actions.slice(0, 6);
}

function profileFromProjectGraph(graph, fallback = {}) {
  const projects = Array.isArray(graph?.projects) ? graph.projects : [];
  const commands = Array.isArray(graph?.commands) ? graph.commands : [];
  return {
    languages: [...new Set([...(fallback.languages || []), ...projects.map((project) => project.language).filter((value) => value && value !== "unknown")])],
    frameworks: [...new Set([...(fallback.frameworks || []), ...projects.map((project) => project.framework).filter(Boolean)])],
    packageManagers: [...new Set([...(fallback.packageManagers || []), ...projects.map((project) => project.packageManager).filter(Boolean)])],
    manifests: [...new Set([...(fallback.manifests || []), ...(graph?.manifests || [])])],
    scripts: Object.fromEntries(commands.map((command) => [`${command.project || command.cwd || "."}:${command.id}`, command.shell_command || [command.file, ...(command.args || [])].join(" ")])),
    projects,
    commands
  };
}

async function collectWorkspaceDoctor(rootDir) {
  const [legacyProfile, graph, git, importantFiles] = await Promise.all([
    detectProjectProfile(rootDir).catch(() => ({ languages: [], frameworks: [], packageManagers: [], manifests: [], scripts: {} })),
    buildProjectGraph(rootDir, { maxDepth: 7, maxFiles: 20000 }).catch(() => ({ projects: [], commands: [], manifests: [] })),
    compactGitStatus(rootDir),
    collectImportantFiles(rootDir).catch(() => [])
  ]);
  const profile = profileFromProjectGraph(graph, legacyProfile);
  const checks = [];
  const add = (id, status, title, detail, recommendation) => checks.push({ id, status, title, detail, recommendation });

  add("version", "pass", "Version", `Local Coding Agent ${VERSION} (${PRODUCT_TIER})`, null);
  add("roots", ROOTS.length ? "pass" : "fail", "Workspace roots", `${ROOTS.length} root(s) configured`, ROOTS.length ? null : "Set AGENT_WORKSPACE to the repository you want to work on.");
  add("policy", "pass", "Policy", `AGENT_POLICY=${AGENT_POLICY}`, AGENT_POLICY === "strict" ? "Strict intentionally blocks write flows." : null);
  add("mode", "pass", "Access mode", `AGENT_ACCESS_MODE=${ACCESS_MODE}`, ACCESS_MODE === "full" ? "Full is the configured default for trusted local automation; balanced and safe remain available." : null);
  add("workflow", "pass", "Workflow mode", `AGENT_WORKFLOW_MODE=${WORKFLOW_MODE}`, null);
  add("verification", "pass", "Verification policy", EXPLICIT_VERIFICATION_INSTRUCTION, null);
  add("dashboard", "pass", "Code-change dashboard", "Enabled for every code mutation in every access/workflow mode", null);
  add("auth", AUTH_TOKEN ? "pass" : "warn", "MCP auth", AUTH_TOKEN ? "Bearer auth enabled" : "MCP_AUTH_TOKEN is not set", AUTH_TOKEN ? null : "Set MCP_AUTH_TOKEN if exposing beyond the private OpenAI tunnel/local loopback.");
  add("origin", ALLOWED_ORIGINS.size ? "warn" : "pass", "Browser Origin policy", ALLOWED_ORIGINS.size ? `${ALLOWED_ORIGINS.size} browser origin(s) allowed` : "Browser-origin MCP calls blocked by default", ALLOWED_ORIGINS.size ? "Keep MCP_ALLOWED_ORIGINS as narrow as possible." : null);
  add("rg", RG_BIN ? "pass" : "warn", "ripgrep", RG_BIN ? `Found: ${RG_BIN}` : "ripgrep not found; search_text falls back to slower scanning", RG_BIN ? null : "Install ripgrep for faster searches on large repos.");
  add("git", git.is_git_repo ? "pass" : "warn", "Git repository", git.is_git_repo ? `${git.clean ? "clean" : `${git.count} changed file(s)`} on ${git.branch || "unknown branch"}` : "Not a git repo or git unavailable", git.is_git_repo ? (git.count > 0 ? "Review current changes before large edits." : null) : "Initialize git or run from the repository root for better change tracking.");
  add("profile", (profile.languages || []).length ? "pass" : "warn", "Project profile", (profile.languages || []).length ? `Detected ${(profile.languages || []).join(", ")}` : "No language/framework detected", (profile.languages || []).length ? null : "Add standard manifests or verify AGENT_WORKSPACE points at the repo root.");
  const hasReadme = importantFiles.some((f) => /^README/i.test(path.basename(f.path)));
  const hasSecurityDoc = importantFiles.some((f) => /^security\.md$/i.test(path.basename(f.path)));
  add("docs", hasReadme ? "pass" : "warn", "README", "README presence checked", hasReadme ? null : "Add a README so agents and contributors understand the repo quickly.");
  add("security_doc", hasSecurityDoc ? "pass" : "warn", "Security docs", "SECURITY.md presence checked", hasSecurityDoc ? null : "Add SECURITY.md for MCP/local-command safety expectations.");

  const fail = checks.filter((c) => c.status === "fail").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  const score = Math.max(0, Math.min(100, 100 - fail * 25 - warn * 6));
  const status = fail ? "fail" : warn ? "warn" : "pass";
  return {
    status,
    score,
    root: toRel(rootDir),
    version: VERSION,
    tier: PRODUCT_TIER,
    mode: MODE,
    access_mode: ACCESS_MODE,
    workflow_mode: WORKFLOW_MODE,
    policy: AGENT_POLICY,
    execution_boundary: boundaryStatus(ACCESS_MODE, rootDir),
    checks,
    summary: { pass: checks.filter((c) => c.status === "pass").length, warn, fail },
    profile,
    git,
    important_files: importantFiles.slice(0, 80),
    recommendations: checks.filter((c) => c.recommendation).map((c) => ({ id: c.id, recommendation: c.recommendation })).slice(0, 10)
  };
}

function normalizeGatePlan(include, commands) {
  const wanted = include?.length ? include : ["lint", "typecheck", "test", "build"];
  const allowed = new Set(["lint", "typecheck", "test", "build"]);
  return wanted
    .filter((name) => allowed.has(name))
    .map((name) => ({ name, command: commands?.[name] || null }));
}

async function runQualityGate({ cwd = ".", include, timeout_ms = 120_000, stop_on_failure = true, dry_run = false }) {
  const rootDir = resolvePath(cwd);
  const commands = await getTestCommandsMerged(rootDir);
  const plan = normalizeGatePlan(include, commands);
  const started = Date.now();
  const gates = [];
  if (dry_run) {
    return { ok: true, dry_run: true, root: toRel(rootDir), plan, commands, duration_ms: 0 };
  }
  for (const gate of plan) {
    if (!gate.command) {
      gates.push({ name: gate.name, status: "skipped", ok: true, reason: "command not detected" });
      continue;
    }
    assertCommandAllowed(gate.command);
    const result = await runGatedCommand(gate.command, rootDir, timeout_ms);
    const entry = { name: gate.name, status: result.ok ? "pass" : "fail", ...result };
    gates.push(entry);
    if (!result.ok && stop_on_failure) break;
  }
  const failed = gates.filter((g) => g.status === "fail");
  const ran = gates.filter((g) => g.status === "pass" || g.status === "fail");
  return {
    ok: failed.length === 0,
    root: toRel(rootDir),
    commands,
    gates,
    ran: ran.length,
    skipped: gates.filter((g) => g.status === "skipped").length,
    failed: failed.length,
    duration_ms: Date.now() - started
  };
}

async function buildSessionReport(rootDir) {
  const [doctor, git] = await Promise.all([
    collectWorkspaceDoctor(rootDir),
    compactGitStatus(rootDir)
  ]);
  return {
    kind: "session_report",
    version: VERSION,
    tier: PRODUCT_TIER,
    ts: isoNow(),
    root: toRel(rootDir),
    mode: MODE,
    access_mode: ACCESS_MODE,
    workflow_mode: WORKFLOW_MODE,
    policy: AGENT_POLICY,
    verification: { tests: "explicit", lint: "explicit", build: "explicit" },
    dashboard: await TASK_RUNTIME.getDashboard(),
    git,
    doctor: {
      status: doctor.status,
      score: doctor.score,
      summary: doctor.summary,
      recommendations: doctor.recommendations
    }
  };
}

function recommendedReads({ importantFiles = [], treeEntries = [] }) {
  const picked = [];
  const add = (file, reason) => {
    if (!file || picked.some((item) => item.path === file)) return;
    picked.push({ path: file, reason });
  };
  for (const item of importantFiles) {
    const base = path.basename(item.path).toLowerCase();
    if (base.startsWith("readme")) add(item.path, "project overview");
    else if (base === "agents.md") add(item.path, "agent/project conventions");
    else if (base === "package.json") add(item.path, "scripts and dependencies");
    else if (base === "pyproject.toml" || base === "go.mod" || base === "cargo.toml" || base.endsWith(".csproj") || base.endsWith(".sln")) add(item.path, "main project manifest");
  }
  for (const entry of treeEntries) {
    if (picked.length >= 8) break;
    const normalized = entry.split(path.sep).join("/");
    if (/^(src|app|lib|server)\/(index|main|app|server)\.(js|ts|tsx|jsx|mjs|py|cs)$/.test(normalized)) {
      add(entry, "likely entrypoint");
    }
  }
  return picked.slice(0, 8);
}

function isSourceFile(file) {
  return /\.(js|ts|mjs|cjs|jsx|tsx|py|cs|go|rs|java)$/i.test(file) && !isTestFile(file);
}

function isTestFile(file) {
  return /(^|\/)(__tests__|tests?|spec)\//i.test(file) || /\.(test|spec)\.(js|ts|mjs|cjs|jsx|tsx)$/i.test(file) || /(^|\/)test_.*\.py$/i.test(file) || /_test\.(py|go|rs)$/i.test(file);
}

function isConfigFile(file) {
  return /(^|\/)(package\.json|tsconfig.*\.json|pyproject\.toml|go\.mod|cargo\.toml|.*\.csproj|.*\.sln|dockerfile|docker-compose.*\.ya?ml|\.github\/workflows\/.*\.ya?ml)$/i.test(file);
}

function parseDiffSummary(diff) {
  const files = new Map();
  let current = null;
  let newLine = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const file = line.slice(4).replace(/^b\//, "").trim();
      if (file === "/dev/null") {
        current = null;
      } else {
        current = files.get(file) || { path: file, added: 0, deleted: 0 };
        files.set(file, current);
      }
      continue;
    }
    if (line.startsWith("@@ ")) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
      newLine = match ? Number(match[1]) - 1 : 0;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      newLine++;
      current.added++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.deleted++;
    } else if (!line.startsWith("\\")) {
      newLine++;
    }
  }
  const changed = [...files.values()];
  return {
    changed_files: changed.length,
    source_files: changed.filter((f) => isSourceFile(f.path)).length,
    test_files: changed.filter((f) => isTestFile(f.path)).length,
    config_files: changed.filter((f) => isConfigFile(f.path)).length,
    added_lines: changed.reduce((sum, f) => sum + f.added, 0),
    deleted_lines: changed.reduce((sum, f) => sum + f.deleted, 0),
    files: changed.slice(0, 80)
  };
}

function analyzeDiff(diff) {
  const findings = [];
  const summary = parseDiffSummary(diff);
  let currentFile = null;
  let lineNum = 0;
  let addedStreak = 0;
  let streakStart = 0;
  const secretPatterns = [
    { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: "github token", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
    { name: "slack token", re: /xox[baprs]-[0-9A-Za-z-]{20,}/ },
    { name: "api key assignment", re: /\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*['"][^'"]{10,}['"]/i }
  ];
  const addFinding = (priority, loc, issue) => {
    if (findings.length < 150) findings.push({ priority, loc, issue });
  };

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      currentFile = line.slice(4).replace(/^b\//, "").trim();
      addedStreak = 0;
      streakStart = 0;
      continue;
    }
    if (line.startsWith("@@ ")) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
      lineNum = match ? Number(match[1]) - 1 : 0;
      addedStreak = 0;
      streakStart = 0;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      lineNum++;
      addedStreak++;
      if (addedStreak === 1) streakStart = lineNum;
      const added = line.slice(1);
      const loc = `${currentFile}:${lineNum}`;
      for (const pattern of secretPatterns) {
        if (pattern.re.test(added)) addFinding("P1", loc, `Secret-like ${pattern.name} added`);
      }
      if (/\beval\s*\(/.test(added)) addFinding("P1", loc, "eval() usage; potential code injection");
      if (/\binnerHTML\s*=/.test(added)) addFinding("P1", loc, "innerHTML assignment; potential XSS");
      if (/dangerouslySetInnerHTML/.test(added)) addFinding("P1", loc, "dangerouslySetInnerHTML; XSS risk");
      if (/\bchild_process\.exec\s*\(/.test(added) || /\brequire\(['"]child_process['"]\)/.test(added)) addFinding("P1", loc, "child_process exec; command injection risk");
      if (/\b(subprocess\.(Popen|run|call)|os\.system)\s*\(/.test(added)) addFinding("P2", loc, "Process execution added; verify arguments are trusted");
      if (/\bconsole\.(log|debug|info)\s*\(/.test(added)) addFinding("P2", loc, "console.log/debug left in code");
      if (/\bdebugger\b/.test(added)) addFinding("P2", loc, "debugger statement");
      const todo = added.match(/\b(TODO|FIXME|HACK)\b/);
      if (todo) addFinding(todo[1].toUpperCase() === "HACK" ? "P3" : "P2", loc, `${todo[1]} comment added`);
      if (addedStreak === 101) addFinding("P3", `${currentFile}:~${streakStart}`, "Very large added block (>100 lines); consider splitting");
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // Deleted lines do not advance the new-file line counter.
    } else if (!line.startsWith("\\")) {
      lineNum++;
      addedStreak = 0;
    }
  }

  if (summary.source_files > 0 && summary.test_files === 0) {
    const firstSource = summary.files.find((file) => isSourceFile(file.path));
    if (firstSource) addFinding("P3", firstSource.path, "Source file changed without a corresponding test file change");
  }
  return { summary, findings };
}

function registerRepoIntelTools(mcp) {
  reg(
    mcp,
    "workspace_doctor",
    {
      title: "Workspace doctor Pro",
      description: "PRO readiness check for the active workspace: roots, safety settings, auth/origin posture, git state, ripgrep, project profile, docs, score, and recommendations.",
      inputSchema: {
        path: z.string().optional().describe("Root dir to inspect (default: primary root).")
      }
    },
    async ({ path: rel = "." }) => {
      const rootDir = resolvePath(rel);
      return jsonResult(await collectWorkspaceDoctor(rootDir));
    }
  );

  reg(
    mcp,
    "workspace_snapshot",
    {
      title: "Workspace snapshot Pro",
      description: "PRO one-call briefing: roots, mode/policy, project profile, important files, compact tree, git status, ripgrep/cache status, recommended reads, and next actions. Use this FIRST to reduce MCP round-trips.",
      inputSchema: {
        path: z.string().optional().describe("Root dir to inspect (default: primary root)."),
        depth: z.number().int().min(1).max(5).optional().describe("Tree depth (default 3)."),
        max_entries: z.number().int().min(20).max(1200).optional().describe("Max tree entries (default 350)."),
        include_symbols: z.boolean().optional().describe("Include compact symbol sample (default false)."),
        refresh: z.boolean().optional().describe("Refresh cached profile/index.")
      }
    },
    async ({ path: rel = ".", depth = 3, max_entries = 350, include_symbols = false, refresh = false }) => {
      const rootDir = resolvePath(rel);
      const [idx, graph] = await Promise.all([
        buildRepoIndex(rootDir, { depth, maxEntries: max_entries, includeSymbols: include_symbols, refresh }),
        buildProjectGraph(rootDir, { maxDepth: Math.max(7, depth + 2), maxFiles: 20000, refresh })
      ]);
      const profile = profileFromProjectGraph(graph, idx.profile || {});
      const tree = idx.tree || { depth, dirs: 0, files: 0, truncated: false, entries: [] };
      const importantFiles = idx.important_files || [];
      const git = idx.git || {};
      const next = recommendNextActions({ profile, git, truncated: tree.truncated });

      return jsonResult({
        kind: "workspace_snapshot",
        pro: true,
        version: VERSION,
        tier: PRODUCT_TIER,
        ts: isoNow(),
        root: toRel(rootDir),
        roots: ROOTS,
        mode: MODE,
        access_mode: ACCESS_MODE,
        workflow_mode: WORKFLOW_MODE,
        policy: AGENT_POLICY,
        verification: { tests: "explicit", lint: "explicit", build: "explicit" },
        dashboard: { show_on_code_change: true, all_modes: true },
        auth: AUTH_TOKEN ? "bearer" : "none",
        safety: {
          file_tools_root_confined: true,
          command_cwd_root_confined: true,
          command_os_sandbox: boundaryStatus(ACCESS_MODE, rootDir).active,
          execution_boundary: boundaryStatus(ACCESS_MODE, rootDir),
          browser_origin_mcp_default: ALLOWED_ORIGINS.size ? "allowlist" : "blocked"
        },
        profile: {
          languages: profile.languages || [],
          frameworks: profile.frameworks || [],
          packageManagers: profile.packageManagers || [],
          manifests: profile.manifests || [],
          scripts: profile.scripts || {},
          projects: (profile.projects || []).map((project) => ({
            id: project.id,
            path: project.path,
            language: project.language,
            framework: project.framework,
            packageManager: project.packageManager,
            command_count: project.commands?.length || 0
          }))
        },
        git,
        tree: {
          depth: tree.depth || depth,
          engine: tree.engine || "scan",
          dirs: tree.dirs || 0,
          files: tree.files || 0,
          truncated: Boolean(tree.truncated),
          entries: (tree.entries || []).slice(0, max_entries)
        },
        important_files: importantFiles.slice(0, 80),
        symbols: include_symbols ? (idx.symbols || []).slice(0, 80) : undefined,
        ripgrep: idx.ripgrep_status || { available: Boolean(RG_BIN), bin: RG_BIN || null },
        cache: { hit: Boolean(idx.cached), generated_at: idx.generated_at || idx.ts, ttl_seconds: Math.floor(REPO_INDEX_TTL_MS / 1000) },
        recommended_reads: recommendedReads({ importantFiles, treeEntries: tree.entries || [] }),
        workflow_hints: [
          "Use read_many for recommended_reads or multiple targeted files.",
          "Use search_text with context before reading many files.",
          "Use repo_symbols for navigation.",
          "Use review_diff for a fast local heuristic review.",
          "Run tests/build/lint only when explicitly requested."
        ],
        next_best_actions: next
      });
    }
  );

  reg(
    mcp,
    "project_profile",
    {
      title: "Project profile",
      description: "Detect languages, frameworks, package managers, and scripts in the workspace. Reads root manifests (package.json, pubspec.yaml, go.mod, Cargo.toml, etc.). Results are cached for 5 min.",
      inputSchema: {
        path: z.string().optional().describe("Root dir to inspect (default: primary root)."),
        refresh: z.boolean().optional().describe("Force re-scan even if cache is fresh.")
      }
    },
    async ({ path: rel = ".", refresh = false }) => {
      const rootDir = resolvePath(rel);
      const [legacyProfile, graph] = await Promise.all([
        detectProjectProfile(rootDir),
        buildProjectGraph(rootDir, { maxDepth: 7, maxFiles: 20000, refresh })
      ]);
      return jsonResult({
        rootDir,
        ...profileFromProjectGraph(graph, legacyProfile),
        cached: Boolean(graph.cached),
        ts: graph.generatedAt
      });
    }
  );

  reg(
    mcp,
    "important_files",
    {
      title: "Important files",
      description: "List key project files (README, config, CI, Docker, etc.) with their sizes.",
      inputSchema: {
        path: z.string().optional().describe("Root dir (default: primary root).")
      }
    },
    async ({ path: rel = "." }) => {
      const rootDir = resolvePath(rel);
      const result = await collectImportantFiles(rootDir);
      return jsonResult({ count: result.length, files: result });
    }
  );

  reg(
    mcp,
    "repo_map",
    {
      title: "Repo map",
      description: "One call: fast directory tree + detected manifests + project profile summary. Uses ripgrep file listing when available. Results cached 5 min.",
      inputSchema: {
        path: z.string().optional(),
        depth: z.number().int().min(1).max(6).optional(),
        max_entries: z.number().int().min(10).max(4000).optional(),
        refresh: z.boolean().optional()
      }
    },
    async ({ path: rel = ".", depth = 3, max_entries = 800, refresh = false }) => {
      const rootDir = resolvePath(rel);
      const [idx, graph] = await Promise.all([
        buildRepoIndex(rootDir, { depth, maxEntries: max_entries, includeSymbols: false, refresh }),
        buildProjectGraph(rootDir, { maxDepth: Math.max(7, depth + 2), maxFiles: 20000, refresh })
      ]);
      const tree = idx.tree || { depth, dirs: 0, files: 0, truncated: false, entries: [] };
      const manifests = [...new Set([
        ...(tree.entries || []).filter((f) => MANIFEST_NAMES.has(path.basename(f).toLowerCase())),
        ...(graph.manifests || [])
      ])];
      const profile = profileFromProjectGraph(graph, idx.profile || {});

      return jsonResult({
        root: toRel(rootDir),
        depth: tree.depth || depth,
        engine: tree.engine || "scan",
        dirs: tree.dirs || 0,
        files: tree.files || 0,
        truncated: Boolean(tree.truncated),
        manifests: manifests.slice(0, 100),
        tree: (tree.entries || []).slice(0, max_entries),
        profile: {
          languages: profile.languages || [],
          frameworks: profile.frameworks || [],
          packageManagers: profile.packageManagers || [],
          scripts: profile.scripts || {},
          projects: (profile.projects || []).map((project) => ({
            id: project.id,
            path: project.path,
            language: project.language,
            packageManager: project.packageManager
          }))
        },
        cached: Boolean(idx.cached && graph.cached),
        ripgrep: idx.ripgrep_status || { available: Boolean(RG_BIN), bin: RG_BIN || null }
      });
    }
  );

  reg(
    mcp,
    "repo_symbols",
    {
      title: "Repo symbols",
      description: "Scan source files for function/class/route definitions. Returns [{path, line, kind, name}]. Useful for navigation without reading entire files.",
      inputSchema: {
        path: z.string().optional().describe("Root dir to scan."),
        max_files: z.number().int().min(1).max(2000).optional(),
        max_matches: z.number().int().min(1).max(5000).optional(),
        kind: z.enum(["function", "class", "const", "method", "route"]).optional().describe("Filter by symbol kind.")
      }
    },
    async ({ path: rel = ".", max_files = 500, max_matches = 2000, kind }) => {
      const rootDir = resolvePath(rel);
      const idx = await buildRepoIndex(rootDir, {
        depth: 6,
        maxEntries: Math.max(max_files * 2, 800),
        includeSymbols: true,
        symbolMaxFiles: max_files,
        symbolMaxMatches: max_matches,
        refresh: false
      });
      let symbols = Array.isArray(idx.symbols) ? idx.symbols : [];
      if (symbols.length > max_matches || max_files < 500) {
        const seeded = relEntriesToAbs(rootDir, idx.tree?.entries || []).slice(0, max_files);
        symbols = await scanSymbols(rootDir, { files: seeded, maxFiles: max_files, maxMatches: max_matches });
      }
      const filtered = kind ? symbols.filter((s) => s.kind === kind) : symbols;
      return jsonResult({ count: filtered.length, cached: Boolean(idx.cached), symbols: filtered.slice(0, max_matches) });
    }
  );

  reg(
    mcp,
    "instruction_chain",
    {
      title: "Instruction hierarchy",
      description: "Load global, repository, and nested AGENTS.md / AGENTS.override.md instructions for a target path, ordered by scope and priority.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        path: z.string().optional().describe("Target file or directory whose nested instruction chain should apply."),
        max_chars: z.number().int().min(1000).max(100000).optional()
      }
    },
    async ({ path: target = ".", max_chars = 32000 }) => jsonResult(await discoverInstructionChain(PRIMARY_ROOT, target, { maxChars: max_chars }))
  );

  reg(
    mcp,
    "project_graph",
    {
      title: "Monorepo project graph",
      description: "Scan nested manifests and return projects, package managers, frameworks, dependencies, and every detected script/verification command without running them.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        path: z.string().optional(),
        max_depth: z.number().int().min(1).max(12).optional(),
        max_files: z.number().int().min(100).max(50000).optional(),
        refresh: z.boolean().optional()
      }
    },
    async ({ path: rel = ".", max_depth = 7, max_files = 20000, refresh = false }) => {
      const rootDir = resolvePath(rel);
      return jsonResult(await buildProjectGraph(rootDir, { maxDepth: max_depth, maxFiles: max_files, refresh }));
    }
  );

  reg(
    mcp,
    "symbol_search",
    {
      title: "Search repository symbols",
      description: "Search the incremental symbol index by name/kind. Uses the built-in parser fallback and reports optional Tree-sitter availability.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        query: z.string().min(1),
        path: z.string().optional(),
        kind: z.enum(["function", "class", "const", "method", "route"]).optional(),
        limit: z.number().int().min(1).max(500).optional()
      }
    },
    async ({ query, path: rel = ".", kind, limit = 100 }) => {
      const rootDir = resolvePath(rel);
      const idx = await buildRepoIndex(rootDir, { depth: 8, maxEntries: 4000, includeSymbols: true, symbolMaxFiles: 2000, symbolMaxMatches: 10000, refresh: false });
      const needle = query.toLowerCase();
      const matches = (idx.symbols || [])
        .filter((symbol) => (!kind || symbol.kind === kind) && String(symbol.name || "").toLowerCase().includes(needle))
        .slice(0, limit);
      return jsonResult({ count: matches.length, engine: hasCommand("tree-sitter") ? "tree-sitter-cli-available+fallback-index" : "builtin-symbol-index", matches });
    }
  );

  reg(
    mcp,
    "find_references",
    {
      title: "Find symbol references",
      description: "Find textual references to a symbol across repository source files using ripgrep when available.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        symbol: z.string().min(1),
        path: z.string().optional(),
        limit: z.number().int().min(1).max(2000).optional()
      }
    },
    async ({ symbol, path: rel = ".", limit = 500 }) => {
      const rootDir = resolvePath(rel);
      let matches = RG_BIN ? await ripgrepGrep(rootDir, `\\b${escapeRegex(symbol)}\\b`, { regex: true, limit, glob: null }) : null;
      if (!matches) matches = await searchTree(rootDir, `\\b${escapeRegex(symbol)}\\b`, { regex: true, limit, glob: null });
      return jsonResult({ symbol, count: matches.length, engine: RG_BIN ? "ripgrep" : "scan", references: matches });
    }
  );

  reg(
    mcp,
    "dependency_impact",
    {
      title: "Dependency impact",
      description: "Estimate direct import/reference impact for a changed file or exported symbol without running builds/tests.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        path: z.string().min(1),
        symbol: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional()
      }
    },
    async ({ path: rel, symbol, limit = 300 }) => {
      const target = resolvePath(rel);
      const rootDir = PRIMARY_ROOT;
      const relative = toRel(target).replace(/\\/g, "/");
      const basename = path.basename(relative, path.extname(relative));
      const needles = [...new Set([symbol, relative, `./${basename}`, `../${basename}`, basename].filter(Boolean))];
      const references = [];
      for (const needle of needles) {
        let hits = RG_BIN ? await ripgrepGrep(rootDir, escapeRegex(needle), { regex: true, limit, glob: null }) : null;
        if (!hits) hits = await searchTree(rootDir, escapeRegex(needle), { regex: true, limit, glob: null });
        for (const hit of hits) if (hit.path !== relative && !references.some((item) => item.path === hit.path && item.line === hit.line)) references.push({ ...hit, matched: needle });
        if (references.length >= limit) break;
      }
      return jsonResult({ path: relative, symbol: symbol || null, direct_reference_count: references.length, references: references.slice(0, limit), note: "Static impact estimate only; verification commands remain explicit-only." });
    }
  );

  reg(
    mcp,
    "go_to_definition",
    {
      title: "Go to symbol definition",
      description: "Resolve likely definitions for a symbol using the cached repository symbol index. Returns all plausible matches instead of guessing.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        symbol: z.string().min(1),
        path: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional()
      }
    },
    async ({ symbol, path: rel = ".", limit = 30 }) => {
      const rootDir = resolvePath(rel);
      const idx = await buildRepoIndex(rootDir, { depth: 8, maxEntries: 5000, includeSymbols: true, symbolMaxFiles: 3000, symbolMaxMatches: 20000, refresh: false });
      const exact = (idx.symbols || []).filter((item) => String(item.name || "") === symbol);
      const insensitive = exact.length ? [] : (idx.symbols || []).filter((item) => String(item.name || "").toLowerCase() === symbol.toLowerCase());
      const matches = [...exact, ...insensitive].slice(0, limit);
      return jsonResult({ symbol, count: matches.length, ambiguous: matches.length > 1, engine: "repository-symbol-index", definitions: matches });
    }
  );

  reg(
    mcp,
    "parallel_inspect",
    {
      title: "Parallel repository inspection",
      description: "Run deterministic repository inspectors concurrently: project graph, instruction chain, Git diff/review metadata, symbols, important files, and language service availability.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        path: z.string().optional(),
        target_path: z.string().optional(),
        diff_scope: z.enum(["working-tree", "staged", "uncommitted", "commit", "branch", "task", "last-transaction", "transaction"]).optional(),
        base: z.string().optional(),
        commit: z.string().optional(),
        task_id: z.string().optional(),
        transaction_id: z.string().optional(),
        include_symbols: z.boolean().optional(),
        max_symbols: z.number().int().min(1).max(1000).optional()
      }
    },
    async ({ path: rel = ".", target_path = ".", diff_scope = "uncommitted", base, commit, task_id, transaction_id, include_symbols = true, max_symbols = 300 }) => {
      const rootDir = resolvePath(rel);
      const [graph, instructions, collected, important, index] = await Promise.all([
        buildProjectGraph(rootDir, { maxDepth: 7, maxFiles: 20000 }),
        discoverInstructionChain(PRIMARY_ROOT, target_path, { maxChars: 24000 }),
        collectGitDiff({ rootDir, scope: diff_scope, base, commit, taskId: task_id, transactionId: transaction_id, includeUntracked: true }),
        collectImportantFiles(rootDir),
        include_symbols ? buildRepoIndex(rootDir, { depth: 8, maxEntries: 5000, includeSymbols: true, symbolMaxFiles: 2000, symbolMaxMatches: max_symbols, refresh: false }) : Promise.resolve(null)
      ]);
      const diffAnalysis = analyzeDiff(collected.diff || "");
      return jsonResult({
        root: toRel(rootDir),
        projects: graph.projects,
        commands: graph.commands,
        instruction_chain: instructions.instructions,
        diff: { ...collected, diff: (collected.diff || "").slice(0, 150000), deterministic_findings: diffAnalysis.findings },
        important_files: important.slice(0, 100),
        symbols: include_symbols ? (index?.symbols || []).slice(0, max_symbols) : [],
        language_services: {
          tree_sitter: hasCommand("tree-sitter"),
          typescript: hasCommand("typescript-language-server"),
          python: hasCommand("pyright-langserver") || hasCommand("pylsp"),
          rust: hasCommand("rust-analyzer"),
          go: hasCommand("gopls")
        },
        verification_instruction: EXPLICIT_VERIFICATION_INSTRUCTION
      });
    }
  );

  reg(
    mcp,
    "language_service_status",
    {
      title: "Language service adapters",
      description: "Report optional Tree-sitter and common LSP executables. LSP servers start only when explicitly requested by a future adapter/tool.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {}
    },
    async () => jsonResult({
      tree_sitter: { available: hasCommand("tree-sitter"), mode: hasCommand("tree-sitter") ? "optional" : "builtin-regex-fallback" },
      lsp: {
        typescript: hasCommand("typescript-language-server"),
        python: hasCommand("pyright-langserver") || hasCommand("pylsp"),
        rust: hasCommand("rust-analyzer"),
        go: hasCommand("gopls"),
        dart: hasCommand("dart")
      },
      auto_start: false
    })
  );

  reg(
    mcp,
    "index_status",
    {
      title: "Index status",
      description: "Return the current repo index cache status (age, freshness, profile summary).",
      inputSchema: {}
    },
    async () => {
      const idx = await readRepoIndex();
      if (!idx) return jsonResult({ cached: false, message: "No index cached yet. Call repo_map to build it." });
      const ageMs = Date.now() - new Date(idx.ts).getTime();
      return jsonResult({
        cached: true,
        fresh: indexFresh(idx),
        ts: idx.ts,
        age_seconds: Math.floor(ageMs / 1000),
        ttl_seconds: Math.floor(REPO_INDEX_TTL_MS / 1000),
        profile_languages: idx.profile?.languages || [],
        profile_frameworks: idx.profile?.frameworks || [],
        tree_engine: idx.tree?.engine || null,
        ripgrep: idx.ripgrep_status || { available: Boolean(RG_BIN), bin: RG_BIN || null },
        symbols_cached: Array.isArray(idx.symbols)
      });
    }
  );
}

// ============================================================================
// v2.2 — Patch Engine + Undo
// ============================================================================

async function readPatchHistory() {
  try {
    return JSON.parse(await readFile(PATCH_HISTORY_PATH, "utf8"));
  } catch {
    return [];
  }
}

async function writePatchHistory(history) {
  await mkdir(path.dirname(PATCH_HISTORY_PATH), { recursive: true });
  await writeFile(PATCH_HISTORY_PATH, JSON.stringify(history, null, 2), "utf8");
}

async function createBackupBatch(tool, filePaths) {
  const batchId = randomUUID();
  const batchDir = path.join(BACKUPS_DIR, batchId);
  await mkdir(batchDir, { recursive: true });

  const files = [];
  for (const fp of filePaths) {
    let hadContent = false;
    try {
      const abs = resolvePath(fp);
      if (existsSync(abs)) {
        const info = await stat(abs);
        const backupFile = path.join(batchDir, `${files.length}-${path.basename(abs) || "root"}`);
        if (info.isDirectory()) await cp(abs, backupFile, { recursive: true, force: true });
        else await copyFile(abs, backupFile);
        hadContent = true;
        files.push({ path: abs, backupFile, hadContent, kind: info.isDirectory() ? "directory" : "file" });
      } else {
        files.push({ path: abs, backupFile: null, hadContent: false, kind: "missing" });
      }
    } catch {
      files.push({ path: String(fp), backupFile: null, hadContent, kind: "unknown" });
    }
  }

  const record = { id: batchId, ts: isoNow(), tool, batchDir, files };
  const history = await readPatchHistory();
  history.push(record);
  if (history.length > 50) {
    const expired = history.splice(0, history.length - 50);
    for (const old of expired) rm(old.batchDir, { recursive: true, force: true }).catch(() => {});
  }
  await writePatchHistory(history);
  return record;
}

// Dry-run a unified diff: return per-file before/after + match status
async function dryRunUnifiedDiff(diffText) {
  const results = [];
  const lines = diffText.split(/\r?\n/);
  const fileChunks = [];
  let current = null;

  const stripPrefix = (p) => p.replace(/^["']|["']$/g, "").replace(/^[ab]\//, "").trim();

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.startsWith("--- ")) {
      const next = lines[i + 1] || "";
      const minus = stripPrefix(ln.slice(4));
      const plus = next.startsWith("+++ ") ? stripPrefix(next.slice(4)) : "";
      current = { minus, plus, hunks: [], hunk: null };
      fileChunks.push(current);
      if (next.startsWith("+++ ")) i++;
      continue;
    }
    if (!current) continue;
    if (ln.startsWith("@@")) {
      current.hunk = { before: [], after: [] };
      current.hunks.push(current.hunk);
      continue;
    }
    if (!current.hunk) continue;
    const tag = ln[0];
    const body = ln.slice(1);
    if (tag === " ") { current.hunk.before.push(body); current.hunk.after.push(body); }
    else if (tag === "-") { current.hunk.before.push(body); }
    else if (tag === "+") { current.hunk.after.push(body); }
  }

  for (const fc of fileChunks) {
    const isNew = fc.minus === "/dev/null";
    const isDelete = fc.plus === "/dev/null";
    const relPath = isNew ? fc.plus : fc.minus || fc.plus;
    try {
      const target = resolvePath(relPath);
      if (isDelete) {
        const exists = existsSync(target);
        results.push({ path: relPath, action: "delete", exists, ok: exists, conflict: !exists ? "file not found" : null });
        continue;
      }
      if (isNew) {
        const exists = existsSync(target);
        const content = fc.hunks.flatMap((h) => h.after).join("\n");
        results.push({ path: relPath, action: "create", exists, ok: true, preview_chars: content.length });
        continue;
      }
      const content = await readFile(target, "utf8");
      const hunkResults = [];
      let previewContent = content;
      let allMatch = true;
      for (const h of fc.hunks) {
        const before = h.before.join("\n");
        const after = h.after.join("\n");
        if (before === after) { hunkResults.push({ match: true, skipped: true }); continue; }
        const match = before ? content.includes(before) : true;
        if (!match) allMatch = false;
        hunkResults.push({ match, before_chars: before.length, after_chars: after.length });
        if (match && before) previewContent = previewContent.replace(before, after);
        else if (!before) previewContent += (previewContent.endsWith("\n") ? "" : "\n") + after;
      }
      results.push({ path: relPath, action: "update", ok: allMatch, hunks: hunkResults, conflict: allMatch ? null : "one or more hunks did not match" });
    } catch (err) {
      results.push({ path: relPath, action: "unknown", ok: false, conflict: String(err?.message || err) });
    }
  }
  return results;
}

function patchOperationSchema() {
  return z.object({
    op: z.enum(["create", "update", "delete", "rename"]),
    path: z.string().min(1),
    content: z.string().optional(),
    rename_to: z.string().optional(),
    recursive: z.boolean().optional(),
    overwrite: z.boolean().optional(),
    expected_sha256: z.string().optional(),
    edits: z.array(z.object({
      old_text: z.string().min(1),
      new_text: z.string(),
      replace_all: z.boolean().optional(),
      expected_occurrences: z.number().int().min(1).optional(),
      near_line: z.number().int().min(1).optional()
    })).optional()
  });
}

function registerPatchEngineTools(mcp) {
  reg(
    mcp,
    "preview_patch",
    {
      title: "Preview atomic patch",
      description: "Validate a unified diff or structured operation batch without writing. Detects create collisions, stale hashes, missing/ambiguous hunks, and rename collisions.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        diff: z.string().optional(),
        operations: z.array(patchOperationSchema()).optional()
      }
    },
    async ({ diff, operations }) => jsonResult(diff?.trim()
      ? { mode: "diff", ...(await MUTATION_ENGINE.previewDiff(diff)) }
      : { mode: "operations", ...(await MUTATION_ENGINE.previewOperations(operations || [])) })
  );

  reg(
    mcp,
    "validate_patch",
    {
      title: "Validate atomic patch",
      description: "Fast conflict-only validation for the atomic mutation engine.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        diff: z.string().optional(),
        operations: z.array(patchOperationSchema()).optional()
      }
    },
    async ({ diff, operations }) => {
      const preview = diff?.trim()
        ? await MUTATION_ENGINE.previewDiff(diff)
        : await MUTATION_ENGINE.previewOperations(operations || []);
      return jsonResult({ ok: preview.ok, conflicts: preview.ok ? [] : [{ conflict: preview.conflict }] });
    }
  );

  reg(
    mcp,
    "transaction_list",
    {
      title: "List mutation transactions",
      description: "List recent atomic code mutation transactions and their status.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { limit: z.number().int().min(1).max(100).optional() }
    },
    async ({ limit = 50 }) => jsonResult({ transactions: await MUTATION_ENGINE.list(limit) })
  );

  reg(
    mcp,
    "transaction_get",
    {
      title: "Get mutation transaction",
      description: "Read one atomic mutation transaction including operations, results, and rollback metadata.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { transaction_id: z.string().min(1) }
    },
    async ({ transaction_id }) => jsonResult(await MUTATION_ENGINE.get(transaction_id))
  );

  reg(
    mcp,
    "transaction_undo",
    {
      title: "Undo mutation transaction",
      description: "Restore the complete snapshot for one transaction. Without an id, undoes the latest transaction.",
      inputSchema: { transaction_id: z.string().optional(), task_id: z.string().optional(), force: z.boolean().optional() }
    },
    async ({ transaction_id, force = false }) => jsonResult(await MUTATION_ENGINE.undo(transaction_id, { force }))
  );

  reg(
    mcp,
    "transaction_redo",
    {
      title: "Redo mutation transaction",
      description: "Reapply an undone transaction after validating the current workspace state.",
      inputSchema: { transaction_id: z.string().min(1), task_id: z.string().optional() }
    },
    async ({ transaction_id }) => jsonResult(await MUTATION_ENGINE.redo(transaction_id))
  );

  reg(
    mcp,
    "undo_last_patch",
    {
      title: "Undo last patch",
      description: "Backward-compatible alias for transaction_undo on the latest transaction.",
      inputSchema: {}
    },
    async () => jsonResult(await MUTATION_ENGINE.undo())
  );
}

// Wire backup into write_file / replace_in_file / apply_patch / delete_path / move_path
// We do this by wrapping the handlers — patch the tool registration functions:
const _origApplyOne = applyOne;
async function applyOneWithBackup(op, batchId) {
  // backup is handled at the batch level before execution
  return _origApplyOne(op);
}

// ============================================================================
// v2.3 — Smart Test / Build Runner
// ============================================================================

async function detectTestCommands(rootDir) {
  const commands = { test: null, build: null, lint: null, dev: null, typecheck: null };

  async function tryRead(rel) {
    try { return await readFile(path.join(rootDir, rel), "utf8"); } catch { return null; }
  }

  // npm / Node
  const pkgJson = await tryRead("package.json");
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson);
      const scripts = pkg.scripts || {};
      if (scripts.test) commands.test = `npm test`;
      if (scripts.build) commands.build = `npm run build`;
      if (scripts.lint) commands.lint = `npm run lint`;
      if (scripts.dev) commands.dev = `npm run dev`;
      if (scripts.typecheck || scripts["type-check"] || scripts["type:check"]) {
        commands.typecheck = `npm run ${Object.keys(scripts).find((k) => /typecheck|type.check/.test(k))}`;
      }
    } catch { /* skip */ }
  }

  // Python / pytest
  const pyproject = await tryRead("pyproject.toml");
  const reqTxt = await tryRead("requirements.txt");
  if (pyproject || reqTxt) {
    if (!commands.test) commands.test = "python -m pytest";
    if (!commands.lint) commands.lint = "python -m flake8";
  }

  // Go
  if (await tryRead("go.mod")) {
    if (!commands.test) commands.test = "go test ./...";
    if (!commands.build) commands.build = "go build ./...";
  }

  // Rust
  if (await tryRead("Cargo.toml")) {
    if (!commands.test) commands.test = "cargo test";
    if (!commands.build) commands.build = "cargo build";
    if (!commands.lint) commands.lint = "cargo clippy";
  }

  // Flutter
  if (await tryRead("pubspec.yaml")) {
    if (!commands.test) commands.test = "flutter test";
    if (!commands.build) commands.build = "flutter build";
  }

  // .NET
  let items;
  try { items = await readdir(rootDir); } catch { items = []; }
  if (items.some((f) => f.endsWith(".csproj") || f.endsWith(".sln"))) {
    if (!commands.test) commands.test = "dotnet test";
    if (!commands.build) commands.build = "dotnet build";
  }

  // Gradle
  if (await tryRead("build.gradle")) {
    if (!commands.test) commands.test = "gradle test";
    if (!commands.build) commands.build = "gradle build";
  }

  // Maven
  if (await tryRead("pom.xml")) {
    if (!commands.test) commands.test = "mvn test";
    if (!commands.build) commands.build = "mvn package";
  }

  return commands;
}

function parseTestFailures(output) {
  const failures = [];
  const lines = output.split(/\r?\n/);
  const patterns = [
    // Jest / Vitest: "FAIL src/foo.test.ts" or "✕ test name"
    /^(FAIL|FAILED)\s+(.+)$/,
    // Node assert / mocha
    /AssertionError/,
    // file:line:col error
    /^(.+):(\d+):(\d+):\s*(Error|error)/,
    // "expected X got Y"
    /expected.*got\b/i,
    // "× test name" (Unicode ×)
    /^[\s]*[×✕✗]\s+(.+)/
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pat of patterns) {
      const m = line.match(pat);
      if (m) {
        failures.push({ message: line.slice(0, 300), context: lines.slice(Math.max(0, i - 1), i + 3).join("\n").slice(0, 500) });
        break;
      }
    }
    if (failures.length >= 30) break;
  }
  return failures;
}

async function runGatedCommand(command, cwd, timeoutMs = 120_000) {
  const result = await runShellCommand(command, cwd, undefined, timeoutMs);
  const output = (result.stdout + "\n" + result.stderr).trim();
  const ok = result.exit_code === 0;
  const failures = ok ? [] : parseTestFailures(output);
  const summary = output.slice(0, 3000);
  return { ok, command, exit_code: result.exit_code, timed_out: result.timed_out, summary, failures };
}

async function runGatedArgv(file, args, cwd, timeoutMs = 120_000) {
  const command = [file, ...args].map((part) => JSON.stringify(String(part))).join(" ");
  const result = await spawnCapture(file, args, cwd, timeoutMs);
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  const ok = result.exit_code === 0;
  return {
    ok,
    command,
    file,
    args,
    exit_code: result.exit_code,
    timed_out: result.timed_out,
    summary: output.slice(0, 3000),
    failures: ok ? [] : parseTestFailures(output)
  };
}

function registerTestRunnerTools(mcp) {
  reg(
    mcp,
    "quality_gate",
    {
      title: "Quality gate Pro",
      description: "Manual verification runner. Detects and runs lint/typecheck/test/build commands only when explicitly requested, with compact pass/fail summaries.",
      inputSchema: {
        cwd: z.string().optional(),
        include: z.array(z.enum(["lint", "typecheck", "test", "build"])).optional().describe("Gate order/subset. Default: lint,typecheck,test,build."),
        timeout_ms: z.number().int().min(1000).max(600000).optional(),
        stop_on_failure: z.boolean().optional(),
        dry_run: z.boolean().optional().describe("Return planned gates without executing.")
      }
    },
    async ({ cwd = ".", include, timeout_ms = 120_000, stop_on_failure = true, dry_run = false }) =>
      jsonResult(await runQualityGate({ cwd, include, timeout_ms, stop_on_failure, dry_run }))
  );

  reg(
    mcp,
    "detect_test_commands",
    {
      title: "Detect test commands",
      description: "Detect test/build/lint/dev commands from workspace manifests (package.json, go.mod, Cargo.toml, etc.).",
      inputSchema: { path: z.string().optional() }
    },
    async ({ path: rel = "." }) => {
      const rootDir = resolvePath(rel);
      const [cmds, profile, graph] = await Promise.all([
        getTestCommandsMerged(rootDir),
        detectProjectProfile(rootDir),
        buildProjectGraph(rootDir, { maxDepth: 7, maxFiles: 20000 })
      ]);
      return jsonResult({
        commands: cmds,
        command_list: graph.commands,
        projects: graph.projects.map((project) => ({ id: project.id, path: project.path, language: project.language, packageManager: project.packageManager, command_count: project.commands?.length || 0 })),
        languages: [...new Set([...(profile.languages || []), ...graph.projects.map((project) => project.language).filter(Boolean)])],
        packageManagers: [...new Set([...(profile.packageManagers || []), ...graph.projects.map((project) => project.packageManager).filter(Boolean)])],
        note: EXPLICIT_VERIFICATION_INSTRUCTION
      });
    }
  );

  reg(
    mcp,
    "run_tests",
    {
      title: "Run tests",
      description: "Run the detected (or provided) test command. Returns {ok, exit_code, summary, failures}.",
      inputSchema: {
        command: z.string().optional().describe("Override detected test command."),
        task_id: z.string().optional().describe("Task whose dashboard should receive the explicit verification result."),
        cwd: z.string().optional(),
        timeout_ms: z.number().int().min(1000).max(600000).optional()
      }
    },
    async ({ command, cwd = ".", timeout_ms = 120_000 }) => {
      const rootDir = resolvePath(cwd);
      let cmd = command;
      if (!cmd) {
        const cmds = await getTestCommandsMerged(rootDir);
        cmd = cmds.test;
        if (!cmd) throw new Error("Could not detect test command. Provide command explicitly.");
      }
      assertCommandAllowed(cmd);
      const res = await runGatedCommand(cmd, rootDir, timeout_ms);
      return jsonResult(res);
    }
  );

  reg(
    mcp,
    "run_build",
    {
      title: "Run build",
      description: "Run the detected (or provided) build command. Returns {ok, exit_code, summary, failures}.",
      inputSchema: {
        command: z.string().optional(),
        task_id: z.string().optional(),
        cwd: z.string().optional(),
        timeout_ms: z.number().int().min(1000).max(600000).optional()
      }
    },
    async ({ command, cwd = ".", timeout_ms = 120_000 }) => {
      const rootDir = resolvePath(cwd);
      let cmd = command;
      if (!cmd) {
        const cmds = await getTestCommandsMerged(rootDir);
        cmd = cmds.build;
        if (!cmd) throw new Error("Could not detect build command. Provide command explicitly.");
      }
      assertCommandAllowed(cmd);
      return jsonResult(await runGatedCommand(cmd, rootDir, timeout_ms));
    }
  );

  reg(
    mcp,
    "run_lint",
    {
      title: "Run lint",
      description: "Run the detected (or provided) lint command. Returns {ok, exit_code, summary, failures}.",
      inputSchema: {
        command: z.string().optional(),
        task_id: z.string().optional(),
        cwd: z.string().optional(),
        timeout_ms: z.number().int().min(1000).max(600000).optional()
      }
    },
    async ({ command, cwd = ".", timeout_ms = 60_000 }) => {
      const rootDir = resolvePath(cwd);
      let cmd = command;
      if (!cmd) {
        const cmds = await getTestCommandsMerged(rootDir);
        cmd = cmds.lint;
        if (!cmd) throw new Error("Could not detect lint command. Provide command explicitly.");
      }
      assertCommandAllowed(cmd);
      return jsonResult(await runGatedCommand(cmd, rootDir, timeout_ms));
    }
  );

  reg(
    mcp,
    "run_changed_tests",
    {
      title: "Run changed tests",
      description: "Run tests for changed files only (git diff + untracked). Maps src files to test files heuristically; falls back to full test suite.",
      inputSchema: {
        task_id: z.string().optional(),
        cwd: z.string().optional(),
        timeout_ms: z.number().int().min(1000).max(600000).optional()
      }
    },
    async ({ cwd = ".", timeout_ms = 120_000 }) => {
      const rootDir = resolvePath(cwd);
      // Get changed files
      const diffRes = await spawnCapture("git", ["diff", "--name-only"], rootDir, DEFAULT_CMD_TIMEOUT);
      const untrackedRes = await spawnCapture("git", ["ls-files", "--others", "--exclude-standard"], rootDir, DEFAULT_CMD_TIMEOUT);
      const changedFiles = [
        ...(diffRes.stdout || "").split(/\r?\n/).filter(Boolean),
        ...(untrackedRes.stdout || "").split(/\r?\n/).filter(Boolean)
      ];

      // Map to test files
      const testFiles = new Set();
      for (const f of changedFiles) {
        const base = path.basename(f, path.extname(f));
        const dir = path.dirname(f);
        // Direct test file check
        for (const pattern of [
          path.join(dir, `${base}.test${path.extname(f)}`),
          path.join(dir, `${base}.spec${path.extname(f)}`),
          path.join(dir, "__tests__", `${base}.test${path.extname(f)}`),
          path.join(dir, "__tests__", `${base}.spec${path.extname(f)}`),
          path.join("test", `${base}.test${path.extname(f)}`),
          path.join("tests", `test_${base}.py`),
          path.join("tests", `${base}_test.py`)
        ]) {
          if (existsSync(path.join(rootDir, pattern))) testFiles.add(pattern);
        }
      }

      const cmds = await getTestCommandsMerged(rootDir);
      if (testFiles.size === 0) {
        // Fall back to full test run
        if (!cmds.test) throw new Error("No changed test files found and no test command detected.");
        assertCommandAllowed(cmds.test);
        const res = await runGatedCommand(cmds.test, rootDir, timeout_ms);
        return jsonResult({ ...res, strategy: "full_fallback", changed_files: changedFiles.length });
      }

      // Build targeted tests with argv, never by concatenating Git-controlled filenames into a shell string.
      const selectedFiles = [...testFiles];
      let res;
      const npmText = String(cmds.test || "");
      const npmMatch = npmText.match(/^npm(?:\.cmd)?\s+(test|run\s+([^\s]+))$/i);
      if (npmMatch) {
        const npm = process.platform === "win32" ? "npm.cmd" : "npm";
        const baseArgs = npmMatch[1].toLowerCase() === "test" ? ["test"] : ["run", npmMatch[2]];
        res = await runGatedArgv(npm, [...baseArgs, "--", ...selectedFiles], rootDir, timeout_ms);
      } else if (npmText.includes("pytest")) {
        const python = process.platform === "win32" ? "python.exe" : "python";
        res = await runGatedArgv(python, ["-m", "pytest", ...selectedFiles], rootDir, timeout_ms);
      } else {
        // Unknown runners receive the normal full command rather than unsafe filename interpolation.
        if (!cmds.test) throw new Error("No supported targeted test runner detected.");
        assertCommandAllowed(cmds.test);
        res = await runGatedCommand(cmds.test, rootDir, timeout_ms);
        res.strategy = "full_fallback_unknown_runner";
      }
      return jsonResult({ ...res, strategy: res.strategy || "targeted_argv", test_files: selectedFiles, changed_files: changedFiles });
    }
  );
}

// ============================================================================
// v2.4 / v5 — Review Mode and rich diff scopes
// ============================================================================

async function untrackedDiff(rootDir, limit = 100) {
  const listed = await spawnCapture("git", ["ls-files", "--others", "--exclude-standard"], rootDir, DEFAULT_CMD_TIMEOUT);
  const files = (listed.stdout || "").split(/\r?\n/).filter(Boolean).slice(0, limit);
  const chunks = [];
  for (const file of files) {
    const diff = await spawnCapture("git", ["diff", "--no-index", "--", "/dev/null", file], rootDir, DEFAULT_CMD_TIMEOUT);
    if (diff.stdout) chunks.push(diff.stdout);
  }
  return { files, diff: chunks.join("\n") };
}

async function collectGitDiff({ rootDir, scope = "working-tree", base, commit, includeUntracked = false, taskId, transactionId }) {
  let args;
  let label = scope;
  if (scope === "staged") args = ["diff", "--staged"];
  else if (scope === "uncommitted") args = ["diff", "HEAD"];
  else if (scope === "commit") {
    if (!commit) throw new Error("commit scope requires commit.");
    args = ["show", "--format=", "--find-renames", commit];
    label = `commit:${commit}`;
  } else if (scope === "branch") {
    const resolvedBase = base || "main";
    args = ["diff", `${resolvedBase}...HEAD`];
    label = `branch:${resolvedBase}...HEAD`;
  } else if (scope === "last-transaction" || scope === "transaction") {
    const record = transactionId ? await MUTATION_ENGINE.get(transactionId) : (await MUTATION_ENGINE.list(1))[0];
    if (!record) return { ok: true, scope, label, diff: "", files: [], untracked: [] };
    const full = await MUTATION_ENGINE.get(record.id);
    const paths = [...new Set((full.snapshots || []).map((item) => toRel(item.path)).filter(Boolean))];
    args = ["diff", "--", ...paths];
    label = `transaction:${record.id}`;
  } else if (scope === "task") {
    const task = taskId ? await TASK_RUNTIME.getTask(taskId) : await TASK_RUNTIME.getCurrentTask();
    if (!task) return { ok: true, scope, label, diff: "", files: [], untracked: [] };
    const paths = [...new Set((task.changes || []).map((item) => item.path).filter(Boolean))];
    if (!paths.length) return { ok: true, scope, label: `task:${task.id}`, diff: "", files: [], untracked: [] };
    args = ["diff", "--", ...paths];
    label = `task:${task.id}`;
  } else {
    args = ["diff"];
    scope = "working-tree";
  }
  const result = await spawnCapture("git", args, rootDir, DEFAULT_CMD_TIMEOUT);
  if (result.exit_code !== 0) return { ok: false, scope, label, error: result.stderr || "git diff failed", diff: "", files: [], untracked: [] };
  let diff = result.stdout || "";
  let untracked = [];
  if (includeUntracked || scope === "uncommitted") {
    const extra = await untrackedDiff(rootDir);
    untracked = extra.files;
    if (extra.diff) diff += `${diff ? "\n" : ""}${extra.diff}`;
  }
  const summary = analyzeDiff(diff).summary;
  return { ok: true, scope, label, diff, files: summary.files || [], untracked, summary };
}

function registerReviewTools(mcp) {
  reg(
    mcp,
    "session_report",
    {
      title: "Session report Pro",
      description: "PRO end-of-session report: git state, doctor summary, mode, policy, root, and version.",
      inputSchema: {
        cwd: z.string().optional().describe("Repository directory inside a root (default primary root).")
      }
    },
    async ({ cwd = "." }) => {
      const rootDir = resolvePath(cwd);
      return jsonResult(await buildSessionReport(rootDir));
    }
  );

  reg(
    mcp,
    "review_diff",
    {
      title: "Review diff",
      description: "Run heuristic review on working tree, staged, all uncommitted including untracked, commit, branch, task, or transaction scope.",
      inputSchema: {
        staged: z.boolean().optional().describe("Backward-compatible alias for scope=staged."),
        scope: z.enum(["working-tree", "staged", "uncommitted", "commit", "branch", "task", "last-transaction", "transaction"]).optional(),
        base: z.string().optional(),
        commit: z.string().optional(),
        task_id: z.string().optional(),
        transaction_id: z.string().optional(),
        include_untracked: z.boolean().optional(),
        cwd: z.string().optional()
      }
    },
    async ({ staged = false, scope, base, commit, task_id, transaction_id, include_untracked = false, cwd = "." }) => {
      const rootDir = resolvePath(cwd);
      const collected = await collectGitDiff({
        rootDir,
        scope: staged ? "staged" : (scope || "working-tree"),
        base,
        commit,
        taskId: task_id,
        transactionId: transaction_id,
        includeUntracked: include_untracked
      });
      if (!collected.ok) return jsonResult(collected);
      const diff = collected.diff || "";
      if (!diff.trim()) return jsonResult({ ok: true, verdict: "CLEAN", summary: { changed_files: 0, source_files: 0, test_files: 0, config_files: 0, added_lines: 0, deleted_lines: 0, files: [] }, findings: [], message: "No changes in working tree." });

      const { summary, findings } = analyzeDiff(diff);
      const p1 = findings.filter((f) => f.priority === "P1").length;
      const verdict = p1 > 0 ? "BLOCK" : findings.length > 0 ? "WARN" : "PASS";
      return jsonResult({ ok: verdict !== "BLOCK", verdict, scope: collected.scope, label: collected.label, summary, untracked: collected.untracked, findings_count: findings.length, findings: findings.slice(0, 100), p1, p2: findings.filter((f) => f.priority === "P2").length, p3: findings.filter((f) => f.priority === "P3").length });
    }
  );

  reg(
    mcp,
    "diff_collect",
    {
      title: "Collect review diff",
      description: "Collect a normalized diff and metadata for semantic review by ChatGPT, including untracked files when requested.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        scope: z.enum(["working-tree", "staged", "uncommitted", "commit", "branch", "task", "last-transaction", "transaction"]).optional(),
        base: z.string().optional(),
        commit: z.string().optional(),
        task_id: z.string().optional(),
        transaction_id: z.string().optional(),
        include_untracked: z.boolean().optional(),
        cwd: z.string().optional(),
        max_chars: z.number().int().min(1000).max(500000).optional()
      }
    },
    async ({ scope = "uncommitted", base, commit, task_id, transaction_id, include_untracked = true, cwd = ".", max_chars = 200000 }) => {
      const result = await collectGitDiff({ rootDir: resolvePath(cwd), scope, base, commit, taskId: task_id, transactionId: transaction_id, includeUntracked: include_untracked });
      return jsonResult({ ...result, diff: (result.diff || "").slice(0, max_chars), truncated: (result.diff || "").length > max_chars });
    }
  );

  reg(
    mcp,
    "review_prepare",
    {
      title: "Prepare semantic code review",
      description: "Collect diff scope, deterministic findings, instruction hierarchy, and suggested review focus for ChatGPT semantic review.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        scope: z.enum(["working-tree", "staged", "uncommitted", "commit", "branch", "task", "last-transaction", "transaction"]).optional(),
        base: z.string().optional(),
        commit: z.string().optional(),
        task_id: z.string().optional(),
        transaction_id: z.string().optional(),
        cwd: z.string().optional()
      }
    },
    async ({ scope = "uncommitted", base, commit, task_id, transaction_id, cwd = "." }) => {
      const rootDir = resolvePath(cwd);
      const collected = await collectGitDiff({ rootDir, scope, base, commit, taskId: task_id, transactionId: transaction_id, includeUntracked: true });
      const analysis = analyzeDiff(collected.diff || "");
      const instructions = await discoverInstructionChain(PRIMARY_ROOT, cwd, { maxChars: 24000 });
      return jsonResult({
        ...collected,
        diff: (collected.diff || "").slice(0, 250000),
        deterministic_findings: analysis.findings,
        instruction_chain: instructions.instructions.map(({ content, ...meta }) => meta),
        review_focus: ["correctness", "regressions", "security", "error handling", "API compatibility", "concurrency", "unwanted scope"]
      });
    }
  );

  reg(
    mcp,
    "security_scan",
    {
      title: "Security scan",
      description: "Scan changed (or all, capped) files for secret patterns (AWS keys, private keys, API tokens, etc.) and unsafe usage. Reports file:line — never echoes the secret value.",
      inputSchema: {
        path: z.string().optional().describe("Dir to scan (default primary root)."),
        changed_only: z.boolean().optional().describe("Only scan files changed in git diff (default false)."),
        cwd: z.string().optional()
      }
    },
    async ({ path: rel = ".", changed_only = false, cwd = "." }) => {
      const rootDir = resolvePath(rel);
      const SECRET_PATTERNS = [
        { name: "AWS Access Key", re: /AKIA[0-9A-Z]{16}/ },
        { name: "Private Key", re: /-----BEGIN [A-Z ]* PRIVATE KEY-----/ },
        { name: "Generic API key", re: /['"](api[_-]?key|apikey|api_secret)['"]\s*[:=]\s*['"][^'"]{10,}['"]/i },
        { name: "Password assignment", re: /\b(password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/i },
        { name: "Token assignment", re: /\b(token|access_token|auth_token|bearer)\s*[:=]\s*['"][^'"]{10,}['"]/i },
        { name: "Slack token", re: /xox[baprs]-[0-9A-Za-z]{10,}/ },
        { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
        { name: "Generic secret", re: /\bsecret\s*[:=]\s*['"][^'"]{10,}['"]/i }
      ];

      let filesToScan = [];
      if (changed_only) {
        const diffRes = await spawnCapture("git", ["diff", "--name-only"], rootDir, DEFAULT_CMD_TIMEOUT);
        filesToScan = (diffRes.stdout || "").split(/\r?\n/).filter(Boolean).map((f) => path.join(rootDir, f));
      } else {
        const { files } = await buildTree(rootDir, 4, 500);
        filesToScan = files.filter((f) => {
          const ext = path.extname(f).toLowerCase();
          return [".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx", ".py", ".json", ".env", ".sh", ".yml", ".yaml"].includes(ext);
        });
      }

      const hits = [];
      for (const fp of filesToScan.slice(0, 300)) {
        let content;
        try { content = await readFile(fp, "utf8"); } catch { continue; }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          for (const pat of SECRET_PATTERNS) {
            if (pat.re.test(lines[i])) {
              hits.push({ file: toRel(fp), line: i + 1, pattern: pat.name });
              break;
            }
          }
          if (hits.length >= 100) break;
        }
        if (hits.length >= 100) break;
      }

      return jsonResult({ ok: hits.length === 0, scanned_files: filesToScan.length, hits_count: hits.length, hits });
    }
  );

  reg(
    mcp,
    "todo_scan",
    {
      title: "TODO scan",
      description: "Find all TODO/FIXME/HACK/XXX comments in the workspace. Returns file:line locations.",
      inputSchema: {
        path: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional()
      }
    },
    async ({ path: rel = ".", limit = 200 }) => {
      const start = resolvePath(rel);
      let matches;
      if (RG_BIN) {
        matches = await ripgrepGrep(start, "TODO|FIXME|HACK|XXX", { regex: true, limit, glob: null });
      }
      if (!matches) {
        matches = await searchTree(start, "TODO|FIXME|HACK|XXX", { regex: true, limit, glob: null });
      }
      const categorized = (matches || []).map((m) => {
        const kind = m.text.match(/\b(TODO|FIXME|HACK|XXX)\b/i)?.[1]?.toUpperCase() || "TODO";
        return { ...m, kind };
      });
      return jsonResult({ count: categorized.length, items: categorized });
    }
  );

  reg(
    mcp,
    "change_summary",
    {
      title: "Change summary",
      description: "Summarize git diff --stat and list changed files with a bullet summary.",
      inputSchema: {
        cwd: z.string().optional(),
        staged: z.boolean().optional()
      }
    },
    async ({ cwd = ".", staged = false }) => {
      const rootDir = resolvePath(cwd);
      const statArgs = ["diff", "--stat"];
      if (staged) statArgs.push("--staged");
      const statRes = await spawnCapture("git", statArgs, rootDir, DEFAULT_CMD_TIMEOUT);

      const nameArgs = ["diff", "--name-status"];
      if (staged) nameArgs.push("--staged");
      const nameRes = await spawnCapture("git", nameArgs, rootDir, DEFAULT_CMD_TIMEOUT);

      if (statRes.exit_code !== 0) {
        return jsonResult({ ok: false, error: "Not a git repo." });
      }

      const stat_output = (statRes.stdout || "").trim();
      const files = (nameRes.stdout || "").split(/\r?\n/).filter(Boolean).map((line) => {
        const [status, ...parts] = line.split(/\t/);
        return { status: status.trim(), path: parts.join("\t").trim() };
      });

      return jsonResult({ ok: true, stat: stat_output, files_changed: files.length, files: files.slice(0, 100) });
    }
  );
}

// ============================================================================
// v2.5 — Planner / Thread Memory
// ============================================================================

function registerPlannerTools(mcp) {
  reg(
    mcp,
    "task_plan",
    {
      title: "Task plan",
      description: "Create or update the current task plan. Stores goal + steps in .agent/state/current-task.json.",
      inputSchema: {
        goal: z.string().min(1).describe("High-level goal description."),
        steps: z.array(z.string()).min(1).describe("Ordered list of steps to complete the goal.")
      }
    },
    async ({ goal, steps }) => {
      await mkdir(AGENT_STATE_DIR, { recursive: true });
      const plan = {
        goal,
        steps: steps.map((text) => ({ text, done: false })),
        created: isoNow(),
        updated: isoNow()
      };
      await writeFile(TASK_PLAN_PATH, JSON.stringify(plan, null, 2), "utf8");
      return jsonResult({ ok: true, goal, steps_count: steps.length, path: TASK_PLAN_PATH });
    }
  );

  reg(
    mcp,
    "task_state",
    {
      title: "Task state",
      description: "Get or update the current task plan. Call with no args to read; pass set_step_done/add_steps/status to update.",
      inputSchema: {
        set_step_done: z.number().int().min(0).optional().describe("Mark step N (0-indexed) as done."),
        add_steps: z.array(z.string()).optional().describe("Append new steps to the plan."),
        status: z.string().optional().describe("Set overall status string.")
      }
    },
    async ({ set_step_done, add_steps, status }) => {
      let plan;
      try {
        plan = JSON.parse(await readFile(TASK_PLAN_PATH, "utf8"));
      } catch {
        return textResult("No task plan found. Call task_plan to create one.");
      }

      let changed = false;
      if (set_step_done !== undefined) {
        if (plan.steps[set_step_done]) { plan.steps[set_step_done].done = true; changed = true; }
      }
      if (add_steps && add_steps.length > 0) {
        plan.steps.push(...add_steps.map((text) => ({ text, done: false })));
        changed = true;
      }
      if (status !== undefined) {
        plan.status = status;
        changed = true;
      }
      if (changed) {
        plan.updated = isoNow();
        await writeFile(TASK_PLAN_PATH, JSON.stringify(plan, null, 2), "utf8");
      }

      const done = plan.steps.filter((s) => s.done).length;
      const total = plan.steps.length;
      return jsonResult({ ...plan, progress: `${done}/${total}` });
    }
  );

  reg(
    mcp,
    "decision_log",
    {
      title: "Decision log",
      description: "Append a decision + reasoning to decisions.md in .agent/state/.",
      inputSchema: {
        decision: z.string().min(1).describe("What was decided."),
        why: z.string().min(1).describe("Why this decision was made.")
      }
    },
    async ({ decision, why }) => {
      await mkdir(AGENT_STATE_DIR, { recursive: true });
      const entry = `\n## ${isoNow()}\n\n**Decision:** ${decision}\n\n**Why:** ${why}\n`;
      await appendFile(DECISIONS_PATH, entry, "utf8");
      return jsonResult({ ok: true, appended_to: DECISIONS_PATH });
    }
  );
}

function taskUiMeta(invoking, invoked) {
  return {
    ui: { resourceUri: COMPANION_WIDGET_URI, visibility: ["model", "app"] },
    "openai/outputTemplate": COMPANION_WIDGET_URI,
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked
  };
}

function registerTaskRuntimeTools(mcp) {
  reg(
    mcp,
    "task_analyze",
    {
      title: "Analyze task workflow",
      description: "Classify a task as simple or complex and recommend fast or plan workflow without modifying code.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { task: z.string().min(1) }
    },
    async ({ task }) => structuredJsonResult(await TASK_RUNTIME.analyzeTask(task))
  );

  reg(
    mcp,
    "task_create",
    {
      title: "Create coding task",
      description: "Create a persistent coding task. Access defaults to full and workflow defaults to auto; verification remains explicit-only.",
      inputSchema: {
        title: z.string().optional(),
        goal: z.string().min(1),
        access_mode: z.enum(["full", "balanced", "safe"]).optional(),
        workflow_mode: z.enum(["fast", "plan", "auto"]).optional(),
        verification: z.object({ tests: z.boolean().optional(), lint: z.boolean().optional(), build: z.boolean().optional() }).optional()
      }
    },
    async ({ title, goal, access_mode, workflow_mode, verification }) => {
      const task = await TASK_RUNTIME.createTask({
        title,
        goal,
        accessMode: access_mode || ACCESS_MODE,
        workflowMode: workflow_mode || WORKFLOW_MODE,
        verification
      });
      await HOOK_MANAGER.run("TaskCreated", { task });
      return structuredJsonResult({ task, dashboard: await TASK_RUNTIME.getDashboard(task.id) });
    }
  );

  reg(
    mcp,
    "task_get",
    {
      title: "Get coding task",
      description: "Read one persistent coding task and its dashboard state.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { task_id: z.string().min(1) }
    },
    async ({ task_id }) => structuredJsonResult({ task: await TASK_RUNTIME.getTask(task_id), dashboard: await TASK_RUNTIME.getDashboard(task_id) })
  );

  reg(
    mcp,
    "task_list",
    {
      title: "List coding tasks",
      description: "List recent persistent coding tasks.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { limit: z.number().int().min(1).max(100).optional() }
    },
    async ({ limit = 30 }) => structuredJsonResult({ tasks: await TASK_RUNTIME.listTasks(limit) })
  );

  reg(
    mcp,
    "task_update",
    {
      title: "Update coding task",
      description: "Update task status, workflow/access mode, verification request, or dashboard preferences.",
      inputSchema: {
        task_id: z.string().min(1),
        status: z.enum(["created", "analyzing", "planned", "implementing", "paused", "verifying", "changed", "completed", "failed", "cancelled"]).optional(),
        title: z.string().optional(),
        goal: z.string().optional(),
        access_mode: z.enum(["full", "balanced", "safe"]).optional(),
        workflow_mode: z.enum(["fast", "plan", "auto"]).optional(),
        verification: z.object({ tests: z.boolean().optional(), lint: z.boolean().optional(), build: z.boolean().optional() }).optional(),
        activity_message: z.string().optional()
      },
      _meta: taskUiMeta("Updating task dashboard…", "Task dashboard updated.")
    },
    async ({ task_id, status, title, goal, access_mode, workflow_mode, verification, activity_message }) => {
      const task = await TASK_RUNTIME.updateTask(task_id, {
        status,
        title,
        goal,
        accessMode: access_mode,
        workflowMode: workflow_mode,
        verification,
        activityMessage: activity_message
      });
      if (status === "completed") await HOOK_MANAGER.run("TaskCompleted", { task });
      if (status === "failed") await HOOK_MANAGER.run("TaskFailed", { task });
      return structuredJsonResult({ task, dashboard: await TASK_RUNTIME.getDashboard(task.id) });
    }
  );

  reg(
    mcp,
    "plan_create",
    {
      title: "Create implementation plan",
      description: "Create or version a structured plan for a persistent task and render a Plan card with an Implement button.",
      inputSchema: {
        task_id: z.string().min(1),
        goal: z.string().optional(),
        assumptions: z.array(z.string()).optional(),
        scope: z.array(z.string()).optional(),
        steps: z.array(z.string()).min(1),
        risks: z.array(z.string()).optional(),
        verification: z.object({ tests: z.boolean().optional(), lint: z.boolean().optional(), build: z.boolean().optional() }).optional()
      },
      _meta: taskUiMeta("Creating implementation plan…", "Plan ready.")
    },
    async ({ task_id, goal, assumptions, scope, steps, risks, verification }) => {
      const plan = await TASK_RUNTIME.createPlan({ taskId: task_id, goal, assumptions, scope, steps, risks, verification });
      await HOOK_MANAGER.run("PlanCreated", { plan });
      const dashboard = await TASK_RUNTIME.getDashboard(task_id);
      return {
        structuredContent: { kind: "lca_plan_card", plan, dashboard },
        content: [{ type: "text", text: `Plan v${plan.version} ready for task ${task_id}. Press Implement in the dashboard to continue without retyping the request.` }]
      };
    }
  );

  reg(
    mcp,
    "plan_update",
    {
      title: "Update implementation plan",
      description: "Create a new immutable plan version while preserving previous versions.",
      inputSchema: {
        plan_id: z.string().min(1),
        goal: z.string().optional(),
        assumptions: z.array(z.string()).optional(),
        scope: z.array(z.string()).optional(),
        steps: z.array(z.union([z.string(), z.object({ text: z.string(), enabled: z.boolean().optional(), done: z.boolean().optional() })])).optional(),
        risks: z.array(z.string()).optional(),
        verification: z.object({ tests: z.boolean().optional(), lint: z.boolean().optional(), build: z.boolean().optional() }).optional()
      },
      _meta: taskUiMeta("Updating implementation plan…", "Plan updated.")
    },
    async ({ plan_id, ...patch }) => {
      const plan = await TASK_RUNTIME.updatePlan(plan_id, patch);
      await HOOK_MANAGER.run("PlanCreated", { plan, updated: true });
      return {
        structuredContent: { kind: "lca_plan_card", plan, dashboard: await TASK_RUNTIME.getDashboard(plan.taskId) },
        content: [{ type: "text", text: `Plan updated to v${plan.version}.` }]
      };
    }
  );

  reg(
    mcp,
    "plan_history",
    {
      title: "Implementation plan history",
      description: "List preserved versions for a plan or task.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { plan_id: z.string().optional(), task_id: z.string().optional() }
    },
    async ({ plan_id, task_id }) => structuredJsonResult({ plans: await TASK_RUNTIME.planHistory({ planId: plan_id, taskId: task_id }) })
  );

  reg(
    mcp,
    "plan_get",
    {
      title: "Get implementation plan",
      description: "Read a structured implementation plan by id.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { plan_id: z.string().min(1) }
    },
    async ({ plan_id }) => structuredJsonResult(await TASK_RUNTIME.getPlan(plan_id))
  );

  reg(
    mcp,
    "task_prepare_implementation",
    {
      title: "Prepare task implementation",
      description: "Validate the selected plan version/hash, mark the task implementing, and return the compact follow-up instruction for ChatGPT Web.",
      inputSchema: {
        task_id: z.string().min(1),
        plan_id: z.string().optional(),
        expected_plan_version: z.number().int().min(1).optional(),
        expected_plan_hash: z.string().optional()
      },
      _meta: taskUiMeta("Preparing implementation…", "Implementation ready.")
    },
    async ({ task_id, plan_id, expected_plan_version, expected_plan_hash }) => {
      await HOOK_MANAGER.run("BeforeImplement", { task_id, plan_id, expected_plan_version, expected_plan_hash });
      const prepared = await TASK_RUNTIME.prepareImplementation({
        taskId: task_id,
        planId: plan_id,
        expectedPlanVersion: expected_plan_version,
        expectedPlanHash: expected_plan_hash
      });
      const dashboard = await TASK_RUNTIME.getDashboard(task_id);
      const requestedVerification = Object.entries(prepared.task.verification || {})
        .filter(([, value]) => value?.status === "requested")
        .map(([kind]) => kind);
      const followUpPrompt = [
        `Implement LCA task ${prepared.task.id} using plan ${prepared.plan.id} version ${prepared.plan.version}.`,
        "Read the task and plan with task_get and plan_get before editing.",
        `Use access mode ${prepared.task.accessMode}.`,
        requestedVerification.length
          ? `After implementation, run only the explicitly selected verification: ${requestedVerification.join(", ")}.`
          : EXPLICIT_VERIFICATION_INSTRUCTION
      ].join("\n");
      return {
        structuredContent: { kind: "lca_implementation_ready", task: prepared.task, plan: prepared.plan, dashboard, follow_up_prompt: followUpPrompt },
        content: [{ type: "text", text: followUpPrompt }]
      };
    }
  );

  reg(
    mcp,
    "task_context",
    {
      title: "Prepare task context",
      description: "Build a compact implementation/resume context packet with task, plan, instructions, project graph, diff, transactions, and running sessions.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        task_id: z.string().min(1),
        target_path: z.string().optional(),
        include_diff: z.boolean().optional(),
        max_diff_chars: z.number().int().min(1000).max(250000).optional()
      }
    },
    async ({ task_id, target_path = ".", include_diff = true, max_diff_chars = 100000 }) => {
      const task = await TASK_RUNTIME.getTask(task_id);
      const [plan, instructions, graph, transactions] = await Promise.all([
        task.planId ? TASK_RUNTIME.getPlan(task.planId).catch(() => null) : null,
        discoverInstructionChain(PRIMARY_ROOT, target_path, { maxChars: 24000 }),
        buildProjectGraph(PRIMARY_ROOT, { maxDepth: 7, maxFiles: 20000 }),
        MUTATION_ENGINE.list(100)
      ]);
      const collected = include_diff
        ? await collectGitDiff({ rootDir: PRIMARY_ROOT, scope: "task", taskId: task_id, includeUntracked: true })
        : { ok: true, diff: "", files: [], untracked: [] };
      const sessions = [...processes.values()]
        .filter((proc) => proc.taskId === task_id)
        .map((proc) => ({ id: proc.id, name: proc.name, command: proc.command, cwd: proc.cwd, status: proc.status, pid: proc.child?.pid, cursor: proc.cursorBase + proc.output.length }));
      return jsonResult({
        task,
        plan,
        instruction_chain: instructions,
        projects: graph.projects.map((project) => ({ id: project.id, path: project.path, language: project.language, packageManager: project.packageManager, commands: project.commands })),
        diff: (collected.diff || "").slice(0, max_diff_chars),
        diff_truncated: (collected.diff || "").length > max_diff_chars,
        untracked: collected.untracked || [],
        transactions: transactions.filter((transaction) => task.transactions?.includes(transaction.id)),
        sessions,
        verification_instruction: EXPLICIT_VERIFICATION_INSTRUCTION
      });
    }
  );

  reg(
    mcp,
    "task_complete",
    {
      title: "Complete coding task",
      description: "Mark a task complete and render its completion dashboard without claiming unrun verification passed.",
      inputSchema: { task_id: z.string().min(1), message: z.string().optional() },
      _meta: taskUiMeta("Completing task…", "Task completed.")
    },
    async ({ task_id, message }) => {
      const task = await TASK_RUNTIME.updateTask(task_id, { status: "completed", activityType: "task_completed", activityMessage: message || "Task completed" });
      await HOOK_MANAGER.run("TaskCompleted", { task });
      return {
        structuredContent: { kind: "lca_task_dashboard", dashboard: await TASK_RUNTIME.getDashboard(task_id) },
        content: [{ type: "text", text: `Task ${task_id} completed. ${EXPLICIT_VERIFICATION_INSTRUCTION}` }]
      };
    }
  );

  reg(
    mcp,
    "task_cancel",
    {
      title: "Cancel coding task",
      description: "Cancel a task and stop all terminal sessions associated with it.",
      inputSchema: { task_id: z.string().min(1), reason: z.string().optional() },
      _meta: taskUiMeta("Cancelling task…", "Task cancelled.")
    },
    async ({ task_id, reason }) => {
      for (const proc of processes.values()) if (proc.taskId === task_id && proc.status === "running") killProcessTree(proc);
      const task = await TASK_RUNTIME.updateTask(task_id, { status: "cancelled", activityType: "task_cancelled", activityMessage: reason || "Task cancelled" });
      return {
        structuredContent: { kind: "lca_task_dashboard", dashboard: await TASK_RUNTIME.getDashboard(task_id) },
        content: [{ type: "text", text: `Task ${task_id} cancelled.` }]
      };
    }
  );

  reg(
    mcp,
    "task_resume",
    {
      title: "Resume coding task",
      description: "Resume a persisted task and return the dashboard plus an instruction to load task_context before continuing.",
      inputSchema: { task_id: z.string().min(1) },
      _meta: taskUiMeta("Resuming task…", "Task resumed.")
    },
    async ({ task_id }) => {
      const existing = await TASK_RUNTIME.getTask(task_id);
      const status = existing.planId ? "implementing" : "analyzing";
      const task = await TASK_RUNTIME.updateTask(task_id, { status, activityType: "task_resumed", activityMessage: "Task resumed" });
      return {
        structuredContent: { kind: "lca_task_dashboard", dashboard: await TASK_RUNTIME.getDashboard(task_id) },
        content: [{ type: "text", text: `Resume task ${task_id}. Call task_context before editing. ${EXPLICIT_VERIFICATION_INSTRUCTION}` }]
      };
    }
  );

  reg(
    mcp,
    "task_dashboard",
    {
      title: "Open task dashboard",
      description: "Render the Apps SDK task dashboard. Code mutation tools also render this automatically in every access/workflow mode.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { task_id: z.string().optional() },
      _meta: taskUiMeta("Opening task dashboard…", "Task dashboard ready.")
    },
    async ({ task_id }) => {
      const dashboard = await TASK_RUNTIME.getDashboard(task_id);
      return {
        structuredContent: { kind: "lca_task_dashboard", dashboard },
        content: [{ type: "text", text: dashboard.visible ? `Dashboard ready for task ${dashboard.task?.id}.` : "No active task dashboard." }]
      };
    }
  );
}

function registerHookTools(mcp) {
  reg(
    mcp,
    "hook_status",
    {
      title: "Lifecycle hook status",
      description: "Show explicitly configured .agent/hooks.json lifecycle hooks. Hooks do not run unless present in that file.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {}
    },
    async () => jsonResult(await HOOK_MANAGER.status())
  );

  reg(
    mcp,
    "hook_reload",
    {
      title: "Reload lifecycle hooks",
      description: "Reload .agent/hooks.json after it changes.",
      inputSchema: {}
    },
    async () => {
      await HOOK_MANAGER.load(true);
      return jsonResult({ ok: true, ...(await HOOK_MANAGER.status()) });
    }
  );

  reg(
    mcp,
    "hook_run",
    {
      title: "Run lifecycle hook event",
      description: "Explicitly run one configured lifecycle event with a JSON payload.",
      inputSchema: {
        event: z.enum(HOOK_EVENTS),
        payload: z.record(z.any()).optional(),
        await_non_blocking: z.boolean().optional()
      }
    },
    async ({ event, payload = {}, await_non_blocking = false }) => jsonResult(await HOOK_MANAGER.run(event, payload, { awaitNonBlocking: await_non_blocking }))
  );
}

// Also update checkpoint to snapshot current-task.json
const _origCheckpoint = null; // we'll patch via the registration

// ============================================================================
// v2.6 — Approval / Policy Layer
// ============================================================================

const POLICY_RULES = {
  strict: {
    description: "Read and analyze only. No writes, installs, external network, deletes, or git mutations. Read-only Figma Desktop loopback tools are allowed.",
    blocked: ["write_file", "replace_in_file", "apply_patch", "make_dir", "move_path", "delete_path",
              "run_command", "proc_start", "git"],
    needs_approval: [],
    allowed_patterns: []
  },
  balanced: {
    description: "Read + edit allowed. Manual verification tools remain available only when explicitly requested. Delete, install, network commands need approval.",
    blocked: [],
    needs_approval: [],
    dangerous_patterns: [
      /\b(npm|pip|pip3|yarn|pnpm|cargo|apt|brew|gem|composer)\s+install\b/i,
      /\bcurl\b.*-[oO]/i,
      /\bwget\b/i,
      /\bgit\s+(push|fetch|pull|clone)\b/i,
      /\bdocker\s+(push|pull|run|build)\b/i
    ],
    allowed: ["read_file", "write_file", "replace_in_file", "apply_patch", "search_text", "find_files"]
  },
  full: {
    description: "Full access (same as before, catastrophic commands still blocked).",
    blocked: [],
    needs_approval: [],
    allowed: ["*"]
  }
};

const STRICT_MUTATION_TOOLS = new Set([
  "figma_call_tool",
  "save_note", "checkpoint", "write_file", "replace_in_file", "apply_patch", "make_dir", "move_path", "delete_path",
  "run_command", "run_commands", "proc_start", "proc_stop", "exec_start", "exec_write", "exec_signal", "exec_cancel",
  "git", "create_skill", "delete_skill", "undo_last_patch", "transaction_undo", "transaction_redo",
  "quality_gate", "run_tests", "run_build", "run_lint", "run_changed_tests",
  "task_plan", "task_state", "task_create", "task_update", "plan_create", "task_prepare_implementation", "decision_log",
  "task_create_worktree", "task_prepare_workspace", "task_apply_to_main", "task_discard_worktree", "hook_run", "hook_reload"
]);

function approvalActionForTool(tool, args) {
  if (tool === "figma_call_tool") {
    const upstreamTool = String(args?.tool || "");
    if (upstreamTool && !FIGMA_DESKTOP_READ_ONLY_TOOLS.has(upstreamTool)) {
      return `figma:${upstreamTool}:${JSON.stringify(args.arguments || {})}`;
    }
  }
  if (tool === "delete_path") return `delete_path:${String(args.path || "")}`;
  if (tool === "delete_skill") return `delete_skill:${String(args.name || "")}`;
  if (tool === "run_command" || tool === "proc_start") {
    const command = String(args.command || "");
    return policyCheck(command).needsApproval ? `${tool}:${command}` : null;
  }
  if (tool === "run_commands") {
    const risky = (Array.isArray(args.commands) ? args.commands : [])
      .filter((item) => policyCheck(String(item?.command || "")).needsApproval)
      .map((item) => ({ command: String(item.command), cwd: String(item.cwd || "."), shell: item.shell || null }));
    return risky.length ? `run_commands:${JSON.stringify(risky)}` : null;
  }
  if (tool === "git") {
    const argv = Array.isArray(args.args) ? args.args : [];
    const sub = (argv.find((a) => !String(a).startsWith("-")) || "").toLowerCase();
    return GIT_READONLY.has(sub) || argv.some((a) => /^(--version|--help)$/i.test(String(a)))
      ? null
      : `git:${JSON.stringify(argv)}`;
  }
  if (tool === "apply_patch") {
    const deletes = Array.isArray(args.operations) && args.operations.some((op) => op?.op === "delete");
    const diffDeletes = typeof args.diff === "string" && /^\+\+\+\s+\/dev\/null$/m.test(args.diff);
    if (deletes || diffDeletes) return `apply_patch:delete`;
  }
  return null;
}

async function enforceToolPolicy(tool, args) {
  if (["policy_status", "explain_risk", "request_approval", "request_approval_batch", "approve_request", "deny_request"].includes(tool)) return;
  if (AGENT_POLICY === "full") return;
  if (AGENT_POLICY === "strict" && STRICT_MUTATION_TOOLS.has(tool)) {
    throw new Error(`Tool "${tool}" is blocked by policy=strict.`);
  }
  if (AGENT_POLICY !== "balanced") return;
  const action = approvalActionForTool(tool, args);
  if (!action) return;
  const previous = approvalLock;
  let release;
  approvalLock = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    const approval = await checkApprovalExists(action);
    if (!approval) {
      throw new Error(`Approval required. Call request_approval with action=${JSON.stringify(action)}, then call approve_request with AGENT_APPROVAL_TOKEN.`);
    }
    const consumed = new Set(Array.isArray(approval.consumed_actions) ? approval.consumed_actions : []);
    consumed.add(action);
    approval.consumed_actions = [...consumed];
    const actions = approvalActions(approval);
    if (actions.every((candidate) => consumed.has(candidate))) {
      approval.status = "consumed";
      approval.consumed_at = isoNow();
    }
    await writeFile(path.join(APPROVALS_DIR, `${approval.id}.json`), JSON.stringify(approval, null, 2), "utf8");
  } finally {
    release();
  }
}

function approvalActions(record) {
  if (Array.isArray(record?.actions)) return record.actions.map(String);
  return record?.action ? [String(record.action)] : [];
}

function approvalIsExpired(record) {
  return Boolean(record?.expires_at && Date.parse(record.expires_at) <= Date.now());
}

function classifyAction(action) {
  const patterns = {
    install: /\b(npm|pip|pip3|yarn|pnpm|cargo|apt|brew|gem|composer)\s+install\b/i,
    network: /\b(curl|wget|fetch|git\s+push|git\s+fetch|git\s+pull|git\s+clone)\b/i,
    delete: /\b(delete_path|rm\s+-rf|remove-item)\b/i,
    git_mutation: /\bgit\s+(push|reset|clean|restore|checkout)\b/i,
    catastrophic: CATASTROPHIC
  };

  for (const [kind, pat] of Object.entries(patterns)) {
    if (Array.isArray(pat)) {
      if (pat.some((p) => p.test(action))) return kind;
    } else if (pat.test(action)) {
      return kind;
    }
  }
  return "general";
}

function policyCheck(action) {
  const rules = POLICY_RULES[AGENT_POLICY];
  const kind = classifyAction(action);

  if (AGENT_POLICY === "strict") {
    if (kind !== "general") {
      throw new Error(`Action blocked by policy=strict: "${kind}" operations are not allowed. Use policy_status to see what's allowed.`);
    }
  }

  if (AGENT_POLICY === "balanced") {
    const dangerous = rules.dangerous_patterns || [];
    if (dangerous.some((p) => p.test(action))) {
      // Check if there's a valid approval
      return { needsApproval: true, kind };
    }
    if (kind === "delete" || kind === "git_mutation") {
      return { needsApproval: true, kind };
    }
  }

  return { needsApproval: false, kind };
}

async function checkApprovalExists(action) {
  try {
    const files = await readdir(APPROVALS_DIR);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(await readFile(path.join(APPROVALS_DIR, f), "utf8"));
        if (rec.status !== "approved") continue;
        if (approvalIsExpired(rec)) {
          rec.status = "expired";
          rec.expired_at = isoNow();
          await writeFile(path.join(APPROVALS_DIR, f), JSON.stringify(rec, null, 2), "utf8");
          continue;
        }
        const consumed = new Set(Array.isArray(rec.consumed_actions) ? rec.consumed_actions : []);
        if (approvalActions(rec).includes(action) && !consumed.has(action)) return rec;
      } catch { /* skip */ }
    }
  } catch { /* dir may not exist */ }
  return null;
}

function registerPolicyTools(mcp) {
  reg(
    mcp,
    "sandbox_status",
    {
      title: "Execution boundary status",
      description: "Report the command execution boundary. Full runs directly; balanced/safe use native Seatbelt/bubblewrap when available.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { cwd: z.string().optional() }
    },
    async ({ cwd = "." }) => jsonResult({
      ...boundaryStatus(ACCESS_MODE, resolvePath(cwd)),
      access_mode: ACCESS_MODE,
      policy: AGENT_POLICY,
      full_bypass: ACCESS_MODE === "full"
    })
  );

  reg(
    mcp,
    "policy_status",
    {
      title: "Policy status",
      description: "Return current policy (strict|balanced|full) and what operations are allowed, need approval, or are blocked.",
      inputSchema: {}
    },
    async () => {
      const rules = POLICY_RULES[AGENT_POLICY];
      return jsonResult({
        policy: AGENT_POLICY,
        mode: MODE,
        access_mode: ACCESS_MODE,
        workflow_mode: WORKFLOW_MODE,
        execution_boundary: boundaryStatus(ACCESS_MODE, PRIMARY_ROOT),
        description: rules.description,
        allowed: AGENT_POLICY === "full" ? ["*"] : AGENT_POLICY === "balanced" ? ["read", "write", "edit", "test", "build"] : ["read", "search", "analyze"],
        needs_approval: AGENT_POLICY === "balanced" ? ["delete_path", "mutating Figma tools", "npm/pip install", "curl/wget", "git push/fetch/pull", "risky run_commands batch"] : [],
        approval_options: AGENT_POLICY === "balanced" ? ["one exact action", "2-20 exact actions in one expiring batch"] : [],
        approval_method: AGENT_POLICY === "balanced" ? "Use request_approval/request_approval_batch, then approve_request or deny_request with AGENT_APPROVAL_TOKEN." : null,
        approval_ttl_minutes: APPROVAL_TTL_MINUTES,
        blocked: AGENT_POLICY === "strict" ? ["all writes", "installs", "external network", "delete", "git mutations", "generic Figma passthrough"] : []
      });
    }
  );

  reg(
    mcp,
    "explain_risk",
    {
      title: "Explain risk",
      description: "Classify a proposed action and explain the risk level + policy decision.",
      inputSchema: {
        action: z.string().min(1).describe("The action or command you want to run.")
      }
    },
    async ({ action }) => {
      const kind = classifyAction(action);
      const riskLevels = {
        install: "HIGH — installs packages, may download malicious code or change locked dependencies",
        network: "HIGH — network operation, may expose data or fetch untrusted content",
        delete: "HIGH — permanently removes files",
        git_mutation: "MEDIUM — mutates git history or remote state",
        catastrophic: "CRITICAL — system-level destructive operation",
        general: "LOW — standard operation"
      };
      const risk = riskLevels[kind] || "LOW";

      let decision;
      if (AGENT_POLICY === "strict") {
        decision = kind === "general" ? "ALLOWED" : "BLOCKED";
      } else if (AGENT_POLICY === "balanced") {
        decision = (kind === "general") ? "ALLOWED" : "NEEDS_APPROVAL";
      } else {
        decision = kind === "catastrophic" ? "BLOCKED" : "ALLOWED";
      }

      return jsonResult({ action, kind, risk, decision, policy: AGENT_POLICY });
    }
  );

  reg(
    mcp,
    "request_approval",
    {
      title: "Request approval",
      description: "Create an expiring pending request for one exact action. Approve or deny it with approve_request/deny_request using AGENT_APPROVAL_TOKEN.",
      inputSchema: {
        action: z.string().min(1),
        reason: z.string().min(1).describe("Why this action is needed.")
      }
    },
    async ({ action, reason }) => {
      const id = randomUUID();
      const created = isoNow();
      const record = {
        id,
        action,
        actions: [action],
        consumed_actions: [],
        reason,
        status: "pending",
        created,
        expires_at: new Date(Date.now() + APPROVAL_TTL_MINUTES * 60_000).toISOString()
      };
      await mkdir(APPROVALS_DIR, { recursive: true });
      await writeFile(path.join(APPROVALS_DIR, `${id}.json`), JSON.stringify(record, null, 2), "utf8");
      return jsonResult({
        id,
        status: "pending",
        expires_at: record.expires_at,
        message: "Approval request created. Call approve_request or deny_request with AGENT_APPROVAL_TOKEN.",
        action,
        reason
      });
    }
  );

  reg(
    mcp,
    "request_approval_batch",
    {
      title: "Request exact batch approval",
      description: "Request one local decision for 2-20 exact risky actions. Each listed action can be consumed once before expiry; wildcards and implicit extra permissions are not supported.",
      inputSchema: {
        actions: z.array(z.string().min(1).max(4000)).min(2).max(20),
        reason: z.string().min(1).max(2000).describe("Why this exact action batch is needed."),
        expires_in_minutes: z.number().int().min(1).max(30).optional()
      }
    },
    async ({ actions, reason, expires_in_minutes = APPROVAL_TTL_MINUTES }) => {
      const exactActions = dedupe(actions.map((action) => action.trim()).filter(Boolean));
      if (exactActions.length < 2) throw new Error("Provide at least two distinct exact actions.");
      const id = randomUUID();
      const record = {
        id,
        action: `batch:${exactActions.length}`,
        actions: exactActions,
        consumed_actions: [],
        reason,
        status: "pending",
        created: isoNow(),
        expires_at: new Date(Date.now() + expires_in_minutes * 60_000).toISOString()
      };
      await mkdir(APPROVALS_DIR, { recursive: true });
      await writeFile(path.join(APPROVALS_DIR, `${id}.json`), JSON.stringify(record, null, 2), "utf8");
      return jsonResult({
        id,
        status: "pending",
        actions: exactActions,
        expires_at: record.expires_at,
        message: "Exact batch approval created. Call approve_request or deny_request with AGENT_APPROVAL_TOKEN."
      });
    }
  );

  reg(
    mcp,
    "approve_request",
    {
      title: "Approve request",
      description: "Approve a pending action using the local operator token configured in AGENT_APPROVAL_TOKEN.",
      inputSchema: { id: z.string().min(1), approval_token: z.string().min(1) }
    },
    async ({ id, approval_token }) => {
      if (!APPROVAL_TOKEN) throw new Error("MCP approval is disabled. Set AGENT_APPROVAL_TOKEN locally or approve out of band.");
      if (!safeEqual(approval_token, APPROVAL_TOKEN)) throw new Error("Invalid local operator approval token.");
      if (!APPROVAL_ID_RE.test(id)) throw new Error("Invalid approval id.");
      const fp = path.join(APPROVALS_DIR, `${id}.json`);
      if (!existsSync(fp)) throw new Error(`No approval request with id ${id}`);
      const rec = JSON.parse(await readFile(fp, "utf8"));
      if (rec.status !== "pending") throw new Error(`Approval is ${rec.status}; only pending requests can be approved.`);
      if (approvalIsExpired(rec)) throw new Error("Approval request is expired.");
      rec.status = "approved";
      rec.approved_at = isoNow();
      rec.approved_via = "mcp_operator_token";
      await writeFile(fp, JSON.stringify(rec, null, 2), "utf8");
      return jsonResult({ ok: true, id, action: rec.action, status: "approved" });
    }
  );

  reg(
    mcp,
    "deny_request",
    {
      title: "Deny request",
      description: "Deny a pending action using the local operator token configured in AGENT_APPROVAL_TOKEN.",
      inputSchema: { id: z.string().min(1), approval_token: z.string().min(1) }
    },
    async ({ id, approval_token }) => {
      if (!APPROVAL_TOKEN) throw new Error("MCP denial is disabled. Set AGENT_APPROVAL_TOKEN locally or deny out of band.");
      if (!safeEqual(approval_token, APPROVAL_TOKEN)) throw new Error("Invalid local operator approval token.");
      if (!APPROVAL_ID_RE.test(id)) throw new Error("Invalid approval id.");
      const fp = path.join(APPROVALS_DIR, `${id}.json`);
      if (!existsSync(fp)) throw new Error(`No approval request with id ${id}`);
      const rec = JSON.parse(await readFile(fp, "utf8"));
      if (rec.status !== "pending") throw new Error(`Approval is ${rec.status}; only pending requests can be denied.`);
      if (approvalIsExpired(rec)) throw new Error("Approval request is expired.");
      rec.status = "denied";
      rec.denied_at = isoNow();
      await writeFile(fp, JSON.stringify(rec, null, 2), "utf8");
      return jsonResult({ ok: true, id, action: rec.action, status: "denied" });
    }
  );
}

// ============================================================================
// v2.8 — Workspace Profile
// ============================================================================

async function loadWorkspaceProfile() {
  const profilePath = path.join(PRIMARY_ROOT, ".agent", "profile.json");
  try {
    const raw = await readFile(profilePath, "utf8");
    WORKSPACE_PROFILE = JSON.parse(raw);
    log(`Loaded workspace profile from ${profilePath}`);
  } catch {
    WORKSPACE_PROFILE = null;
  }
}

function registerProfileTools(mcp) {
  reg(
    mcp,
    "profile_status",
    {
      title: "Profile status",
      description: "Return the loaded workspace profile (.agent/profile.json) and explain what it configures.",
      inputSchema: {}
    },
    async () => {
      if (!WORKSPACE_PROFILE) {
        return jsonResult({
          loaded: false,
          path: path.join(PRIMARY_ROOT, ".agent", "profile.json"),
          message: "No profile.json found. Create one to configure ignored dirs, conventions, policy, and optional manual test commands.",
          schema: {
            accessMode: "full|balanced|safe (default full)",
            mode: "backward-compatible alias for accessMode",
            workflowMode: "fast|plan|auto (default auto)",
            policy: "strict|balanced|full",
            verification: { tests: "explicit", lint: "explicit", build: "explicit" },
            dashboard: { showOnCodeChange: true, autoPipOnImplement: true, autoOpenOnComplete: false },
            worktree: { mode: "when-needed|always|never" },
            commandEnv: "inherit",
            excludedCommandEnv: ["array of additional environment keys to strip"],
            extraRoots: ["array of extra root paths"],
            testCommands: { test: "command", build: "command", lint: "command" },
            ignoredDirs: ["array of dir names to skip"],
            conventions: "string describing project conventions",
            description: "short project description"
          }
        });
      }
      return jsonResult({ loaded: true, profile: WORKSPACE_PROFILE });
    }
  );

  reg(
    mcp,
    "reload_profile",
    {
      title: "Reload profile",
      description: "Reload .agent/profile.json from disk (e.g. after editing it).",
      inputSchema: {}
    },
    async () => {
      await loadWorkspaceProfile();
      return jsonResult({ ok: true, loaded: WORKSPACE_PROFILE !== null, profile: WORKSPACE_PROFILE });
    }
  );
}

// Helper for explicit manual verification tools: get test commands merging profile overrides.
async function getTestCommandsMerged(rootDir) {
  const detected = await detectTestCommands(rootDir);
  if (WORKSPACE_PROFILE && WORKSPACE_PROFILE.testCommands) {
    return { ...detected, ...WORKSPACE_PROFILE.testCommands };
  }
  return detected;
}
