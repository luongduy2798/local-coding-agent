// Local Coding Agent storage worker
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { parentPort, workerData } from "node:worker_threads";
import { existsSync, renameSync, unlinkSync } from "node:fs";

if (!parentPort) throw new Error("storage-worker must run inside a Worker thread.");

let database = null;
let statements = new Map();
let backupPath = null;
let backupRefreshedAt = null;

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    code: error?.code || error?.sqliteCode || null,
    stack: error?.stack || null
  };
}

function assertIdentifierVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0 || version > 1_000_000) {
    throw new Error(`Invalid SQLite schema version: ${value}`);
  }
  return version;
}

function cachedStatement(sql) {
  const source = String(sql || "");
  if (!source.trim()) throw new Error("SQL statement is required.");
  let statement = statements.get(source);
  if (statement) {
    statements.delete(source);
    statements.set(source, statement);
    return statement;
  }
  statement = database.prepare(source);
  statements.set(source, statement);
  if (statements.size > 128) {
    const oldest = statements.keys().next().value;
    statements.delete(oldest);
  }
  return statement;
}

function executeStep(step = {}) {
  const mode = step.mode || "run";
  if (mode === "exec") {
    database.exec(String(step.sql || ""));
    return null;
  }
  const statement = cachedStatement(step.sql);
  const params = Array.isArray(step.params) ? step.params : [];
  if (mode === "run") return statement.run(...params);
  if (mode === "get") return statement.get(...params) ?? null;
  if (mode === "all") return statement.all(...params);
  throw new Error(`Unsupported SQLite operation mode: ${mode}`);
}

function runBatch(steps, transaction = true) {
  if (!Array.isArray(steps)) throw new TypeError("batch.steps must be an array.");
  if (!transaction) return steps.map(executeStep);
  database.exec("BEGIN IMMEDIATE");
  try {
    const results = steps.map(executeStep);
    database.exec("COMMIT");
    return results;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original transaction failure.
    }
    throw error;
  }
}

function applyMigrations(schema = {}) {
  const requestedVersion = assertIdentifierVersion(schema.version ?? 0);
  const row = database.prepare("PRAGMA user_version").get();
  let currentVersion = Number(row?.user_version || 0);
  if (currentVersion > requestedVersion) {
    const error = new Error(
      `Database schema ${currentVersion} is newer than supported schema ${requestedVersion}.`
    );
    error.code = "SQLITE_SCHEMA_TOO_NEW";
    throw error;
  }

  const migrations = Array.isArray(schema.migrations)
    ? [...schema.migrations].sort((a, b) => Number(a.version) - Number(b.version))
    : [];
  for (const migration of migrations) {
    const version = assertIdentifierVersion(migration.version);
    if (version <= currentVersion) continue;
    if (version !== currentVersion + 1) {
      const error = new Error(
        `Missing SQLite migration between schema ${currentVersion} and ${version}.`
      );
      error.code = "SQLITE_MIGRATION_GAP";
      throw error;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(String(migration.sql || ""));
      database.exec(`PRAGMA user_version = ${version}`);
      database.exec("COMMIT");
      currentVersion = version;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the migration failure.
      }
      throw error;
    }
  }

  if (currentVersion !== requestedVersion) {
    const error = new Error(
      `Database schema ${currentVersion} does not match required schema ${requestedVersion}.`
    );
    error.code = "SQLITE_SCHEMA_MISMATCH";
    throw error;
  }
  return currentVersion;
}

function databaseHealth() {
  const integrity = String(
    database.prepare("PRAGMA quick_check").get()?.quick_check || "unknown"
  );
  return {
    schemaVersion: Number(database.prepare("PRAGMA user_version").get()?.user_version || 0),
    journalMode: String(database.prepare("PRAGMA journal_mode").get()?.journal_mode || ""),
    foreignKeys: Number(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys || 0),
    busyTimeout: Number(database.prepare("PRAGMA busy_timeout").get()?.timeout || 0),
    synchronous: Number(database.prepare("PRAGMA synchronous").get()?.synchronous || 0),
    integrity,
    backupPath: backupPath ? "configured" : "disabled",
    backupRefreshedAt
  };
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function refreshBackup() {
  if (!database || !backupPath) return null;
  const temporary = `${backupPath}.${process.pid}.tmp`;
  try {
    if (existsSync(temporary)) unlinkSync(temporary);
    database.exec(`VACUUM INTO ${sqlString(temporary)}`);
    try {
      // POSIX rename replaces atomically and keeps the previous backup valid
      // until the new snapshot is durable. Windows may require an explicit
      // unlink when the destination already exists.
      renameSync(temporary, backupPath);
    } catch (error) {
      if (!existsSync(backupPath) || !["EEXIST", "EPERM"].includes(error?.code)) throw error;
      unlinkSync(backupPath);
      renameSync(temporary, backupPath);
    }
    backupRefreshedAt = new Date().toISOString();
    return backupRefreshedAt;
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // Preserve the backup failure.
    }
    throw error;
  }
}

