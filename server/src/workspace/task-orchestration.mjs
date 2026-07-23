// Local Coding Agent task orchestration guidance.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";

const PROFILES = new Set(["quick_edit", "normal", "complex"]);
const PHASES = new Set(["opened", "discovering", "decision_ready", "mutating", "confirming", "blocked", "closing"]);
const EVIDENCE_STATES = new Set([
  "not_started",
  "insufficient",
  "likely_sufficient",
  "target_confirmed",
  "mutation_applied",
  "confirmation_complete"
]);
const DISCOVERY_TOOLS = new Set([
  "workspace_snapshot",
  "code_query",
  "search_text",
  "find_files",
  "list_files",
  "read_file",
  "read_many",
  "project_profile",
  "index_control",
  "figma"
]);
const VERIFICATION_TOOLS = new Set([
  "run_changed_tests",
  "verify_changes",
  "review_diff",
  "security_scan",
  "todo_scan"
]);
const PLANNING_TOOLS = new Set(["task_plan", "task_state", "task_checkpoint"]);
const CONTROL_TOOLS = new Set([
  "task_open",
  "task_reclassify",
  "task_close",
  "workspace_attach",
  "workspace_detach",
  "workspace_select",
  "workspace_register"
]);
const EXECUTION_TOOLS = new Set(["git", "run_command", "run_commands", "process"]);
const MUTATION_TOOLS = new Set(["apply_patch"]);
const MAX_RECENT_FINGERPRINTS = 64;

export function normalizeTaskObjective(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, 4_000);
}

export function normalizeComplexityProfile(value, fallback = null) {
  const normalized = String(value || "").trim().toLowerCase();
  return PROFILES.has(normalized) ? normalized : fallback;
}

export function classifyTaskComplexity({
  complexityHint,
  complexityOverride = false,
  workspaceCount = 1
} = {}) {
  const requestedProfile = normalizeComplexityProfile(complexityHint);
  const effectiveProfile = requestedProfile || "normal";
  const count = Number(workspaceCount) || 1;
  let suggestedProfile = null;
  const scopeReasons = [];

  if (count > 3) {
    suggestedProfile = "complex";
    scopeReasons.push(`task starts with ${count} attached workspaces`);
  } else if (count > 1 && effectiveProfile === "quick_edit") {
    suggestedProfile = "normal";
    scopeReasons.push(`quick_edit starts with ${count} attached workspaces`);
  }

  return {
    requested_profile: requestedProfile,
    effective_profile: effectiveProfile,
    complexity_override: Boolean(complexityOverride),
    confidence: suggestedProfile ? 1 : 0.5,
    reasons: [requestedProfile ? `model selected profile: ${requestedProfile}` : "no model profile supplied; defaulted to normal"],
    suggested_profile: suggestedProfile,
    scope_signal: suggestedProfile ? compareProfiles(suggestedProfile, effectiveProfile) : null,
    scope_reasons: scopeReasons
  };
}

export function createTaskOrchestration(classification = {}) {
  const effectiveProfile = normalizeComplexityProfile(classification.effective_profile, "normal");
  return {
    version: 1,
    requested_profile: normalizeComplexityProfile(classification.requested_profile),
    effective_profile: effectiveProfile,
    confidence: finiteConfidence(classification.confidence),
    classification_reasons: normalizeReasons(classification.reasons),
    suggested_profile: normalizeComplexityProfile(classification.suggested_profile),
    scope_signal: normalizeScopeSignal(classification.scope_signal),
    scope_reasons: normalizeReasons(classification.scope_reasons),
    phase: "opened",
    evidence_status: "not_started",
    budgets: profileBudgets(effectiveProfile),
    counters: emptyCounters(),
    mutation_epoch: 0,
    recent_fingerprints: [],
    last_status_normalized: null,
    last_notice: null,
    updated_at: new Date().toISOString()
  };
}

