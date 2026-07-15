// Local Coding Agent
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export class ChangeJournalError extends Error {
  constructor(code, message, details = {}, statusCode = 400) {
    super(message);
    this.name = "ChangeJournalError";
    this.code = code;
    this.details = details;
    this.statusCode = statusCode;
  }

  toJSON() {
    return {
      error: this.code,
      code: this.code,
      message: this.message,
      ...this.details
    };
  }
}

export function createChangeJournal({
  root,
  workspaceId,
  dataDir,
  validatePath,
  toRelativePath = (value) => path.relative(root, value),
  maxSnapshotBytes = DEFAULT_MAX_SNAPSHOT_BYTES
}) {
  if (!root || !workspaceId || !dataDir || typeof validatePath !== "function") {
    throw new TypeError("createChangeJournal requires root, workspaceId, dataDir and validatePath.");
  }

  const recordsDir = path.join(dataDir, "records");
  const snapshotsDir = path.join(dataDir, "snapshots");
  const activitiesDir = path.join(dataDir, "activities");
  const indexPath = path.join(dataDir, "index.json");
  const knownVersions = new Map();
  let operationLock = Promise.resolve();
  let initialized = false;

  function withOperationLock(work) {
    const previous = operationLock;
    let release;
    operationLock = new Promise((resolve) => { release = resolve; });
    return previous.then(work).finally(release);
  }

  async function init() {
    if (initialized) return;
    await mkdir(recordsDir, { recursive: true });
    await mkdir(snapshotsDir, { recursive: true });
    await mkdir(activitiesDir, { recursive: true });
    try {
      await access(indexPath);
    } catch {
      await atomicWriteJson(indexPath, { schemaVersion: SCHEMA_VERSION, changes: [], activities: [] });
    }
    initialized = true;
  }

  function normalizeAbsolute(filePath) {
    return normalizeForMap(path.resolve(filePath));
  }

  function rememberRead(filePath, buffer) {
    const version = hashBuffer(buffer);
    knownVersions.set(normalizeAbsolute(filePath), version);
    return version;
  }

  function forgetRead(filePath) {
    knownVersions.delete(normalizeAbsolute(filePath));
  }

  async function capturePath(filePath, { changeId, side, persist = true } = {}) {
    const abs = validatePath(filePath);
    const rel = normalizeRelative(toRelativePath(abs));
    let info;
    try {
      info = await lstat(abs);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          path: rel,
          absolutePath: abs,
          exists: false,
          type: "missing",
          size: 0,
          version: null,
          snapshot: null,
          undoable: true
        };
      }
      throw error;
    }

    if (info.isSymbolicLink()) {
      return {
        path: rel,
        absolutePath: abs,
        exists: true,
        type: "symlink",
        size: info.size,
        version: metadataVersion(info, "symlink"),
        snapshot: null,
        undoable: false,
        reason: "symlink"
      };
    }

    if (info.isDirectory()) {
      return {
        path: rel,
        absolutePath: abs,
        exists: true,
        type: "directory",
        size: info.size,
        version: metadataVersion(info, "directory"),
        snapshot: null,
        undoable: false,
        reason: "directory_metadata_only"
      };
    }

    if (!info.isFile()) {
      return {
        path: rel,
        absolutePath: abs,
        exists: true,
        type: "other",
        size: info.size,
        version: metadataVersion(info, "other"),
        snapshot: null,
        undoable: false,
        reason: "unsupported_type"
      };
    }

    const buffer = await readFile(abs);
    const version = hashBuffer(buffer);
    const binary = isLikelyBinary(buffer);
    const withinLimit = buffer.length <= maxSnapshotBytes;
    const undoable = withinLimit && !binary;
    let snapshot = null;

    if (persist && undoable && changeId && side) {
      const snapshotPath = path.join(snapshotsDir, changeId, side, snapshotFileName(rel));
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      await atomicWriteJson(snapshotPath, {
        schemaVersion: SCHEMA_VERSION,
        exists: true,
        type: "file",
        size: buffer.length,
        version,
        encoding: "base64",
        content: buffer.toString("base64"),
        undoable: true
      });
      snapshot = normalizeRelative(path.relative(dataDir, snapshotPath));
    }

    return {
      path: rel,
      absolutePath: abs,
      exists: true,
      type: "file",
      size: buffer.length,
      version,
      snapshot,
      undoable,
      reason: undoable ? null : binary ? "binary_file" : "snapshot_limit",
      buffer: !binary ? buffer : undefined,
      text: !binary ? buffer.toString("utf8") : undefined
    };
  }

  async function runMutation({ source, paths, renameGroups = [], mutate }) {
    return withOperationLock(async () => {
      await init();
      const changeId = createId("change");
      const normalizedPaths = dedupePaths(paths.map((item) => validatePath(item)));
      const before = [];
      for (const filePath of normalizedPaths) {
        before.push(await capturePath(filePath, { changeId, side: "before", persist: true }));
      }
      assertNotStale(before);

      let mutationResult;
      try {
        mutationResult = await mutate({
          changeId,
          before: new Map(before.map((item) => [normalizeAbsolute(item.absolutePath), item]))
        });
      } catch (error) {
        await rm(path.join(snapshotsDir, changeId), { recursive: true, force: true }).catch(() => {});
        throw error;
      }

      const after = [];
      for (const filePath of normalizedPaths) {
        after.push(await capturePath(filePath, { changeId, side: "after", persist: true }));
      }

      const record = buildRecord({ changeId, workspaceId, source, before, after, renameGroups });
      if (record.files.length > 0) {
        await saveRecord(record);
        for (const file of record.files) {
          const abs = validatePath(file.path);
          const nextVersion = file.after?.version ?? null;
          knownVersions.set(normalizeAbsolute(abs), nextVersion);
        }
      } else {
        await rm(path.join(snapshotsDir, changeId), { recursive: true, force: true }).catch(() => {});
      }

      return {
        result: mutationResult,
        change: record.files.length > 0 ? publicRecord(record) : null
      };
    });
  }

  function assertNotStale(beforeSnapshots) {
    for (const snapshot of beforeSnapshots) {
      if (snapshot.type !== "file" && snapshot.type !== "missing") continue;
      const key = normalizeAbsolute(snapshot.absolutePath);
      if (!knownVersions.has(key)) continue;
      const knownVersion = knownVersions.get(key);
      const currentVersion = snapshot.version;
      if (knownVersion !== currentVersion) {
        throw new ChangeJournalError(
          "STALE_FILE",
          "The file changed after it was read. Reread the file and retry the mutation.",
          {
            path: snapshot.path,
            knownVersion,
            currentVersion
          },
          409
        );
      }
    }
  }

  async function recordActivity(activity) {
    return withOperationLock(async () => {
      await init();
      const id = createId("activity");
      const createdAt = new Date().toISOString();
      const record = {
        id,
        schemaVersion: SCHEMA_VERSION,
        kind: "command",
        source: String(activity.source || "command"),
        createdAt,
        commandCount: Number(activity.commandCount || 1),
        completed: Number(activity.completed ?? activity.commandCount ?? 1),
        failed: Number(activity.failed || 0),
        cwd: normalizeRelative(String(activity.cwd || ".")),
        exitCode: activity.exitCode ?? null,
        timedOut: Boolean(activity.timedOut),
        message: String(activity.message || "Command completed.")
      };
      const recordPath = path.join(activitiesDir, `${id}.json`);
      await atomicWriteJson(recordPath, record);
      const index = await readIndex();
      index.activities.unshift({ id, createdAt });
      await atomicWriteJson(indexPath, index);
      return record;
    });
  }

  async function listChanges({ limit = 50 } = {}) {
    await init();
    const parsedLimit = Number(limit);
    const boundedLimit = Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(200, parsedLimit))
      : 50;
    const index = await readIndex();
    const changes = [];
    for (const entry of index.changes.slice(0, boundedLimit)) {
      const record = await readRecord(entry.id).catch(() => null);
      if (record) changes.push(await publicRecordWithStats(record, readSnapshotText));
    }
    return { count: changes.length, changes };
  }

  async function getChange(id) {
    await init();
    return publicRecordWithStats(await readRecord(id), readSnapshotText);
  }

  async function getDiff(id, { path: selectedPath } = {}) {
    await init();
    const record = await readRecord(id);
    const requested = selectedPath ? normalizeRelative(selectedPath) : null;
    const files = requested ? record.files.filter((file) => file.path === requested) : record.files;
    const chunks = [];
    const unavailable = [];
    for (const file of files) {
      if (!file.before?.undoable || !file.after?.undoable) {
        unavailable.push({ path: file.path, reason: file.before?.reason || file.after?.reason || "diff_unavailable" });
        continue;
      }
      const beforeText = file.before.exists ? await readSnapshotText(file.before) : "";
      const afterText = file.after.exists ? await readSnapshotText(file.after) : "";
      chunks.push(createUnifiedDiff(file.path, beforeText, afterText, file.before.exists, file.after.exists));
    }
    return {
      changeId: id,
      path: requested,
      diff: chunks.filter(Boolean).join("\n"),
      truncated: false,
      unavailable
    };
  }

  async function getContent(id, { path: selectedPath, side } = {}) {
    await init();
    const record = await readRecord(id);
    const requested = normalizeRelative(String(selectedPath || ""));
    if (!requested || requested === ".") {
      throw new ChangeJournalError("change_path_required", "A change path is required.", {}, 400);
    }
    if (side !== "before" && side !== "after") {
      throw new ChangeJournalError("invalid_change_side", "Side must be before or after.", {}, 400);
    }
    const file = record.files.find((item) => item.path === requested);
    if (!file) {
      throw new ChangeJournalError("change_path_not_found", "No matching path in change.", { changeId: id, path: requested }, 404);
    }
    const snapshot = file[side];
    if (!snapshot?.exists) {
      return {
        changeId: id,
        path: requested,
        side,
        exists: false,
        type: snapshot?.type || "missing",
        undoable: Boolean(snapshot?.undoable),
        version: snapshot?.version ?? null,
        reason: snapshot?.reason || null,
        content: ""
      };
    }
    if (snapshot.type !== "file" || !snapshot.undoable || !snapshot.snapshot) {
      return {
        changeId: id,
        path: requested,
        side,
        exists: true,
        type: snapshot.type,
        undoable: false,
        version: snapshot.version ?? null,
        reason: snapshot.reason || "content_unavailable",
        content: null
      };
    }
    return {
      changeId: id,
      path: requested,
      side,
      exists: true,
      type: "file",
      undoable: true,
      version: snapshot.version ?? null,
      reason: null,
      content: await readSnapshotText(snapshot)
    };
  }

  async function undo(id, { paths } = {}) {
    return withOperationLock(async () => {
      await init();
      const record = await readRecord(id);
      const selected = selectFiles(record, paths, "undo");
      const conflicts = await preflightFiles(selected, "after");
      if (conflicts.length) {
        await markConflict(record, "undo", conflicts);
        throw conflictError(record.id, conflicts);
      }
      for (const group of groupForApplication(selected)) {
        await applyUndoGroup(group);
      }
      for (const file of selected) file.undoStatus = file.undoable ? "undone" : "not_undoable";
      record.status = deriveStatus(record.files);
      record.updatedAt = new Date().toISOString();
      record.lastOperation = { kind: "undo", status: "ok", at: record.updatedAt, paths: selected.map((item) => item.path) };
      await saveRecord(record, { updateIndex: false });
      return publicRecordWithStats(record, readSnapshotText);
    });
  }

  async function reapply(id, { paths } = {}) {
    return withOperationLock(async () => {
      await init();
      const record = await readRecord(id);
      const selected = selectFiles(record, paths, "reapply");
      const conflicts = await preflightFiles(selected, "before");
      if (conflicts.length) {
        await markConflict(record, "reapply", conflicts);
        throw conflictError(record.id, conflicts);
      }
      for (const group of groupForApplication(selected)) {
        await applyReapplyGroup(group);
      }
      for (const file of selected) file.undoStatus = file.undoable ? "applied" : "not_undoable";
      const derived = deriveStatus(record.files);
      record.status = derived === "applied" ? "reapplied" : derived;
      record.updatedAt = new Date().toISOString();
      record.lastOperation = { kind: "reapply", status: "ok", at: record.updatedAt, paths: selected.map((item) => item.path) };
      await saveRecord(record, { updateIndex: false });
      return publicRecordWithStats(record, readSnapshotText);
    });
  }

  async function undoAll() {
    return withOperationLock(async () => {
      await init();
      const index = await readIndex();
      const records = [];
      for (const entry of index.changes) {
        const record = await readRecord(entry.id);
        if (record.files.some((file) => file.undoable && file.undoStatus === "applied")) records.push(record);
      }

      const projected = new Map();
      const conflicts = [];
      for (const record of records) {
        const selected = selectFiles(record, undefined, "undo");
        for (const file of selected) {
          const key = normalizeAbsolute(validatePath(file.path));
          const expected = file.after;
          const projectedState = projected.has(key) ? projected.get(key) : await capturePath(file.path, { persist: false });
          if (!snapshotMatches(projectedState, expected)) {
            conflicts.push(conflictItem(file.path, expected, projectedState));
          } else {
            projected.set(key, file.before);
          }
        }
      }
      if (conflicts.length) throw conflictError("undo-all", conflicts);

      const undone = [];
      for (const record of records) {
        const selected = selectFiles(record, undefined, "undo");
        for (const group of groupForApplication(selected)) await applyUndoGroup(group);
        for (const file of selected) file.undoStatus = file.undoable ? "undone" : "not_undoable";
        record.status = deriveStatus(record.files);
        record.updatedAt = new Date().toISOString();
        record.lastOperation = { kind: "undo", status: "ok", at: record.updatedAt, paths: selected.map((item) => item.path) };
        await saveRecord(record, { updateIndex: false });
        undone.push(record.id);
      }
      return { ok: true, undone };
    });
  }

  async function clear() {
    return withOperationLock(async () => {
      await init();
      const index = await readIndex();
      const deleted = index.changes.length;
      await rm(recordsDir, { recursive: true, force: true });
      await rm(snapshotsDir, { recursive: true, force: true });
      await rm(activitiesDir, { recursive: true, force: true });
      await Promise.all([
        mkdir(recordsDir, { recursive: true }),
        mkdir(snapshotsDir, { recursive: true }),
        mkdir(activitiesDir, { recursive: true })
      ]);
      await atomicWriteJson(indexPath, { schemaVersion: SCHEMA_VERSION, changes: [], activities: [] });
      initialized = true;
      return { ok: true, deleted };
    });
  }

  async function saveRecord(record, { updateIndex = true } = {}) {
    const recordPath = path.join(recordsDir, `${record.id}.json`);
    await atomicWriteJson(recordPath, stripRuntimeFields(record));
    if (updateIndex) {
      const index = await readIndex();
      index.changes = index.changes.filter((entry) => entry.id !== record.id);
      index.changes.unshift({ id: record.id, createdAt: record.createdAt });
      await atomicWriteJson(indexPath, index);
    }
  }

  async function readRecord(id) {
    validateId(id, "change");
    try {
      return JSON.parse(await readFile(path.join(recordsDir, `${id}.json`), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new ChangeJournalError("change_not_found", "Change not found.", { changeId: id }, 404);
      }
      throw error;
    }
  }

  async function readIndex() {
    const parsed = JSON.parse(await readFile(indexPath, "utf8"));
    return {
      schemaVersion: SCHEMA_VERSION,
      changes: Array.isArray(parsed.changes) ? parsed.changes : [],
      activities: Array.isArray(parsed.activities) ? parsed.activities : []
    };
  }

  async function preflightFiles(files, expectedSide) {
    const conflicts = [];
    for (const file of files) {
      if (!file.undoable) continue;
      const current = await capturePath(file.path, { persist: false });
      const expected = file[expectedSide];
      if (!snapshotMatches(current, expected)) conflicts.push(conflictItem(file.path, expected, current));
    }
    return conflicts;
  }

  async function applyUndoGroup(group) {
    if (group.rename) return applyRenameState(group.files, "before");
    for (const file of group.files) {
      if (!file.undoable) continue;
      await restoreSnapshot(file.path, file.before);
    }
  }

  async function applyReapplyGroup(group) {
    if (group.rename) return applyRenameState(group.files, "after");
    for (const file of group.files) {
      if (!file.undoable) continue;
      await restoreSnapshot(file.path, file.after);
    }
  }

  async function applyRenameState(files, side) {
    const desiredExisting = files.filter((file) => file[side]?.exists);
    const desiredMissing = files.filter((file) => !file[side]?.exists);
    if (desiredExisting.length === 1 && desiredMissing.length === 1) {
      const fromFile = desiredMissing[0];
      const toFile = desiredExisting[0];
      const from = validatePath(fromFile.path);
      const to = validatePath(toFile.path);
      await mkdir(path.dirname(to), { recursive: true });
      await rename(from, to);
      return;
    }
    for (const file of files) await restoreSnapshot(file.path, file[side]);
  }

  async function restoreSnapshot(filePath, snapshot) {
    const abs = validatePath(filePath);
    if (!snapshot?.exists) {
      await rm(abs, { recursive: true, force: true });
      return;
    }
    if (snapshot.type !== "file" || !snapshot.undoable) {
      throw new ChangeJournalError("change_not_undoable", `Path is not automatically restorable: ${filePath}`, { path: filePath }, 409);
    }
    const buffer = await readSnapshotBuffer(snapshot);
    await mkdir(path.dirname(abs), { recursive: true });
    await atomicWriteBuffer(abs, buffer);
  }

  async function readSnapshotBuffer(snapshot) {
    if (!snapshot.snapshot) throw new Error("Snapshot content is missing.");
    const payload = JSON.parse(await readFile(path.join(dataDir, snapshot.snapshot), "utf8"));
    return Buffer.from(payload.content || "", payload.encoding || "base64");
  }

  async function readSnapshotText(snapshot) {
    return (await readSnapshotBuffer(snapshot)).toString("utf8");
  }

  async function markConflict(record, kind, conflicts) {
    record.status = "conflict";
    record.updatedAt = new Date().toISOString();
    record.lastOperation = { kind, status: "conflict", at: record.updatedAt, conflicts };
    await saveRecord(record, { updateIndex: false });
  }

  return {
    init,
    rememberRead,
    forgetRead,
    runMutation,
    recordActivity,
    listChanges,
    getChange,
    getDiff,
    getContent,
    undo,
    reapply,
    undoAll,
    clear,
    get knownVersions() { return new Map(knownVersions); }
  };
}

