// Local Coding Agent
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  SqliteWorkerDatabase,
  assertSqliteCapability,
  openRegistryDatabase
} from "../storage/database.mjs";
import {
  classifyTaskComplexity,
  createTaskOrchestration,
  normalizeTaskObjective,
  normalizeTaskOrchestration
} from "./task-orchestration.mjs";

const MAX_WORKSPACES_PER_TASK = 9;

export class TaskRouterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "TaskRouterError";
    this.code = code;
    this.details = details;
  }
}

export class TaskRouter {
  constructor({ database, databasePath }) {
    this.database = database;
    this.databasePath = databasePath;
  }

  static async open({ dataDir, busyTimeoutMs = 5_000 } = {}) {
    if (!dataDir) throw new TypeError("TaskRouter.open requires dataDir");
    await assertSqliteCapability();
    const root = path.resolve(dataDir);
    await mkdir(root, { recursive: true });
    const databasePath = path.join(root, "registry.sqlite");
    const database = await openRegistryDatabase({
      databasePath,
      busyTimeoutMs
    });
    await migrateLegacyTaskRouter({ root, database, busyTimeoutMs });
    return new TaskRouter({ database, databasePath });
  }

  async openTask({
    title,
    objective,
    complexityHint,
    complexityOverride = false,
    primaryWorkspaceId,
    attachedWorkspaceIds = [],
    ownerSessionId = null,
    workspaceBaselines = []
  } = {}) {
    const primary = validateWorkspaceId(primaryWorkspaceId);
    const attached = dedupe(attachedWorkspaceIds.map(validateWorkspaceId)).filter((id) => id !== primary);
    const workspaceIds = [primary, ...attached];
    if (workspaceIds.length > MAX_WORKSPACES_PER_TASK) {
      throw new TaskRouterError("TOO_MANY_WORKSPACES", `A task supports at most ${MAX_WORKSPACES_PER_TASK} workspaces.`);
    }
    const normalizedObjective = normalizeTaskObjective(objective);
    const normalizedTitle = normalizeTitle(title || normalizedObjective || "LCA task");
    const classification = classifyTaskComplexity({
      complexityHint,
      complexityOverride,
      workspaceCount: workspaceIds.length
    });
    const orchestration = createTaskOrchestration(classification);
    const taskId = `task_${randomUUID().replaceAll("-", "")}`;
    const taskToken = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(taskToken);
    const timestamp = isoNow();
    const baselines = normalizeWorkspaceBaselines(workspaceIds, workspaceBaselines);
    const steps = [{
      mode: "run",
      sql: `
        INSERT INTO task_router_tasks(
          id, token_hash, owner_session_id, title, objective,
          requested_profile, effective_profile, complexity_override,
          profile_confidence, orchestration_json, status, version,
          workspace_set_frozen, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, 0, ?, ?)
      `,
      params: [
        taskId,
        tokenHash,
        ownerSessionId ? String(ownerSessionId) : null,
        normalizedTitle,
        normalizedObjective || null,
        classification.requested_profile,
        classification.effective_profile,
        classification.complexity_override ? 1 : 0,
        classification.confidence,
        JSON.stringify(orchestration),
        timestamp,
        timestamp
      ]
    }, ...workspaceIds.map((workspaceId, index) => ({
      mode: "run",
      sql: `
        INSERT INTO task_router_workspaces(task_id, workspace_id, role, attached_at)
        VALUES (?, ?, ?, ?)
      `,
      params: [taskId, workspaceId, index === 0 ? "primary" : "attached", timestamp]
    })), ...workspaceIds.map((workspaceId) => baselineInsertStep(
      taskId,
      workspaceId,
      baselines.get(workspaceId),
      timestamp
    ))];
    if (ownerSessionId) steps.push(sessionBindingStep(String(ownerSessionId), taskId, timestamp));
    await this.database.batch(steps);
    return { ...(await this.getTaskById(taskId)), task_token: taskToken };
  }

  async resumeTask({ taskToken, sessionId } = {}) {
    const task = await this.getTaskByToken(taskToken);
    if (task.status !== "open") {
      throw new TaskRouterError("TASK_CLOSED", `Task is ${task.status}: ${task.id}`, { task_id: task.id });
    }
    if (sessionId) {
      const timestamp = isoNow();
      await this.database.batch([
        sessionBindingStep(String(sessionId), task.id, timestamp),
        {
          mode: "run",
          sql: "UPDATE task_router_tasks SET owner_session_id = ?, updated_at = ? WHERE id = ?",
          params: [String(sessionId), timestamp, task.id]
        }
      ]);
    }
    return this.getTaskById(task.id);
  }

