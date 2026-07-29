// Local Coding Agent response shaping helpers.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

export const RESPONSE_MODES = Object.freeze(["auto", "compact", "full", "diagnostic"]);

export function normalizeResponseMode(value) {
  return RESPONSE_MODES.includes(value) ? value : "auto";
}

export function shouldCompactResponse(value, profile, compactProfiles = ["quick_edit", "normal"]) {
  const mode = normalizeResponseMode(value);
  if (mode === "compact") return true;
  if (mode === "full" || mode === "diagnostic") return false;
  return compactProfiles.includes(String(profile || "normal"));
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
    orchestration: task.orchestration || null
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