function buildRecord({ changeId, workspaceId, source, before, after, renameGroups }) {
  const beforeByPath = new Map(before.map((item) => [item.path, item]));
  const afterByPath = new Map(after.map((item) => [item.path, item]));
  const now = new Date().toISOString();
  const normalizedRenameGroups = renameGroups.map((group, index) => ({
    id: group.id || `rename_${index + 1}`,
    atomic: true,
    from: normalizeRelative(group.from),
    to: normalizeRelative(group.to)
  }));
  const groupByPath = new Map();
  for (const group of normalizedRenameGroups) {
    groupByPath.set(group.from, group.id);
    groupByPath.set(group.to, group.id);
  }

  const files = [];
  for (const filePath of new Set([...beforeByPath.keys(), ...afterByPath.keys()])) {
    const beforeRuntime = beforeByPath.get(filePath);
    const afterRuntime = afterByPath.get(filePath);
    const beforeSnapshot = stripRuntimeSnapshot(beforeRuntime);
    const afterSnapshot = stripRuntimeSnapshot(afterRuntime);
    if (snapshotMatches(beforeSnapshot, afterSnapshot)) continue;
    const operation = determineOperation(beforeSnapshot, afterSnapshot, groupByPath.has(filePath));
    const undoable = groupByPath.has(filePath)
      ? true
      : Boolean(beforeSnapshot?.undoable && afterSnapshot?.undoable);
    files.push({
      path: filePath,
      operation,
      before: beforeSnapshot,
      after: afterSnapshot,
      undoable,
      undoStatus: undoable ? "applied" : "not_undoable",
      group: groupByPath.get(filePath) || null,
      stats: lineStatsFromRuntime(beforeRuntime, afterRuntime)
    });
  }

  const stats = sumLineStats(files);

  return {
    id: changeId,
    schemaVersion: SCHEMA_VERSION,
    workspace: workspaceId,
    source: String(source || "mutation"),
    status: files.length ? "applied" : "failed",
    createdAt: now,
    updatedAt: now,
    files,
    stats,
    renameGroups: normalizedRenameGroups,
    undoable: files.some((file) => file.undoable),
    lastOperation: null
  };
}