  async getTask({ taskToken, sessionId, required = true } = {}) {
    let task = null;
    if (taskToken) {
      task = await this.getTaskByToken(taskToken);
      if (sessionId) {
        const boundTask = await this.getTaskBySession(sessionId);
        if (!boundTask) {
          throw new TaskRouterError(
            "TASK_CONTEXT_REQUIRED",
            "Resume the task with task_open before using its token in this stateful MCP session.",
            { task_id: task.id }
          );
        }
        if (boundTask.id !== task.id) {
          throw new TaskRouterError(
            "TASK_CONTEXT_MISMATCH",
            `Task token ${task.id} does not match the task bound to this MCP session.`,
            {
              task_id: task.id,
              bound_task_id: boundTask.id
            }
          );
        }
      }
    } else if (sessionId) {
      task = await this.getTaskBySession(sessionId);
    }
    if (!task && required) {
      throw new TaskRouterError(
        "TASK_CONTEXT_REQUIRED",
        "Open a task or provide task_token before using task-scoped workspace operations."
      );
    }
    return task;
  }

  async getTaskBySession(sessionId) {
    const id = String(sessionId || "").trim();
    if (!id) return null;
    const row = await this.database.get(
      `
        SELECT t.* FROM task_router_sessions s
        JOIN task_router_tasks t ON t.id = s.task_id
        WHERE s.session_id = ?
      `,
      [id]
    );
    return row ? this.hydrate(row) : null;
  }

  async unbindSession(sessionId) {
    const id = String(sessionId || "").trim();
    if (!id) return false;
    const timestamp = isoNow();
    const results = await this.database.batch([
      {
        mode: "run",
        sql: "DELETE FROM task_router_sessions WHERE session_id = ?",
        params: [id]
      },
      {
        mode: "run",
        sql: `
          UPDATE task_router_tasks
          SET owner_session_id = NULL, updated_at = ?
          WHERE owner_session_id = ?
        `,
        params: [timestamp, id]
      }
    ]);
    return Number(results[0]?.changes || 0) > 0;
  }

  async getTaskByToken(taskToken) {
    const token = String(taskToken || "");
    if (!token) throw new TaskRouterError("TASK_TOKEN_REQUIRED", "task_token is required");
    const row = await this.database.get(
      "SELECT * FROM task_router_tasks WHERE token_hash = ?",
      [hashToken(token)]
    );
    if (!row) throw new TaskRouterError("TASK_TOKEN_INVALID", "Task token is invalid or expired.");
    return this.hydrate(row);
  }

  async getTaskById(taskId) {
    const row = await this.database.get("SELECT * FROM task_router_tasks WHERE id = ?", [String(taskId)]);
    if (!row) throw new TaskRouterError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
    return this.hydrate(row);
  }

  async assertWorkspaceAccess({ taskToken, sessionId, workspaceId } = {}) {
    const task = await this.getTask({ taskToken, sessionId });
    if (task.status !== "open") {
      throw new TaskRouterError("TASK_CLOSED", `Task is ${task.status}: ${task.id}`, {
        task_id: task.id
      });
    }
    const workspace = validateWorkspaceId(workspaceId);
    if (!task.workspace_ids.includes(workspace)) {
      throw new TaskRouterError(
        "TASK_WORKSPACE_NOT_ATTACHED",
        `Workspace ${workspace} is not attached to task ${task.id}.`,
        {
          task_id: task.id,
          workspace_id: workspace,
          workspace_ids: task.workspace_ids
        }
      );
    }
    return task;
  }

