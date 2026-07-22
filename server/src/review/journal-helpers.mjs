// Local Coding Agent change journal records, replay and diff helpers.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ChangeJournalError, JOURNAL_SCHEMA_VERSION } from "./journal-contract.mjs";

export function buildRecord({
  changeId,
  workspaceId,
  source,
  before,
  after,
  renameGroups,
  computeStats = true,
  routingTaskId = null,
  transactionId = null
}) {
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
      stats: computeStats ? lineStatsFromRuntime(beforeRuntime, afterRuntime) : null
    });
  }

  const stats = sumLineStats(files);

  return {
    id: changeId,
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    workspace: workspaceId,
    routingTaskId,
    transactionId,
    source: String(source || "mutation"),
    status: files.length ? "applied" : "failed",
    createdAt: now,
    updatedAt: now,
    files,
    stats,
    statsPending: !computeStats && files.length > 0,
    renameGroups: normalizedRenameGroups,
    undoable: files.some((file) => file.undoable),
    lastOperation: null
  };
}

export function emptyIndex() {
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    changes: [],
    tasks: [],
    activeTaskId: null,
    activities: []
  };
}

export function createTaskRecord({ workspaceId, title }) {
  const now = new Date().toISOString();
  return {
    id: createId("task"),
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    workspace: workspaceId,
    title: normalizeTaskTitle(title) || "LCA task",
    status: "active",
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    operationIds: [],
    lastOperation: null
  };
}

export function normalizeTaskTitle(value) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 180) : "";
}

export function sourceTitle() {
  return "LCA task";
}

export function taskIndexEntry(task) {
  return {
    id: task.id,
    routingTaskId: task.routingTaskId || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    status: task.status,
    operationCount: Array.isArray(task.operationIds) ? task.operationIds.length : 0
  };
}

export function publicTask(task) {
  return JSON.parse(JSON.stringify({
    ...task,
    operationCount: Array.isArray(task.operationIds) ? task.operationIds.length : 0
  }));
}

export function aggregateTask(task, records) {
  const pathStates = new Map();
  for (const record of records || []) {
    for (const file of record.files || []) {
      const state = pathStates.get(file.path) || {
        path: file.path,
        before: file.before,
        after: file.after,
        operationFiles: []
      };
      if (!state.operationFiles.length) state.before = file.before;
      state.after = file.after;
      state.operationFiles.push(file);
      pathStates.set(file.path, state);
    }
  }

  const components = buildRenameComponents(records);
  const componentByPath = new Map();
  for (const component of components) {
    for (const filePath of component) componentByPath.set(filePath, component);
  }

  const renameGroups = [];
  const groupByPath = new Map();
  let renameIndex = 0;
  for (const component of components) {
    const initial = [...component].filter((filePath) => pathStates.get(filePath)?.before?.exists);
    const final = [...component].filter((filePath) => pathStates.get(filePath)?.after?.exists);
    if (initial.length !== 1 || final.length !== 1 || initial[0] === final[0]) continue;
    const group = {
      id: `task_rename_${++renameIndex}`,
      atomic: true,
      from: initial[0],
      to: final[0]
    };
    renameGroups.push(group);
    for (const filePath of component) groupByPath.set(filePath, group.id);
  }

  const files = [];
  for (const state of pathStates.values()) {
    if (snapshotMatches(state.before, state.after)) continue;
    const component = componentByPath.get(state.path);
    const relevantFiles = component
      ? [...component].flatMap((filePath) => pathStates.get(filePath)?.operationFiles || [])
      : state.operationFiles;
    const undoable = relevantFiles.length > 0 && relevantFiles.every((file) => file.undoable);
    const allUndone = relevantFiles.length > 0
      && relevantFiles.filter((file) => file.undoable).every((file) => file.undoStatus === "undone");
    files.push({
      path: state.path,
      operation: determineOperation(state.before, state.after, groupByPath.has(state.path)),
      before: state.before,
      after: state.after,
      undoable,
      undoStatus: undoable ? allUndone ? "undone" : "applied" : "not_undoable",
      group: groupByPath.get(state.path) || null,
      stats: null
    });
  }

  const derived = deriveStatus(files);
  const status = task.lastOperation?.status === "conflict"
    ? "conflict"
    : task.lastOperation?.kind === "reapply" && derived === "applied"
      ? "reapplied"
      : derived;
  const sources = [...new Set((records || []).map((record) => record.source).filter(Boolean))];
  const transactionIds = [...new Set((records || []).map((record) => record.transactionId).filter(Boolean))];
  const createdAt = task.createdAt || records?.[0]?.createdAt || new Date().toISOString();
  const updatedAt = task.updatedAt || records?.[records.length - 1]?.updatedAt || createdAt;

  return {
    id: task.id,
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    workspace: task.workspace,
    routingTaskId: task.routingTaskId || null,
    transactionIds,
    source: sources.length === 1 ? sources[0] : "task",
    title: task.title || "LCA task",
    taskStatus: task.status || "completed",
    completedAt: task.completedAt || null,
    operationCount: records.length,
    operationIds: records.map((record) => record.id),
    operations: records.map((record) => ({
      id: record.id,
      source: record.source,
      transactionId: record.transactionId || null,
      createdAt: record.createdAt,
      paths: (record.files || []).map((file) => file.path)
    })),
    status,
    createdAt,
    updatedAt,
    files,
    stats: sumLineStats(files),
    statsPending: files.some((file) => !hasLineStats(file.stats)),
    renameGroups,
    undoable: files.some((file) => file.undoable),
    lastOperation: task.lastOperation || null
  };
}

