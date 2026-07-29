// Compact deterministic policy for task-close workspace Memory updates.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import { assertWorkspaceMemoryPublicText } from "./workspace-memory.mjs";

export const MAX_TASK_CLOSE_MEMORY_OPERATIONS = 6;
const ACTIONS = new Set([
  "save", "update", "supersede", "pin", "unpin", "resolve",
  "archive", "restore", "current", "stale"
]);
const TRANSITIONS = new Set([
  "pin", "unpin", "resolve", "archive", "restore", "current", "stale"
]);
const KINDS = new Set([
  "project_goal", "architecture_decision", "constraint", "known_issue",
  "open_question", "user_preference", "verification_result"
]);
const LIFECYCLES = new Set(["active", "resolved", "superseded", "archived"]);
const FRESHNESS = new Set(["current", "needs_review", "stale"]);

export function prepareTaskMemoryOutbox(task, updates = []) {
  if (!task?.id || !Array.isArray(task.workspace_ids) || !task.primary_workspace_id) {
    throw policyError("WORKSPACE_MEMORY_TASK_INVALID", "Task context is required for Memory persistence.");
  }
  const source = Array.isArray(updates) ? updates : [];
  const accepted = [];
  const dropReasons = [];
  const maxNew = task.effective_profile === "complex" ? 2 : 1;
  let newCount = 0;

  for (let index = 0; index < source.length; index++) {
    if (index >= MAX_TASK_CLOSE_MEMORY_OPERATIONS) {
      dropReasons.push("operation_limit");
      continue;
    }
    const raw = source[index] || {};
    const action = String(raw.action || "save");
    if (!ACTIONS.has(action)) {
      throw policyError("WORKSPACE_MEMORY_ACTION_INVALID", `Unsupported task_close Memory action: ${action}`);
    }
    const workspaceId = String(raw.workspace_id || task.primary_workspace_id);
    if (!task.workspace_ids.includes(workspaceId)) {
      throw policyError("WORKSPACE_NOT_ATTACHED", `Memory update targets unattached workspace ${workspaceId}.`);
    }
    if (action === "save") {
      if (newCount >= maxNew) {
        dropReasons.push("new_memory_limit");
        continue;
      }
      newCount++;
    }
    accepted.push({ workspaceId, update: normalizeUpdate(raw, action, workspaceId) });
  }

  const grouped = new Map();
  for (const entry of accepted) {
    const list = grouped.get(entry.workspaceId) || [];
    list.push(entry.update);
    grouped.set(entry.workspaceId, list);
  }
  const createdAt = new Date().toISOString();
  const taskSnapshot = compactTask(task);
  const jobs = [...grouped.entries()].map(([workspaceId, workspaceUpdates]) => {
    const payload = {
      version: 1,
      workspace_id: workspaceId,
      task: taskSnapshot,
      updates: workspaceUpdates
    };
    return {
      id: `memory_job_${randomUUID().replaceAll("-", "")}`,
      workspace_id: workspaceId,
      payload_hash: sha256(JSON.stringify(payload)),
      payload,
      available_at: createdAt,
      created_at: createdAt
    };
  });
  return {
    jobs,
    response: jobs.length ? {
      status: "queued",
      job_ids: jobs.map((job) => job.id),
      accepted_updates: accepted.length,
      dropped_updates: dropReasons.length,
      drop_reasons: [...new Set(dropReasons)],
      workspace_count: jobs.length
    } : {
      status: "skipped",
      job_ids: [],
      accepted_updates: 0,
      dropped_updates: dropReasons.length,
      drop_reasons: [...new Set(dropReasons)],
      workspace_count: 0
    }
  };
}

function normalizeUpdate(raw, action, workspaceId) {
  if (TRANSITIONS.has(action)) {
    return { action, id: requireMemoryId(raw.id) };
  }
  if (action === "save") {
    const body = compactContent(raw, { requireContent: true });
    body.id = stableMemoryId(workspaceId, { action, ...body });
    return { action, ...body };
  }
  if (action === "update") {
    const expectedRevision = requireRevision(raw.expected_revision, action);
    const body = compactContent(raw, { requireContent: false });
    if (!Object.keys(body).length) {
      throw policyError("WORKSPACE_MEMORY_CONTENT_INVALID", "task_close update must change at least one Memory field.");
    }
    return { action, id: requireMemoryId(raw.id), expected_revision: expectedRevision, ...body };
  }
  const existingId = requireMemoryId(raw.id);
  const expectedRevision = requireRevision(raw.expected_revision, action);
  const replacement = compactContent(raw.replacement || raw, { requireContent: true });
  replacement.id = stableMemoryId(workspaceId, {
    action,
    supersedes_id: existingId,
    replacement
  });
  return {
    action,
    id: existingId,
    expected_revision: expectedRevision,
    replacement
  };
}