function determineOperation(before, after, isRename) {
  if (isRename) return "renamed";
  if (!before?.exists && after?.exists) return "created";
  if (before?.exists && !after?.exists) return "deleted";
  if (before?.type !== "file" || after?.type !== "file") return "metadata_only";
  return "modified";
}

function selectFiles(record, paths, operation) {
  let requested = Array.isArray(paths) && paths.length ? new Set(paths.map(normalizeRelative)) : null;
  if (requested) {
    for (const group of record.renameGroups || []) {
      if (requested.has(group.from) || requested.has(group.to)) {
        requested.add(group.from);
        requested.add(group.to);
      }
    }
  }
  const files = record.files.filter((file) => !requested || requested.has(file.path));
  if (!files.length) throw new ChangeJournalError("change_path_not_found", "No matching paths in change.", {}, 404);
  const selected = files.filter((file) => {
    if (!file.undoable) return false;
    if (operation === "undo") return file.undoStatus === "applied";
    return file.undoStatus === "undone";
  });
  if (!selected.length) {
    throw new ChangeJournalError("change_not_applicable", `No paths are eligible for ${operation}.`, {}, 409);
  }
  return selected;
}

function groupForApplication(files) {
  const groups = new Map();
  for (const file of files) {
    const key = file.group || `file:${file.path}`;
    if (!groups.has(key)) groups.set(key, { rename: Boolean(file.group), files: [] });
    groups.get(key).files.push(file);
  }
  return [...groups.values()];
}