  async attachWorkspace({ taskToken, workspaceId, baseline } = {}) {
    const task = await this.getTaskByToken(taskToken);
    assertWorkspaceSetMutable(task);
    const workspace = validateWorkspaceId(workspaceId);
    if (task.workspaces.some((item) => item.workspace_id === workspace)) return task;
    if (task.workspaces.length >= MAX_WORKSPACES_PER_TASK) {
      throw new TaskRouterError("TOO_MANY_WORKSPACES", `A task supports at most ${MAX_WORKSPACES_PER_TASK} workspaces.`);
    }
    const timestamp = isoNow();
    const results = await this.database.batch([
      {
        mode: "run",
        sql: `
          INSERT OR IGNORE INTO task_router_workspaces(task_id, workspace_id, role, attached_at)
          SELECT id, ?, 'attached', ?
          FROM task_router_tasks
          WHERE id = ? AND status = 'open' AND workspace_set_frozen = 0
            AND (
              SELECT COUNT(*) FROM task_router_workspaces
              WHERE task_id = ?
            ) < ?
        `,
        params: [workspace, timestamp, task.id, task.id, MAX_WORKSPACES_PER_TASK]
      },
      {
        mode: "run",
        sql: `
          UPDATE task_router_tasks
          SET version = version + 1, updated_at = ?
          WHERE id = ? AND changes() > 0
        `,
        params: [timestamp, task.id]
      },
      baselineInsertStep(task.id, workspace, normalizeBaseline(baseline), timestamp)
    ]);
    const current = await this.getTaskById(task.id);
    if (Number(results[0]?.changes || 0) === 0) {
      assertWorkspaceSetMutable(current);
      if (!current.workspace_ids.includes(workspace) && current.workspaces.length >= MAX_WORKSPACES_PER_TASK) {
        throw new TaskRouterError("TOO_MANY_WORKSPACES", `A task supports at most ${MAX_WORKSPACES_PER_TASK} workspaces.`);
      }
    }
    return current;
  }

  async detachWorkspace({ taskToken, workspaceId } = {}) {
    const task = await this.getTaskByToken(taskToken);
    assertWorkspaceSetMutable(task);
    const workspace = validateWorkspaceId(workspaceId);
    const item = task.workspaces.find((entry) => entry.workspace_id === workspace);
    if (!item) return task;
    if (item.role === "primary") throw new TaskRouterError("PRIMARY_WORKSPACE_REQUIRED", "The primary workspace cannot be detached.");
    const timestamp = isoNow();
    const results = await this.database.batch([
      {
        mode: "run",
        sql: `
          DELETE FROM task_router_workspaces
          WHERE task_id = ? AND workspace_id = ? AND role = 'attached'
            AND EXISTS (
              SELECT 1 FROM task_router_tasks
              WHERE id = ? AND status = 'open' AND workspace_set_frozen = 0
            )
        `,
        params: [task.id, workspace, task.id]
      },
      {
        mode: "run",
        sql: `
          UPDATE task_router_tasks
          SET version = version + 1, updated_at = ?
          WHERE id = ? AND changes() > 0
        `,
        params: [timestamp, task.id]
      }
    ]);
    const current = await this.getTaskById(task.id);
    if (Number(results[0]?.changes || 0) === 0 && current.workspace_ids.includes(workspace)) {
      assertWorkspaceSetMutable(current);
    }
    return current;
  }

  async freezeWorkspaceSet({ taskToken, sessionId } = {}) {
    const task = await this.getTask({ taskToken, sessionId });
    if (task.status !== "open") throw new TaskRouterError("TASK_CLOSED", `Task is ${task.status}: ${task.id}`);
    if (task.workspace_set_frozen) return task;
    const timestamp = isoNow();
    await this.database.run(
      `
        UPDATE task_router_tasks
        SET workspace_set_frozen = 1, mutation_started_at = ?,
            version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'open'
      `,
      [timestamp, timestamp, task.id]
    );
    return this.getTaskById(task.id);
  }

  async closeTask({ taskToken, sessionId, status = "closed" } = {}) {
    const task = await this.getTask({ taskToken, sessionId });
    const nextStatus = status === "failed" ? "failed" : "closed";
    const timestamp = isoNow();
    await this.database.batch([
      {
        mode: "run",
        sql: `
          UPDATE task_router_tasks
          SET status = ?, version = version + 1,
              closed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'open'
        `,
        params: [nextStatus, timestamp, timestamp, task.id]
      },
      {
        mode: "run",
        sql: "DELETE FROM task_router_sessions WHERE task_id = ?",
        params: [task.id]
      }
    ]);
    return this.getTaskById(task.id);
  }

