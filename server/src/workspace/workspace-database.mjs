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
import {
  embeddingVectorFromBlob,
  escapeLike,
  hydrateMemoryRows,
  memoryEventStep,
  memoryMetaBumpStep,
  memoryMetaFromRow,
  validateMemoryId
} from "./workspace-memory-database-helpers.mjs";

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

  async getMemoryMeta() {
    const timestamp = nowIso();
    const results = await this.#withDatabase((database) => database.batch([
      {
        mode: "run",
        sql: `
          INSERT INTO workspace_memory_meta(workspace_id, updated_at)
          VALUES (?, ?)
          ON CONFLICT(workspace_id) DO NOTHING
        `,
        params: [this.workspaceId, timestamp]
      },
      {
        mode: "get",
        sql: "SELECT * FROM workspace_memory_meta WHERE workspace_id = ?",
        params: [this.workspaceId]
      }
    ]));
    return memoryMetaFromRow(results[1], this.workspaceId);
  }

  async updateMemorySettings({ enabled, autoLoad, includeRecentTasks, semanticSearch } = {}) {
    await this.getMemoryMeta();
    const row = await this.#withDatabase((database) => database.get(
      `
        UPDATE workspace_memory_meta
        SET enabled = COALESCE(?, enabled),
            auto_load = COALESCE(?, auto_load),
            include_recent_tasks = COALESCE(?, include_recent_tasks),
            semantic_search = COALESCE(?, semantic_search),
            revision = revision + 1,
            cached_brief_revision = 0,
            updated_at = ?
        WHERE workspace_id = ?
        RETURNING *
      `,
      [
        enabled === undefined ? null : enabled ? 1 : 0,
        autoLoad === undefined ? null : autoLoad ? 1 : 0,
        includeRecentTasks === undefined ? null : includeRecentTasks ? 1 : 0,
        semanticSearch === undefined ? null : semanticSearch ? 1 : 0,
        nowIso(),
        this.workspaceId
      ]
    ));
    return memoryMetaFromRow(row, this.workspaceId);
  }

  async listMemoryItems({ query, kind, lifecycle, freshness, limit = 100, offset = 0 } = {}) {
    const clauses = ["workspace_id = ?"];
    const params = [this.workspaceId];
    if (query) {
      clauses.push("(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')");
      const like = `%${escapeLike(query)}%`;
      params.push(like, like);
    }
    if (kind) {
      clauses.push("kind = ?");
      params.push(String(kind));
    }
    if (lifecycle) {
      clauses.push("lifecycle = ?");
      params.push(String(lifecycle));
    }
    if (freshness) {
      clauses.push("freshness = ?");
      params.push(String(freshness));
    }
    const boundedLimit = Math.max(1, Math.min(501, Number(limit) || 100));
    const boundedOffset = Math.max(0, Math.min(100_000, Number(offset) || 0));
    params.push(boundedLimit, boundedOffset);
    return this.#withDatabase(async (database) => {
      const rows = await database.all(
        `
          SELECT * FROM workspace_memory_items
          WHERE ${clauses.join(" AND ")}
          ORDER BY pinned DESC, updated_at DESC, id
          LIMIT ? OFFSET ?
        `,
        params
      );
      return hydrateMemoryRows(database, rows);
    });
  }

  async getMemoryItem(memoryId) {
    const id = validateMemoryId(memoryId);
    return this.#withDatabase(async (database) => {
      const row = await database.get(
        "SELECT * FROM workspace_memory_items WHERE id = ? AND workspace_id = ?",
        [id, this.workspaceId]
      );
      if (!row) return null;
      return (await hydrateMemoryRows(database, [row]))[0];
    });
  }

  async createMemoryItem(record) {
    await this.getMemoryMeta();
    const timestamp = record.createdAt || nowIso();
    await this.#withDatabase((database) => database.batch([
      {
        mode: "run",
        sql: `
          INSERT INTO workspace_memory_items(
            id, workspace_id, kind, title, summary, lifecycle, freshness,
            pinned, origin, confidence, source_task_id, source_head,
            supersedes_id, revision, content_hash, created_at, updated_at, archived_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        `,
        params: [
          record.id,
          this.workspaceId,
          record.kind,
          record.title,
          record.summary,
          record.lifecycle,
          record.freshness,
          record.pinned ? 1 : 0,
          record.origin,
          record.confidence,
          record.sourceTaskId || null,
          record.sourceHead || null,
          record.supersedesId || null,
          record.contentHash,
          timestamp,
          timestamp,
          record.archivedAt || null
        ]
      },
      ...(record.paths || []).map((item) => ({
        mode: "run",
        sql: "INSERT INTO workspace_memory_paths(memory_id, path) VALUES (?, ?)",
        params: [record.id, item]
      })),
      ...(record.tags || []).map((item) => ({
        mode: "run",
        sql: "INSERT INTO workspace_memory_tags(memory_id, tag) VALUES (?, ?)",
        params: [record.id, item]
      })),
      memoryMetaBumpStep(this.workspaceId, timestamp),
      memoryEventStep({
        workspaceId: this.workspaceId,
        memoryId: record.id,
        operation: "create",
        actor: record.actor || record.origin,
        taskId: record.sourceTaskId,
        afterHash: record.contentHash,
        timestamp
      })
    ]));
    return this.getMemoryItem(record.id);
  }

  async updateMemoryItem(record, { expectedRevision } = {}) {
    const id = validateMemoryId(record.id);
    const timestamp = nowIso();
    const nextRevision = Number(expectedRevision) + 1;
    const guard = `
      EXISTS (
        SELECT 1 FROM workspace_memory_items
        WHERE id = ? AND workspace_id = ? AND revision = ? AND content_hash = ?
      )
    `;
    const results = await this.#withDatabase((database) => database.batch([
      {
        mode: "run",
        sql: `
          UPDATE workspace_memory_items
          SET kind = ?, title = ?, summary = ?, lifecycle = ?, freshness = ?,
              pinned = ?, origin = ?, confidence = ?, source_task_id = ?,
              source_head = ?, supersedes_id = ?, revision = revision + 1,
              content_hash = ?, updated_at = ?, archived_at = ?
          WHERE id = ? AND workspace_id = ? AND revision = ?
        `,
        params: [
          record.kind,
          record.title,
          record.summary,
          record.lifecycle,
          record.freshness,
          record.pinned ? 1 : 0,
          record.origin,
          record.confidence,
          record.sourceTaskId || null,
          record.sourceHead || null,
          record.supersedesId || null,
          record.contentHash,
          timestamp,
          record.archivedAt || null,
          id,
          this.workspaceId,
          Number(expectedRevision)
        ]
      },
      {
        mode: "run",
        sql: `DELETE FROM workspace_memory_paths WHERE memory_id = ? AND ${guard}`,
        params: [id, id, this.workspaceId, nextRevision, record.contentHash]
      },
      {
        mode: "run",
        sql: `DELETE FROM workspace_memory_tags WHERE memory_id = ? AND ${guard}`,
        params: [id, id, this.workspaceId, nextRevision, record.contentHash]
      },
      ...(record.paths || []).map((item) => ({
        mode: "run",
        sql: `
          INSERT INTO workspace_memory_paths(memory_id, path)
          SELECT ?, ? WHERE ${guard}
        `,
        params: [id, item, id, this.workspaceId, nextRevision, record.contentHash]
      })),
      ...(record.tags || []).map((item) => ({
        mode: "run",
        sql: `
          INSERT INTO workspace_memory_tags(memory_id, tag)
          SELECT ?, ? WHERE ${guard}
        `,
        params: [id, item, id, this.workspaceId, nextRevision, record.contentHash]
      })),
      {
        mode: "run",
        sql: `
          INSERT INTO workspace_memory_meta(workspace_id, revision, updated_at)
          SELECT ?, 1, ? WHERE ${guard}
          ON CONFLICT(workspace_id) DO UPDATE SET
            revision = workspace_memory_meta.revision + 1,
            cached_brief_revision = 0,
            updated_at = excluded.updated_at
        `,
        params: [
          this.workspaceId,
          timestamp,
          id,
          this.workspaceId,
          nextRevision,
          record.contentHash
        ]
      },
      {
        mode: "run",
        sql: `
          INSERT INTO workspace_memory_events(
            id, workspace_id, memory_id, operation, actor, task_id,
            before_hash, after_hash, created_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}
        `,
        params: [
          `memory_event_${randomUUID().replaceAll("-", "")}`,
          this.workspaceId,
          id,
          record.eventOperation || "update",
          record.actor || record.origin,
          record.sourceTaskId || null,
          record.beforeHash || null,
          record.contentHash,
          timestamp,
          id,
          this.workspaceId,
          nextRevision,
          record.contentHash
        ]
      }
    ]));
    if (Number(results[0]?.changes || 0) === 0) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_MEMORY_REVISION_CONFLICT",
        `Workspace memory item changed before update: ${id}`,
        { memoryId: id, expectedRevision }
      );
    }
    return this.getMemoryItem(id);
  }

  async deleteMemoryItem(memoryId, { actor = "user", taskId, beforeHash } = {}) {
    const id = validateMemoryId(memoryId);
    const timestamp = nowIso();
    const guard = `
      EXISTS (
        SELECT 1 FROM workspace_memory_items
        WHERE id = ? AND workspace_id = ? AND content_hash = ?
      )
    `;
    const results = await this.#withDatabase((database) => database.batch([
      {
        mode: "run",
        sql: `
          INSERT INTO workspace_memory_events(
            id, workspace_id, memory_id, operation, actor, task_id,
            before_hash, after_hash, created_at
          )
          SELECT ?, ?, ?, 'delete', ?, ?, ?, NULL, ? WHERE ${guard}
        `,
        params: [
          `memory_event_${randomUUID().replaceAll("-", "")}`,
          this.workspaceId,
          id,
          actor,
          taskId || null,
          beforeHash || null,
          timestamp,
          id,
          this.workspaceId,
          beforeHash || null
        ]
      },
      {
        mode: "run",
        sql: `
          INSERT INTO workspace_memory_meta(workspace_id, revision, updated_at)
          SELECT ?, 1, ? WHERE ${guard}
          ON CONFLICT(workspace_id) DO UPDATE SET
            revision = workspace_memory_meta.revision + 1,
            cached_brief_revision = 0,
            updated_at = excluded.updated_at
        `,
        params: [
          this.workspaceId,
          timestamp,
          id,
          this.workspaceId,
          beforeHash || null
        ]
      },
      {
        mode: "run",
        sql: `
          DELETE FROM workspace_memory_items
          WHERE id = ? AND workspace_id = ? AND content_hash = ?
        `,
        params: [id, this.workspaceId, beforeHash || null]
      }
    ]));
    return Number(results[2]?.changes || 0) > 0;
  }

  async listMemoryEmbeddings({ modelId, memoryIds = [] } = {}) {
    const model = String(modelId || "").trim();
    if (!model) return [];
    const ids = [...new Set((memoryIds || []).map(validateMemoryId))].slice(0, 500);
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await this.#withDatabase((database) => database.all(
      `
        SELECT memory_id, workspace_id, content_hash, model_id, dimensions, vector, updated_at
        FROM workspace_memory_embeddings
        WHERE workspace_id = ? AND model_id = ? AND memory_id IN (${placeholders})
      `,
      [this.workspaceId, model, ...ids]
    ));
    return rows.map((row) => ({
      memory_id: row.memory_id,
      workspace_id: row.workspace_id,
      content_hash: row.content_hash,
      model_id: row.model_id,
      dimensions: Number(row.dimensions),
      vector: embeddingVectorFromBlob(row.vector, Number(row.dimensions)),
      updated_at: row.updated_at
    })).filter((row) => row.vector);
  }

  async upsertMemoryEmbedding({ memoryId, contentHash, modelId, dimensions, vector } = {}) {
    const id = validateMemoryId(memoryId);
    const hash = String(contentHash || "");
    const model = String(modelId || "").trim().slice(0, 240);
    const size = Number(dimensions);
    if (!/^[a-f0-9]{64}$/i.test(hash) || !model || !Number.isInteger(size) || size < 1 || size > 65_536) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_MEMORY_EMBEDDING_INVALID",
        "Workspace memory embedding metadata is invalid."
      );
    }
    const values = vector instanceof Float32Array ? vector : Float32Array.from(vector || [], Number);
    if (values.length !== size || values.some((value) => !Number.isFinite(value))) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_MEMORY_EMBEDDING_INVALID",
        "Workspace memory embedding vector is invalid."
      );
    }
    const timestamp = nowIso();
    const blob = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    const result = await this.#withDatabase((database) => database.run(
      `
        INSERT INTO workspace_memory_embeddings(
          memory_id, workspace_id, content_hash, model_id, dimensions, vector,
          created_at, updated_at
        )
        SELECT id, workspace_id, content_hash, ?, ?, ?, ?, ?
        FROM workspace_memory_items
        WHERE id = ? AND workspace_id = ? AND content_hash = ?
        ON CONFLICT(memory_id, model_id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          content_hash = excluded.content_hash,
          dimensions = excluded.dimensions,
          vector = excluded.vector,
          updated_at = excluded.updated_at
      `,
      [model, size, blob, timestamp, timestamp, id, this.workspaceId, hash]
    ));
    return Number(result?.changes || 0) > 0;
  }

  async memoryEmbeddingSummary(modelId) {
    const model = String(modelId || "").trim();
    const row = await this.#withDatabase((database) => database.get(
      `
        SELECT
          COUNT(e.memory_id) AS indexed,
          SUM(CASE WHEN e.content_hash = i.content_hash THEN 1 ELSE 0 END) AS current
        FROM workspace_memory_items i
        LEFT JOIN workspace_memory_embeddings e
          ON e.memory_id = i.id AND e.model_id = ?
        WHERE i.workspace_id = ? AND i.lifecycle = 'active'
      `,
      [model, this.workspaceId]
    ));
    return {
      indexed: Number(row?.indexed || 0),
      current: Number(row?.current || 0)
    };
  }

  async setMemoryCache({ revision, items }) {
    await this.getMemoryMeta();
    await this.#withDatabase((database) => database.run(
      `
        UPDATE workspace_memory_meta
        SET cached_brief_json = ?, cached_brief_revision = ?, updated_at = ?
        WHERE workspace_id = ? AND revision = ?
      `,
      [JSON.stringify(items || []), Number(revision) || 0, nowIso(), this.workspaceId, Number(revision) || 0]
    ));
    return this.getMemoryMeta();
  }

  async memorySummary() {
    const meta = await this.getMemoryMeta();
    const counts = await this.#withDatabase((database) => database.get(
      `
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN lifecycle = 'active' THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN pinned = 1 AND lifecycle = 'active' THEN 1 ELSE 0 END) AS pinned,
          SUM(CASE WHEN freshness IN ('needs_review', 'stale') AND lifecycle = 'active' THEN 1 ELSE 0 END) AS needs_review
        FROM workspace_memory_items
        WHERE workspace_id = ?
      `,
      [this.workspaceId]
    ));
    return {
      ...meta,
      counts: {
        total: Number(counts?.total || 0),
        active: Number(counts?.active || 0),
        pinned: Number(counts?.pinned || 0),
        needs_review: Number(counts?.needs_review || 0)
      }
    };
  }

  async markMemoryPaths(changes, { taskId } = {}) {
    const normalized = [...new Map((changes || []).map((item) => [item.path, item])).values()];
    if (!normalized.length) return { updated: 0, ids: [] };
    const placeholders = normalized.map(() => "?").join(", ");
    const rows = await this.#withDatabase((database) => database.all(
      `
        SELECT DISTINCT p.memory_id, p.path
        FROM workspace_memory_paths p
        JOIN workspace_memory_items i ON i.id = p.memory_id
        WHERE i.workspace_id = ? AND i.lifecycle = 'active' AND p.path IN (${placeholders})
      `,
      [this.workspaceId, ...normalized.map((item) => item.path)]
    ));
    if (!rows.length) return { updated: 0, ids: [] };
    const byPath = new Map(normalized.map((item) => [item.path, item.freshness]));
    const targets = new Map();
    for (const row of rows) {
      const next = byPath.get(row.path) === "stale" ? "stale" : "needs_review";
      const current = targets.get(row.memory_id);
      targets.set(row.memory_id, current === "stale" || next === "stale" ? "stale" : next);
    }
    const timestamp = nowIso();
    await this.#withDatabase((database) => database.batch([
      ...[...targets].map(([id, freshness]) => ({
        mode: "run",
        sql: `
          UPDATE workspace_memory_items
          SET freshness = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND freshness <> ?
        `,
        params: [freshness, timestamp, id, this.workspaceId, freshness]
      })),
      memoryMetaBumpStep(this.workspaceId, timestamp),
      ...[...targets].map(([id]) => memoryEventStep({
        workspaceId: this.workspaceId,
        memoryId: id,
        operation: "freshness",
        actor: "system",
        taskId,
        timestamp
      }))
    ]));
    return { updated: targets.size, ids: [...targets.keys()] };
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

