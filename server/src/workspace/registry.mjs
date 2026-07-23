// Local Coding Agent workspace registry and task-scoped storage
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  stat
} from "node:fs/promises";
import path from "node:path";
import {
  openRegistryDatabase,
  openWorkspaceDatabase,
  StorageError
} from "../storage/database.mjs";
import { WorkspaceRegistryError } from "./registry-contract.mjs";
import {
  DEFAULT_SELECTION_SCOPE,
  MAX_ATTACHMENTS,
  attachmentFromRow,
  attachmentInsertStep,
  canonicalWorkspaceRoot,
  inspectAttachment,
  inspectAttachments,
  isInsideOrEqual,
  normalizeRelative,
  normalizedPathKey,
  noteFromRow,
  nowIso,
  safeJsonParse,
  taskFromRow,
  transactionFromRow,
  validateScope,
  validateTaskId,
  validateToken,
  validateTransactionState,
  validateWorkspaceId,
  workspaceIdentityAvailable,
  workspaceFromRow
} from "./registry-helpers.mjs";
import {
  archiveWorkspaceRecord,
  deleteWorkspaceRecords,
  inspectWorkspaceLifecycle,
  restoreWorkspaceRecord
} from "./registry-lifecycle.mjs";

export { WorkspaceRegistryError } from "./registry-contract.mjs";

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

export class WorkspaceRegistry {
  #database;
  #hotWorkspaces = new Map();
  #workspaceHandles = new Set();
  #closed = false;

  constructor({
    dataDir,
    database,
    busyTimeoutMs = 5_000,
    maxOpenWorkspaces = 4
  }) {
    this.dataDir = path.resolve(dataDir);
    this.databasePath = path.join(this.dataDir, "registry.sqlite");
    this.workspacesDir = path.join(this.dataDir, "workspaces");
    this.busyTimeoutMs = busyTimeoutMs;
    this.maxOpenWorkspaces = Math.max(1, Math.min(64, Number(maxOpenWorkspaces) || 4));
    this.#database = database;
  }

  static async open({
    dataDir,
    busyTimeoutMs = 5_000,
    maxOpenWorkspaces = 4
  }) {
    if (!dataDir) throw new TypeError("WorkspaceRegistry.open requires dataDir.");
    const root = path.resolve(dataDir);
    await mkdir(path.join(root, "workspaces"), { recursive: true });
    const canonicalRoot = await realpath(root);
    const database = await openRegistryDatabase({
      databasePath: path.join(canonicalRoot, "registry.sqlite"),
      busyTimeoutMs
    });
    return new WorkspaceRegistry({
      dataDir: canonicalRoot,
      database,
      busyTimeoutMs,
      maxOpenWorkspaces
    });
  }

