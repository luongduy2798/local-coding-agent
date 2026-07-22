// Local Coding Agent fixed 35-tool MCP catalog.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compactWorkspaceSnapshotForBudget, focusedWorkspaceEvidence } from "../coding/context-evidence.mjs";
import {
  attachContext,
  compareSearchMatch,
  dedupeSearchMatches,
  findFiles,
  gitGrep,
  listEntries,
  listRepoFilesFast,
  ripgrepGrep,
  searchTree
} from "../coding/search.mjs";
import { assertCommandAllowed, defaultShell, killProcessTree, runShellCommand, spawnCapture, startBackground } from "../execution/runner.mjs";
import { getTestCommandsMerged } from "../execution/policy.mjs";
import { buildFigmaDesktopArguments } from "../integrations/figma-desktop.mjs";
import { discoverSkills, isWorkspaceSkillsDir, sanitizeSkillName, skillDirs } from "../integrations/skills.mjs";
import { registerWidgetIntegration } from "../integrations/widget.mjs";
import { preparePatchTaskContext, runPatchTransactionWithJournals } from "./tools/mutation.mjs";
import { GIT_READONLY, registerExecutionTools } from "./tools/execution.mjs";
import { registerContextTools } from "./tools/context.mjs";
import { registerUtilityTools } from "./tools/integration.mjs";
import { registerMutationTools } from "./tools/mutation.mjs";
import { registerPlanningTools } from "./tools/planning.mjs";
import { registerRepositoryTools } from "./tools/repository.mjs";
import { registerReviewTools } from "./tools/review.mjs";
import { registerSystemTools } from "./tools/system.mjs";
import { registerVerificationTools } from "./tools/verification.mjs";
import { registerWorkspaceTools } from "./tools/workspace.mjs";
import {
  REVIEW_PAGE_SIZE_DEFAULT,
  REVIEW_PAGE_SIZE_MAX,
  REVIEW_SOURCES,
  aggregateReviewSummary,
  aggregateReviewVerdict,
  collectChangedSecurityCandidates,
  compactReviewWorkspace,
  decodeReviewCursor,
  encodeReviewCursor,
  reviewWorkspaceDiff
} from "../review/report.mjs";
import {
  boundedNumber,
  dedupe,
  fitJsonItems,
  isoNow,
  jsonResult,
  textResult,
  trimOutputPair
} from "../shared/utils.mjs";
import {
  decodePageCursor,
  historyPagination,
  invalidPageCursor,
  pageMetadata,
  pageScope
} from "../shared/pagination.mjs";
import {
  impactedTestStrategy,
  recommendedReads,
  runGatedCommand,
  transactionInDoubt,
  verifyWorkspaceChanges
} from "../verification/service.mjs";
import {
  REAL_ROOTS,
  captureVerificationWorkspaceState,
  currentMcpSessionId,
  currentTask,
  freezeTaskForMutation,
  isWithinRoots,
  markUnmanagedChange,
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
  compactGitStatus,
  detectProjectProfile,
  mutationFingerprintChanged,
  recommendNextActions,
  workspaceMutationFingerprint
} from "../workspace/repository-profile.mjs";
import { MANIFEST_NAMES, buildTree, buildTreeFast } from "../workspace/tree.mjs";

