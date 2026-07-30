// Local Coding Agent response shaping helpers.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

export const RESPONSE_MODES = Object.freeze(["auto", "minimal", "compact", "full", "diagnostic"]);

export function normalizeResponseMode(value) {
  return RESPONSE_MODES.includes(value) ? value : "auto";
}

export function isMinimalResponse(value) {
  return normalizeResponseMode(value) === "minimal";
}

export function shouldCompactResponse(value, profile, compactProfiles = ["quick_edit", "normal"]) {
  const mode = normalizeResponseMode(value);
  if (mode === "minimal" || mode === "compact") return true;
  if (mode === "full" || mode === "diagnostic") return false;
  return compactProfiles.includes(String(profile || "normal"));
}

export function minimalTask(task) {
  if (!task || typeof task !== "object") return task ?? null;
  return {
    id: task.id,
    title: task.title,
    task_token: task.task_token,
    status: task.status,
    version: task.version,
    effective_profile: task.effective_profile || "normal",
    primary_workspace_id: task.primary_workspace_id || null,
    workspace_ids: [...(task.workspace_ids || [])],
    workspace_set_frozen: task.workspace_set_frozen === true
  };
}

export function compactTask(task) {
  if (!task || typeof task !== "object") return task ?? null;
  return {
    id: task.id,
    title: task.title,
    objective: task.objective || null,
    task_token: task.task_token,
    status: task.status,
    version: task.version,
    memory_mode: task.memory_mode || "auto",
    include_recent_tasks: task.include_recent_tasks === true,
    relevant_paths: (task.relevant_paths || []).map((entry) => ({
      workspace_id: entry.workspace_id,
      path: entry.path
    })),
    requested_profile: task.requested_profile || null,
    effective_profile: task.effective_profile || "normal",
    profile_confidence: Number.isFinite(task.profile_confidence) ? task.profile_confidence : null,
    primary_workspace_id: task.primary_workspace_id || null,
    workspace_ids: [...(task.workspace_ids || [])],
    session_bound: task.session_bound === true,
    detached_at: task.detached_at || null,
    closed_reason: task.closed_reason || null,
    workspace_set_frozen: task.workspace_set_frozen === true,
    mutation_started_at: task.mutation_started_at || null,
    created_at: task.created_at || null,
    updated_at: task.updated_at || null,
    closed_at: task.closed_at || null,
    orchestration: compactOrchestration(task.orchestration)
  };
}

export function minimalOrchestration(value) {
  if (!value || typeof value !== "object") return value ?? null;
  return {
    effective_profile: value.effective_profile || null,
    phase: value.phase || null,
    execution_status: value.execution_status || null,
    verification_status: value.verification_status || null,
    integrity_status: value.integrity_status || null,
    review_status: value.review_status || null,
    run_state: value.run_state || null,
    blocker: value.blocker || null,
    recommended_transition: value.recommended_transition || null
  };
}

export function compactOrchestration(value) {
  if (!value || typeof value !== "object") return value ?? null;
  return {
    version: value.version || null,
    requested_profile: value.requested_profile || null,
    effective_profile: value.effective_profile || null,
    suggested_profile: value.suggested_profile || null,
    scope_signal: value.scope_signal || null,
    scope_reasons: value.scope_reasons || [],
    phase: value.phase || null,
    evidence_status: value.evidence_status || null,
    execution_status: value.execution_status || null,
    verification_policy: value.verification_policy || null,
    verification_status: value.verification_status || null,
    integrity_status: value.integrity_status || null,
    review_status: value.review_status || null,
    run_state: value.run_state || null,
    blocker: value.blocker || null,
    last_notice: value.last_notice || null,
    recommended_transition: value.recommended_transition || null
  };
}

export function shapeOrchestrationForResponse(value, {
  mode = "auto",
  profile = "normal",
  compactProfiles = ["quick_edit", "normal"],
  minimalWhenCompact = false
} = {}) {
  if (isMinimalResponse(mode)) return minimalOrchestration(value);
  if (shouldCompactResponse(mode, profile, compactProfiles)) {
    return minimalWhenCompact ? minimalOrchestration(value) : compactOrchestration(value);
  }
  return value;
}

export function compactWorkspaceMemory(memory, { minimal = false } = {}) {
  if (!memory || typeof memory !== "object") return memory ?? null;
  const output = {
    available: memory.available === true,
    requested_mode: memory.requested_mode || null,
    effective_mode: memory.effective_mode || null,
    skipped: memory.skipped === true,
    semantic_used: memory.semantic_used === true,
    recent_tasks_requested: memory.recent_tasks_requested === true,
    recent_tasks_included: memory.recent_tasks_included === true,
    truncated: memory.truncated === true,
    brief: memory.brief || ""
  };
  if (minimal) return output;
  return {
    ...output,
    revision: memory.revision || null,
    item_ids: (memory.items || []).map((item) => item.id).filter(Boolean),
    recent_task_ids: (memory.recent_tasks || []).map((task) => task.id).filter(Boolean)
  };
}

export function minimalCompletionGuard(guard) {
  if (!guard || typeof guard !== "object") return guard ?? null;
  return {
    ok: guard.ok === true,
    status: guard.status,
    verification_status: guard.verification_status,
    integrity_status: guard.integrity_status,
    incomplete_reasons: guard.incomplete_reasons || []
  };
}

export function compactCompletionGuard(guard) {
  if (!guard || typeof guard !== "object") return guard ?? null;
  return {
    ok: guard.ok === true,
    status: guard.status,
    task_id: guard.task_id,
    verification_policy: guard.verification_policy,
    verification_status: guard.verification_status,
    integrity_status: guard.integrity_status,
    running_processes: guard.running_processes || [],
    integrity_reasons: guard.integrity_reasons || [],
    verification_reasons: guard.verification_reasons || [],
    incomplete_reasons: guard.incomplete_reasons || [],
    workspaces: (guard.workspaces || []).map((workspace) => ({
      workspace_id: workspace.workspace_id,
      ok: workspace.ok === true,
      transaction_in_doubt: workspace.transaction_in_doubt === true,
      unmanaged_changes: workspace.unmanaged_changes === true,
      unmanaged_state_known: workspace.unmanaged_state_known === true,
      verification_status: workspace.verification?.status || null,
      verification_reasons: workspace.verification_reasons || [],
      integrity_reasons: workspace.integrity_reasons || [],
      reasons: workspace.reasons || []
    }))
  };
}