export function buildRenameComponents(records) {
  const graph = new Map();
  const connect = (left, right) => {
    const a = normalizeRelative(left);
    const b = normalizeRelative(right);
    if (!graph.has(a)) graph.set(a, new Set());
    if (!graph.has(b)) graph.set(b, new Set());
    graph.get(a).add(b);
    graph.get(b).add(a);
  };
  for (const record of records || []) {
    for (const group of record.renameGroups || []) connect(group.from, group.to);
  }
  const visited = new Set();
  const components = [];
  for (const start of graph.keys()) {
    if (visited.has(start)) continue;
    const component = new Set();
    const stack = [start];
    while (stack.length) {
      const current = stack.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      component.add(current);
      for (const next of graph.get(current) || []) stack.push(next);
    }
    components.push(component);
  }
  return components;
}

export function expandTaskPaths(records, paths) {
  if (!Array.isArray(paths) || !paths.length) return null;
  const requested = new Set(paths.map(normalizeRelative));
  for (const component of buildRenameComponents(records)) {
    if ([...component].some((filePath) => requested.has(filePath))) {
      for (const filePath of component) requested.add(filePath);
    }
  }
  return requested;
}

export function eligibleOperationFiles(record, requested, operation) {
  const expanded = requested ? new Set(requested) : null;
  if (expanded) {
    for (const group of record.renameGroups || []) {
      if (expanded.has(group.from) || expanded.has(group.to)) {
        expanded.add(group.from);
        expanded.add(group.to);
      }
    }
  }
  return (record.files || []).filter((file) => {
    if (expanded && !expanded.has(file.path)) return false;
    if (!file.undoable) return false;
    return operation === "undo" ? file.undoStatus === "applied" : file.undoStatus === "undone";
  });
}

export function createSerialLock() {
  let tail = Promise.resolve();
  return function withLock(work) {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    return previous.then(work).finally(release);
  };
}

