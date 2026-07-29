// Pure ranking and payload helpers for adaptive workspace Memory retrieval.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

export const LIGHT_MAX_BRIEF_BYTES = 1_024;
export const MAX_BRIEF_ITEMS = 8;
export const LIGHT_MAX_BRIEF_ITEMS = 2;

const MAX_RECENT_TASK_BYTES = 800;
const MAX_RECENT_OBJECTIVE_CHARS = 240;
const MEMORY_MODES = new Set(["auto", "skip", "full"]);
const LIGHT_SCOPED_KINDS = new Set([
  "constraint",
  "architecture_decision",
  "known_issue"
]);

export function resolveTaskMemoryPolicy(task = {}) {
  const requested = String(task.memory_mode || "");
  const requestedMode = MEMORY_MODES.has(requested) ? requested : "auto";
  const effectiveMode = requestedMode === "auto"
    ? task.effective_profile === "quick_edit" ? "light" : "full"
    : requestedMode;
  const seen = new Set();
  const relevantPaths = [];
  for (const entry of Array.isArray(task.relevant_paths) ? task.relevant_paths : []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const workspaceId = String(entry.workspace_id || task.primary_workspace_id || "");
    const path = normalizeRetrievalPath(entry.path);
    const key = `${workspaceId}:${path}`;
    if (!workspaceId || !path || seen.has(key)) continue;
    seen.add(key);
    relevantPaths.push({ workspace_id: workspaceId, path });
    if (relevantPaths.length >= 32) break;
  }
  return {
    requested_mode: requestedMode,
    effective_mode: effectiveMode,
    recent_tasks_requested: task.include_recent_tasks === true,
    relevant_paths: relevantPaths
  };
}

export function skippedTaskMemoryBrief(task) {
  const policy = resolveTaskMemoryPolicy(task);
  return {
    version: 1,
    available: true,
    requested_mode: policy.requested_mode,
    effective_mode: "skip",
    skipped: true,
    semantic_used: false,
    recent_tasks_requested: policy.recent_tasks_requested,
    recent_tasks_included: false,
    revision: 0,
    workspace_revisions: [],
    items: [],
    recent_tasks: [],
    truncated: false,
    brief: ""
  };
}

export function unavailableTaskMemoryBrief(
  task,
  code = "WORKSPACE_MEMORY_UNAVAILABLE"
) {
  return unavailableMemoryBrief(code, resolveTaskMemoryPolicy(task));
}

export function unavailableMemoryBrief(code, policy = {}) {
  return {
    version: 1,
    available: false,
    error_code: code,
    requested_mode: policy.requested_mode || "auto",
    effective_mode: policy.effective_mode || "full",
    skipped: false,
    semantic_used: false,
    recent_tasks_requested: policy.recent_tasks_requested === true,
    recent_tasks_included: false,
    items: [],
    recent_tasks: [],
    truncated: false,
    brief: ""
  };
}

export function basePriority(item) {
  const kindPriority = {
    constraint: 50,
    architecture_decision: 45,
    project_goal: 40,
    known_issue: 35,
    user_preference: 32,
    open_question: 25,
    verification_result: 20
  }[item.kind] || 0;
  const freshnessPriority = item.freshness === "current"
    ? 10
    : item.freshness === "needs_review"
      ? -10
      : -30;
  return (item.pinned ? 100 : 0) +
    kindPriority +
    freshnessPriority +
    Number(item.confidence || 0) * 10;
}

export function rankMemory(item, tokens, workspaceIndex, semanticQuery) {
  let score = basePriority(item) - workspaceIndex * 15;
  const title = String(item.title || "").toLowerCase();
  const summary = String(item.summary || "").toLowerCase();
  const tags = new Set(item.tags || []);
  for (const token of tokens) {
    if (title.includes(token)) score += 8;
    if (summary.includes(token)) score += 3;
    if (tags.has(token)) score += 20;
    if ((item.paths || []).some((path) => path.toLowerCase().includes(token))) score += 25;
  }
  const similarity = cosineSimilarity(semanticQuery, item.semantic_vector);
  if (similarity !== null) {
    item.semantic_similarity = similarity;
    score += semanticBoost(similarity);
  }
  return score;
}

export function rankLightMemory(item, relevantPaths) {
  const itemPaths = scopedMemoryPaths(item.paths);
  if (!itemPaths.length) {
    // Workspace-wide pinned constraints are a safety net, not a substitute for
    // a directly related file or directory constraint.
    return 80 + Number(item.confidence || 0) * 10;
  }
  let score = basePriority(item);
  for (const hint of relevantPaths || []) {
    if (hint.workspace_id !== item.workspace_id) continue;
    for (const itemPath of itemPaths) score += pathMatchScore(itemPath, hint.path);
  }
  return score;
}