export function normalizeTaskOrchestration(value, fallbackProfile = "normal") {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const effectiveProfile = normalizeComplexityProfile(source.effective_profile, normalizeComplexityProfile(fallbackProfile, "normal"));
  return {
    version: 1,
    requested_profile: normalizeComplexityProfile(source.requested_profile),
    effective_profile: effectiveProfile,
    confidence: finiteConfidence(source.confidence),
    classification_reasons: normalizeReasons(source.classification_reasons),
    suggested_profile: normalizeComplexityProfile(source.suggested_profile),
    scope_signal: normalizeScopeSignal(source.scope_signal),
    scope_reasons: normalizeReasons(source.scope_reasons),
    phase: PHASES.has(source.phase) ? source.phase : "opened",
    evidence_status: EVIDENCE_STATES.has(source.evidence_status) ? source.evidence_status : "not_started",
    budgets: normalizeBudgets(source.budgets, effectiveProfile),
    counters: normalizeCounters(source.counters),
    mutation_epoch: nonNegativeInteger(source.mutation_epoch),
    recent_fingerprints: normalizeFingerprints(source.recent_fingerprints),
    last_status_normalized: normalizeOptionalString(source.last_status_normalized, 240),
    last_notice: normalizeNotice(source.last_notice),
    updated_at: normalizeTimestamp(source.updated_at) || new Date().toISOString()
  };
}

export function publicTaskOrchestration(value, fallbackProfile = "normal") {
  const state = normalizeTaskOrchestration(value, fallbackProfile);
  return {
    version: state.version,
    requested_profile: state.requested_profile,
    effective_profile: state.effective_profile,
    confidence: state.confidence,
    classification_reasons: state.classification_reasons,
    suggested_profile: state.suggested_profile,
    scope_signal: state.scope_signal,
    scope_reasons: state.scope_reasons,
    phase: state.phase,
    evidence_status: state.evidence_status,
    budgets: state.budgets,
    counters: state.counters,
    last_notice: state.last_notice,
    recommended_transition: recommendedTransition(state)
  };
}

export function classifyTaskTool(tool, args = {}) {
  const name = String(tool || "");
  if (DISCOVERY_TOOLS.has(name)) return "discovery";
  if (VERIFICATION_TOOLS.has(name)) return "verification";
  if (PLANNING_TOOLS.has(name)) return "planning";
  if (CONTROL_TOOLS.has(name)) return "control";
  if (MUTATION_TOOLS.has(name)) return "mutation";
  if (name === "change_history") {
    return ["undo", "reapply", "undo_all", "clear"].includes(String(args.action || "")) ? "mutation" : "discovery";
  }
  if (name === "skills") return ["create", "delete"].includes(String(args.action || "")) ? "mutation" : "planning";
  if (name === "notes") return String(args.action || "list") === "save" ? "mutation" : "planning";
  if (EXECUTION_TOOLS.has(name)) return "execution";
  return "utility";
}

export function taskToolFingerprint(tool, args, orchestration) {
  const state = normalizeTaskOrchestration(orchestration);
  const normalizedArgs = normalizeFingerprintValue(args, new Set(["task_token", "evidence_gap"]));
  return createHash("sha256")
    .update(JSON.stringify({ tool: String(tool || ""), args: normalizedArgs, mutation_epoch: state.mutation_epoch }))
    .digest("hex")
    .slice(0, 24);
}

