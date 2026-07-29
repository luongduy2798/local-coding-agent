// Local Coding Agent fixed 37-tool MCP catalog.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compactWorkspaceSnapshotForBudget, focusedWorkspaceEvidence } from "../coding/context-evidence.mjs";
import { discoveryRoutingInstructions } from "./discovery-groups.mjs";
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
import { registerMemoryTools } from "./tools/memory.mjs";
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
      memoryService: config.memoryService,
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
    registerMemoryTools(mcp, {
      currentTask,
      jsonResult,
      memoryService: config.memoryService,
      reg: config.reg,
      selectWorkspace
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
      selectWorkspace,
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
      getChangeJournal: config.getChangeJournal,
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
      taskRouter: config.taskRouter
    });
    registerUtilityTools(mcp, {
      FIGMA_DESKTOP_MCP_URL: config.figmaDesktopUrl,
      FIGMA_DESKTOP_TIMEOUT_MS: config.figmaDesktopTimeoutMs,
      MAX_READ_CHARS: config.maxReadChars,
      buildFigmaDesktopArguments,
      discoverSkills,
      isWorkspaceSkillsDir,
      jsonResult,
      preparePatchTaskContext,
      reg: config.reg,
      resolveWorkspacePath,
      runPatchTransactionWithJournals,
      sanitizeSkillName,
      selectWorkspace,
      getSkillDirs: skillDirs,
      toWorkspaceRel
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
      memoryOutbox: config.memoryOutbox,
      memoryService: config.memoryService,
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
    discoveryRoutingInstructions(),
    "START: for a new conversation, call workspace_list and pass its selected_workspace_id as primary_workspace_id to the first new task_open. task_open returns conversation_workspace_token; retain and reuse that token for every later new task in the same conversation, even if the global selected workspace changes. Separate conversations use separate tokens. Never replace a conversation token by rereading the default workspace; an unknown or mismatched token is a hard stop, not permission to create a new pin. workspace_select affects only future conversations and never reroutes pinned conversations or active tasks. A task has one primary workspace and at most eight attached workspaces.",
    "ISOLATION: every context, mutation, execution and review call belongs to the current task. Attach or detach workspaces before the first mutation; the workspace set freezes afterwards. Never infer another repository. If context is missing or ambiguous, stop on TASK_CONTEXT_REQUIRED.",
    "PATHS: results use {workspace_id,path}; paths are relative to that workspace. Always pass workspace_id when a task contains more than one workspace.",
    "OBJECTIVE: objective is optional durable, user-visible task metadata for the intended result and task-specific constraints. Keep it concise. Do not include private reasoning, secrets, unrelated conversation text, or general agent policy. title is a short UI label; providing title alone leaves objective unset, while an omitted title may be derived from objective.",
    "CONTEXT: use the lightest targeted discovery needed for the objective. task_open memory_mode defaults to auto: quick_edit gets light path-aware Memory (max two items, no semantic/recent-task work), while normal/complex gets full bounded retrieval. Pass relevant_paths for known quick-edit targets; use skip only for fully mechanical work and full when complete durable context is required. Set include_recent_tasks only for explicit continuation work. Stale or needs_review items are advisory. Use workspace_memory only for deeper explicit management, not as a mandatory startup call. Use workspace_snapshot for initial repository orientation, search_text for literal or regex content, code_query for symbols and relationships, and project_profile only when manifest or script details are specifically needed. Prefer a few substantial calls, do not repeat unchanged evidence, and provide evidence_gap when a similar call is genuinely needed again. response_mode defaults to auto: quick_edit/normal receive compact lifecycle, patch and review payloads, while full or diagnostic remains available when detailed evidence is necessary.",
    "ORCHESTRATION: the model selects the effective quick_edit, normal or complex profile. LCA only reports advisory suggested_profile and scope_signal from observable tool evidence; it never changes the effective profile automatically. Use task_reclassify with a reason only after the model confirms a profile change. For quick edits, normally skip task_plan and skills; use task_plan action=set_status only for a real phase transition or blocker. When a result contains halt=true or run_state=blocked/waiting_for_user, do not call another repository or execution tool; report the structured blocker and required_action to the user. Resume only through task_open with structured resume input after the relevant state changes.",
    "MUTATION: before apply_patch, open the first task with explicit primary_workspace_id or a later task with the conversation_workspace_token already pinned by the first task. Mutation never auto-creates a task or chooses a fallback workspace. Use apply_patch with expected_version for related file changes, including cross-workspace batches. A transaction reported in_doubt blocks further mutation until recovery. Shell changes are not atomic or undoable; tracked source changed by a command is marked unmanaged and must be adopted/reviewed.",
    "REVIEW: review_diff is conditional, not mandatory after every mutation. scope=task is the default and reviews only the current task's journaled change set; use scope=workspace only when the user explicitly requests review of every staged, unstaged and untracked Git change under cwd. Clean mechanical mutations may close directly from apply_patch transaction evidence without review_diff. Use git only for raw status, diff or history inspection, and change_history action=diff for one journaled change ID.",
    "VERIFICATION: use verify_changes as the canonical quality-gate path only when the user explicitly requests verification. strategy=required runs required gates, impacted runs package-aware affected tests, and full requests lint, typecheck, test and build. completion_policy defaults to required when verify_changes is called; requested records evidence without making it a hard close gate. Raw run_command or run_commands output is not official completion-guard evidence. Do not add gates solely to obtain PASS; PASS or CLEAN is forbidden while required evidence remains incomplete.",
    "CLOSING: after the requested work and any necessary source/diff review are complete, close promptly. Memory defaults to zero updates: never save routine edits, task logs, commands, output, copied source, or temporary progress. Save only compact durable goals, decisions, constraints, unresolved issues/questions, workspace-specific preferences, or meaningful verification results; normally at most one new item, and at most two for a complex task. Prefer update/supersede/resolve over duplicate cards. Accepted memory_updates are atomically queued with task closure and persisted asynchronously. A task closed without requested verification is completed with verification_status=not_requested when integrity is clean; missing verification is not an incomplete task. Required verification that is missing, stale or failed blocks a complete close. Explicit status=incomplete remains available for deliberately unfinished work but never bypasses integrity blockers. Repeating task_close with the same closed task token is idempotent.",
    "EXECUTION: reserve run_command/run_commands/process for builds, tests, installs and programs that dedicated tools cannot perform. Set cwd instead of embedding cd, and bound output. Investigation run_command calls should pass intent with purpose, target and expected_evidence so equivalent checks can be stopped without limiting distinct forensic evidence gathering.",
    policy === "balanced"
      ? "POLICY: risky actions can return Approval required. Use the local approval UI or CLI to review and authorize the exact action."
      : null,
    "Unknown legacy tools are not supported. Refresh the connector and use the current fixed catalog."
  ].filter(Boolean).join("\n");
}
