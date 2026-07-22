// Local Coding Agent runtime data activation and legacy migration
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm
} from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";

const ACTIVATION_FILE = ".runtime-activation.json";
const TEMP_OWNER_FILE = ".runtime-migration-owner.json";
const INTENT_FILE = ".runtime-migration-intent.json";
const LOCK_DIRECTORY = ".runtime-migration.lock";
const MIGRATION_VERSION = 1;
const STORAGE_WORKER_URL = new URL("./worker.mjs", import.meta.url);

export class RuntimeDataMigrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RuntimeDataMigrationError";
    this.code = code;
    this.details = details;
  }
}

export function resolveRuntimeDataPaths({ agentDataDir = "", configRoot = "" } = {}) {
  const dataRoot = agentDataDir
    ? path.resolve(agentDataDir)
    : path.resolve(configRoot, "data");
  return {
    dataRoot,
    runtimeDir: path.join(dataRoot, "runtime"),
    legacyDir: path.join(dataRoot, "v5"),
    intentPath: path.join(dataRoot, INTENT_FILE),
    lockDir: path.join(dataRoot, LOCK_DIRECTORY)
  };
}

export async function prepareRuntimeDataDirectory({
  agentDataDir = "",
  configRoot = "",
  assertStopped,
  validate = true,
  faultAt = "",
  stageHook
} = {}) {
  const paths = resolveRuntimeDataPaths({ agentDataDir, configRoot });
  await mkdir(paths.dataRoot, { recursive: true, mode: 0o700 });
  if (assertStopped && await needsStoppedRuntimeGuard(paths)) await assertStopped();

  const releaseLock = await acquireMigrationLock(paths);
  try {
    return await activateRuntimeDirectory(paths, { validate, faultAt, stageHook });
  } finally {
    await releaseLock();
  }
}

async function needsStoppedRuntimeGuard(paths) {
  const source = await entryIdentity(paths.legacyDir);
  if (!source) return false;
  const target = await entryIdentity(paths.runtimeDir);
  if (!target) return true;
  const activation = await readJson(path.join(paths.runtimeDir, ACTIVATION_FILE));
  return !activationMatchesSource(activation, source);
}

async function activateRuntimeDirectory(paths, options) {
  const source = await entryIdentity(paths.legacyDir);
  const target = await entryIdentity(paths.runtimeDir);
  const savedIntent = await readJson(paths.intentPath);

  if (source && target) {
    const activation = await readJson(path.join(paths.runtimeDir, ACTIVATION_FILE));
    if (!activationMatchesSource(activation, source)) {
      if (!await intentExplainsRenamedTarget(savedIntent, paths, source)) {
        throw new RuntimeDataMigrationError(
          "RUNTIME_DATA_CONFLICT",
          "Both legacy v5 data and runtime data exist without a verifiable activation marker. Refusing to merge them.",
          { legacy_dir: paths.legacyDir, runtime_dir: paths.runtimeDir }
        );
      }
      await validateRuntimeTree(paths.runtimeDir, options);
      await writeActivation(paths.runtimeDir, source, savedIntent.nonce);
      await durableRemoveFile(paths.intentPath);
      return activationResult(paths, "recovered", source);
    }
    await validateRuntimeTree(paths.runtimeDir, options);
    if (savedIntent) await durableRemoveFile(paths.intentPath);
    return activationResult(paths, savedIntent ? "recovered" : "active", source);
  }

  if (target) {
    await validateRuntimeTree(paths.runtimeDir, options);
    const activation = await readJson(path.join(paths.runtimeDir, ACTIVATION_FILE));
    if (!activation) await writeActivation(paths.runtimeDir, null, randomUUID());
    if (savedIntent) await durableRemoveFile(paths.intentPath);
    return activationResult(paths, "active", null);
  }

  if (!source) {
    await mkdir(paths.runtimeDir, { recursive: false, mode: 0o700 });
    await writeActivation(paths.runtimeDir, null, randomUUID());
    await syncDirectory(paths.dataRoot);
    if (savedIntent) await durableRemoveFile(paths.intentPath);
    return activationResult(paths, "fresh", null);
  }

  return migrateLegacyDirectory(paths, source, savedIntent, options);
}

