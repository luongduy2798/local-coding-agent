// Local Coding Agent
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn, spawnSync } from "node:child_process";
import {
  mkdir,
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
  rename,
  rm,
  appendFile,
  access
} from "node:fs/promises";
import { createReadStream, createWriteStream, readFileSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { summarizeArgs } from "../core/redaction.mjs";
import { createChangeJournal } from "../change-journal.mjs";
import { McpSessionManager } from "../mcp/session-manager.mjs";
import { createToolRegistrar } from "../mcp/tool-runtime.mjs";
import { registerContextTools } from "../mcp/tools/context.mjs";
import {
  GIT_READONLY,
  parsePorcelainZ,
  registerExecutionTools
} from "../mcp/tools/execution.mjs";
import { registerUtilityTools } from "../mcp/tools/integration.mjs";
import {
  preparePatchTaskContext,
  registerMutationTools,
  runPatchTransactionWithJournals
} from "../mcp/tools/mutation.mjs";
import { registerPlanningTools } from "../mcp/tools/planning.mjs";
import { registerRepositoryTools } from "../mcp/tools/repository.mjs";
import { registerReviewTools } from "../mcp/tools/review.mjs";
import { registerSystemTools } from "../mcp/tools/system.mjs";
import { registerVerificationTools } from "../mcp/tools/verification.mjs";
import { registerWorkspaceTools } from "../mcp/tools/workspace.mjs";
import {
  compactWorkspaceSnapshotForBudget,
  configureContextEvidence,
  focusedWorkspaceEvidence,
  tokenizeSearch
} from "../coding/context-evidence.mjs";
import {
  attachContext,
  compareSearchMatch,
  configureSearchServices,
  createAsyncPool,
  dedupeSearchMatches,
  findFiles,
  gitGrep,
  listEntries,
  listRepoFilesFast,
  ripgrepGrep,
  searchTree
} from "../coding/search.mjs";
import {
  analyzeDiff,
  configureVerificationServices,
  detectTestCommands,
  impactedTestStrategy,
  recommendedReads,
  runGatedCommand,
  transactionInDoubt,
  verifyWorkspaceChanges
} from "../verification/service.mjs";
import {
  REVIEW_PAGE_SIZE_DEFAULT,
  REVIEW_PAGE_SIZE_MAX,
  REVIEW_SOURCES,
  aggregateReviewSummary,
  aggregateReviewVerdict,
  collectChangedSecurityCandidates,
  collectReviewInventory,
  collectTrackedReviewDiff,
  collectUntrackedReviewDiff,
  compactReviewWorkspace,
  configureReviewServices,
  decodeReviewCursor,
  encodeReviewCursor,
  reviewEvidenceDescriptor,
  reviewWorkspaceDiff
} from "../review/report.mjs";
import {
  REAL_ROOTS,
  adoptUnmanagedChange,
  canonicalize,
  captureVerificationWorkspaceState,
  configureWorkspaceContext,
  currentMcpSessionId,
  currentTask,
  freezeTaskForMutation,
  isWithinRoots,
  markUnmanagedChange,
  modelSafeToolError,
  persistTaskVerificationEvidence,
  qualifiedPath,
  qualifyGitStatus,
  readTaskVerificationEvidence,
  redactGitOutputPaths,
  resolvePath,
  resolveWorkspacePath,
  selectWorkspace,
  taskArtifactPath,
  toRel,
  toWorkspaceRel,
  unmanagedChangeState,
  verificationGateSignature
} from "../workspace/context.mjs";
import {
  collectImportantFiles,
  configureRepositoryProfile,
  detectProjectProfile,
  mutationFingerprintChanged,
  recommendNextActions,
  workspaceMutationFingerprint
} from "../workspace/repository-profile.mjs";
import {
  MANIFEST_NAMES,
  buildTree,
  configureWorkspaceTree
} from "../workspace/tree.mjs";
import {
  DEFAULT_FIGMA_DESKTOP_MCP_URL,
  buildFigmaDesktopArguments
} from "../integrations/figma-desktop.mjs";
import { registerWidgetIntegration } from "../integrations/widget.mjs";
import {
  configureSkillDiscovery,
  discoverSkills,
  isWorkspaceSkillsDir,
  sanitizeSkillName,
  skillDirs
} from "../integrations/skills.mjs";
import {
  assertCommandAllowed,
  configureExecutionServices,
  defaultShell,
  killProcessTree,
  runShellCommand,
  spawnCapture,
  spawnOutputHash,
  startBackground
} from "../execution/runner.mjs";
import {
  configureExecutionPolicy,
  enforceToolPolicy,
  loadWorkspaceProfile
} from "../execution/policy.mjs";
import {
  configureHttpHelpers,
  oauthProtectedResourceMetadata,
  originAllowed,
  readJsonBody,
  sendJson,
  setCors
} from "../http/helpers.mjs";
import {
  appendLimited,
  atomicWriteJson,
  boundedNumber,
  comparePath,
  configureSharedUtils,
  dedupe,
  finiteMetric,
  fitJsonItems,
  firstText,
  hasCommand,
  isoNow,
  jsonResult,
  resultLen,
  resultBytes,
  roundMs,
  textResult,
  trimOutputPair,
  truncateUtf8
} from "../shared/utils.mjs";
import {
  configurePagination,
  decodePageCursor,
  historyPagination,
  invalidPageCursor,
  pageMetadata,
  pageScope
} from "../shared/pagination.mjs";
import { createAuditLog } from "../shared/audit.mjs";
import { createStatusService } from "./status.mjs";
import { createRuntimeManager } from "./runtime-manager.mjs";
import { loadApplicationConfig } from "./config.mjs";
import { createTaskCloseService } from "../review/task-close.mjs";
import { createChangeRoutes } from "../http/change-routes.mjs";
import { createApplicationHttpServer } from "../http/server.mjs";
import { createMcpHttpTransport } from "../mcp/http-transport.mjs";
import { createMcpCatalogFactory } from "../mcp/catalog.mjs";
import {
  CATALOG_HASH,
  CATALOG_VERSION,
  MODEL_TOOL_NAMES,
  STORAGE_REQUIRED_TOOLS,
  TASK_ACTIVITY_TOOLS,
  TASK_CONTEXT_TOOLS
} from "../mcp/contract.mjs";

// ----------------------------------------------------------------------------
// Configuration (all overridable via environment variables)
// ----------------------------------------------------------------------------
const {
  AGENT_POLICY,
  AGENT_STATE_DIR,
  ALLOWED_ORIGINS,
  ALLOW_DANGEROUS,
  APPROVALS_DIR,
  APPROVAL_TTL_MINUTES,
  AUDIT_ARGS,
  AUDIT_ENABLED,
  AUDIT_PATH,
  AUDIT_ROTATE_BYTES,
  AUDIT_ROTATE_FILES,
  AUTH_TOKEN,
  CATASTROPHIC,
  CHECKPOINT_PATH,
  CMD_OUTPUT_DEFAULT,
  COMPANION_WIDGET_PATH,
  CONTROL_CENTER_UI_DIR,
  CONFIG_ID,
  DATA_DIR,
  DEFAULT_CMD_TIMEOUT,
  DEFAULT_RESPONSE_CHARS,
  FIGMA_DESKTOP_MCP_URL,
  FIGMA_DESKTOP_READ_ONLY_TOOLS,
  FIGMA_DESKTOP_TIMEOUT_MS,
  HOST,
  HOT_WORKSPACE_LIMIT,
  HTTP_LOG,
  INSTANCE_NONCE,
  MAX_BATCH_READ_CHARS,
  MAX_BODY_BYTES,
  MAX_COMMAND_OUTPUT,
  MAX_PAGE_OFFSET,
  MAX_PROCS,
  MAX_READ_CHARS,
  MAX_SEARCH_PROCESSES,
  MAX_SERIALIZED_RESPONSE_CHARS,
  MCP_MAX_SESSIONS,
  MCP_SESSION_IDLE_TTL_MS,
  MODE,
  NON_GIT_MUTATION_MAX_FILES,
  NON_GIT_MUTATION_MAX_FILE_BYTES,
  NON_GIT_MUTATION_MAX_TOTAL_BYTES,
  NON_GIT_MUTATION_TIMEOUT_MS,
  PAGE_CURSOR_SECRET,
  PORT,
  PRIMARY_ROOT,
  PROC_BUFFER,
  PRODUCT_TIER,
  READ_DEFAULT,
  READ_MANY_FILE_DEFAULT,
  REPOSITORY_DIR,
  ROOTS,
  RUNTIME_DATA_DIR,
  RUN_COMMANDS_OUTPUT_DEFAULT,
  SAFE_MODE_BLOCKS,
  SEARCH_OUTPUT_DEFAULT,
  SKILLS_DIRS,
  SKIP_DIRS,
  STARTUP_PROFILE,
  TASK_PLAN_PATH,
  TEST_RUNTIME_DIAGNOSTICS,
  VERSION,
  WORKSPACE_DATA_DIR,
  WORKSPACE_ID,
  WORKSPACE_IDLE_UNLOAD_MS
} = await loadApplicationConfig();

configureHttpHelpers({ allowedOrigins: ALLOWED_ORIGINS, host: HOST, port: PORT });
configureSkillDiscovery({
  roots: ROOTS,
  skillDirectories: SKILLS_DIRS,
  repositoryDir: REPOSITORY_DIR,
  comparePaths: comparePath,
  dedupeValues: dedupe
});
configureContextEvidence({ defaultResponseChars: DEFAULT_RESPONSE_CHARS });
configurePagination({ pageCursorSecret: PAGE_CURSOR_SECRET, maxPageOffset: MAX_PAGE_OFFSET });

const AUDIT_LOG = createAuditLog({
  auditPath: AUDIT_PATH,
  enabled: AUDIT_ENABLED,
  rotateBytes: AUDIT_ROTATE_BYTES,
  rotateFiles: AUDIT_ROTATE_FILES,
  now: isoNow
});
const { audit, log } = AUDIT_LOG;
const RUNTIME_ID = randomUUID();
let WORKSPACE_PROFILE = STARTUP_PROFILE;

function auditIdentifier(value) {
  if (!value) return null;
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

// State
// ----------------------------------------------------------------------------
const processes = new Map(); // id -> { id, name, command, child, status, exitCode, startedAt, stdout, stderr }
configureExecutionServices({
  ALLOW_DANGEROUS,
  CATASTROPHIC,
  MAX_COMMAND_OUTPUT,
  MODE,
  PRIMARY_ROOT,
  PROC_BUFFER,
  SAFE_MODE_BLOCKS,
  appendLimited,
  hasCommand,
  isoNow,
  processes
});
const UNMANAGED_WORKSPACE_CHANGES = new Set();
const UNMANAGED_MANIFEST_LOCKS = new Map();
configureExecutionPolicy({
  AGENT_POLICY,
  APPROVALS_DIR,
  APPROVAL_TTL_MINUTES,
  CATASTROPHIC,
  FIGMA_DESKTOP_READ_ONLY_TOOLS,
  GIT_READONLY,
  PRIMARY_ROOT,
  atomicWriteJson,
  auditIdentifier,
  currentMcpSessionId,
  currentTask: currentTask,
  dedupe,
  detectTestCommands,
  getWorkspaceProfile: () => WORKSPACE_PROFILE,
  isoNow,
  log,
  setWorkspaceProfile: (profile) => { WORKSPACE_PROFILE = profile; }
});
const MCP_REQUEST_CONTEXT = new AsyncLocalStorage();
configureSharedUtils({ requestContext: MCP_REQUEST_CONTEXT });
const TOOL_RUNTIME_METRICS = {
  scope: "process",
  startedAt: isoNow(),
  calls: 0,
  outputChars: 0,
  outputBytes: 0,
  largestOutputChars: 0,
  largestOutputBytes: 0,
  largestOutputTool: null,
  errors: 0
};
const EVENT_LOOP_DELAY = monitorEventLoopDelay({ resolution: 20 });
EVENT_LOOP_DELAY.enable();
const SEARCH_PROCESS_POOL = createAsyncPool(MAX_SEARCH_PROCESSES);
const RUNTIME_MANAGER = createRuntimeManager({
  canonicalize,
  initialPrimaryWorkspaceId: `ws_${WORKSPACE_ID}`,
  isWithinRoots,
  primaryRoot: PRIMARY_ROOT,
  runtimeDataDir: RUNTIME_DATA_DIR,
  hotWorkspaceLimit: HOT_WORKSPACE_LIMIT,
  idleUnloadMs: WORKSPACE_IDLE_UNLOAD_MS,
  testRuntimeDiagnostics: TEST_RUNTIME_DIAGNOSTICS,
  toWorkspaceRel
});
const WORKSPACE_RUNTIMES = RUNTIME_MANAGER.runtimes;
const WORKSPACE_RUNTIME_INITS = RUNTIME_MANAGER.runtimeInits;
const WORKSPACE_RUNTIME_EVICTIONS = RUNTIME_MANAGER.runtimeEvictions;
const CHANGE_JOURNALS = RUNTIME_MANAGER.journals;
const {
  captureTaskWorkspaceBaseline,
  closeWorkspaceRuntimes: closeWorkspaceRuntimes,
  evictWorkspaceRuntime: evictWorkspaceRuntime,
  getChangeJournal: getChangeJournal,
  getWorkspaceRuntime: getWorkspaceRuntime,
  modelSafeGraphSnapshot,
  modelSafePersistenceStatus,
  modelSafeSemanticAdapterStatus,
  modelSafeWatcherStatus,
  onDidChange: onRuntimeChange,
  sanitizeGraphSnapshot,
  taskOpenPayload,
  taskWorkspaceBaseline
} = RUNTIME_MANAGER;

const CHANGE_JOURNAL = createChangeJournal({
  root: PRIMARY_ROOT,
  workspaceId: WORKSPACE_ID,
  dataDir: path.join(WORKSPACE_DATA_DIR, "changes"),
  validatePath: resolvePath,
  toRelativePath: toRel,
  maxSnapshotBytes: boundedNumber(process.env.AGENT_MAX_SNAPSHOT_BYTES, 5 * 1024 * 1024, 1, 100 * 1024 * 1024),
  snapshotConcurrency: boundedNumber(process.env.AGENT_JOURNAL_SNAPSHOT_CONCURRENCY, 4, 1, 16),
  deferLineStats: process.env.AGENT_DEFER_LINE_STATS !== "0",
  deferLineStatsBytes: boundedNumber(process.env.AGENT_DEFER_LINE_STATS_BYTES, 512_000, 32_000, 100 * 1024 * 1024)
});

// ----------------------------------------------------------------------------
// Bootstrap
// ----------------------------------------------------------------------------
await mkdir(DATA_DIR, { recursive: true });
await mkdir(WORKSPACE_DATA_DIR, { recursive: true });
await mkdir(PRIMARY_ROOT, { recursive: true });
await mkdir(APPROVALS_DIR, { recursive: true });
await mkdir(AGENT_STATE_DIR, { recursive: true });
await CHANGE_JOURNAL.init();
await RUNTIME_MANAGER.initialize();
const WORKSPACE_REGISTRY = RUNTIME_MANAGER.registry;
const TASK_ROUTER = RUNTIME_MANAGER.taskRouter;
const PATCH_COORDINATOR = RUNTIME_MANAGER.patchCoordinator;
const PRIMARY_WORKSPACE_ID = RUNTIME_MANAGER.primaryWorkspaceId;
const STORAGE_ERROR = RUNTIME_MANAGER.storageError;
await AUDIT_LOG.init();
audit({
  ts: isoNow(),
  kind: "runtime",
  phase: "started",
  runtime_id: RUNTIME_ID,
  pid: process.pid,
  version: VERSION,
  started_at: isoNow()
});






// v2.8 Load workspace profile on startup
await loadWorkspaceProfile();

// Detect ripgrep once at startup — the fastest search engine when present.
const RG_BIN = await detectRg();
if (RG_BIN) console.log("ripgrep detected: search_text/find_files will use rg");
configureWorkspaceContext({
  DATA_DIR,
  MCP_REQUEST_CONTEXT,
  PRIMARY_ROOT,
  REPOSITORY_DIR,
  ROOTS,
  RUNTIME_DATA_DIR,
  TEST_RUNTIME_DIAGNOSTICS,
  UNMANAGED_MANIFEST_LOCKS,
  UNMANAGED_WORKSPACE_CHANGES,
  atomicWriteJson,
  comparePath,
  dedupe,
  getWorkspaceRuntime: getWorkspaceRuntime,
  isoNow,
  primaryWorkspaceId: PRIMARY_WORKSPACE_ID,
  registry: WORKSPACE_REGISTRY,
  storageError: STORAGE_ERROR,
  taskRouter: TASK_ROUTER,
  workspaceMutationFingerprint
});
configureSearchServices({
  PRIMARY_ROOT,
  RG_BIN,
  SEARCH_PROCESS_POOL,
  SKIP_DIRS,
  toRel
});
configureWorkspaceTree({ skipDirectories: SKIP_DIRS, listFilesFast: listRepoFilesFast });
configureRepositoryProfile({
  DEFAULT_CMD_TIMEOUT,
  NON_GIT_MUTATION_MAX_FILES,
  NON_GIT_MUTATION_MAX_FILE_BYTES,
  NON_GIT_MUTATION_MAX_TOTAL_BYTES,
  NON_GIT_MUTATION_TIMEOUT_MS,
  SKIP_DIRS,
  isWithinRoots,
  parsePorcelainZ,
  spawnCapture,
  spawnOutputHash,
  toRel
});
configureReviewServices({
  DEFAULT_CMD_TIMEOUT,
  MAX_COMMAND_OUTPUT,
  analyzeDiff,
  canonicalize,
  dedupe,
  isWithinRoots,
  resolveWorkspacePath: resolveWorkspacePath,
  spawnCapture,
  toWorkspaceRel,
  transactionInDoubt,
  unmanagedChangeState
});
configureVerificationServices({
  PRIMARY_ROOT,
  RG_BIN,
  SEARCH_OUTPUT_DEFAULT,
  adoptUnmanagedChange,
  assertCommandAllowed,
  attachContext,
  collectReviewInventory,
  collectTrackedReviewDiff,
  collectUntrackedReviewDiff,
  dedupe,
  fitJsonItems,
  freezeTaskForMutation: freezeTaskForMutation,
  gitGrep,
  markUnmanagedChange,
  mutationFingerprintChanged,
  patchCoordinator: PATCH_COORDINATOR,
  persistTaskVerificationEvidence,
  resolveWorkspacePath: resolveWorkspacePath,
  reviewEvidenceDescriptor,
  ripgrepGrep,
  runShellCommand,
  searchTree,
  taskWorkspaceBaseline,
  tokenizeSearch,
  unmanagedChangeState,
  workspaceMutationFingerprint
});
const TASK_CLOSE_SERVICE = createTaskCloseService({
  atomicWriteJson,
  captureVerificationWorkspaceState,
  dedupe,
  getChangeJournal: getChangeJournal,
  getPrimaryWorkspaceId: () => PRIMARY_WORKSPACE_ID,
  getWorkspaceRuntime: getWorkspaceRuntime,
  isoNow,
  processes,
  readTaskVerificationEvidence,
  runtimeDataDir: RUNTIME_DATA_DIR,
  taskArtifactPath,
  taskWorkspaceBaseline,
  transactionInDoubt,
  unmanagedChangeState,
  verificationGateSignature
});
const {
  applyTaskCloseTestDelay,
  injectTaskCloseJournalCorruptionForTest,
  preflightTaskClose,
  prepareTaskJournals,
  recoverTaskCloseIntent,
  rollbackCompletedTaskJournals,
  taskCloseIntentPath,
  taskRunningProcesses
} = TASK_CLOSE_SERVICE;
const reg = createToolRegistrar({
  audit,
  auditEnabled: AUDIT_ENABLED,
  currentTask: currentTask,
  defaultResponseBytes: DEFAULT_RESPONSE_CHARS,
  enforcePolicy: enforceToolPolicy,
  firstText,
  getStorageError: () => STORAGE_ERROR,
  isoNow,
  maxResponseBytes: MAX_SERIALIZED_RESPONSE_CHARS,
  modelSafeError: modelSafeToolError,
  recoverTaskCloseIntent,
  requestContext: MCP_REQUEST_CONTEXT,
  resultBytes,
  resultLen,
  roundMs,
  runtimeId: RUNTIME_ID,
  storageRequiredTools: STORAGE_REQUIRED_TOOLS,
  taskActivityTools: TASK_ACTIVITY_TOOLS,
  taskContextTools: TASK_CONTEXT_TOOLS,
  taskRouter: TASK_ROUTER,
  testRuntimeDiagnostics: TEST_RUNTIME_DIAGNOSTICS,
  toolMetrics: TOOL_RUNTIME_METRICS,
  truncateUtf8
});

const createMcpServer = createMcpCatalogFactory({
  agentPolicy: AGENT_POLICY,
  allowedOrigins: ALLOWED_ORIGINS,
  atomicWriteJson,
  authToken: AUTH_TOKEN,
  captureTaskWorkspaceBaseline,
  catalogVersion: CATALOG_VERSION,
  changeJournal: CHANGE_JOURNAL,
  checkpointPath: CHECKPOINT_PATH,
  commandOutputDefault: CMD_OUTPUT_DEFAULT,
  comparePath,
  defaultCommandTimeout: DEFAULT_CMD_TIMEOUT,
  defaultResponseChars: DEFAULT_RESPONSE_CHARS,
  evictWorkspaceRuntime: evictWorkspaceRuntime,
  figmaDesktopTimeoutMs: FIGMA_DESKTOP_TIMEOUT_MS,
  figmaDesktopUrl: FIGMA_DESKTOP_MCP_URL,
  getChangeJournal: getChangeJournal,
  getWorkspaceRuntime: getWorkspaceRuntime,
  invalidateStatusControlCache: (...args) => STATUS_SERVICE.invalidateStatusControlCache(...args),
  maxBatchReadChars: MAX_BATCH_READ_CHARS,
  maxCommandOutput: MAX_COMMAND_OUTPUT,
  maxPageOffset: MAX_PAGE_OFFSET,
  maxProcesses: MAX_PROCS,
  maxReadChars: MAX_READ_CHARS,
  mode: MODE,
  modelSafeGraphSnapshot,
  modelSafeSemanticAdapterStatus,
  modelSafeWatcherStatus,
  patchCoordinator: PATCH_COORDINATOR,
  policy: AGENT_POLICY,
  primaryRoot: PRIMARY_ROOT,
  primaryWorkspaceId: PRIMARY_WORKSPACE_ID,
  processBuffer: PROC_BUFFER,
  processes,
  productTier: PRODUCT_TIER,
  readDefault: READ_DEFAULT,
  readManyFileDefault: READ_MANY_FILE_DEFAULT,
  reg,
  registry: WORKSPACE_REGISTRY,
  rgBin: RG_BIN,
  roots: ROOTS,
  runCommandsOutputDefault: RUN_COMMANDS_OUTPUT_DEFAULT,
  sanitizeGraphSnapshot,
  searchOutputDefault: SEARCH_OUTPUT_DEFAULT,
  skipDirs: SKIP_DIRS,
  storageError: STORAGE_ERROR,
  taskCloseService: TASK_CLOSE_SERVICE,
  taskOpenPayload,
  taskPlanPath: TASK_PLAN_PATH,
  taskRouter: TASK_ROUTER,
  taskWorkspaceBaseline,
  testRuntimeDiagnostics: TEST_RUNTIME_DIAGNOSTICS,
  version: VERSION,
  widgetPath: COMPANION_WIDGET_PATH,
  workspaceInfoPayload: (...args) => STATUS_SERVICE.workspaceInfoPayload(...args)
});

const MCP_SESSION_MANAGER = new McpSessionManager({
  createServer: createMcpServer,
  maxSessions: MCP_MAX_SESSIONS,
  idleTtlMs: MCP_SESSION_IDLE_TTL_MS,
  allowStatelessFallback: true,
  onSessionOpened: ({ id: sessionId, ...session }) => audit({
    ts: isoNow(),
    kind: "mcp_session",
    action: "open",
    ...session,
    sessionIdHash: auditIdentifier(sessionId)
  }),
  onSessionClosed: async ({ id: sessionId, ...session }) => {
    audit({
      ts: isoNow(),
      kind: "mcp_session",
      action: "close",
      ...session,
      sessionIdHash: auditIdentifier(sessionId)
    });
    await TASK_ROUTER?.unbindSession(sessionId).catch(() => {});
  }
});

const STATUS_SERVICE = createStatusService({
  auditStatus: () => AUDIT_LOG.status(),
  eventLoopDelay: EVENT_LOOP_DELAY,
  finiteMetric,
  getSessionSummary: () => MCP_SESSION_MANAGER.summary(),
  getState: () => ({
    registry: WORKSPACE_REGISTRY,
    taskRouter: TASK_ROUTER,
    patchCoordinator: PATCH_COORDINATOR,
    primaryWorkspaceId: PRIMARY_WORKSPACE_ID,
    storageError: STORAGE_ERROR,
    runtimes: WORKSPACE_RUNTIMES,
    runtimeInits: WORKSPACE_RUNTIME_INITS,
    runtimeEvictions: WORKSPACE_RUNTIME_EVICTIONS
  }),
  modelSafePersistenceStatus,
  modelSafeWatcherStatus,
  processes,
  searchProcessPool: SEARCH_PROCESS_POOL,
  settings: {
    allowDangerous: ALLOW_DANGEROUS,
    authToken: AUTH_TOKEN,
    catalogHash: CATALOG_HASH,
    catalogVersion: CATALOG_VERSION,
    mode: MODE,
    policy: AGENT_POLICY,
    primaryRoot: PRIMARY_ROOT,
    productTier: PRODUCT_TIER,
    roots: ROOTS,
    testRuntimeDiagnostics: TEST_RUNTIME_DIAGNOSTICS,
    version: VERSION,
    limits: {
      max_read_chars: MAX_READ_CHARS,
      read_default_chars: READ_DEFAULT,
      read_many_file_default_chars: READ_MANY_FILE_DEFAULT,
      max_batch_read_chars: MAX_BATCH_READ_CHARS,
      command_output_default_chars: CMD_OUTPUT_DEFAULT,
      max_command_output: MAX_COMMAND_OUTPUT,
      search_output_default_chars: SEARCH_OUTPUT_DEFAULT,
      response_default_chars: DEFAULT_RESPONSE_CHARS,
      response_hard_max_chars: MAX_SERIALIZED_RESPONSE_CHARS,
      response_default_bytes: DEFAULT_RESPONSE_CHARS,
      response_hard_max_bytes: MAX_SERIALIZED_RESPONSE_CHARS,
      max_procs: MAX_PROCS
    }
  },
  toolMetrics: TOOL_RUNTIME_METRICS
});
const {
  invalidateStatusControlCache: invalidateStatusControlCache,
  workspaceInfoPayload
} = STATUS_SERVICE;

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

const CHANGE_ROUTES = createChangeRoutes({
  getChangeJournal: getChangeJournal,
  subscribeToChangeEvents: onRuntimeChange,
  getPrimaryWorkspaceId: () => PRIMARY_WORKSPACE_ID,
  getRegistry: () => WORKSPACE_REGISTRY,
  getTaskRouter: () => TASK_ROUTER,
  getProcesses: () => processes,
  maxBodyBytes: MAX_BODY_BYTES,
  primaryRoot: PRIMARY_ROOT,
  readJsonBody,
  sendJson,
  testRuntimeDiagnostics: TEST_RUNTIME_DIAGNOSTICS
});
const MCP_HTTP_TRANSPORT = createMcpHttpTransport({
  audit,
  auditIdentifier,
  catalogHash: CATALOG_HASH,
  catalogVersion: CATALOG_VERSION,
  isoNow,
  maxBodyBytes: MAX_BODY_BYTES,
  readJsonBody,
  requestContext: MCP_REQUEST_CONTEXT,
  roundMs,
  sendJson,
  sessionManager: MCP_SESSION_MANAGER
});
const HTTP_APPLICATION = createApplicationHttpServer({
  allowDangerous: ALLOW_DANGEROUS,
  auditPath: AUDIT_PATH,
  authToken: AUTH_TOKEN,
  catalogHash: CATALOG_HASH,
  catalogVersion: CATALOG_VERSION,
  changeRoutes: CHANGE_ROUTES,
  configId: CONFIG_ID,
  controlCenterUiDir: CONTROL_CENTER_UI_DIR,
  getPrimaryWorkspaceId: () => PRIMARY_WORKSPACE_ID,
  getRegistry: () => WORKSPACE_REGISTRY,
  getTaskRouter: () => TASK_ROUTER,
  host: HOST,
  httpLog: HTTP_LOG,
  instanceNonce: INSTANCE_NONCE,
  log,
  mcpTransport: MCP_HTTP_TRANSPORT,
  mode: MODE,
  oauthProtectedResourceMetadata,
  originAllowed,
  policy: AGENT_POLICY,
  port: PORT,
  primaryRoot: PRIMARY_ROOT,
  readJsonBody,
  productTier: PRODUCT_TIER,
  runtimeId: RUNTIME_ID,
  auditStatus: () => AUDIT_LOG.status(),
  processes,
  roots: ROOTS,
  sendJson,
  sessionManager: MCP_SESSION_MANAGER,
  setCors,
  testRuntimeDiagnostics: TEST_RUNTIME_DIAGNOSTICS,
  version: VERSION
});
const httpServer = HTTP_APPLICATION.listen({
  onReady: () => setImmediate(() => {
    getWorkspaceRuntime(PRIMARY_WORKSPACE_ID).catch(() => {});
  })
});

// Never let a single bad request take the whole server down.
process.on("uncaughtException", (err) => log(`uncaughtException: ${err?.stack || err}`));
process.on("unhandledRejection", (err) => log(`unhandledRejection: ${err?.stack || err}`));
let shutdownStarted = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    log(`${sig} received, shutting down`);
    void (async () => {
      audit({
        ts: isoNow(),
        kind: "runtime",
        phase: "stopped",
        runtime_id: RUNTIME_ID,
        pid: process.pid,
        stopped_at: isoNow()
      });
      for (const proc of processes.values()) killProcessTree(proc);
      await MCP_SESSION_MANAGER.close().catch(() => {});
      await closeWorkspaceRuntimes().catch(() => {});
      await TASK_ROUTER?.close().catch(() => {});
      await WORKSPACE_REGISTRY?.close().catch(() => {});
      await AUDIT_LOG.close().catch(() => {});
      EVENT_LOOP_DELAY.disable();
      await new Promise((resolve) => httpServer.close(resolve));
      process.exit(0);
    })();
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}

// ----------------------------------------------------------------------------
// Auth + transport
// ----------------------------------------------------------------------------
// First workspace skills dir for authoring: <PRIMARY_ROOT>/.claude/skills.

// Skill folder names: keep them simple path segments (no separators / traversal).

// A path is "inside a skills directory" if any segment of its parent chain is a
// known skills dir (from SKILLS_DIRS) or matches the .claude/skills | .agent/skills
// convention under a root. Used to confine create/delete to skills areas.


// ----------------------------------------------------------------------------
// Companion UI tools: @ context picker and / workflow command palette
// ----------------------------------------------------------------------------





// ----------------------------------------------------------------------------
// Tool registration helper: audit + uniform error handling
// ----------------------------------------------------------------------------



// ----------------------------------------------------------------------------
// Filesystem read tools
// ----------------------------------------------------------------------------




// ----------------------------------------------------------------------------
// Filesystem write tools
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Command execution
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Path safety
// ----------------------------------------------------------------------------
// Canonical (symlink/junction-resolved) form of the roots, computed once.

// Resolve the longest existing ancestor with realpath, then re-append the
// not-yet-existing tail. This canonicalizes symlinks/junctions even for files
// that don't exist yet (e.g. apply_patch create targets).

// ----------------------------------------------------------------------------
// Listing / search
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Command policy + execution
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Notes
// ----------------------------------------------------------------------------


// ----------------------------------------------------------------------------
// Skills (Claude-style on-demand playbooks)
// ----------------------------------------------------------------------------






// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------


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





// Trim command output for display: prefer line slicing (head/tail), else cap chars.





// Compact JSON keeps payloads (and the tokens ChatGPT must read) small, which
// is the main lever for perceived speed over the tunnel.





















// ============================================================================
// v2.1 — Repo Intelligence
// ============================================================================



// ============================================================================
// v2.4 — Review Mode
// ============================================================================



// ============================================================================
// v2.5 — Planner / Thread Memory
// ============================================================================


// ============================================================================
// v2.6 — Approval / Policy Layer
// ============================================================================
