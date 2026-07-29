// Task-scoped Memory policy normalization.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

const MEMORY_MODES = new Set(["auto", "skip", "full"]);
const WORKSPACE_ID_PATTERN = /^ws_[a-z0-9]{16,64}$/i;

export function normalizeTaskMemoryPolicy(
  value = {},
  { primaryWorkspaceId, workspaceIds = [], errorFactory = taskMemoryPolicyError } = {}
) {
  const memoryMode = normalizeTaskMemoryMode(value.memoryMode);
  const relevantPaths = [];
  const seen = new Set();
  for (const entry of Array.isArray(value.relevantPaths)
    ? value.relevantPaths.slice(0, 32)
    : []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const workspaceId = validateWorkspaceId(entry.workspace_id || primaryWorkspaceId, errorFactory);
    if (!workspaceIds.includes(workspaceId)) {
      throw errorFactory(
        "TASK_WORKSPACE_NOT_ATTACHED",
        `Memory-relevance path refers to unattached workspace ${workspaceId}.`,
        { workspace_id: workspaceId, workspace_ids: workspaceIds }
      );
    }
    const normalizedPath = normalizeTaskRelevantPath(entry.path, errorFactory);
    const key = `${workspaceId}:${normalizedPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    relevantPaths.push({ workspace_id: workspaceId, path: normalizedPath });
  }
  return {
    memory_mode: memoryMode,
    include_recent_tasks: value.includeRecentTasks === true,
    relevant_paths: relevantPaths
  };
}

export function normalizeTaskMemoryMode(value) {
  const normalized = String(value || "");
  return MEMORY_MODES.has(normalized) ? normalized : "auto";
}

export function hydrateTaskRelevantPaths(value, primaryWorkspaceId, workspaceIds) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return normalizeTaskMemoryPolicy({ relevantPaths: parsed }, {
      primaryWorkspaceId,
      workspaceIds
    }).relevant_paths;
  } catch {
    return [];
  }
}

function normalizeTaskRelevantPath(value, errorFactory) {
  const raw = String(value || "").trim().replaceAll("\\", "/");
  if (!raw) {
    throw errorFactory(
      "TASK_MEMORY_PATH_INVALID",
      "Memory-relevance path is required."
    );
  }
  if (raw.startsWith("/") || raw.startsWith("//") || /^[A-Za-z]:\//.test(raw)) {
    throw errorFactory(
      "TASK_MEMORY_PATH_INVALID",
      `Memory-relevance path must be workspace-relative: ${value}`
    );
  }
  const parts = raw.split("/").filter((part) => part && part !== ".");
  if (parts.includes("..")) {
    throw errorFactory(
      "TASK_MEMORY_PATH_INVALID",
      `Memory-relevance path cannot escape its workspace: ${value}`
    );
  }
  return parts.join("/") || ".";
}

function validateWorkspaceId(value, errorFactory) {
  const id = String(value || "");
  if (!WORKSPACE_ID_PATTERN.test(id)) {
    throw errorFactory("INVALID_WORKSPACE_ID", `Invalid workspace ID: ${id}`);
  }
  return id;
}

function taskMemoryPolicyError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "TaskMemoryPolicyError";
  error.code = code;
  error.details = details;
  return error;
}