async function migrateLegacyDirectory(paths, source, savedIntent, options) {
  const intent = normalizeIntent(savedIntent, paths, source);
  const tempDir = path.join(paths.dataRoot, `.runtime-migration-${intent.nonce}.tmp`);
  intent.temp_dir = tempDir;
  await durableWriteJson(paths.intentPath, { ...intent, stage: "intent" }, 0o600);
  await migrationStage(options, "after_intent", { paths, intent, tempDir });

  await rejectSymlinksAndEscapes(paths.legacyDir);
  await removeOwnedTemporary(tempDir, intent.nonce);
  await mkdir(tempDir, { recursive: false, mode: source.mode & 0o777 });
  await durableWriteJson(path.join(tempDir, TEMP_OWNER_FILE), {
    migration_version: MIGRATION_VERSION,
    nonce: intent.nonce,
    source: intent.source
  }, 0o600);
  await migrationStage(options, "before_copy", { paths, intent, tempDir });
  for (const entry of await readdir(paths.legacyDir)) {
    if (entry === ACTIVATION_FILE) continue;
    await cp(path.join(paths.legacyDir, entry), path.join(tempDir, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true
    });
  }
  await migrationStage(options, "after_copy_contents", { paths, intent, tempDir });
  await rejectSymlinksAndEscapes(paths.legacyDir);
  const sourceAfterCopy = await entryIdentity(paths.legacyDir);
  if (!sameIdentity(source, sourceAfterCopy)) {
    throw new RuntimeDataMigrationError(
      "RUNTIME_MIGRATION_SOURCE_CHANGED",
      "Legacy runtime data changed while it was being copied. Refusing to activate the temporary copy."
    );
  }
  await chmod(tempDir, source.mode & 0o777).catch(() => {});
  await durableWriteJson(paths.intentPath, { ...intent, stage: "copied" }, 0o600);
  await migrationStage(options, "after_copy", { paths, intent, tempDir });

  await migrationStage(options, "before_validation", { paths, intent, tempDir });
  await validateRuntimeTree(tempDir, options);
  await syncTree(tempDir);
  await durableWriteJson(paths.intentPath, { ...intent, stage: "validated" }, 0o600);
  await migrationStage(options, "after_validate", { paths, intent, tempDir });

  await durableWriteJson(paths.intentPath, { ...intent, stage: "rename_pending" }, 0o600);
  await rename(tempDir, paths.runtimeDir);
  await syncDirectory(paths.dataRoot);
  await durableWriteJson(paths.intentPath, { ...intent, stage: "renamed" }, 0o600);
  await migrationStage(options, "after_rename", { paths, intent, tempDir: paths.runtimeDir });

  await writeActivation(paths.runtimeDir, source, intent.nonce);
  await validateRuntimeTree(paths.runtimeDir, options);
  await migrationStage(options, "after_activation", { paths, intent, tempDir: paths.runtimeDir });
  await durableRemoveFile(paths.intentPath);
  return activationResult(paths, "migrated", source);
}

function normalizeIntent(saved, paths, source) {
  if (!saved) {
    return {
      migration_version: MIGRATION_VERSION,
      nonce: randomUUID(),
      source,
      source_dir: paths.legacyDir,
      target_dir: paths.runtimeDir,
      created_at: new Date().toISOString()
    };
  }
  if (
    saved.migration_version !== MIGRATION_VERSION ||
    saved.source_dir !== paths.legacyDir ||
    saved.target_dir !== paths.runtimeDir ||
    !sameIdentity(saved.source, source) ||
    !/^[0-9a-f-]{36}$/i.test(String(saved.nonce || ""))
  ) {
    throw new RuntimeDataMigrationError(
      "RUNTIME_MIGRATION_INTENT_CONFLICT",
      "An existing runtime migration intent does not match the legacy data source.",
      { intent_path: paths.intentPath }
    );
  }
  return saved;
}

async function acquireMigrationLock(paths) {
  const nonce = randomUUID();
  try {
    await mkdir(paths.lockDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const owner = await readJson(path.join(paths.lockDir, "owner.json"));
    if (owner?.pid && isProcessAlive(owner.pid)) {
      throw new RuntimeDataMigrationError(
        "RUNTIME_MIGRATION_LOCKED",
        "Runtime data migration is already owned by a live process.",
        { pid: owner.pid }
      );
    }
    await rm(paths.lockDir, { recursive: true, force: true });
    await mkdir(paths.lockDir, { mode: 0o700 });
  }
  await durableWriteJson(path.join(paths.lockDir, "owner.json"), {
    nonce,
    pid: process.pid,
    created_at: new Date().toISOString()
  }, 0o600);
  await syncDirectory(paths.dataRoot);
  return async () => {
    const owner = await readJson(path.join(paths.lockDir, "owner.json"));
    if (owner?.nonce !== nonce) return;
    await rm(paths.lockDir, { recursive: true, force: true });
    await syncDirectory(paths.dataRoot);
  };
}

async function removeOwnedTemporary(tempDir, nonce) {
  const info = await lstat(tempDir).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new RuntimeDataMigrationError("RUNTIME_MIGRATION_TEMP_UNSAFE", "Migration temporary path is not an owned directory.");
  }
  const owner = await readJson(path.join(tempDir, TEMP_OWNER_FILE));
  if (owner?.nonce !== nonce) {
    throw new RuntimeDataMigrationError("RUNTIME_MIGRATION_TEMP_FOREIGN", "Refusing to remove a migration temporary directory owned by another nonce.");
  }
  await rm(tempDir, { recursive: true, force: true });
}

async function rejectSymlinksAndEscapes(root) {
  const canonicalRoot = await realpath(root);
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new RuntimeDataMigrationError("RUNTIME_MIGRATION_SYMLINK", "Legacy runtime data contains a symlink.", { path: current });
    }
    const canonical = await realpath(current);
    if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new RuntimeDataMigrationError("RUNTIME_MIGRATION_ESCAPE", "Legacy runtime data resolves outside its canonical root.", { path: current });
    }
    if (!info.isDirectory()) continue;
    for (const entry of await readdir(current)) pending.push(path.join(current, entry));
  }
}