export function compareJournalRecords(left, right) {
  return String(right?.createdAt || right?.updatedAt || "")
    .localeCompare(String(left?.createdAt || left?.updatedAt || "")) ||
    String(left?.id || "").localeCompare(String(right?.id || ""));
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  const source = Array.isArray(items) ? items : [];
  const output = new Array(source.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, Number(concurrency) || 1), source.length || 1) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= source.length) return;
      output[index] = await mapper(source[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

export function snapshotRuntimeBytes(snapshots) {
  let total = 0;
  for (const snapshot of snapshots || []) {
    if (snapshot?.buffer) total += snapshot.buffer.length;
    else if (typeof snapshot?.text === "string") total += Buffer.byteLength(snapshot.text);
  }
  return total;
}

export function determineOperation(before, after, isRename) {
  if (isRename) return "renamed";
  if (!before?.exists && after?.exists) return "created";
  if (before?.exists && !after?.exists) return "deleted";
  if (before?.type !== "file" || after?.type !== "file") return "metadata_only";
  return "modified";
}

export function selectFiles(record, paths, operation) {
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

export function groupForApplication(files) {
  const groups = new Map();
  for (const file of files) {
    const key = file.group || `file:${file.path}`;
    if (!groups.has(key)) groups.set(key, { rename: Boolean(file.group), files: [] });
    groups.get(key).files.push(file);
  }
  return [...groups.values()];
}

export function deriveStatus(files) {
  const eligible = files.filter((file) => file.undoable);
  if (!eligible.length) return "applied";
  const undone = eligible.filter((file) => file.undoStatus === "undone").length;
  if (undone === 0) return "applied";
  if (undone === eligible.length) return "undone";
  return "partially_undone";
}

export function snapshotMatches(left, right) {
  if (!left || !right) return false;
  if (Boolean(left.exists) !== Boolean(right.exists)) return false;
  if (!left.exists) return true;
  return left.type === right.type && left.version === right.version;
}

export function conflictItem(filePath, expected, current) {
  return {
    path: normalizeRelative(filePath),
    expectedVersion: expected?.version ?? null,
    currentVersion: current?.version ?? null,
    expectedExists: Boolean(expected?.exists),
    currentExists: Boolean(current?.exists)
  };
}

export function conflictError(changeId, files) {
  return new ChangeJournalError(
    "change_conflict",
    "The current filesystem state does not match the expected change state.",
    { changeId, files, filesystemChanged: false },
    409
  );
}

export async function publicRecordWithStats(record, readSnapshotTextFn) {
  const clone = publicRecord(record);
  const sourceFiles = Array.isArray(record.files) ? record.files : [];
  const targetFiles = Array.isArray(clone.files) ? clone.files : [];

  for (let index = 0; index < targetFiles.length; index++) {
    const file = targetFiles[index];
    if (hasLineStats(file.stats)) continue;
    file.stats = await lineStatsFromStoredFile(sourceFiles[index], readSnapshotTextFn).catch(() => null);
  }
  clone.stats = sumLineStats(targetFiles);
  clone.statsPending = false;
  return clone;
}

export function publicRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

export function hasLineStats(value) {
  return Boolean(
    value
    && Number.isInteger(value.additions)
    && value.additions >= 0
    && Number.isInteger(value.deletions)
    && value.deletions >= 0
  );
}

export function lineStatsFromRuntime(before, after) {
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

export async function lineStatsFromStoredFile(file, readSnapshotTextFn) {
  if (!file?.before || !file?.after) return null;
  if (!snapshotTextAvailable(file.before) || !snapshotTextAvailable(file.after)) return null;
  const beforeText = file.before.exists ? await readSnapshotTextFn(file.before) : "";
  const afterText = file.after.exists ? await readSnapshotTextFn(file.after) : "";
  return countLineChanges(beforeText, afterText);
}

export function snapshotTextAvailable(snapshot) {
  return !snapshot.exists || (
    snapshot.type === "file"
    && snapshot.undoable
    && Boolean(snapshot.snapshot)
  );
}

export function sumLineStats(files) {
  let additions = 0;
  let deletions = 0;
  for (const file of files || []) {
    if (!hasLineStats(file.stats)) continue;
    additions += file.stats.additions;
    deletions += file.stats.deletions;
  }
  return { additions, deletions };
}

export function countLineChanges(beforeText, afterText) {
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

export function splitTextLines(value) {
  if (!value) return [];
  const lines = String(value).replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function myersEditDistance(beforeLines, afterLines) {
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

export function stripRuntimeFields(record) {
  return JSON.parse(JSON.stringify(record));
}

export function stripRuntimeSnapshot(snapshot) {
  if (!snapshot) return snapshot;
  const { absolutePath, buffer, text, ...serializable } = snapshot;
  return serializable;
}

export function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function metadataVersion(info, type) {
  return createHash("sha256")
    .update(`${type}:${info.size}:${info.mode}:${info.mtimeMs}`)
    .digest("hex");
}

export function isLikelyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const value of sample) {
    if (value < 7 || (value > 13 && value < 32)) suspicious++;
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}

export function normalizeForMap(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized;
}

export function normalizeRelative(value) {
  return String(value || ".").split(path.sep).join("/").replace(/^\.\//, "");
}

export function dedupePaths(paths) {
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

export function snapshotFileName(rel) {
  return `${createHash("sha256").update(rel).digest("hex")}.json`;
}

export function createId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
  return `${prefix}_${stamp}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

export function validateId(id, prefix) {
  const expression = new RegExp(`^${prefix}_[A-Za-z0-9_]+$`);
  if (!expression.test(String(id || ""))) {
    throw new ChangeJournalError("invalid_change_id", "Invalid change id.", {}, 400);
  }
}

export async function atomicWriteJson(filePath, value) {
  await atomicWriteBuffer(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

export async function atomicWriteBuffer(filePath, buffer, { mode = 0o600 } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(tempPath, "wx", mode);
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

export async function atomicWriteBufferIfAbsent(filePath, buffer) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await rename(tempPath, filePath);
    } catch (error) {
      if (!["EEXIST", "EPERM"].includes(error?.code) || !await fileExists(filePath)) {
        throw error;
      }
      await unlink(tempPath).catch(() => {});
    }
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

export async function syncDirectory(directoryPath) {
  const directory = await open(directoryPath, "r").catch(() => null);
  if (!directory) return;
  try {
    await directory.sync();
  } finally {
    await directory.close().catch(() => {});
  }
}

export async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function resolveContainedPath(root, relativePath) {
  const raw = String(relativePath || "");
  if (!raw || path.isAbsolute(raw)) {
    throw new ChangeJournalError("snapshot_corrupt", "Snapshot path is invalid.", {}, 409);
  }
  const base = path.resolve(root);
  const resolved = path.resolve(base, raw);
  const relative = path.relative(base, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ChangeJournalError("snapshot_corrupt", "Snapshot path escapes journal storage.", {}, 409);
  }
  return resolved;
}

export function createUnifiedDiff(filePath, before, after, beforeExists, afterExists) {
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
