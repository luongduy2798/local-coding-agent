// Local Coding Agent workspace memory database helpers
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { WorkspaceRegistryError } from "./registry-contract.mjs";

export function validateMemoryId(value) {
  const id = String(value || "");
  if (!/^memory_[A-Za-z0-9_-]{8,160}$/.test(id)) {
    throw new WorkspaceRegistryError(
      "WORKSPACE_MEMORY_ID_INVALID",
      "Invalid workspace memory ID.",
      { memoryId: id }
    );
  }
  return id;
}

export function memoryMetaFromRow(row, workspaceId) {
  return {
    workspace_id: row?.workspace_id || workspaceId,
    revision: Number(row?.revision || 0),
    enabled: row?.enabled !== 0,
    auto_load: row?.auto_load !== 0,
    include_recent_tasks: row?.include_recent_tasks !== 0,
    semantic_search: row?.semantic_search !== 0,
    cached_brief_json: row?.cached_brief_json || "[]",
    cached_brief_revision: Number(row?.cached_brief_revision || 0),
    updated_at: row?.updated_at || null
  };
}

export async function hydrateMemoryRows(database, rows) {
  return Promise.all((rows || []).map(async (row) => {
    const [paths, tags] = await Promise.all([
      database.all("SELECT path FROM workspace_memory_paths WHERE memory_id = ? ORDER BY path", [row.id]),
      database.all("SELECT tag FROM workspace_memory_tags WHERE memory_id = ? ORDER BY tag", [row.id])
    ]);
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      lifecycle: row.lifecycle,
      freshness: row.freshness,
      pinned: Boolean(row.pinned),
      origin: row.origin,
      confidence: Number(row.confidence),
      source_task_id: row.source_task_id || null,
      source_head: row.source_head || null,
      supersedes_id: row.supersedes_id || null,
      revision: Number(row.revision),
      content_hash: row.content_hash,
      paths: paths.map((item) => item.path),
      tags: tags.map((item) => item.tag),
      created_at: row.created_at,
      updated_at: row.updated_at,
      archived_at: row.archived_at || null
    };
  }));
}

export function embeddingVectorFromBlob(value, dimensions) {
  if (!value || !Number.isInteger(dimensions) || dimensions < 1) return null;
  const bytes = Buffer.isBuffer(value)
    ? value
    : ArrayBuffer.isView(value)
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : value instanceof ArrayBuffer
        ? Buffer.from(value)
        : null;
  if (!bytes || bytes.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) return null;
  const aligned = Uint8Array.from(bytes);
  return new Float32Array(aligned.buffer, 0, dimensions);
}

export function memoryMetaBumpStep(workspaceId, timestamp) {
  return {
    mode: "run",
    sql: `
      INSERT INTO workspace_memory_meta(workspace_id, revision, updated_at)
      VALUES (?, 1, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        revision = revision + 1,
        cached_brief_revision = 0,
        updated_at = excluded.updated_at
    `,
    params: [workspaceId, timestamp]
  };
}

export function memoryEventStep({
  workspaceId,
  memoryId,
  operation,
  actor,
  taskId,
  beforeHash,
  afterHash,
  timestamp
}) {
  return {
    mode: "run",
    sql: `
      INSERT INTO workspace_memory_events(
        id, workspace_id, memory_id, operation, actor, task_id,
        before_hash, after_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    params: [
      `memory_event_${randomUUID().replaceAll("-", "")}`,
      workspaceId,
      memoryId || null,
      operation,
      actor || "system",
      taskId || null,
      beforeHash || null,
      afterHash || null,
      timestamp
    ]
  };
}

export function escapeLike(value) {
  return String(value || "").replace(/[\\%_]/g, (match) => `\\${match}`);
}