export function isLightMemoryCandidate(item, relevantPaths) {
  if (item.freshness === "stale") return false;
  const itemPaths = scopedMemoryPaths(item.paths);
  if (!itemPaths.length) {
    return item.pinned === true && item.kind === "constraint" && item.freshness === "current";
  }
  if (!LIGHT_SCOPED_KINDS.has(item.kind)) return false;
  return (relevantPaths || []).some((hint) =>
    hint.workspace_id === item.workspace_id &&
    itemPaths.some((itemPath) => pathMatchScore(itemPath, hint.path) > 0)
  );
}

export function compactRecentTask(task) {
  return {
    task_id: task.task_id,
    title: compact(task.title, 180),
    objective: compact(task.objective, MAX_RECENT_OBJECTIVE_CHARS) || null,
    status: task.status,
    closed_at: task.closed_at
  };
}

export function fitBrief(payload, maxBytes) {
  const output = {
    ...payload,
    workspace_revisions: [...(payload.workspace_revisions || [])],
    items: [],
    recent_tasks: [],
    recent_tasks_included: false
  };
  while (byteLength(output) > maxBytes && output.workspace_revisions.length > 1) {
    output.workspace_revisions.pop();
    output.truncated = true;
  }
  for (const item of payload.items || []) {
    const candidate = { ...output, items: [...output.items, item] };
    if (byteLength(candidate) > maxBytes) {
      output.truncated = true;
      break;
    }
    output.items.push(item);
  }
  let recentBytes = 0;
  for (const task of payload.recent_tasks || []) {
    const taskBytes = byteLength(task);
    if (recentBytes + taskBytes > MAX_RECENT_TASK_BYTES) {
      output.truncated = true;
      break;
    }
    const candidate = { ...output, recent_tasks: [...output.recent_tasks, task] };
    if (byteLength(candidate) > maxBytes) {
      output.truncated = true;
      break;
    }
    output.recent_tasks.push(task);
    recentBytes += taskBytes;
  }
  output.recent_tasks_included = output.recent_tasks.length > 0;
  output.brief = buildBriefText(output);
  while (byteLength(output) > maxBytes && output.recent_tasks.length) {
    output.recent_tasks.pop();
    output.recent_tasks_included = output.recent_tasks.length > 0;
    output.brief = buildBriefText(output);
  }
  while (byteLength(output) > maxBytes && output.items.length) {
    output.items.pop();
    output.brief = buildBriefText(output);
  }
  while (byteLength(output) > maxBytes && output.workspace_revisions.length > 0) {
    output.workspace_revisions.pop();
    output.truncated = true;
  }
  if (byteLength(output) > maxBytes) {
    output.brief = "";
    output.truncated = true;
  }
  return output;
}

export function stripScore(item) {
  const {
    score,
    workspace_index,
    content_hash,
    semantic_vector,
    semantic_similarity,
    ...rest
  } = item;
  return rest;
}

function scopedMemoryPaths(paths) {
  return (paths || []).filter((path) => comparablePath(path) !== ".");
}

function pathMatchScore(memoryPath, taskPath) {
  const memory = comparablePath(memoryPath);
  const task = comparablePath(taskPath);
  if (!memory || !task) return 0;
  if (memory === task) return 100;
  if (memory === "." || task.startsWith(`${memory}/`)) return 80;
  if (task === "." || memory.startsWith(`${task}/`)) return 60;
  return 0;
}

function comparablePath(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .toLowerCase() || ".";
}

function normalizeRetrievalPath(value) {
  const raw = String(value || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) return "";
  const parts = raw.split("/");
  if (parts.includes("..")) return "";
  return parts.filter((part) => part && part !== ".").join("/") || ".";
}

function buildBriefText(payload) {
  const lines = [];
  for (const item of payload.items || []) {
    const warning = item.freshness === "current" ? "" : ` [${item.freshness}]`;
    lines.push(`${item.kind}: ${item.title}${warning} — ${item.summary}`);
  }
  for (const task of payload.recent_tasks || []) {
    lines.push(`recent_task: ${task.title}${task.objective ? ` — ${task.objective}` : ""}`);
  }
  return lines.join("\n").slice(0, 2_400);
}

function cosineSimilarity(left, right) {
  if (!(left instanceof Float32Array) || !(right instanceof Float32Array) ||
      left.length !== right.length || !left.length) return null;
  let dot = 0;
  for (let index = 0; index < left.length; index++) dot += left[index] * right[index];
  return Number.isFinite(dot) ? Math.max(-1, Math.min(1, dot)) : null;
}

function semanticBoost(similarity) {
  if (similarity < 0.72) return 0;
  return Math.min(35, ((similarity - 0.72) / 0.28) * 35);
}

function compact(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value));
}