export function inspectTaskTool({ task, tool, args = {} } = {}) {
  const state = normalizeTaskOrchestration(task?.orchestration, task?.effective_profile);
  const toolClass = classifyTaskTool(tool, args);
  const fingerprint = taskToolFingerprint(tool, args, state);
  const previous = state.recent_fingerprints.find((entry) => entry.fingerprint === fingerprint) || null;
  const evidenceGap = normalizeOptionalString(args.evidence_gap, 1_000);
  const statusNormalized = tool === "task_state" ? normalizeStatusText(args.status) : null;
  const statusOnly = tool === "task_state" && Boolean(statusNormalized) &&
    args.set_step_done === undefined && (!Array.isArray(args.add_steps) || args.add_steps.length === 0);
  const statusDuplicate = statusOnly && statusTextSimilar(statusNormalized, state.last_status_normalized);
  let skip = false;
  let notice = null;

  if (statusDuplicate) {
    skip = true;
    notice = buildNotice(
      "DUPLICATE_STATUS_UPDATE",
      "info",
      "This status-only update does not represent a new task transition and was deduplicated.",
      "continue_current_work"
    );
  } else if (toolClass === "discovery" && previous && previous.count >= 2 && !evidenceGap && isRecentFingerprint(previous)) {
    skip = !["read_file", "read_many"].includes(String(tool));
    notice = buildNotice(
      "TASK_LOOP_DETECTED",
      "warning",
      "The same unchanged evidence has been requested repeatedly. State the missing evidence or move to a decision.",
      "make_decision_or_identify_evidence_gap"
    );
  } else if (toolClass === "discovery" && previous) {
    notice = buildNotice(
      "REPEATED_UNCHANGED_EVIDENCE",
      previous.count >= 1 ? "warning" : "info",
      "This evidence request has already been made in the current mutation epoch.",
      "make_decision_or_identify_evidence_gap"
    );
  } else if (state.effective_profile === "quick_edit" && tool === "task_plan") {
    notice = buildNotice(
      "PLAN_NOT_RECOMMENDED_FOR_QUICK_EDIT",
      "info",
      "A persistent plan is usually unnecessary for a localized quick edit unless independent steps or ambiguity remain.",
      "continue_or_explain_scope_expansion"
    );
  } else if (state.effective_profile === "quick_edit" && tool === "skills" && String(args.action || "") === "list") {
    skip = true;
    notice = buildNotice(
      "SKILLS_NOT_RECOMMENDED_FOR_QUICK_EDIT",
      "info",
      "No task-specific skill has been identified for this localized edit.",
      "continue_or_identify_relevant_skill"
    );
  }

  return {
    state,
    tool_class: toolClass,
    fingerprint,
    previous,
    duplicate: Boolean(previous),
    status_only: statusOnly,
    status_normalized: statusNormalized,
    evidence_gap: evidenceGap,
    source_changed: false,
    skip,
    notice
  };
}