  async updateOrchestration({ taskId, orchestration, effectiveProfile, profileConfidence } = {}) {
    const id = String(taskId || "");
    if (!/^task_[A-Za-z0-9_-]{8,160}$/.test(id)) {
      throw new TaskRouterError("INVALID_TASK_ID", `Invalid task ID: ${id}`);
    }
    const current = await this.getTaskById(id);
    if (current.status !== "open") return current;
    const normalized = normalizeTaskOrchestration(
      orchestration,
      effectiveProfile || current.effective_profile
    );
    const timestamp = isoNow();
    await this.database.run(
      `
        UPDATE task_router_tasks
        SET effective_profile = ?, profile_confidence = ?, orchestration_json = ?, updated_at = ?
        WHERE id = ? AND status = 'open'
      `,
      [
        normalized.effective_profile,
        Number.isFinite(Number(profileConfidence)) ? Number(profileConfidence) : normalized.confidence,
        JSON.stringify(normalized),
        timestamp,
        id
      ]
    );
    return this.getTaskById(id);
  }

  async listTasksForWorkspace({ workspaceId } = {}) {
    const workspace = validateWorkspaceId(workspaceId);
    const rows = await this.database.all(
      `
        SELECT t.*
        FROM task_router_tasks t
        JOIN task_router_workspaces w ON w.task_id = t.id
        WHERE w.workspace_id = ?
        ORDER BY t.updated_at DESC
      `,
      [workspace]
    );
    return Promise.all(rows.map((row) => this.hydrate(row)));
  }

  async deleteTask({ taskId } = {}) {
    const id = validateTaskId(taskId);
    const task = await this.getTaskById(id);
    if (task.status === "open") {
      throw new TaskRouterError(
        "TASK_OPEN",
        `Close task ${task.id} before deleting it.`,
        { task_id: task.id }
      );
    }
    const result = await this.database.run(
      "DELETE FROM task_router_tasks WHERE id = ? AND status <> 'open'",
      [id]
    );
    return {
      ok: true,
      deleted: Number(result?.changes || 0),
      task_id: id,
      workspace_ids: task.workspace_ids
    };
  }

  async listTasks({ limit = 100, status } = {}) {
    const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
    const rows = status
      ? await this.database.all(
          "SELECT * FROM task_router_tasks WHERE status = ? ORDER BY updated_at DESC LIMIT ?",
          [String(status), bounded]
        )
      : await this.database.all("SELECT * FROM task_router_tasks ORDER BY updated_at DESC LIMIT ?", [bounded]);
    return Promise.all(rows.map((row) => this.hydrate(row)));
  }

  async hydrate(row) {
    const workspaces = await this.database.all(
      `
        SELECT
          w.workspace_id,
          w.role,
          w.attached_at,
          b.known AS baseline_known,
          b.base_head AS baseline_base_head,
          b.branch AS baseline_branch,
          b.clean AS baseline_clean,
          b.dirty_unknown AS baseline_dirty_unknown,
          b.dirty_json AS baseline_dirty_json,
          b.captured_at AS baseline_captured_at
        FROM task_router_workspaces w
        LEFT JOIN task_router_workspace_baselines b
          ON b.task_id = w.task_id AND b.workspace_id = w.workspace_id
        WHERE w.task_id = ?
        ORDER BY CASE w.role WHEN 'primary' THEN 0 ELSE 1 END, w.attached_at, w.workspace_id
      `,
      [row.id]
    );
    const hydratedWorkspaces = workspaces.map(hydrateWorkspace);
    let orchestrationSource = null;
    try {
      orchestrationSource = JSON.parse(row.orchestration_json || "{}");
    } catch {}
    const orchestration = normalizeTaskOrchestration(orchestrationSource, row.effective_profile || "normal");
    return {
      id: row.id,
      title: row.title,
      objective: row.objective || null,
      requested_profile: row.requested_profile || null,
      effective_profile: orchestration.effective_profile,
      complexity_override: Boolean(row.complexity_override),
      profile_confidence: Number.isFinite(Number(row.profile_confidence))
        ? Number(row.profile_confidence)
        : orchestration.confidence,
      orchestration,
      status: row.status,
      version: Number(row.version),
      owner_session_id: row.owner_session_id || null,
      workspace_set_frozen: Boolean(row.workspace_set_frozen),
      mutation_started_at: row.mutation_started_at || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      closed_at: row.closed_at || null,
      primary_workspace_id: hydratedWorkspaces.find((item) => item.role === "primary")?.workspace_id || null,
      workspace_ids: hydratedWorkspaces.map((item) => item.workspace_id),
      workspaces: hydratedWorkspaces,
      workspace_baselines: hydratedWorkspaces.map((item) => ({
        workspace_id: item.workspace_id,
        ...item.baseline
      }))
    };
  }

  async health() {
    return this.database.health();
  }

  async close() {
    await this.database.close();
  }
}

