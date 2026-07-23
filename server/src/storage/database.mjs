// Local Coding Agent SQLite storage abstraction
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  rename
} from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

export const MINIMUM_SQLITE_NODE_VERSION = Object.freeze({ major: 22, minor: 13, patch: 0 });
export const REGISTRY_SCHEMA_VERSION = 7;
export const WORKSPACE_SCHEMA_VERSION = 2;

const STORAGE_WORKER_URL = new URL("./worker.mjs", import.meta.url);
let capabilityPromise = null;
const REGISTRY_DATABASE_POOL = new Map();

const REGISTRY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT INTO schema_meta(key, value) VALUES ('kind', 'workspace-registry')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    root TEXT NOT NULL,
    canonical_root TEXT NOT NULL UNIQUE,
    canonical_key TEXT NOT NULL UNIQUE,
    availability TEXT NOT NULL DEFAULT 'available'
      CHECK (availability IN ('available', 'unavailable')),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_selected_at TEXT
  );
  CREATE INDEX IF NOT EXISTS workspaces_availability_selected_idx
    ON workspaces(availability, last_selected_at DESC, created_at ASC);

  CREATE TABLE IF NOT EXISTS workspace_selections (
    scope TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    selected_at TEXT NOT NULL
  );
`;

const REGISTRY_TASK_ROUTER_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS task_router_tasks (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    owner_session_id TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open'
      CHECK(status IN ('open', 'closed', 'failed')),
    version INTEGER NOT NULL DEFAULT 1,
    workspace_set_frozen INTEGER NOT NULL DEFAULT 0
      CHECK(workspace_set_frozen IN (0, 1)),
    mutation_started_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS task_router_status_updated_idx
    ON task_router_tasks(status, updated_at DESC);

  CREATE TABLE IF NOT EXISTS task_router_workspaces (
    task_id TEXT NOT NULL REFERENCES task_router_tasks(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    role TEXT NOT NULL CHECK(role IN ('primary', 'attached')),
    attached_at TEXT NOT NULL,
    PRIMARY KEY(task_id, workspace_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS task_router_one_primary_idx
    ON task_router_workspaces(task_id) WHERE role = 'primary';

  CREATE TABLE IF NOT EXISTS task_router_sessions (
    session_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES task_router_tasks(id) ON DELETE CASCADE,
    bound_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const REGISTRY_TASK_BASELINE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS task_router_workspace_baselines (
    task_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    known INTEGER NOT NULL DEFAULT 0 CHECK(known IN (0, 1)),
    base_head TEXT,
    branch TEXT,
    clean INTEGER CHECK(clean IS NULL OR clean IN (0, 1)),
    dirty_unknown INTEGER CHECK(dirty_unknown IS NULL OR dirty_unknown IN (0, 1)),
    dirty_json TEXT,
    captured_at TEXT NOT NULL,
    PRIMARY KEY(task_id, workspace_id),
    FOREIGN KEY(task_id, workspace_id)
      REFERENCES task_router_workspaces(task_id, workspace_id)
      ON DELETE CASCADE
  );
`;

const REGISTRY_TRANSACTION_COORDINATOR_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS patch_transactions (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL
      CHECK(status IN (
        'preparing', 'staged', 'committing', 'committed',
        'complete', 'in_doubt', 'rolled_back'
      )),
    task_id TEXT,
    workspace_ids_json TEXT NOT NULL,
    manifest_version INTEGER NOT NULL CHECK(manifest_version >= 1),
    manifest_file TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    error_code TEXT
  );
  CREATE INDEX IF NOT EXISTS patch_transactions_status_updated_idx
    ON patch_transactions(status, updated_at DESC, id);
`;

const REGISTRY_WORKSPACE_LIFECYCLE_SCHEMA_SQL = `
  ALTER TABLE workspaces ADD COLUMN registration_state TEXT NOT NULL DEFAULT 'active'
    CHECK(registration_state IN ('active', 'archived'));
  ALTER TABLE workspaces ADD COLUMN archived_at TEXT;
  CREATE INDEX IF NOT EXISTS workspaces_registration_availability_idx
    ON workspaces(registration_state, availability, last_selected_at DESC, created_at ASC);