function deriveStatus(files) {
  const eligible = files.filter((file) => file.undoable);
  if (!eligible.length) return "applied";
  const undone = eligible.filter((file) => file.undoStatus === "undone").length;
  if (undone === 0) return "applied";
  if (undone === eligible.length) return "undone";
  return "partially_undone";
}

function snapshotMatches(left, right) {
  if (!left || !right) return false;
  if (Boolean(left.exists) !== Boolean(right.exists)) return false;
  if (!left.exists) return true;
  return left.type === right.type && left.version === right.version;
}

function conflictItem(filePath, expected, current) {
  return {
    path: normalizeRelative(filePath),
    expectedVersion: expected?.version ?? null,
    currentVersion: current?.version ?? null,
    expectedExists: Boolean(expected?.exists),
    currentExists: Boolean(current?.exists)
  };
}

function conflictError(changeId, files) {
  return new ChangeJournalError(
    "change_conflict",
    "The current filesystem state does not match the expected change state.",
    { changeId, files, filesystemChanged: false },
    409
  );
}

async function publicRecordWithStats(record, readSnapshotTextFn) {
  const clone = publicRecord(record);
  const sourceFiles = Array.isArray(record.files) ? record.files : [];
  const targetFiles = Array.isArray(clone.files) ? clone.files : [];

  for (let index = 0; index < targetFiles.length; index++) {
    const file = targetFiles[index];
    if (hasLineStats(file.stats)) continue;
    file.stats = await lineStatsFromStoredFile(sourceFiles[index], readSnapshotTextFn).catch(() => null);
  }
  clone.stats = sumLineStats(targetFiles);
  return clone;
}

function publicRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

function hasLineStats(value) {
  return Boolean(
    value
    && Number.isInteger(value.additions)
    && value.additions >= 0
    && Number.isInteger(value.deletions)
    && value.deletions >= 0
  );
}

function lineStatsFromRuntime(before, after) {
  if (!before || !after) return null;
  if (before.exists && before.type !== "file") return null;
  if (after.exists && after.type !== "file") return null;
  if (before.exists && typeof before.text !== "string") return null;
  if (after.exists && typeof after.text !== "string") return null;
  return countLineChanges(
    before.exists ? before.text : "",
    after.exists ? after.text : ""
  );
}

async function lineStatsFromStoredFile(file, readSnapshotTextFn) {
  if (!file?.before || !file?.after) return null;
  if (!snapshotTextAvailable(file.before) || !snapshotTextAvailable(file.after)) return null;
  const beforeText = file.before.exists ? await readSnapshotTextFn(file.before) : "";
  const afterText = file.after.exists ? await readSnapshotTextFn(file.after) : "";
  return countLineChanges(beforeText, afterText);
}

function snapshotTextAvailable(snapshot) {
  return !snapshot.exists || (
    snapshot.type === "file"
    && snapshot.undoable
    && Boolean(snapshot.snapshot)
  );
}

function sumLineStats(files) {
  let additions = 0;
  let deletions = 0;
  for (const file of files || []) {
    if (!hasLineStats(file.stats)) continue;
    additions += file.stats.additions;
    deletions += file.stats.deletions;
  }
  return { additions, deletions };
}

