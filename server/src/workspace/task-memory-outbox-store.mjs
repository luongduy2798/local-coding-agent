// Durable registry-backed outbox for task-close workspace Memory updates.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

const OUTBOX_FINAL_STATES = new Set(["complete", "partial"]);

export function taskMemoryOutboxInsertSteps(jobs, taskId, timestamp) {
  return (jobs || []).map((job) => ({
    mode: "run",
    sql: `
      INSERT INTO task_memory_outbox(
        id, task_id, workspace_id, payload_hash, payload_json, status,
        attempts, available_at, lease_owner, lease_expires_at, result_json,
        last_error_code, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, NULL, ?, ?, NULL)
      ON CONFLICT(task_id, workspace_id, payload_hash) DO NOTHING
    `,
    params: [
      job.id,
      taskId,
      job.workspace_id,
      job.payload_hash,
      JSON.stringify(job.payload),
      job.available_at || timestamp,
      job.created_at || timestamp,
      timestamp
    ]
  }));
}

export class TaskMemoryOutboxStore {
  constructor({ database } = {}) {
    if (!database) throw new TypeError("TaskMemoryOutboxStore requires a registry database.");
    this.database = database;
  }

  async recoverExpiredLeases(now = new Date().toISOString()) {
    const result = await this.database.run(
      `
        UPDATE task_memory_outbox
        SET status = 'retry', available_at = ?, lease_owner = NULL,
            lease_expires_at = NULL, last_error_code = 'MEMORY_OUTBOX_LEASE_EXPIRED',
            updated_at = ?
        WHERE status = 'processing'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?
      `,
      [now, now, now]
    );
    return Number(result?.changes || 0);
  }

  async claimNext({ leaseOwner, leaseMs = 30_000, now = new Date() } = {}) {
    const owner = String(leaseOwner || "").slice(0, 180);
    if (!owner) throw new TypeError("Memory outbox lease owner is required.");
    const claimedAt = now instanceof Date ? now : new Date(now);
    const timestamp = claimedAt.toISOString();
    const leaseExpiresAt = new Date(claimedAt.getTime() + Math.max(1_000, Number(leaseMs) || 30_000)).toISOString();
    const row = await this.database.get(
      `
        UPDATE task_memory_outbox
        SET status = 'processing', attempts = attempts + 1,
            lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = (
          SELECT id FROM task_memory_outbox
          WHERE status IN ('pending', 'retry') AND available_at <= ?
          ORDER BY created_at, id
          LIMIT 1
        )
        RETURNING *
      `,
      [owner, leaseExpiresAt, timestamp, timestamp]
    );
    return row ? hydrateOutboxRow(row) : null;
  }

  async complete(job, { status = "complete", result = null } = {}) {
    if (!OUTBOX_FINAL_STATES.has(status)) throw new TypeError(`Invalid Memory outbox completion state: ${status}`);
    const timestamp = new Date().toISOString();
    const response = await this.database.run(
      `
        UPDATE task_memory_outbox
        SET status = ?, payload_json = '{}', result_json = ?,
            last_error_code = NULL, lease_owner = NULL, lease_expires_at = NULL,
            updated_at = ?, completed_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?
      `,
      [status, safeJson(result), timestamp, timestamp, job.id, job.lease_owner]
    );
    return Number(response?.changes || 0) === 1;
  }

  async retry(job, errorCode, delayMs) {
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const availableAt = new Date(now + Math.max(250, Number(delayMs) || 1_000)).toISOString();
    const response = await this.database.run(
      `
        UPDATE task_memory_outbox
        SET status = 'retry', available_at = ?, last_error_code = ?,
            result_json = NULL, lease_owner = NULL, lease_expires_at = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?
      `,
      [availableAt, compactCode(errorCode), timestamp, job.id, job.lease_owner]
    );
    return Number(response?.changes || 0) === 1;
  }

  async fail(job, { status = "failed", errorCode, result = null } = {}) {
    if (!new Set(["failed", "partial"]).has(status)) {
      throw new TypeError(`Invalid Memory outbox failure state: ${status}`);
    }
    const timestamp = new Date().toISOString();
    const response = await this.database.run(
      `
        UPDATE task_memory_outbox
        SET status = ?, result_json = ?, last_error_code = ?,
            lease_owner = NULL, lease_expires_at = NULL,
            updated_at = ?, completed_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?
      `,
      [status, safeJson(result), compactCode(errorCode), timestamp, timestamp, job.id, job.lease_owner]
    );
    return Number(response?.changes || 0) === 1;
  }

  async retryFailed(workspaceId) {
    const timestamp = new Date().toISOString();
    const result = await this.database.run(
      `
        UPDATE task_memory_outbox
        SET status = 'retry', attempts = 0, available_at = ?,
            lease_owner = NULL, lease_expires_at = NULL, result_json = NULL,
            last_error_code = NULL, completed_at = NULL, updated_at = ?
        WHERE workspace_id = ? AND status = 'failed'
      `,
      [timestamp, timestamp, String(workspaceId || "")]
    );
    return Number(result?.changes || 0);
  }

  async summary(workspaceId = null) {
    const id = workspaceId ? String(workspaceId) : null;
    const row = await this.database.get(
      `
        SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
          SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END) AS retrying,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          MAX(CASE WHEN status IN ('complete', 'partial') THEN completed_at END) AS last_completed_at
        FROM task_memory_outbox
        WHERE (? IS NULL OR workspace_id = ?)
      `,
      [id, id]
    );
    return {
      pending: Number(row?.pending || 0),
      processing: Number(row?.processing || 0),
      retrying: Number(row?.retrying || 0),
      failed: Number(row?.failed || 0),
      last_completed_at: row?.last_completed_at || null
    };
  }
}

function hydrateOutboxRow(row) {
  let payload = null;
  try { payload = JSON.parse(row.payload_json || "{}"); } catch {}
  return {
    id: row.id,
    task_id: row.task_id,
    workspace_id: row.workspace_id,
    payload_hash: row.payload_hash,
    payload,
    status: row.status,
    attempts: Number(row.attempts || 0),
    available_at: row.available_at,
    lease_owner: row.lease_owner || null,
    lease_expires_at: row.lease_expires_at || null,
    last_error_code: row.last_error_code || null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function safeJson(value) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value).slice(0, 32 * 1024);
  } catch {
    return JSON.stringify({ serialization_failed: true });
  }
}

function compactCode(value) {
  return String(value || "WORKSPACE_MEMORY_PERSIST_FAILED").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
}