async function initialize() {
  const { DatabaseSync } = await import("node:sqlite");
  if (workerData?.mode === "probe") {
    parentPort.postMessage({
      type: "ready",
      ok: true,
      capability: {
        databaseSync: typeof DatabaseSync === "function",
        node: process.versions.node
      }
    });
    return;
  }

  const databasePath = String(workerData?.databasePath || "");
  if (!databasePath) throw new Error("storage-worker requires databasePath.");
  if (workerData?.mode === "integrity") {
    const candidate = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const integrity = String(
        candidate.prepare("PRAGMA quick_check").get()?.quick_check || "unknown"
      );
      if (integrity.toLowerCase() !== "ok") {
        const error = new Error(`SQLite integrity check failed: ${integrity}`);
        error.code = "SQLITE_INTEGRITY_CHECK_FAILED";
        throw error;
      }
      parentPort.postMessage({
        type: "ready",
        ok: true,
        health: {
          integrity,
          schemaVersion: Number(candidate.prepare("PRAGMA user_version").get()?.user_version || 0)
        }
      });
    } finally {
      candidate.close();
    }
    parentPort.close();
    return;
  }
  const busyTimeoutMs = Math.max(1, Math.min(60_000, Number(workerData?.busyTimeoutMs) || 5_000));
  backupPath = workerData?.backupPath ? String(workerData.backupPath) : null;
  database = new DatabaseSync(databasePath);
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = NORMAL");
  const integrity = String(
    database.prepare("PRAGMA quick_check").get()?.quick_check || "unknown"
  );
  if (integrity.toLowerCase() !== "ok") {
    const error = new Error(`SQLite integrity check failed: ${integrity}`);
    error.code = "SQLITE_INTEGRITY_CHECK_FAILED";
    throw error;
  }
  const schemaVersion = applyMigrations(workerData?.schema || {});
  if (backupPath && !existsSync(backupPath)) refreshBackup();
  parentPort.postMessage({
    type: "ready",
    ok: true,
    health: { ...databaseHealth(), schemaVersion }
  });
}

parentPort.on("message", (message = {}) => {
  const id = message.id;
  try {
    let result;
    if (!database) throw new Error("SQLite database is not initialized.");
    if (message.operation === "exec") {
      result = executeStep({ mode: "exec", sql: message.sql });
    } else if (message.operation === "run") {
      result = executeStep({ mode: "run", sql: message.sql, params: message.params });
    } else if (message.operation === "get") {
      result = executeStep({ mode: "get", sql: message.sql, params: message.params });
    } else if (message.operation === "all") {
      result = executeStep({ mode: "all", sql: message.sql, params: message.params });
    } else if (message.operation === "batch") {
      result = runBatch(message.steps, message.transaction !== false);
    } else if (message.operation === "health") {
      result = databaseHealth();
    } else if (message.operation === "backup") {
      result = { refreshedAt: refreshBackup() };
    } else if (message.operation === "close") {
      statements.clear();
      refreshBackup();
      database.close();
      database = null;
      parentPort.postMessage({ type: "response", id, ok: true, result: null });
      parentPort.close();
      return;
    } else {
      throw new Error(`Unknown storage operation: ${message.operation}`);
    }
    parentPort.postMessage({ type: "response", id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ type: "response", id, ok: false, error: serializeError(error) });
  }
});

initialize().catch((error) => {
  parentPort.postMessage({ type: "ready", ok: false, error: serializeError(error) });
  parentPort.close();
});