export function advanceTaskOrchestration({
  task,
  tool,
  args = {},
  success,
  resultPayload,
  invocationId,
  finishedAt,
  inspection,
  skipped = false
} = {}) {
  const observed = inspection || inspectTaskTool({ task, tool, args });
  const resultTask = tool === "task_reclassify" && resultPayload?.task && typeof resultPayload.task === "object"
    ? resultPayload.task
    : null;
  const state = normalizeTaskOrchestration(
    resultTask?.orchestration || observed.state,
    resultTask?.effective_profile || task?.effective_profile
  );
  const counters = { ...state.counters };
  const lifecycleCall = ["task_open", "task_close"].includes(String(tool || ""));
  counters.total_calls++;
  if (!lifecycleCall) counters.work_calls++;
  if (observed.duplicate) counters.duplicate_calls++;
  else counters.unique_calls++;
  if (observed.tool_class === "discovery") counters.discovery_calls++;
  if (observed.status_only) counters.status_only_calls++;
  if (!success) counters.failed_calls++;

  const effectiveProfile = state.effective_profile;
  let suggestedProfile = null;
  let scopeReasons = [];
  const workspaceCount = Number(task?.workspace_ids?.length || 0);
  if (tool !== "task_reclassify") {
    if (workspaceCount > 3) {
      suggestedProfile = "complex";
      scopeReasons.push("task spans more than three workspaces");
    } else if (effectiveProfile === "quick_edit" && workspaceCount > 1) {
      suggestedProfile = "normal";
      scopeReasons.push("quick_edit spans multiple workspaces");
    } else if (effectiveProfile === "quick_edit" && tool === "task_plan" && success && !skipped) {
      suggestedProfile = "normal";
      scopeReasons.push("the model created a persistent multi-step plan");
    }
  }
  const scopeSignal = suggestedProfile ? compareProfiles(suggestedProfile, effectiveProfile) : null;

  const fingerprints = [...state.recent_fingerprints];
  const existingIndex = fingerprints.findIndex((entry) => entry.fingerprint === observed.fingerprint);
  const fingerprintEntry = {
    fingerprint: observed.fingerprint,
    tool: String(tool || ""),
    count: observed.source_changed
      ? 1
      : (existingIndex >= 0 ? fingerprints[existingIndex].count : 0) + 1,
    invocation_id: normalizeOptionalString(invocationId, 180),
    observed_at: normalizeTimestamp(finishedAt) || new Date().toISOString()
  };
  if (existingIndex >= 0) fingerprints.splice(existingIndex, 1);
  fingerprints.unshift(fingerprintEntry);
  fingerprints.splice(MAX_RECENT_FINGERPRINTS);

  let phase = state.phase;
  let evidenceStatus = state.evidence_status;
  let mutationEpoch = state.mutation_epoch;
  let evidenceDelta = false;
  const resultStatus = String(resultPayload?.status || resultPayload?.verification?.status || resultPayload?.verification || "").toUpperCase();

  if (tool === "task_close") {
    phase = "closing";
  } else if (!success && ["mutation", "execution", "verification", "control"].includes(observed.tool_class)) {
    phase = "blocked";
  } else if (skipped && observed.tool_class === "discovery") {
    phase = "decision_ready";
  } else if (observed.tool_class === "mutation") {
    if (success && !skipped) {
      phase = "mutating";
      evidenceStatus = "mutation_applied";
      mutationEpoch++;
      counters.mutations++;
      evidenceDelta = true;
    }
  } else if (observed.tool_class === "execution") {
    const workspaceMutated = success && !skipped && resultIndicatesWorkspaceMutation(resultPayload);
    if (workspaceMutated) {
      phase = "mutating";
      evidenceStatus = "mutation_applied";
      mutationEpoch++;
      counters.mutations++;
      evidenceDelta = true;
    } else if (success && !skipped) {
      phase = counters.mutations > 0 ? "confirming" : "decision_ready";
      evidenceDelta = !observed.duplicate;
    }
  } else if (observed.tool_class === "verification") {
    phase = "confirming";
    if (success && ["PASS", "CLEAN"].includes(resultStatus)) evidenceStatus = "confirmation_complete";
    else if (counters.mutations > 0) evidenceStatus = "mutation_applied";
    evidenceDelta = success && !observed.duplicate;
  } else if (observed.tool_class === "discovery") {
    evidenceDelta = success && !skipped && !observed.duplicate && discoveryResultHasEvidence(resultPayload);
    if (counters.mutations > 0) {
      phase = "confirming";
      if (success && !skipped) evidenceStatus = "confirmation_complete";
    } else if (success && !skipped && ["read_file", "read_many"].includes(String(tool))) {
      phase = "decision_ready";
      evidenceStatus = evidenceStatus === "target_confirmed" ? evidenceStatus : "likely_sufficient";
    } else {
      phase = "discovering";
      if (evidenceStatus === "not_started") evidenceStatus = "insufficient";
      if (success && !skipped && Number(resultPayload?.count) === 1) evidenceStatus = "target_confirmed";
    }
  }

  if (observed.tool_class === "discovery") {
    counters.stagnant_discovery_calls = evidenceDelta
      ? 0
      : counters.stagnant_discovery_calls + 1;
  }

  let notice = observed.notice;
  if (!notice && scopeSignal === "expanded") {
    notice = buildNotice(
      "TASK_PROFILE_REVIEW_SUGGESTED",
      "info",
      `Observed scope suggests ${suggestedProfile}, but the effective profile remains ${effectiveProfile} until the model confirms a change.`,
      "continue_or_reclassify_task"
    );
  }
  const budgets = profileBudgets(effectiveProfile);
  const budgetStalled = phase === "discovering" &&
    (observed.duplicate || counters.stagnant_discovery_calls >= 2);
  if (!notice && budgetStalled && budgets.discovery_soft_limit !== null && counters.discovery_calls > budgets.discovery_soft_limit) {
    notice = buildNotice(
      effectiveProfile === "quick_edit" ? "QUICK_EDIT_DISCOVERY_BUDGET_EXCEEDED" : "TASK_DISCOVERY_BUDGET_EXCEEDED",
      "warning",
      effectiveProfile === "quick_edit"
        ? "This localized task has exceeded its expected discovery budget."
        : "This task has exceeded its expected discovery budget.",
      "make_decision_or_explain_scope_expansion"
    );
  }
  if (!notice && budgetStalled && budgets.total_soft_limit !== null && counters.work_calls > budgets.total_soft_limit) {
    notice = buildNotice(
      "TASK_TOOL_BUDGET_EXCEEDED",
      "warning",
      "This task has exceeded its expected soft tool-call budget.",
      "make_decision_or_explain_scope_expansion"
    );
  }

  const next = {
    ...state,
    effective_profile: effectiveProfile,
    suggested_profile: suggestedProfile,
    scope_signal: scopeSignal,
    scope_reasons: normalizeReasons(scopeReasons),
    phase,
    evidence_status: evidenceStatus,
    budgets,
    counters,
    mutation_epoch: mutationEpoch,
    recent_fingerprints: fingerprints,
    last_status_normalized: observed.status_only && !skipped
      ? observed.status_normalized
      : state.last_status_normalized,
    last_notice: notice,
    updated_at: normalizeTimestamp(finishedAt) || new Date().toISOString()
  };
  return {
    state: next,
    public: publicTaskOrchestration(next, effectiveProfile),
    notice,
    tool_class: observed.tool_class,
    fingerprint: observed.fingerprint,
    duplicate: observed.duplicate,
    status_only: observed.status_only,
    policy_skip: skipped,
    evidence_delta: evidenceDelta,
    phase_before: state.phase,
    phase_after: next.phase
  };
}