  #assertOpen() {
    if (this.#closed) {
      throw new WorkspaceRegistryError("WORKSPACE_REGISTRY_CLOSED", "Workspace registry is closed.");
    }
  }

  async health() {
    this.#assertOpen();
    return this.#database.health();
  }

  async upsertTransactionState(record) {
    this.#assertOpen();
    const state = validateTransactionState(record);
    const row = await this.#database.get(
      `
        INSERT INTO patch_transactions(
          id, status, task_id, workspace_ids_json, manifest_version,
          manifest_file, created_at, updated_at, completed_at, error_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          task_id = excluded.task_id,
          workspace_ids_json = excluded.workspace_ids_json,
          manifest_version = excluded.manifest_version,
          manifest_file = excluded.manifest_file,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at,
          error_code = excluded.error_code
        RETURNING *
      `,
      [
        state.id,
        state.status,
        state.taskId,
        JSON.stringify(state.workspaceIds),
        state.manifestVersion,
        state.manifestFile,
        state.createdAt,
        state.updatedAt,
        state.completedAt,
        state.errorCode
      ]
    );
    return transactionFromRow(row);
  }

  async getTransactionState(transactionId) {
    this.#assertOpen();
    const id = String(transactionId || "");
    if (!/^[A-Za-z0-9_-]{8,160}$/.test(id)) {
      throw new WorkspaceRegistryError(
        "INVALID_TRANSACTION_ID",
        "Invalid transaction ID.",
        { transactionId: id }
      );
    }
    return transactionFromRow(await this.#database.get(
      "SELECT * FROM patch_transactions WHERE id = ?",
      [id]
    ));
  }

  async listTransactionStates({ incompleteOnly = false } = {}) {
    this.#assertOpen();
    const rows = await this.#database.all(
      incompleteOnly
        ? `
            SELECT * FROM patch_transactions
            WHERE status NOT IN ('complete', 'rolled_back')
            ORDER BY updated_at ASC, id
          `
        : `
            SELECT * FROM patch_transactions
            ORDER BY updated_at DESC, id
          `
    );
    return rows.map(transactionFromRow);
  }

  async registerWorkspace(root, { metadata = {}, workspaceId } = {}) {
    this.#assertOpen();
    const canonical = await canonicalWorkspaceRoot(root);
    if (
      isInsideOrEqual(canonical.canonical, this.dataDir) ||
      isInsideOrEqual(this.dataDir, canonical.canonical)
    ) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_CONTROL_PLANE_OVERLAP",
        "Workspace root must not contain or be contained by the LCA control-plane data directory.",
        { root: canonical.canonical }
      );
    }
    const id = workspaceId
      ? validateWorkspaceId(workspaceId)
      : `ws_${randomUUID().replaceAll("-", "")}`;
    const existing = await this.#database.get(
      "SELECT * FROM workspaces WHERE canonical_key = ?",
      [canonical.key]
    );
    const nextMetadata = {
      ...(metadata || {}),
      git: canonical.git,
      root_identity: canonical.rootIdentity
    };
    if (existing) {
      if ((existing.registration_state || "active") === "archived") {
        throw new WorkspaceRegistryError(
          "WORKSPACE_ARCHIVED",
          "This workspace is archived. Restore it explicitly before connecting it again.",
          { workspaceId: existing.id, root: existing.canonical_root }
        );
      }
      const existingMetadata = safeJsonParse(existing.metadata_json);
      if (workspaceIdentityChanged(existingMetadata, canonical)) {
        throw new WorkspaceRegistryError(
          "WORKSPACE_IDENTITY_CHANGED",
          "The registered workspace path now points to a different filesystem or Git identity.",
          { workspaceId: existing.id, root: existing.canonical_root }
        );
      }
      const mergedMetadata = {
        ...existingMetadata,
        ...nextMetadata
      };
      const updatedAt = nowIso();
      const updated = await this.#database.get(
        `
          UPDATE workspaces
          SET metadata_json = ?, availability = 'available', updated_at = ?
          WHERE id = ?
          RETURNING *
        `,
        [JSON.stringify(mergedMetadata), updatedAt, existing.id]
      );
      return { workspace: workspaceFromRow(updated), created: false };
    }

    const timestamp = nowIso();
    const row = await this.#database.get(
      `
        INSERT INTO workspaces(
          id, root, canonical_root, canonical_key, availability,
          metadata_json, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, 'available', ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM workspaces
          WHERE canonical_key = ?
             OR substr(canonical_key, 1, length(?) + 1) = ? || '/'
             OR substr(?, 1, length(canonical_key) + 1) = canonical_key || '/'
        )
        RETURNING *
      `,
      [
        id,
        canonical.requested,
        canonical.canonical,
        canonical.key,
        JSON.stringify(nextMetadata),
        timestamp,
        timestamp,
        canonical.key,
        canonical.key,
        canonical.key,
        canonical.key
      ]
    ).catch(async (error) => {
      if (/UNIQUE constraint failed: workspaces\.id/i.test(error?.message || "")) {
        throw new WorkspaceRegistryError(
          "WORKSPACE_ID_CONFLICT",
          `Workspace ID already belongs to another root: ${id}`,
          { workspaceId: id }
        );
      }
      throw error;
    });
    if (row) return { workspace: workspaceFromRow(row), created: true };

    const conflict = await this.#database.get(
      `
        SELECT * FROM workspaces
        WHERE canonical_key = ?
           OR substr(canonical_key, 1, length(?) + 1) = ? || '/'
           OR substr(?, 1, length(canonical_key) + 1) = canonical_key || '/'
        ORDER BY length(canonical_key) ASC
        LIMIT 1
      `,
      [canonical.key, canonical.key, canonical.key, canonical.key]
    );
    if (conflict?.canonical_key === canonical.key) {
      return { workspace: workspaceFromRow(conflict), created: false };
    }
    throw new WorkspaceRegistryError(
      "WORKSPACE_ROOT_OVERLAP",
      `Workspace overlaps registered root ${conflict?.canonical_root || "unknown"}.`,
      {
        root: canonical.canonical,
        conflictWorkspaceId: conflict?.id || null,
        conflictRoot: conflict?.canonical_root || null
      }
    );
  }

  async #refreshWorkspaceRow(row) {
    const available = await workspaceIdentityAvailable({
      canonicalRoot: row.canonical_root,
      requestedRoot: row.root,
      metadata: safeJsonParse(row.metadata_json)
    });
    const next = available ? "available" : "unavailable";
    if (next !== row.availability) {
      const timestamp = nowIso();
      await this.#database.run(
        "UPDATE workspaces SET availability = ?, updated_at = ? WHERE id = ?",
        [next, timestamp, row.id]
      );
      return { ...row, availability: next, updated_at: timestamp };
    }
    return row;
  }

  async getWorkspace(workspaceId, { refreshAvailability = true, allowArchived = false } = {}) {
    this.#assertOpen();
    const id = validateWorkspaceId(workspaceId);
    let row = await this.#database.get("SELECT * FROM workspaces WHERE id = ?", [id]);
    if (!row) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_NOT_FOUND",
        `Workspace not found: ${id}`,
        { workspaceId: id }
      );
    }
    if (!allowArchived && (row.registration_state || "active") === "archived") {
      throw new WorkspaceRegistryError(
        "WORKSPACE_ARCHIVED",
        `Workspace is archived: ${row.canonical_root}`,
        { workspaceId: id, root: row.canonical_root }
      );
    }
    if (refreshAvailability) row = await this.#refreshWorkspaceRow(row);
    return workspaceFromRow(row);
  }

  async listWorkspaces({ refreshAvailability = true, includeArchived = false } = {}) {
    this.#assertOpen();
    let rows = await this.#database.all(
      `
        SELECT * FROM workspaces
        ${includeArchived ? "" : "WHERE registration_state = 'active'"}
        ORDER BY
          CASE registration_state WHEN 'active' THEN 0 ELSE 1 END,
          CASE availability WHEN 'available' THEN 0 ELSE 1 END,
          last_selected_at DESC,
          created_at ASC
      `
    );
    if (refreshAvailability) {
      rows = await Promise.all(rows.map((row) => this.#refreshWorkspaceRow(row)));
      rows.sort((a, b) => {
        const leftState = a.registration_state || "active";
        const rightState = b.registration_state || "active";
        if (leftState !== rightState) return leftState === "active" ? -1 : 1;
        if (a.availability !== b.availability) return a.availability === "available" ? -1 : 1;
        return String(b.last_selected_at || "").localeCompare(String(a.last_selected_at || ""))
          || String(a.created_at).localeCompare(String(b.created_at));
      });
    }
    return rows.map(workspaceFromRow);
  }

  async inspectWorkspaceLifecycle(workspaceId) {
    this.#assertOpen();
    const workspace = await this.getWorkspace(workspaceId, {
      refreshAvailability: false,
      allowArchived: true
    });
    return { workspace, ...(await inspectWorkspaceLifecycle(this.#database, workspace.id)) };
  }

  async archiveWorkspace(workspaceId) {
    this.#assertOpen();
    const workspace = await this.getWorkspace(workspaceId, {
      refreshAvailability: false,
      allowArchived: true
    });
    if (workspace.registrationState === "archived") return { archived: true, workspace };
    await this.#closeWorkspaceHandle(workspace.id);
    const result = await archiveWorkspaceRecord(this.#database, workspace.id, nowIso());
    return { archived: true, workspace: workspaceFromRow(result.row), inspection: result.inspection };
  }

  async restoreWorkspace(workspaceId) {
    this.#assertOpen();
    const workspace = await this.getWorkspace(workspaceId, {
      refreshAvailability: false,
      allowArchived: true
    });
    if (workspace.registrationState === "active") return { restored: true, workspace };
    if (workspace.metadata?.trusted !== true) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_TRUST_REQUIRED",
        "Trust this workspace explicitly before restoring it.",
        { workspaceId: workspace.id, root: workspace.canonicalRoot }
      );
    }
    const canonical = await canonicalWorkspaceRoot(workspace.root);
    const expectedGit = workspace.metadata?.git || {};
    const gitIdentityChanged = Boolean(expectedGit.is_repository) !== Boolean(canonical.git.is_repository) ||
      String(expectedGit.identity || "") !== String(canonical.git.identity || "");
    const rootIdentityChanged = workspace.metadata?.root_identity &&
      workspace.metadata.root_identity !== canonical.rootIdentity;
    if (
      canonical.key !== normalizedPathKey(workspace.canonicalRoot) ||
      gitIdentityChanged ||
      rootIdentityChanged
    ) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_IDENTITY_CHANGED",
        "The archived workspace no longer matches its registered filesystem and Git identity.",
        {
          workspaceId: workspace.id,
          expectedRoot: workspace.canonicalRoot,
          actualRoot: canonical.canonical
        }
      );
    }
    const row = await restoreWorkspaceRecord(this.#database, workspace.id, nowIso());
    return { restored: true, workspace: workspaceFromRow(row) };
  }

  async deleteWorkspaceRecords(workspaceId, inspection) {
    this.#assertOpen();
    const workspace = await this.getWorkspace(workspaceId, {
      refreshAvailability: false,
      allowArchived: true
    });
    await this.#closeWorkspaceHandle(workspace.id);
    await deleteWorkspaceRecords(this.#database, workspace.id, inspection);
    return { removed: true, workspace };
  }

  async #closeWorkspaceHandle(workspaceId) {
    const handle = [...this.#workspaceHandles].find(
      (candidate) => candidate.workspaceId === workspaceId
    );
    if (!handle) return;
    this.#hotWorkspaces.delete(workspaceId);
    this.#workspaceHandles.delete(handle);
    await handle.close();
  }

  async removeWorkspace(workspaceId) {
    this.#assertOpen();
    const id = validateWorkspaceId(workspaceId);
    throw new WorkspaceRegistryError(
      "WORKSPACE_PURGE_REQUIRED",
      "Use the durable workspace purge service for permanent removal.",
      { workspaceId: id }
    );
  }

  async #persistSelection(workspace, scope) {
    const timestamp = nowIso();
    await this.#database.batch([
      {
        mode: "run",
        sql: "UPDATE workspaces SET last_selected_at = ?, updated_at = ? WHERE id = ?",
        params: [timestamp, timestamp, workspace.id]
      },
      {
        mode: "run",
        sql: `
          INSERT INTO workspace_selections(scope, workspace_id, selected_at)
          VALUES (?, ?, ?)
          ON CONFLICT(scope) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            selected_at = excluded.selected_at
        `,
        params: [scope, workspace.id, timestamp]
      }
    ]);
    return {
      workspace: { ...workspace, lastSelectedAt: timestamp, updatedAt: timestamp },
      scope
    };
  }

  async selectWorkspace(workspaceId, { scope = DEFAULT_SELECTION_SCOPE } = {}) {
    this.#assertOpen();
    const id = validateWorkspaceId(workspaceId);
    const selectedScope = validateScope(scope);
    const requested = await this.getWorkspace(id, { refreshAvailability: true });
    if (requested.availability !== "available") {
      throw new WorkspaceRegistryError(
        "WORKSPACE_UNAVAILABLE",
        `Workspace is unavailable: ${requested.canonicalRoot}`,
        { workspaceId: id, root: requested.canonicalRoot }
      );
    }
    return this.#persistSelection(requested, selectedScope);
  }

  async claimWorkspaceSelection(workspaceId, { scope = DEFAULT_SELECTION_SCOPE } = {}) {
    this.#assertOpen();
    const id = validateWorkspaceId(workspaceId);
    const selectedScope = validateScope(scope);
    const requested = await this.getWorkspace(id, { refreshAvailability: true });
    if (requested.availability !== "available") {
      throw new WorkspaceRegistryError(
        "WORKSPACE_UNAVAILABLE",
        `Workspace is unavailable: ${requested.canonicalRoot}`,
        { workspaceId: id, root: requested.canonicalRoot }
      );
    }
    const timestamp = nowIso();
    const claimed = await this.#database.get(
      `
        INSERT INTO workspace_selections(scope, workspace_id, selected_at)
        VALUES (?, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET
          selected_at = workspace_selections.selected_at
        RETURNING workspace_id, selected_at
      `,
      [selectedScope, requested.id, timestamp]
    );
    if (claimed?.workspace_id !== requested.id) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_SELECTION_SCOPE_CONFLICT",
        "This workspace selection scope is already pinned to another workspace.",
        {
          scope: selectedScope,
          requestedWorkspaceId: requested.id,
          selectedWorkspaceId: claimed?.workspace_id || null
        }
      );
    }
    return {
      workspace: requested,
      scope: selectedScope,
      created: claimed?.selected_at === timestamp
    };
  }

  async getSelectedWorkspace({ scope = DEFAULT_SELECTION_SCOPE } = {}) {
    this.#assertOpen();
    const selectedScope = validateScope(scope);
    const selected = await this.#database.get(
      "SELECT workspace_id FROM workspace_selections WHERE scope = ?",
      [selectedScope]
    );
    if (selected?.workspace_id) {
      const workspace = await this.getWorkspace(selected.workspace_id, {
        refreshAvailability: true
      });
      if (workspace.availability !== "available") {
        throw new WorkspaceRegistryError(
          "WORKSPACE_UNAVAILABLE",
          `Selected workspace is unavailable: ${workspace.canonicalRoot}`,
          { workspaceId: workspace.id }
        );
      }
      return { workspace, scope: selectedScope };
    }
    return null;
  }

  async #touchWorkspace(handle) {
    if (this.#closed) return;
    this.#hotWorkspaces.delete(handle.workspaceId);
    this.#hotWorkspaces.set(handle.workspaceId, handle);
    while (this.#hotWorkspaces.size > this.maxOpenWorkspaces) {
      const oldestId = this.#hotWorkspaces.keys().next().value;
      if (oldestId === handle.workspaceId) break;
      const oldest = this.#hotWorkspaces.get(oldestId);
      this.#hotWorkspaces.delete(oldestId);
      await oldest?.evict();
    }
  }

  async openWorkspace(workspaceId, { allowUnavailable = false } = {}) {
    this.#assertOpen();
    const workspace = await this.getWorkspace(workspaceId, {
      refreshAvailability: true
    });
    if (!allowUnavailable && workspace.availability !== "available") {
      throw new WorkspaceRegistryError(
        "WORKSPACE_UNAVAILABLE",
        `Workspace is unavailable: ${workspace.canonicalRoot}`,
        { workspaceId: workspace.id, root: workspace.canonicalRoot }
      );
    }
    let handle = [...this.#workspaceHandles].find(
      (candidate) => candidate.workspaceId === workspace.id
    );
    if (!handle) {
      const workspaceDir = path.join(this.workspacesDir, workspace.id);
      await mkdir(workspaceDir, { recursive: true });
      handle = new WorkspaceDatabase({
        workspace,
        databasePath: path.join(workspaceDir, "state.sqlite"),
        busyTimeoutMs: this.busyTimeoutMs,
        onUse: (candidate) => this.#touchWorkspace(candidate)
      });
      this.#workspaceHandles.add(handle);
    }
    await this.#touchWorkspace(handle);
    await handle.health();
    return handle;
  }

  async openSelectedWorkspace(options = {}) {
    const selected = await this.getSelectedWorkspace(options);
    if (!selected?.workspace) return null;
    return this.openWorkspace(selected.workspace.id);
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#workspaceHandles].map((handle) => handle.close()));
    this.#workspaceHandles.clear();
    this.#hotWorkspaces.clear();
    await this.#database.close();
  }
}

function workspaceIdentityChanged(metadata, canonical) {
  if (metadata?.root_identity && metadata.root_identity !== canonical.rootIdentity) return true;
  const expectedGit = metadata?.git;
  return Boolean(expectedGit) && (
    Boolean(expectedGit.is_repository) !== Boolean(canonical.git.is_repository) ||
    String(expectedGit.identity || "") !== String(canonical.git.identity || "")
  );
}

export { StorageError };