`;

const REGISTRY_TASK_ORCHESTRATION_SCHEMA_SQL = `
  ALTER TABLE task_router_tasks ADD COLUMN objective TEXT;
  ALTER TABLE task_router_tasks ADD COLUMN requested_profile TEXT;
  ALTER TABLE task_router_tasks ADD COLUMN effective_profile TEXT NOT NULL DEFAULT 'normal';
  ALTER TABLE task_router_tasks ADD COLUMN complexity_override INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE task_router_tasks ADD COLUMN profile_confidence REAL NOT NULL DEFAULT 0.6;
  ALTER TABLE task_router_tasks ADD COLUMN orchestration_json TEXT NOT NULL DEFAULT '{}';
`;

const REGISTRY_TASK_DETACHED_SCHEMA_SQL = `
  ALTER TABLE task_router_tasks ADD COLUMN detached_at TEXT;
  ALTER TABLE task_router_tasks ADD COLUMN closed_reason TEXT;
  UPDATE task_router_tasks
  SET detached_at = COALESCE(detached_at, updated_at)
  WHERE status = 'open' AND owner_session_id IS NULL;
`;

const WORKSPACE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT INTO schema_meta(key, value) VALUES ('kind', 'workspace-runtime')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open'
      CHECK (status IN ('open', 'frozen', 'closed')),
    token INTEGER NOT NULL DEFAULT 1 CHECK (token >= 1),
    owner_session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    frozen_at TEXT,
    closed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS tasks_status_updated_idx
    ON tasks(status, updated_at DESC);

  CREATE TABLE IF NOT EXISTS task_attachments (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    canonical_path TEXT NOT NULL,
    version TEXT,
    access TEXT NOT NULL CHECK (access IN ('read', 'write')),
    exists_at_attach INTEGER NOT NULL CHECK (exists_at_attach IN (0, 1)),
    type TEXT NOT NULL CHECK (type IN ('file', 'directory', 'missing')),
    size INTEGER,
    attached_at TEXT NOT NULL,
    PRIMARY KEY (task_id, canonical_path)
  );
  CREATE INDEX IF NOT EXISTS task_attachments_task_idx
    ON task_attachments(task_id, path);
`;

const WORKSPACE_NOTES_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notes_task_created_idx
    ON notes(task_id, created_at DESC, id);