function compactContent(raw, { requireContent }) {
  const output = {};
  if (raw.kind !== undefined) {
    const kind = String(raw.kind);
    if (!KINDS.has(kind)) throw policyError("WORKSPACE_MEMORY_CONTENT_INVALID", `Invalid Memory kind: ${kind}`);
    output.kind = kind;
  }
  if (raw.title !== undefined || requireContent) {
    const title = compact(raw.title, 180);
    if (!title) throw policyError("WORKSPACE_MEMORY_CONTENT_INVALID", "Memory title is required.");
    output.title = title;
  }
  if (raw.summary !== undefined || requireContent) {
    const summary = compactMultiline(raw.summary, 800);
    if (!summary) throw policyError("WORKSPACE_MEMORY_CONTENT_INVALID", "Memory summary is required.");
    output.summary = summary;
  }
  if (output.title || output.summary) {
    assertWorkspaceMemoryPublicText(`${output.title || ""}\n${output.summary || ""}`);
  }
  if (raw.lifecycle !== undefined) {
    const lifecycle = String(raw.lifecycle);
    if (!LIFECYCLES.has(lifecycle)) {
      throw policyError("WORKSPACE_MEMORY_CONTENT_INVALID", `Invalid Memory lifecycle: ${lifecycle}`);
    }
    output.lifecycle = lifecycle;
  }
  if (raw.freshness !== undefined) {
    const freshness = String(raw.freshness);
    if (!FRESHNESS.has(freshness)) {
      throw policyError("WORKSPACE_MEMORY_CONTENT_INVALID", `Invalid Memory freshness: ${freshness}`);
    }
    output.freshness = freshness;
  }
  if (raw.pinned !== undefined) {
    if (typeof raw.pinned !== "boolean") {
      throw policyError("WORKSPACE_MEMORY_CONTENT_INVALID", "Memory pinned must be boolean.");
    }
    output.pinned = raw.pinned;
  }
  if (raw.confidence !== undefined) {
    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw policyError("WORKSPACE_MEMORY_CONTENT_INVALID", "Memory confidence must be between 0 and 1.");
    }
    output.confidence = confidence;
  }
  if (raw.paths !== undefined) output.paths = compactList(raw.paths, 8, 2_000);
  if (raw.tags !== undefined) output.tags = compactList(raw.tags, 8, 48, true);
  return output;
}

function compactTask(task) {
  return {
    id: String(task.id),
    primary_workspace_id: String(task.primary_workspace_id),
    workspace_ids: [...task.workspace_ids],
    effective_profile: task.effective_profile || "normal",
    workspaces: (task.workspaces || []).map((workspace) => ({
      workspace_id: workspace.workspace_id,
      baseline: {
        base_head: workspace.baseline?.base_head || null
      }
    }))
  };
}

function stableMemoryId(workspaceId, payload) {
  return `memory_auto_${sha256(`${workspaceId}\n${JSON.stringify(payload)}`).slice(0, 32)}`;
}

function requireMemoryId(value) {
  const id = String(value || "");
  if (!/^memory_[A-Za-z0-9_-]{8,160}$/.test(id)) {
    throw policyError("WORKSPACE_MEMORY_ID_INVALID", "A valid existing Memory ID is required.");
  }
  return id;
}

function requireRevision(value, action) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) {
    throw policyError(
      "WORKSPACE_MEMORY_REVISION_REQUIRED",
      `expected_revision is required for task_close ${action}.`
    );
  }
  return revision;
}

function compactList(values, maxItems, maxLength, lower = false) {
  if (!Array.isArray(values)) throw policyError("WORKSPACE_MEMORY_CONTENT_INVALID", "Memory paths and tags must be arrays.");
  const result = [];
  for (const value of values) {
    let item = compact(value, maxLength);
    if (lower) item = item.toLowerCase();
    if (item && !result.includes(item)) result.push(item);
    if (result.length >= maxItems) break;
  }
  return result;
}

function compact(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function compactMultiline(value, max) {
  return String(value || "").replace(/\r\n?/g, "\n").trim().slice(0, max);
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function policyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