export function confirmTaskComplexity(value, profile, reason) {
  const state = normalizeTaskOrchestration(value);
  const effectiveProfile = normalizeComplexityProfile(profile);
  if (!effectiveProfile) throw new TypeError(`Invalid complexity profile: ${profile}`);
  const confirmationReason = normalizeOptionalString(reason, 1_000);
  return {
    ...state,
    effective_profile: effectiveProfile,
    budgets: profileBudgets(effectiveProfile),
    classification_reasons: normalizeReasons([
      ...state.classification_reasons,
      `model confirmed profile: ${effectiveProfile}${confirmationReason ? ` — ${confirmationReason}` : ""}`
    ]),
    suggested_profile: null,
    scope_signal: null,
    scope_reasons: [],
    last_notice: null,
    updated_at: new Date().toISOString()
  };
}

export function normalizeStatusText(value) {
  const source = String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(now|final|ready|currently|đang|bây giờ|cuối cùng|to|the|a|an)\b/gu, " ")
    .replace(/\b(apply|applying|applied|write|writing|written|edit|editing|edited|patch|patching|change|changes|changing|sửa|ghi|thay đổi)\b/gu, " mutate ")
    .replace(/\b(read|reading|search|searching|inspect|inspecting|đọc|tìm|kiểm tra)\b/gu, " discover ")
    .replace(/\b(verify|verifying|review|reviewing|xác minh|rà soát)\b/gu, " verify ")
    .replace(/\b(plan|planning|lập kế hoạch)\b/gu, " plan ")
    .replace(/\b(close|closing|đóng)\b/gu, " close ")
    .replace(/\s+/g, " ")
    .trim();
  return source ? source.slice(0, 240) : null;
}

function statusTextSimilar(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return false;
  let common = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) common++;
  return common / Math.min(leftTokens.size, rightTokens.size) >= 0.75;
}

function isRecentFingerprint(entry, maxAgeMs = 30_000) {
  const timestamp = Date.parse(String(entry?.observed_at || ""));
  return Number.isFinite(timestamp) && Date.now() - timestamp <= maxAgeMs;
}

function discoveryResultHasEvidence(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (payload.unchanged === true) return false;
  if (Number.isFinite(Number(payload.count))) return Number(payload.count) > 0;
  if (typeof payload.content === "string") return payload.content.length > 0;
  for (const key of ["matches", "files", "entries", "recommended_reads", "results"]) {
    if (Array.isArray(payload[key])) return payload[key].length > 0;
  }
  return Object.keys(payload).some((key) => !["ok", "status", "orchestration"].includes(key));
}

function resultIndicatesWorkspaceMutation(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.mutation_performed === true || payload.unmanaged_changes === true) return true;
  if (Array.isArray(payload.results)) {
    return payload.results.some((entry) => entry?.unmanaged_changes === true || entry?.mutation_performed === true);
  }
  return false;
}