function countLineChanges(beforeText, afterText) {
  const beforeLines = splitTextLines(beforeText);
  const afterLines = splitTextLines(afterText);

  let start = 0;
  while (
    start < beforeLines.length
    && start < afterLines.length
    && beforeLines[start] === afterLines[start]
  ) {
    start++;
  }

  let beforeEnd = beforeLines.length;
  let afterEnd = afterLines.length;
  while (
    beforeEnd > start
    && afterEnd > start
    && beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]
  ) {
    beforeEnd--;
    afterEnd--;
  }

  const beforeChanged = beforeLines.slice(start, beforeEnd);
  const afterChanged = afterLines.slice(start, afterEnd);
  if (!beforeChanged.length) return { additions: afterChanged.length, deletions: 0 };
  if (!afterChanged.length) return { additions: 0, deletions: beforeChanged.length };

  const distance = myersEditDistance(beforeChanged, afterChanged);
  if (distance === null) {
    return { additions: afterChanged.length, deletions: beforeChanged.length };
  }
  const delta = afterChanged.length - beforeChanged.length;
  const additions = Math.max(0, Math.round((distance + delta) / 2));
  return {
    additions,
    deletions: Math.max(0, distance - additions)
  };
}

function splitTextLines(value) {
  if (!value) return [];
  const lines = String(value).replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function myersEditDistance(beforeLines, afterLines) {
  const beforeLength = beforeLines.length;
  const afterLength = afterLines.length;
  const max = beforeLength + afterLength;
  const offset = max + 1;
  const furthest = new Int32Array(max * 2 + 3);
  const maxWork = 5_000_000;
  let work = 0;
  furthest[offset + 1] = 0;

  for (let distance = 0; distance <= max; distance++) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (++work > maxWork) return null;
      const index = offset + diagonal;
      let x;
      if (
        diagonal === -distance
        || (diagonal !== distance && furthest[index - 1] < furthest[index + 1])
      ) {
        x = furthest[index + 1];
      } else {
        x = furthest[index - 1] + 1;
      }
      let y = x - diagonal;
      while (
        x < beforeLength
        && y < afterLength
        && beforeLines[x] === afterLines[y]
      ) {
        x++;
        y++;
      }
      furthest[index] = x;
      if (x >= beforeLength && y >= afterLength) return distance;
    }
  }
  return null;
}