`;

export class StorageError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.details = details;
  }
}

export class StorageCapabilityError extends StorageError {
  constructor(message, details = {}) {
    super("SQLITE_CAPABILITY_UNAVAILABLE", message, details);
    this.name = "StorageCapabilityError";
  }
}

export function parseNodeVersion(raw = process.versions.node) {
  const match = String(raw || "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

export function isNodeVersionSupported(
  raw = process.versions.node,
  minimum = MINIMUM_SQLITE_NODE_VERSION
) {
  const current = parseNodeVersion(raw);
  if (!current) return false;
  for (const key of ["major", "minor", "patch"]) {
    if (current[key] > minimum[key]) return true;
    if (current[key] < minimum[key]) return false;
  }
  return true;
}

function workerCapabilityProbe(timeoutMs) {
  return new Promise((resolve) => {
    const worker = new Worker(STORAGE_WORKER_URL, {
      workerData: { mode: "probe" },
      env: { ...process.env, NODE_NO_WARNINGS: "1" }
    });
    let settled = false;
    const finish = async (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await worker.terminate().catch(() => {});
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        reason: "probe_timeout",
        node: process.versions.node,
        minimum: MINIMUM_SQLITE_NODE_VERSION
      });
    }, timeoutMs);
    timer.unref?.();
    worker.once("message", (message) => {
      if (message?.type === "ready" && message.ok && message.capability?.databaseSync) {
        finish({
          ok: true,
          node: process.versions.node,
          minimum: MINIMUM_SQLITE_NODE_VERSION,
          databaseSync: true
        });
        return;
      }
      finish({
        ok: false,
        reason: message?.error?.message || "node:sqlite DatabaseSync is unavailable",
        node: process.versions.node,
        minimum: MINIMUM_SQLITE_NODE_VERSION
      });
    });
    worker.once("error", (error) => {
      finish({
        ok: false,
        reason: error?.message || String(error),
        node: process.versions.node,
        minimum: MINIMUM_SQLITE_NODE_VERSION
      });
    });
  });
}

export async function probeSqliteCapability({ refresh = false, timeoutMs = 5_000 } = {}) {
  if (!isNodeVersionSupported()) {
    return {
      ok: false,
      reason: "node_version_too_old",
      node: process.versions.node,
      minimum: MINIMUM_SQLITE_NODE_VERSION
    };
  }
  if (refresh || !capabilityPromise) {
    capabilityPromise = workerCapabilityProbe(Math.max(100, Number(timeoutMs) || 5_000));
  }
  return capabilityPromise;
}

export async function assertSqliteCapability(options) {
  const capability = await probeSqliteCapability(options);
  if (!capability.ok) {
    const minimum = MINIMUM_SQLITE_NODE_VERSION;
    throw new StorageCapabilityError(
      `LCA storage requires Node.js >= ${minimum.major}.${minimum.minor}.${minimum.patch} with node:sqlite.`,
      capability
    );
  }
  return capability;
}

function reviveWorkerError(payload = {}) {
  const error = new StorageError(
    payload.code || "SQLITE_WORKER_ERROR",
    payload.message || "SQLite worker operation failed."
  );
  error.name = payload.name || "StorageError";
  if (payload.stack) error.stack = payload.stack;
  return error;
}

export class SqliteWorkerDatabase {
  #worker;
  #ready;
  #pending = new Map();
  #pendingWaiters = [];
  #nextId = 0;
  #closing = false;
  #closed = false;
  #exited = false;
  #closePromise = null;
  #readyResolved = false;
  #health = null;
  #metrics = {
    requests: 0,
    errors: 0,
    totalMs: 0,
    maxMs: 0,
    durations: [],
    operations: new Map()
  };

  constructor({ databasePath, schema, busyTimeoutMs = 5_000 }) {
    this.databasePath = path.resolve(databasePath);
    this.backupPath = `${this.databasePath}.backup`;
    this.#worker = new Worker(STORAGE_WORKER_URL, {
      workerData: {
        databasePath: this.databasePath,
        backupPath: this.backupPath,
        busyTimeoutMs,
        schema
      },
      env: { ...process.env, NODE_NO_WARNINGS: "1" }
    });
    let rejectReady = () => {};
    this.#ready = new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        this.#worker.off("message", onReady);
        callback(value);
      };
      const onReady = (message) => {
        if (message?.type !== "ready") return;
        if (!message.ok) {
          settle(reject, reviveWorkerError(message.error));
          return;
        }
        this.#health = message.health || null;
        this.#readyResolved = true;
        settle(resolve, this);
      };
      rejectReady = (error) => settle(reject, error);
      this.#worker.on("message", onReady);
    });
    this.#worker.on("message", (message) => this.#handleMessage(message));
    this.#worker.on("error", (error) => {
      rejectReady(error);
      this.#failAll(error);
    });
    this.#worker.on("exit", (code) => {
      this.#exited = true;
      if (this.#closed && this.#pending.size === 0) return;
      const error = new StorageError(
        "SQLITE_WORKER_EXIT",
        `SQLite worker exited with code ${code}.`,
        { code }
      );
      rejectReady(error);
      this.#failAll(error);
    });
  }

  static async open(options) {
    await assertSqliteCapability();
    await mkdir(path.dirname(path.resolve(options.databasePath)), { recursive: true });
    let database = new SqliteWorkerDatabase(options);
    try {
      await database.ready();
      return database;
    } catch (error) {
      await database.#terminateFailedOpen();
      if (!isRecoverableDatabaseError(error)) throw error;
      const recovery = await restoreDatabaseBackup(path.resolve(options.databasePath));
      if (!recovery) throw error;
      database = new SqliteWorkerDatabase(options);
      try {
        await database.ready();
      } catch (retryError) {
        await database.#terminateFailedOpen();
        retryError.recovery = recovery;
        throw retryError;
      }
      database.#health = {
        ...(database.#health || {}),
        recovered: true,
        recovery
      };
      return database;
    }
  }

  async #terminateFailedOpen() {
    this.#closing = true;
    this.#closed = true;
    this.#failAll(new StorageError("SQLITE_DATABASE_CLOSED", "SQLite database failed to open."));
    await this.#worker.terminate().catch(() => {});
  }

  async ready() {
    return this.#ready;
  }

  get initialHealth() {
    return this.#health ? { ...this.#health } : null;
  }

  #handleMessage(message) {
    if (message?.type !== "response") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    this.#notifyPendingDrained();
    this.#recordMetric(pending, message.ok !== true);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(reviveWorkerError(message.error));
  }

  #recordMetric(pending, failed) {
    const durationMs = Math.max(0, performance.now() - Number(pending.startedAt || performance.now()));
    this.#metrics.requests++;
    if (failed) this.#metrics.errors++;
    this.#metrics.totalMs += durationMs;
    this.#metrics.maxMs = Math.max(this.#metrics.maxMs, durationMs);
    this.#metrics.durations.push(durationMs);
    if (this.#metrics.durations.length > 256) this.#metrics.durations.shift();
    const operation = String(pending.operation || "unknown");
    const current = this.#metrics.operations.get(operation) || {
      calls: 0,
      errors: 0,
      totalMs: 0,
      maxMs: 0
    };
    current.calls++;
    if (failed) current.errors++;
    current.totalMs += durationMs;
    current.maxMs = Math.max(current.maxMs, durationMs);
    this.#metrics.operations.set(operation, current);
  }

  metricsSnapshot() {
    const sorted = [...this.#metrics.durations].sort((left, right) => left - right);
    const percentile = (value) => sorted.length
      ? sorted[Math.max(0, Math.ceil((value / 100) * sorted.length) - 1)]
      : 0;
    return {
      requests: this.#metrics.requests,
      errors: this.#metrics.errors,
      in_flight: this.#pending.size,
      mean_ms: roundMetric(this.#metrics.requests ? this.#metrics.totalMs / this.#metrics.requests : 0),
      p95_ms: roundMetric(percentile(95)),
      max_ms: roundMetric(this.#metrics.maxMs),
      by_operation: Object.fromEntries([...this.#metrics.operations.entries()].map(([operation, metric]) => [
        operation,
        {
          calls: metric.calls,
          errors: metric.errors,
          mean_ms: roundMetric(metric.calls ? metric.totalMs / metric.calls : 0),
          max_ms: roundMetric(metric.maxMs)
        }
      ]))
    };
  }

  #notifyPendingDrained() {
    if (this.#pending.size !== 0) return;
    const waiters = this.#pendingWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  async #waitForPending() {
    if (this.#pending.size === 0) return;
    await new Promise((resolve) => this.#pendingWaiters.push(resolve));
  }

  #failAll(error) {
    for (const pending of this.#pending.values()) {
      this.#recordMetric(pending, true);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#notifyPendingDrained();
  }

  async #request(
    operation,
    payload = {},
    { allowClosed = false, allowClosing = false } = {}
  ) {
    if (!this.#readyResolved) await this.#ready;
    if (this.#closed && !allowClosed) {
      throw new StorageError("SQLITE_DATABASE_CLOSED", "SQLite worker database is closed.");
    }
    if (this.#closing && !allowClosing) {
      throw new StorageError("SQLITE_DATABASE_CLOSING", "SQLite worker database is closing.");
    }
    if (this.#exited) {
      throw new StorageError("SQLITE_WORKER_EXIT", "SQLite worker is no longer running.");
    }
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, operation, startedAt: performance.now() };
      this.#pending.set(id, pending);
      try {
        this.#worker.postMessage({ type: "request", id, operation, ...payload });
      } catch (error) {
        this.#pending.delete(id);
        this.#notifyPendingDrained();
        this.#recordMetric(pending, true);
        reject(error);
      }
    });
  }

  exec(sql) {
    return this.#request("exec", { sql });
  }

  run(sql, params = []) {
    return this.#request("run", { sql, params });
  }

  get(sql, params = []) {
    return this.#request("get", { sql, params });
  }

  all(sql, params = []) {
    return this.#request("all", { sql, params });
  }

  batch(steps, { transaction = true } = {}) {
    return this.#request("batch", { steps, transaction });
  }

  backup() {
    return this.#request("backup");
  }

  async health() {
    const health = await this.#request("health");
    return { ...health, clientMetrics: this.metricsSnapshot() };
  }

  async close() {
    if (this.#closed) return;
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      try {
        await this.#ready;
        await this.#waitForPending();
        if (!this.#exited) {
          await this.#request("close", {}, {
            allowClosed: true,
            allowClosing: true
          });
        }
      } finally {
        this.#closed = true;
        this.#closing = false;
        this.#failAll(
          new StorageError("SQLITE_DATABASE_CLOSED", "SQLite worker database is closed.")
        );
        await this.#worker.terminate().catch(() => {});
      }
    })();
    return this.#closePromise;
  }
}

class SharedDatabaseLease {
  #entry;
  #key;
  #closed = false;

  constructor(entry, key) {
    this.#entry = entry;
    this.#key = key;
    this.databasePath = entry.database.databasePath;
  }

  get initialHealth() {
    return this.#entry.database.initialHealth;
  }

  #database() {
    if (this.#closed) {
      throw new StorageError("SQLITE_DATABASE_CLOSED", "SQLite database lease is closed.");
    }
    return this.#entry.database;
  }

  exec(sql) {
    return this.#database().exec(sql);
  }

  run(sql, params = []) {
    return this.#database().run(sql, params);
  }

  get(sql, params = []) {
    return this.#database().get(sql, params);
  }

  all(sql, params = []) {
    return this.#database().all(sql, params);
  }

  batch(steps, options) {
    return this.#database().batch(steps, options);
  }

  backup() {
    return this.#database().backup();
  }

  health() {
    return this.#database().health();
  }

  metricsSnapshot() {
    return this.#database().metricsSnapshot();
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const entry = this.#entry;
    entry.references = Math.max(0, entry.references - 1);
    if (entry.references !== 0) return;
    if (REGISTRY_DATABASE_POOL.get(this.#key) === entry) {
      REGISTRY_DATABASE_POOL.delete(this.#key);
    }
    await entry.database.close();
  }
}

export async function openRegistryDatabase({
  databasePath,
  busyTimeoutMs = 5_000
}) {
  const resolvedPath = path.resolve(databasePath);
  let entry = REGISTRY_DATABASE_POOL.get(resolvedPath);
  if (!entry) {
    entry = { database: null, references: 0, opening: null };
    entry.opening = SqliteWorkerDatabase.open({
      databasePath: resolvedPath,
      busyTimeoutMs,
      schema: {
        version: REGISTRY_SCHEMA_VERSION,
        migrations: [
          { version: 1, sql: REGISTRY_SCHEMA_SQL },
          { version: 2, sql: REGISTRY_TASK_ROUTER_SCHEMA_SQL },
          { version: 3, sql: REGISTRY_TASK_BASELINE_SCHEMA_SQL },
          { version: 4, sql: REGISTRY_TRANSACTION_COORDINATOR_SCHEMA_SQL },
          { version: 5, sql: REGISTRY_WORKSPACE_LIFECYCLE_SCHEMA_SQL },
          { version: 6, sql: REGISTRY_TASK_ORCHESTRATION_SCHEMA_SQL },
          { version: 7, sql: REGISTRY_TASK_DETACHED_SCHEMA_SQL }
        ]
      }
    });
    REGISTRY_DATABASE_POOL.set(resolvedPath, entry);
  }
  try {
    entry.database ||= await entry.opening;
  } catch (error) {
    if (REGISTRY_DATABASE_POOL.get(resolvedPath) === entry) {
      REGISTRY_DATABASE_POOL.delete(resolvedPath);
    }
    throw error;
  }
  entry.references++;
  return new SharedDatabaseLease(entry, resolvedPath);
}

export async function openWorkspaceDatabase({
  databasePath,
  busyTimeoutMs = 5_000
}) {
  return SqliteWorkerDatabase.open({
    databasePath,
    busyTimeoutMs,
    schema: {
      version: WORKSPACE_SCHEMA_VERSION,
      migrations: [
        { version: 1, sql: WORKSPACE_SCHEMA_SQL },
        { version: 2, sql: WORKSPACE_NOTES_SCHEMA_SQL }
      ]
    }
  });
}

function roundMetric(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function isRecoverableDatabaseError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "");
  return code === "SQLITE_INTEGRITY_CHECK_FAILED" ||
    code.includes("CORRUPT") ||
    /database disk image is malformed|file is not a database|integrity check failed/i.test(message);
}

async function restoreDatabaseBackup(databasePath) {
  const backupPath = `${databasePath}.backup`;
  const backupInfo = await lstat(backupPath).catch(() => null);
  if (!backupInfo?.isFile() || backupInfo.isSymbolicLink()) return null;
  const quarantineDir = path.join(
    path.dirname(databasePath),
    "recovery",
    `${path.basename(databasePath)}-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`
  );
  await mkdir(quarantineDir, { recursive: true, mode: 0o700 });
  const quarantined = [];
  for (const source of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    const info = await lstat(source).catch(() => null);
    if (!info || info.isSymbolicLink()) continue;
    const destination = path.join(quarantineDir, path.basename(source));
    await rename(source, destination);
    quarantined.push(path.basename(source));
  }
  await copyFile(backupPath, databasePath);
  await chmod(databasePath, 0o600).catch(() => {});
  return {
    source: "clean_backup",
    quarantine: path.relative(path.dirname(databasePath), quarantineDir).split(path.sep).join("/"),
    quarantined
  };
}
