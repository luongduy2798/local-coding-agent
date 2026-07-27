// Local Coding Agent workspace-scoped task storage
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { openWorkspaceDatabase } from "../storage/database.mjs";
import { WorkspaceRegistryError } from "./registry-contract.mjs";
import {
  attachmentFromRow,
  attachmentInsertStep,
  inspectAttachment,
  inspectAttachments,
  normalizedPathKey,
  noteFromRow,
  nowIso,
  taskFromRow,
  validateTaskId,
  validateToken,
  workspaceIdentityAvailable
} from "./registry-helpers.mjs";

export class WorkspaceDatabase {
  #database = null;
  #opening = null;
  #closed = false;
  #onUse;
  #activeOperations = 0;
  #evictionRequested = false;
  #idleWaiters = [];

  constructor({
    workspace,
    databasePath,
    busyTimeoutMs = 5_000,
    onUse
  }) {
    this.workspace = workspace;
    this.workspaceId = workspace.id;
    this.root = workspace.canonicalRoot;
    this.databasePath = databasePath;
    this.busyTimeoutMs = busyTimeoutMs;
    this.#onUse = onUse;
  }

  async #ensureOpen() {
    if (this.#closed) {
      throw new WorkspaceRegistryError("WORKSPACE_DATABASE_CLOSED", "Workspace database is closed.");
    }
    this.#evictionRequested = false;
    await this.#onUse?.(this);
    if (this.#database) return this.#database;
    if (!this.#opening) {
      this.#opening = openWorkspaceDatabase({
        databasePath: this.databasePath,
        busyTimeoutMs: this.busyTimeoutMs
      }).then((database) => {
        this.#database = database;
        return database;
      }).finally(() => {
        this.#opening = null;
      });
    }
    return this.#opening;
  }

  async #withDatabase(operation) {
    this.#activeOperations++;
    try {
      const database = await this.#ensureOpen();
      return await operation(database);
    } finally {
      this.#activeOperations--;
      if (this.#activeOperations === 0) {
        const waiters = this.#idleWaiters.splice(0);
        for (const resolve of waiters) resolve();
        if (this.#evictionRequested && !this.#closed) {
          this.#evictionRequested = false;
          await this.evict();
        }
      }
    }
  }

  async #waitForIdle() {
    if (this.#activeOperations === 0) return;
    await new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  async #assertRootAvailable() {
    if (!(await workspaceIdentityAvailable({
      canonicalRoot: this.root,
      requestedRoot: this.workspace.root,
      metadata: this.workspace.metadata
    }))) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_UNAVAILABLE",
        `Workspace is unavailable: ${this.root}`,
        { workspaceId: this.workspaceId, root: this.root }
      );
    }
  }

  async health() {
    return this.#withDatabase((database) => database.health());
  }

  async listNotes({ taskId, limit = 100, offset = 0 } = {}) {
    const id = validateTaskId(taskId);
    const boundedLimit = Math.max(1, Math.min(501, Number(limit) || 100));
    const boundedOffset = Math.max(0, Math.min(100_000, Number(offset) || 0));
    const rows = await this.#withDatabase((database) => database.all(
      `
        SELECT id, task_id, workspace_id, title, body, created_at, updated_at
        FROM notes
        WHERE task_id = ? AND workspace_id = ?
        ORDER BY created_at DESC, id
        LIMIT ? OFFSET ?
      `,
      [id, this.workspaceId, boundedLimit, boundedOffset]
    ));
    return rows.map(noteFromRow);
  }

  async saveNote({
    id = `note_${randomUUID().replaceAll("-", "")}`,
    taskId,
    title,
    body
  } = {}) {
    const task = validateTaskId(taskId);
    const noteId = String(id || "");
    if (!/^note_[A-Za-z0-9_-]{8,160}$/.test(noteId)) {
      throw new WorkspaceRegistryError("INVALID_NOTE_ID", "Invalid note ID.", { noteId });
    }
    const normalizedTitle = String(title || "").replace(/\s+/g, " ").trim().slice(0, 180);
    const normalizedBody = String(body || "").trim();
    if (!normalizedTitle || !normalizedBody) {
      throw new WorkspaceRegistryError(
        "INVALID_NOTE",
        "Note title and body are required."
      );
    }
    const timestamp = nowIso();
    const row = await this.#withDatabase((database) => database.get(
      `
        INSERT INTO notes(
          id, task_id, workspace_id, title, body, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        RETURNING id, task_id, workspace_id, title, body, created_at, updated_at
      `,
      [
        noteId,
        task,
        this.workspaceId,
        normalizedTitle,
        normalizedBody,
        timestamp,
        timestamp
      ]
    ));
    return noteFromRow(row);
  }

  async openTask({
    taskId = `task_${randomUUID().replaceAll("-", "")}`,
    title = "LCA task",
    ownerSessionId = null,
    attachments = []
  } = {}) {
    await this.#assertRootAvailable();
    const id = validateTaskId(taskId);
    const inspected = await inspectAttachments(this.root, attachments);
    const timestamp = nowIso();
    const steps = [{
      mode: "get",
      sql: `
        INSERT INTO tasks(
          id, workspace_id, title, status, token, owner_session_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'open', 1, ?, ?, ?)
        RETURNING *
      `,
      params: [
        id,
        this.workspaceId,
        String(title || "LCA task").replace(/\s+/g, " ").trim().slice(0, 180) || "LCA task",
        ownerSessionId ? String(ownerSessionId) : null,
        timestamp,
        timestamp
      ]
    }, ...inspected.map((item) => attachmentInsertStep(id, item, timestamp))];
    try {
      await this.#withDatabase((database) => database.batch(steps));
    } catch (error) {
      if (/UNIQUE constraint failed: tasks\.id/i.test(error?.message || "")) {
        throw new WorkspaceRegistryError("TASK_ALREADY_EXISTS", `Task already exists: ${id}`, { taskId: id });
      }
      throw error;
    }
    return this.getTask(id);
  }

  async getTask(taskId) {
    const id = validateTaskId(taskId);
    const [task, attachments] = await this.#withDatabase((database) => Promise.all([
      database.get("SELECT * FROM tasks WHERE id = ?", [id]),
      database.all(
        "SELECT * FROM task_attachments WHERE task_id = ? ORDER BY path, canonical_path",
        [id]
      )
    ]));
    if (!task) {
      throw new WorkspaceRegistryError("TASK_NOT_FOUND", `Task not found: ${id}`, { taskId: id });
    }
    return taskFromRow(task, attachments.map(attachmentFromRow));
  }

  async listTasks({ status, limit = 100 } = {}) {
    const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const rows = await this.#withDatabase((database) => status
      ? database.all(
          "SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC LIMIT ?",
          [String(status), boundedLimit]
        )
      : database.all("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?", [boundedLimit]));
    return rows.map((row) => taskFromRow(row));
  }

  async #diagnoseTaskGuard(taskId, expectedToken, allowedStatuses = ["open"]) {
    const row = await this.#withDatabase((database) =>
      database.get("SELECT id, status, token FROM tasks WHERE id = ?", [taskId])
    );
    if (!row) {
      throw new WorkspaceRegistryError("TASK_NOT_FOUND", `Task not found: ${taskId}`, { taskId });
    }
    if (Number(row.token) !== Number(expectedToken)) {
      throw new WorkspaceRegistryError(
        "TASK_TOKEN_STALE",
        `Task token is stale for ${taskId}.`,
        { taskId, expectedToken, currentToken: Number(row.token) }
      );
    }
    if (!allowedStatuses.includes(row.status)) {
      throw new WorkspaceRegistryError(
        "TASK_STATE_INVALID",
        `Task ${taskId} is ${row.status}; expected ${allowedStatuses.join(" or ")}.`,
        { taskId, status: row.status, expectedStatuses: allowedStatuses }
      );
    }
    return row;
  }

  async assertTaskToken(taskId, token, { statuses = ["open"] } = {}) {
    const id = validateTaskId(taskId);
    const expected = validateToken(token);
    await this.#diagnoseTaskGuard(id, expected, statuses);
    return true;
  }

  async rotateTaskToken(taskId, token, { ownerSessionId } = {}) {
    const id = validateTaskId(taskId);
    const expected = validateToken(token);
    const row = await this.#withDatabase((database) => database.get(
      `
        UPDATE tasks
        SET token = token + 1,
            owner_session_id = COALESCE(?, owner_session_id),
            updated_at = ?
        WHERE id = ? AND status = 'open' AND token = ?
        RETURNING *
      `,
      [ownerSessionId ? String(ownerSessionId) : null, nowIso(), id, expected]
    ));
    if (!row) await this.#diagnoseTaskGuard(id, expected, ["open"]);
    return taskFromRow(row);
  }

  async addAttachments(taskId, token, attachments) {
    await this.#assertRootAvailable();
    const id = validateTaskId(taskId);
    const expected = validateToken(token);
    const inspected = await inspectAttachments(this.root, attachments);
    if (!inspected.length) {
      await this.assertTaskToken(id, expected, { statuses: ["open"] });
      return this.getTask(id);
    }
    const timestamp = nowIso();
    const steps = [
      {
        mode: "get",
        sql: "SELECT id FROM tasks WHERE id = ? AND status = 'open' AND token = ?",
        params: [id, expected]
      },
      ...inspected.map((item) =>
        attachmentInsertStep(id, item, timestamp, { conditionalToken: expected })
      ),
      {
        mode: "get",
        sql: `
          UPDATE tasks SET updated_at = ?
          WHERE id = ? AND status = 'open' AND token = ?
          RETURNING id
        `,
        params: [timestamp, id, expected]
      }
    ];
    const results = await this.#withDatabase((database) => database.batch(steps));
    if (!results[0] || !results.at(-1)) {
      await this.#diagnoseTaskGuard(id, expected, ["open"]);
    }
    return this.getTask(id);
  }

  async verifyTaskAttachments(taskId) {
    const task = await this.getTask(taskId);
    const conflicts = [];
    for (const expected of task.attachments) {
      try {
        const current = await inspectAttachment(this.root, {
          path: expected.path,
          access: expected.access
        });
        if (
          current.version !== expected.version
          || current.exists !== expected.exists
          || normalizedPathKey(current.canonicalPath) !== normalizedPathKey(expected.canonicalPath)
        ) {
          conflicts.push({
            path: expected.path,
            expectedVersion: expected.version,
            currentVersion: current.version,
            expectedExists: expected.exists,
            currentExists: current.exists
          });
        }
      } catch (error) {
        conflicts.push({
          path: expected.path,
          error: error?.code || error?.message || String(error)
        });
      }
    }
    return { ok: conflicts.length === 0, taskId: task.id, conflicts };
  }

  async freezeTask(taskId, token, { verifyAttachments = false } = {}) {
    const id = validateTaskId(taskId);
    const expected = validateToken(token);
    if (verifyAttachments) {
      const verification = await this.verifyTaskAttachments(id);
      if (!verification.ok) {
        throw new WorkspaceRegistryError(
          "TASK_ATTACHMENTS_STALE",
          `Task attachments changed before freeze: ${id}`,
          verification
        );
      }
    }
    const timestamp = nowIso();
    const row = await this.#withDatabase((database) => database.get(
      `
        UPDATE tasks
        SET status = 'frozen', token = token + 1,
            frozen_at = ?, updated_at = ?
        WHERE id = ? AND status = 'open' AND token = ?
        RETURNING *
      `,
      [timestamp, timestamp, id, expected]
    ));
    if (!row) await this.#diagnoseTaskGuard(id, expected, ["open"]);
    return this.getTask(id);
  }

  async closeTask(taskId, token) {
    const id = validateTaskId(taskId);
    const expected = validateToken(token);
    const timestamp = nowIso();
    const row = await this.#withDatabase((database) => database.get(
      `
        UPDATE tasks
        SET status = 'closed', token = token + 1,
            closed_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('open', 'frozen') AND token = ?
        RETURNING *
      `,
      [timestamp, timestamp, id, expected]
    ));
    if (!row) await this.#diagnoseTaskGuard(id, expected, ["open", "frozen"]);
    return this.getTask(id);
  }

  async evict() {
    if (this.#activeOperations > 0 || this.#opening) {
      this.#evictionRequested = true;
      return false;
    }
    if (!this.#database) return true;
    const database = this.#database;
    this.#database = null;
    await database.close();
    return true;
  }

  async close() {
    this.#closed = true;
    await this.#opening?.catch(() => {});
    await this.#waitForIdle();
    if (this.#database) {
      const database = this.#database;
      this.#database = null;
      await database.close();
    }
  }
}