async function migrateLegacyTaskRouter({ root, database, busyTimeoutMs }) {
  const legacyPath = path.join(root, "task-router.sqlite3");
  if (!await stat(legacyPath).then((info) => info.isFile()).catch(() => false)) return;
  const existing = Number(
    (await database.get("SELECT COUNT(*) AS count FROM task_router_tasks"))?.count || 0
  );
  if (existing > 0) return;

  const legacy = await SqliteWorkerDatabase.open({
    databasePath: legacyPath,
    busyTimeoutMs,
    schema: { version: 1, migrations: [] }
  });
  try {
    const [tasks, workspaces, sessions, registered] = await Promise.all([
      legacy.all("SELECT * FROM task_router_tasks ORDER BY created_at, id"),
      legacy.all("SELECT * FROM task_router_workspaces ORDER BY attached_at, task_id, workspace_id"),
      legacy.all("SELECT * FROM task_router_sessions ORDER BY bound_at, session_id"),
      database.all("SELECT id FROM workspaces")
    ]);
    if (!tasks.length) return;
    const registeredIds = new Set(registered.map((row) => row.id));
    const missingWorkspaceIds = [...new Set(
      workspaces
        .map((row) => row.workspace_id)
        .filter((workspaceId) => !registeredIds.has(workspaceId))
    )];
    if (missingWorkspaceIds.length) {
      throw new TaskRouterError(
        "LEGACY_TASK_MIGRATION_BLOCKED",
        "Legacy tasks reference workspaces that are not present in registry.sqlite.",
        { legacy_path: legacyPath, missing_workspace_ids: missingWorkspaceIds }
      );
    }

    await database.batch([
      ...tasks.map((row) => ({
        mode: "run",
        sql: `
          INSERT INTO task_router_tasks(
            id, token_hash, owner_session_id, title, status, version,
            workspace_set_frozen, mutation_started_at, created_at, updated_at, closed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        params: [
          row.id,
          row.token_hash,
          row.owner_session_id,
          row.title,
          row.status,
          row.version,
          row.workspace_set_frozen,
          row.mutation_started_at,
          row.created_at,
          row.updated_at,
          row.closed_at
        ]
      })),
      ...workspaces.map((row) => ({
        mode: "run",
        sql: `
          INSERT INTO task_router_workspaces(task_id, workspace_id, role, attached_at)
          VALUES (?, ?, ?, ?)
        `,
        params: [row.task_id, row.workspace_id, row.role, row.attached_at]
      })),
      ...workspaces.map((row) => baselineInsertStep(
        row.task_id,
        row.workspace_id,
        { known: false },
        row.attached_at
      )),
      ...sessions.map((row) => ({
        mode: "run",
        sql: `
          INSERT INTO task_router_sessions(session_id, task_id, bound_at, updated_at)
          VALUES (?, ?, ?, ?)
        `,
        params: [row.session_id, row.task_id, row.bound_at, row.updated_at]
      })),
      {
        mode: "run",
        sql: `
          INSERT INTO schema_meta(key, value) VALUES ('legacy_task_router_migrated_from', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `,
        params: [legacyPath]
      }
    ]);
  } finally {
    await legacy.close();
  }
}

function sessionBindingStep(sessionId, taskId, timestamp) {
  return {
    mode: "run",
    sql: `
      INSERT INTO task_router_sessions(session_id, task_id, bound_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        task_id = excluded.task_id,
        updated_at = excluded.updated_at
    `,
    params: [sessionId, taskId, timestamp, timestamp]
  };
}

function baselineInsertStep(taskId, workspaceId, baseline, timestamp) {
  const normalized = normalizeBaseline(baseline);
  return {
    mode: "run",
    sql: `
      INSERT OR IGNORE INTO task_router_workspace_baselines(
        task_id, workspace_id, known, base_head, branch, clean,
        dirty_unknown, dirty_json, captured_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM task_router_workspaces
        WHERE task_id = ? AND workspace_id = ?
      )
    `,
    params: [
      taskId,
      workspaceId,
      normalized.known ? 1 : 0,
      normalized.base_head,
      normalized.branch,
      normalized.clean === null ? null : (normalized.clean ? 1 : 0),
      normalized.dirty_unknown === null ? null : (normalized.dirty_unknown ? 1 : 0),
      normalized.dirty === null ? null : JSON.stringify(normalized.dirty),
      normalizeTimestamp(normalized.captured_at) || timestamp,
      taskId,
      workspaceId
    ]
  };
}

function normalizeWorkspaceBaselines(workspaceIds, values) {
  const byWorkspace = new Map();
  const entries = Array.isArray(values)
    ? values
    : values && typeof values === "object"
      ? Object.entries(values).map(([workspace_id, baseline]) => ({ workspace_id, ...baseline }))
      : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const workspaceId = String(entry.workspace_id || "");
    if (!workspaceIds.includes(workspaceId)) continue;
    byWorkspace.set(workspaceId, normalizeBaseline(entry));
  }
  for (const workspaceId of workspaceIds) {
    if (!byWorkspace.has(workspaceId)) byWorkspace.set(workspaceId, normalizeBaseline(null));
  }
  return byWorkspace;
}

function normalizeBaseline(value) {
  if (!value || typeof value !== "object" || value.known !== true) {
    return {
      known: false,
      base_head: null,
      branch: null,
      clean: null,
      dirty_unknown: null,
      dirty: null,
      captured_at: normalizeTimestamp(value?.captured_at)
    };
  }
  const dirty = normalizeJsonValue(value.dirty);
  return {
    known: true,
    base_head: normalizeOptionalText(value.base_head, 256),
    branch: normalizeOptionalText(value.branch, 512),
    clean: typeof value.clean === "boolean" ? value.clean : null,
    dirty_unknown: typeof value.dirty_unknown === "boolean" ? value.dirty_unknown : null,
    dirty,
    captured_at: normalizeTimestamp(value.captured_at)
  };
}

function hydrateWorkspace(row) {
  let dirty = null;
  let baselineKnown = Boolean(row.baseline_known);
  if (row.baseline_dirty_json !== null && row.baseline_dirty_json !== undefined) {
    try {
      dirty = JSON.parse(row.baseline_dirty_json);
    } catch {
      baselineKnown = false;
    }
  }
  return {
    workspace_id: row.workspace_id,
    role: row.role,
    attached_at: row.attached_at,
    baseline: {
      known: baselineKnown,
      base_head: baselineKnown ? row.baseline_base_head || null : null,
      branch: baselineKnown ? row.baseline_branch || null : null,
      clean: baselineKnown && row.baseline_clean !== null
        ? Boolean(row.baseline_clean)
        : null,
      dirty_unknown: baselineKnown && row.baseline_dirty_unknown !== null
        ? Boolean(row.baseline_dirty_unknown)
        : null,
      dirty: baselineKnown ? dirty : null,
      captured_at: row.baseline_captured_at || null
    }
  };
}

function normalizeOptionalText(value, maxLength) {
  if (value === null || value === undefined || value === "") return null;
  return String(value).slice(0, maxLength);
}

function normalizeTimestamp(value) {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeJsonValue(value) {
  if (value === undefined || value === null) return null;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > 64 * 1024) return { truncated: true };
    return JSON.parse(serialized);
  } catch {
    return { serialization_failed: true };
  }
}

function bumpTaskStep(taskId, timestamp) {
  return {
    mode: "run",
    sql: "UPDATE task_router_tasks SET version = version + 1, updated_at = ? WHERE id = ?",
    params: [timestamp, taskId]
  };
}

function assertWorkspaceSetMutable(task) {
  if (task.status !== "open") throw new TaskRouterError("TASK_CLOSED", `Task is ${task.status}: ${task.id}`);
  if (task.workspace_set_frozen) {
    throw new TaskRouterError(
      "TASK_WORKSPACE_SET_FROZEN",
      "Workspace attachments cannot change after the first mutation. Open a new task."
    );
  }
}

function validateTaskId(value) {
  const id = String(value || "");
  if (!/^task_[A-Za-z0-9_-]{8,160}$/.test(id)) {
    throw new TaskRouterError("INVALID_TASK_ID", `Invalid task ID: ${id}`);
  }
  return id;
}

function validateWorkspaceId(value) {
  const id = String(value || "");
  if (!/^ws_[a-z0-9]{16,64}$/i.test(id)) throw new TaskRouterError("INVALID_WORKSPACE_ID", `Invalid workspace ID: ${id}`);
  return id;
}

function normalizeTitle(value) {
  return String(value || "LCA task").replace(/\s+/g, " ").trim().slice(0, 180) || "LCA task";
}

function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function dedupe(values) {
  return [...new Set(values)];
}

function isoNow() {
  return new Date().toISOString();
}