export function createMcpCatalogFactory(config) {
  return function createMcpServer() {
    const mcp = new McpServer(
      { name: "Local Coding Agent", version: config.version },
      { instructions: serverInstructions(config.policy) }
    );
    registerWidgetIntegration(mcp, {
      widgetPath: config.widgetPath,
      reg: config.reg,
      currentTask,
      selectWorkspace
    });
    registerContextTools(mcp, {
      DEFAULT_RESPONSE_CHARS: config.defaultResponseChars,
      MANIFEST_NAMES,
      MAX_BATCH_READ_CHARS: config.maxBatchReadChars,
      MAX_PAGE_OFFSET: config.maxPageOffset,
      MAX_READ_CHARS: config.maxReadChars,
      READ_DEFAULT: config.readDefault,
      READ_MANY_FILE_DEFAULT: config.readManyFileDefault,
      RG_BIN: config.rgBin,
      SEARCH_OUTPUT_DEFAULT: config.searchOutputDefault,
      SKIP_DIRS: config.skipDirs,
      attachContext,
      buildTree,
      compareSearchMatch,
      decodePageCursor,
      dedupe,
      dedupeSearchMatches,
      findFiles,
      fitJsonItems,
      getChangeJournal: config.getChangeJournal,
      gitGrep,
      jsonResult,
      listEntries,
      listRepoFilesFast,
      pageMetadata,
      pageScope,
      reg: config.reg,
      resolvePath,
      resolveWorkspacePath,
      ripgrepGrep,
      searchTree,
      toRel,
      toWorkspaceRel
    });
    registerMutationTools(mcp, {
      PRIMARY_ROOT: config.primaryRoot,
      ROOTS: config.roots,
      TEST_RUNTIME_DIAGNOSTICS: config.testRuntimeDiagnostics,
      comparePath: config.comparePath,
      currentMcpSessionId,
      currentTask,
      dedupe,
      getChangeJournal: config.getChangeJournal,
      getWorkspaceRuntime: config.getWorkspaceRuntime,
      jsonResult,
      markUnmanagedChange,
      patchCoordinator: config.patchCoordinator,
      primaryWorkspaceId: config.primaryWorkspaceId,
      reg: config.reg,
      resolvePath,
      resolveWorkspacePath,
      selectWorkspace,
      storageError: config.storageError,
      taskRouter: config.taskRouter,
      toRel,
      toWorkspaceRel
    });
    registerExecutionTools(mcp, {
      CMD_OUTPUT_DEFAULT: config.commandOutputDefault,
      DEFAULT_CMD_TIMEOUT: config.defaultCommandTimeout,
      MAX_COMMAND_OUTPUT: config.maxCommandOutput,
      MAX_PROCS: config.maxProcesses,
      MODE: config.mode,
      PROC_BUFFER: config.processBuffer,
      RUN_COMMANDS_OUTPUT_DEFAULT: config.runCommandsOutputDefault,
      assertCommandAllowed,
      defaultShell,
      freezeTaskForMutation,
      getChangeJournal: config.getChangeJournal,
      jsonResult,
      killProcessTree,
      markUnmanagedChange,
      mutationFingerprintChanged,
      processes: config.processes,
      qualifiedPath,
      redactGitOutputPaths,
      reg: config.reg,
      resolvePath,
      resolveWorkspacePath,
      runShellCommand,
      spawnCapture,
      startBackground,
      toRel,
      toWorkspaceRel,
      trimOutputPair,
      workspaceMutationFingerprint
    });
    registerWorkspaceTools(mcp, {
      DEFAULT_RESPONSE_CHARS: config.defaultResponseChars,
      REAL_ROOTS,
      boundedNumber,
      captureTaskWorkspaceBaseline: config.captureTaskWorkspaceBaseline,
      comparePath: config.comparePath,
      currentMcpSessionId,
      decodePageCursor,
      dedupe,
      evictWorkspaceRuntime: config.evictWorkspaceRuntime,
      fitJsonItems,
      invalidPageCursor,
      invalidateStatusControlCache: config.invalidateStatusControlCache,
      isWithinRoots,
      jsonResult,
      modelSafeGraphSnapshot: config.modelSafeGraphSnapshot,
      modelSafeSemanticAdapterStatus: config.modelSafeSemanticAdapterStatus,
      modelSafeWatcherStatus: config.modelSafeWatcherStatus,
      pageMetadata,
      pageScope,
      primaryWorkspaceId: config.primaryWorkspaceId,
      reg: config.reg,
      registry: config.registry,
      sanitizeGraphSnapshot: config.sanitizeGraphSnapshot,
      selectWorkspace,
      storageError: config.storageError,
      taskOpenPayload: config.taskOpenPayload,
      taskRouter: config.taskRouter
    });
    registerRepositoryTools(mcp, {
      AGENT_POLICY: config.policy,
      ALLOWED_ORIGINS: config.allowedOrigins,
      AUTH_TOKEN: config.authToken,
      CATALOG_VERSION: config.catalogVersion,
      MODE: config.mode,
      PRODUCT_TIER: config.productTier,
      RG_BIN: config.rgBin,
      SEARCH_OUTPUT_DEFAULT: config.searchOutputDefault,
      VERSION: config.version,
      buildTreeFast,
      collectImportantFiles,
      compactGitStatus,
      compactWorkspaceSnapshotForBudget,
      detectProjectProfile,
      focusedWorkspaceEvidence,
      isoNow,
      jsonResult,
      modelSafeGraphSnapshot: config.modelSafeGraphSnapshot,
      qualifyGitStatus,
      recommendNextActions,
      recommendedReads,
      reg: config.reg,
      resolveWorkspacePath,
      sanitizeGraphSnapshot: config.sanitizeGraphSnapshot,
      toWorkspaceRel
    });
    registerVerificationTools(mcp, {
      assertCommandAllowed,
      currentTask,
      dedupe,
      freezeTaskForMutation,
      getTestCommandsMerged,
      impactedTestStrategy,
      jsonResult,
      markUnmanagedChange,
      mutationFingerprintChanged,
      persistTaskVerificationEvidence,
      reg: config.reg,
      resolveWorkspacePath,
      runGatedCommand,
      taskWorkspaceBaseline: config.taskWorkspaceBaseline,
      transactionInDoubt,
      unmanagedChangeState,
      verifyWorkspaceChanges,
      workspaceMutationFingerprint
    });
    registerReviewTools(mcp, {
      REVIEW_PAGE_SIZE_DEFAULT,
      REVIEW_PAGE_SIZE_MAX,
      REVIEW_SOURCES,
      RG_BIN: config.rgBin,
      TEST_RUNTIME_DIAGNOSTICS: config.testRuntimeDiagnostics,
      aggregateReviewSummary,
      aggregateReviewVerdict,
      buildTree,
      collectChangedSecurityCandidates,
      compactReviewWorkspace,
      currentTask,
      decodeReviewCursor,
      dedupe,
      encodeReviewCursor,
      jsonResult,
      reg: config.reg,
      resolveWorkspacePath,
      reviewWorkspaceDiff,
      ripgrepGrep,
      searchTree,
      selectWorkspace,
      toWorkspaceRel
    });
    registerPlanningTools(mcp, {
      CHANGE_JOURNAL: config.changeJournal,
      TASK_PLAN_PATH: config.taskPlanPath,
      atomicWriteJson: config.atomicWriteJson,
      currentTask,
      getChangeJournal: config.getChangeJournal,
      isoNow,
      jsonResult,
      reg: config.reg,
      taskArtifactPath,
      taskRouter: config.taskRouter,
      textResult
    });
    registerUtilityTools(mcp, {
      FIGMA_DESKTOP_MCP_URL: config.figmaDesktopUrl,
      FIGMA_DESKTOP_TIMEOUT_MS: config.figmaDesktopTimeoutMs,
      MAX_READ_CHARS: config.maxReadChars,
      buildFigmaDesktopArguments,
      currentTask,
      decodePageCursor,
      discoverSkills,
      isWorkspaceSkillsDir,
      jsonResult,
      pageMetadata,
      pageScope,
      preparePatchTaskContext,
      reg: config.reg,
      registry: config.registry,
      resolveWorkspacePath,
      runPatchTransactionWithJournals,
      sanitizeSkillName,
      selectWorkspace,
      getSkillDirs: skillDirs,
      toWorkspaceRel,
      verifyWorkspaceChanges
    });
    registerSystemTools(mcp, {
      CHANGE_JOURNAL: config.changeJournal,
      CHECKPOINT_PATH: config.checkpointPath,
      MAX_PROCS: config.maxProcesses,
      PROC_BUFFER: config.processBuffer,
      TASK_PLAN_PATH: config.taskPlanPath,
      ...config.taskCloseService,
      assertCommandAllowed,
      atomicWriteJson: config.atomicWriteJson,
      currentMcpSessionId,
      currentTask,
      decodePageCursor,
      freezeTaskForMutation,
      getChangeJournal: config.getChangeJournal,
      historyPagination,
      isoNow,
      jsonResult,
      killProcessTree,
      markUnmanagedChange,
      mutationFingerprintChanged,
      pageScope,
      primaryWorkspaceId: config.primaryWorkspaceId,
      processes: config.processes,
      qualifiedPath,
      reg: config.reg,
      resolveWorkspacePath,
      selectWorkspace,
      startBackground,
      taskArtifactPath,
      taskRouter: config.taskRouter,
      toWorkspaceRel,
      workspaceInfoPayload: config.workspaceInfoPayload,
      workspaceMutationFingerprint
    });
    return mcp;
  };
}