function compareProfiles(suggested, effective) {
  const rank = { quick_edit: 0, normal: 1, complex: 2 };
  if (!(suggested in rank) || !(effective in rank)) return null;
  if (rank[suggested] > rank[effective]) return "expanded";
  if (rank[suggested] < rank[effective]) return "reduced";
  return "aligned";
}

function normalizeScopeSignal(value) {
  return ["expanded", "reduced", "aligned"].includes(value) ? value : null;
}

function profileBudgets(profile) {
  if (profile === "quick_edit") return { discovery_soft_limit: 5, total_soft_limit: 9 };
  if (profile === "normal") return { discovery_soft_limit: 8, total_soft_limit: 18 };
  return { discovery_soft_limit: null, total_soft_limit: null };
}

function recommendedTransition(state) {
  if (state.last_notice?.recommended_transition) return state.last_notice.recommended_transition;
  if (state.phase === "decision_ready") return "make_decision_or_gather_specific_evidence";
  if (state.phase === "confirming") return "confirm_or_close";
  if (state.phase === "blocked") return "resolve_blocker";
  if (state.phase === "closing") return "close_task";
  return "gather_targeted_evidence";
}

function emptyCounters() {
  return {
    total_calls: 0,
    work_calls: 0,
    unique_calls: 0,
    duplicate_calls: 0,
    discovery_calls: 0,
    stagnant_discovery_calls: 0,
    status_only_calls: 0,
    failed_calls: 0,
    mutations: 0
  };
}

function normalizeCounters(value) {
  const source = value && typeof value === "object" ? value : {};
  const output = emptyCounters();
  for (const key of Object.keys(output)) output[key] = nonNegativeInteger(source[key]);
  return output;
}

function normalizeBudgets(value, profile) {
  const defaults = profileBudgets(profile);
  const source = value && typeof value === "object" ? value : {};
  return {
    discovery_soft_limit: nullableNonNegativeInteger(source.discovery_soft_limit, defaults.discovery_soft_limit),
    total_soft_limit: nullableNonNegativeInteger(source.total_soft_limit, defaults.total_soft_limit)
  };
}

function normalizeFingerprints(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_RECENT_FINGERPRINTS).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const fingerprint = String(entry.fingerprint || "");
    if (!/^[a-f0-9]{24}$/.test(fingerprint)) return [];
    return [{
      fingerprint,
      tool: normalizeOptionalString(entry.tool, 80) || "unknown",
      count: Math.max(1, nonNegativeInteger(entry.count)),
      invocation_id: normalizeOptionalString(entry.invocation_id, 180),
      observed_at: normalizeTimestamp(entry.observed_at)
    }];
  });
}

function normalizeFingerprintValue(value, omittedKeys) {
  if (Array.isArray(value)) return value.map((item) => normalizeFingerprintValue(item, omittedKeys));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
    if (omittedKeys.has(key) || value[key] === undefined) return [];
    return [[key, normalizeFingerprintValue(value[key], omittedKeys)]];
  }));
}

function buildNotice(code, severity, message, recommendedTransitionValue) {
  return {
    code,
    severity,
    message,
    recommended_transition: recommendedTransitionValue
  };
}

function normalizeNotice(value) {
  if (!value || typeof value !== "object") return null;
  const code = String(value.code || "");
  if (!/^[A-Z][A-Z0-9_]{1,80}$/.test(code)) return null;
  return {
    code,
    severity: ["info", "warning", "error"].includes(value.severity) ? value.severity : "info",
    message: normalizeOptionalString(value.message, 1_000) || code,
    recommended_transition: normalizeOptionalString(value.recommended_transition, 160)
  };
}

function normalizeReasons(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => normalizeOptionalString(item, 500)).filter(Boolean))].slice(0, 12);
}

function finiteConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, Math.round(number * 100) / 100)) : 0.6;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function nullableNonNegativeInteger(value, fallback) {
  if (value === null) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function normalizeOptionalString(value, maxLength) {
  if (value === null || value === undefined || value === "") return null;
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLength) || null;
}

function normalizeTimestamp(value) {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