export async function validateRuntimeTree(root, { validate = true, faultAt = "", stageHook } = {}) {
  if (!validate) return { sqlite: 0, json: 0 };
  await rejectSymlinksAndEscapes(root);
  const sqliteFiles = [];
  const jsonFiles = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    const info = await lstat(current);
    if (info.isDirectory()) {
      for (const entry of await readdir(current)) pending.push(path.join(current, entry));
      continue;
    }
    if (!info.isFile()) continue;
    if (/\.(?:sqlite|sqlite3|db)$/i.test(current)) sqliteFiles.push(current);
    if (/\.json$/i.test(current) && /(journal|transaction|manifest|migration|activation|owner)/i.test(current)) {
      jsonFiles.push(current);
    }
  }
  for (const file of jsonFiles) JSON.parse(await readFile(file, "utf8"));
  for (const file of sqliteFiles) await checkSqliteIntegrity(file);
  await migrationStage({ validate, faultAt, stageHook }, "during_validation", { root });
  return { sqlite: sqliteFiles.length, json: jsonFiles.length };
}

async function checkSqliteIntegrity(databasePath) {
  await new Promise((resolve, reject) => {
    const worker = new Worker(STORAGE_WORKER_URL, {
      workerData: { mode: "integrity", databasePath },
      env: { ...process.env, NODE_NO_WARNINGS: "1" }
    });
    let settled = false;
    const finish = async (error) => {
      if (settled) return;
      settled = true;
      await worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve();
    };
    worker.once("message", (message) => {
      if (message?.type !== "ready") return;
      if (!message.ok || String(message.health?.integrity || "").toLowerCase() !== "ok") {
        const error = new RuntimeDataMigrationError(
          "RUNTIME_SQLITE_INTEGRITY",
          message?.error?.message || `SQLite integrity check failed for ${databasePath}.`
        );
        finish(error);
        return;
      }
      finish();
    });
    worker.once("error", finish);
  });
}

async function entryIdentity(candidate) {
  const info = await lstat(candidate).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new RuntimeDataMigrationError("RUNTIME_DATA_PATH_UNSAFE", "Runtime data path must be a real directory.", { path: candidate });
  }
  return {
    canonical_path: await realpath(candidate),
    device: String(info.dev),
    inode: String(info.ino),
    mode: info.mode,
    modified_ms: Math.trunc(info.mtimeMs)
  };
}

function activationMatchesSource(marker, source) {
  return marker?.migration_version === MIGRATION_VERSION && sameIdentity(marker.source, source);
}

async function intentExplainsRenamedTarget(intent, paths, source) {
  if (
    !["rename_pending", "renamed"].includes(intent?.stage) ||
    intent?.source_dir !== paths.legacyDir ||
    intent?.target_dir !== paths.runtimeDir ||
    !sameIdentity(intent?.source, source)
  ) return false;
  const owner = await readJson(path.join(paths.runtimeDir, TEMP_OWNER_FILE));
  return owner?.nonce === intent?.nonce;
}

function sameIdentity(left, right) {
  return Boolean(left && right) &&
    left.canonical_path === right.canonical_path &&
    String(left.device) === String(right.device) &&
    String(left.inode) === String(right.inode) &&
    Number(left.mode) === Number(right.mode) &&
    Number(left.modified_ms) === Number(right.modified_ms);
}

async function writeActivation(runtimeDir, source, nonce) {
  await durableWriteJson(path.join(runtimeDir, ACTIVATION_FILE), {
    migration_version: MIGRATION_VERSION,
    active: true,
    nonce,
    source,
    activated_at: new Date().toISOString(),
    schema: { registry: 4, workspace: 2 }
  }, 0o600);
  await syncDirectory(runtimeDir);
}

async function durableWriteJson(file, value, mode) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  await syncDirectory(path.dirname(file));
}

async function durableRemoveFile(file) {
  await rm(file, { force: true });
  await syncDirectory(path.dirname(file));
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function syncTree(root) {
  const pending = [root];
  const directories = [];
  while (pending.length) {
    const current = pending.pop();
    const info = await lstat(current);
    if (info.isDirectory()) {
      directories.push(current);
      for (const entry of await readdir(current)) pending.push(path.join(current, entry));
      continue;
    }
    if (!info.isFile()) continue;
    const handle = await open(current, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
  for (const directory of directories.reverse()) await syncDirectory(directory);
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "EPERM", "EISDIR", "EBADF"].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function migrationStage(options, stage, context = {}) {
  if (typeof options?.stageHook === "function") {
    await options.stageHook(stage, context);
  }
  if (options?.faultAt !== stage) return;
  throw new RuntimeDataMigrationError("RUNTIME_MIGRATION_FAULT", `Injected migration fault at ${stage}.`, { stage });
}

function activationResult(paths, state, source) {
  return {
    state,
    runtimeDir: paths.runtimeDir,
    legacyBackupDir: source ? paths.legacyDir : null,
    migrated: state === "migrated" || state === "recovered"
  };
}