function stripRuntimeFields(record) {
  return JSON.parse(JSON.stringify(record));
}

function stripRuntimeSnapshot(snapshot) {
  if (!snapshot) return snapshot;
  const { absolutePath, buffer, text, ...serializable } = snapshot;
  return serializable;
}

function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function metadataVersion(info, type) {
  return createHash("sha256")
    .update(`${type}:${info.size}:${info.mode}:${info.mtimeMs}`)
    .digest("hex");
}

function isLikelyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const value of sample) {
    if (value < 7 || (value > 13 && value < 32)) suspicious++;
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}

function normalizeForMap(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized;
}

function normalizeRelative(value) {
  return String(value || ".").split(path.sep).join("/").replace(/^\.\//, "");
}

function dedupePaths(paths) {
  const seen = new Set();
  const output = [];
  for (const filePath of paths) {
    const key = normalizeForMap(filePath);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(filePath);
  }
  return output;
}

function snapshotFileName(rel) {
  return `${createHash("sha256").update(rel).digest("hex")}.json`;
}

function createId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
  return `${prefix}_${stamp}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function validateId(id, prefix) {
  const expression = new RegExp(`^${prefix}_[A-Za-z0-9_]+$`);
  if (!expression.test(String(id || ""))) {
    throw new ChangeJournalError("invalid_change_id", "Invalid change id.", {}, 400);
  }
}

async function atomicWriteJson(filePath, value) {
  await atomicWriteBuffer(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

async function atomicWriteBuffer(filePath, buffer) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, buffer);
  await rename(tempPath, filePath);
}

function createUnifiedDiff(filePath, before, after, beforeExists, afterExists) {
  if (before === after && beforeExists === afterExists) return "";
  const oldName = beforeExists ? `a/${filePath}` : "/dev/null";
  const newName = afterExists ? `b/${filePath}` : "/dev/null";
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const lines = [`--- ${oldName}`, `+++ ${newName}`, `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`];
  for (const line of beforeLines) lines.push(`-${line}`);
  for (const line of afterLines) lines.push(`+${line}`);
  return lines.join("\n");
}