function serverInstructions(policy) {
  return [
    "Local Coding Agent is task-scoped and may operate across explicitly attached workspaces. File tools are root-confined; command execution is audited but is not an OS sandbox.",
    "START: call workspace_list, optionally workspace_select for future tasks, then task_open. workspace_select never reroutes an existing task. A task has one primary workspace and at most eight attached workspaces.",
    "ISOLATION: every context, mutation, execution and review call belongs to the current task. Attach or detach workspaces before the first mutation; the workspace set freezes afterwards. Never infer another repository. If context is missing or ambiguous, stop on TASK_CONTEXT_REQUIRED.",
    "PATHS: results use {workspace_id,path}; paths are relative to that workspace. Always pass workspace_id when a task contains more than one workspace.",
    "CONTEXT: start with workspace_snapshot. Use code_query for symbols, definitions, references, imports and call relationships; use search_text/find_files/read_many only for missing evidence. Prefer bounded, targeted reads and a few substantial calls.",
    "MUTATION: use apply_patch with expected_version for related file changes, including cross-workspace batches. A transaction reported in_doubt blocks further mutation until recovery. Shell changes are not atomic or undoable; tracked source changed by a command is marked unmanaged and must be adopted/reviewed.",
    "VERIFICATION: use run_changed_tests or verify_changes, then review_diff/security_scan as appropriate. PASS or CLEAN is forbidden when any workspace, changed file, transaction, unmanaged change, or required gate is incomplete.",
    "EXECUTION: reserve run_command/run_commands/process for builds, tests, installs and programs that dedicated tools cannot perform. Set cwd instead of embedding cd, and bound output.",
    policy === "balanced"
      ? "POLICY: risky actions can return Approval required. Use the local approval UI or CLI to review and authorize the exact action."
      : null,
    "Unknown legacy tools are not supported. Refresh the connector and use the current fixed catalog."
  ].filter(Boolean).join("\n");
}
