// Local Coding Agent
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  brotliCompress,
  brotliDecompress,
  constants as zlibConstants
} from "node:zlib";
import {
  ChangeJournalError,
  DEFAULT_MAX_SNAPSHOT_BYTES,
  JOURNAL_SCHEMA_VERSION
} from "./review/journal-contract.mjs";
import { createJournalSnapshotStore } from "./review/journal-snapshots.mjs";
import { createJournalTaskService } from "./review/journal-tasks.mjs";
import {
  aggregateTask,
  atomicWriteBuffer,
  atomicWriteBufferIfAbsent,
  atomicWriteJson,
  buildRecord,
  buildRenameComponents,
  compareJournalRecords,
  conflictError,
  conflictItem,
  createId,
  createSerialLock,
  createTaskRecord,
  createUnifiedDiff,
  dedupePaths,
  deriveStatus,
  determineOperation,
  eligibleOperationFiles,
  emptyIndex,
  expandTaskPaths,
  fileExists,
  groupForApplication,
  hashBuffer,
  hasLineStats,
  isLikelyBinary,
  lineStatsFromRuntime,
  lineStatsFromStoredFile,
  mapWithConcurrency,
  metadataVersion,
  normalizeForMap,
  normalizeRelative,
  normalizeTaskTitle,
  publicRecord,
  publicRecordWithStats,
  publicTask,
  resolveContainedPath,
  selectFiles,
  snapshotFileName,
  snapshotMatches,
  snapshotRuntimeBytes,
  sourceTitle,
  stripRuntimeFields,
  sumLineStats,
  taskIndexEntry,
  validateId
} from "./review/journal-helpers.mjs";

const compressBrotli = promisify(brotliCompress);
const decompressBrotli = promisify(brotliDecompress);
export { ChangeJournalError } from "./review/journal-contract.mjs";

export function createChangeJournal({
  root,
  workspaceId,
  dataDir,
  validatePath,
  toRelativePath = (value) => path.relative(root, value),
  maxSnapshotBytes = DEFAULT_MAX_SNAPSHOT_BYTES,
  snapshotConcurrency = 4,
  deferLineStats = true,
  deferLineStatsBytes = 512_000
}) {
  if (!root || !workspaceId || !dataDir || typeof validatePath !== "function") {
    throw new TypeError("createChangeJournal requires root, workspaceId, dataDir and validatePath.");
  }

  const recordsDir = path.join(dataDir, "records");
  const tasksDir = path.join(dataDir, "tasks");
  const snapshotsDir = path.join(dataDir, "snapshots");
  const blobsDir = path.join(dataDir, "blobs");
  const activitiesDir = path.join(dataDir, "activities");
  const indexPath = path.join(dataDir, "index.json");
  const knownVersions = new Map();
  const withOperationLock = createSerialLock();
  const withActivityLock = createSerialLock();
  const withIndexLock = createSerialLock();
  let initialized = false;
  let initPromise = null;
  let indexRecoveryPromise = null;
  let statsQueue = Promise.resolve();
  const { capturePath, forgetRead, normalizeAbsolute, rememberRead } = createJournalSnapshotStore({
    blobsDir,
    dataDir,
    knownVersions,
    maxSnapshotBytes,
    snapshotsDir,
    toRelativePath,
    validatePath
  });

  async function init() {
    if (initialized) return;
    if (!initPromise) {
      initPromise = (async () => {
        await mkdir(recordsDir, { recursive: true });
        await mkdir(tasksDir, { recursive: true });
        await mkdir(snapshotsDir, { recursive: true });
        await mkdir(blobsDir, { recursive: true });
        await mkdir(activitiesDir, { recursive: true });
        try {
          await access(indexPath);
        } catch {
          await atomicWriteJson(indexPath, emptyIndex());
        }
        initialized = true;
      })();
    }
    await initPromise;
  }

  const {
    beginTask,
    completeTask,
    ensureActiveTaskUnlocked,
    ensureRoutedTaskUnlocked,
    prepareTaskCompletion,
    reopenTask
  } = createJournalTaskService({
    indexPath,
    init,
    readIndex,
    readTaskIfPresent,
    readTaskOperations,
    saveTask,
    withOperationLock,
    workspaceId
  });

  async function runMutation({
    source,
    paths,
    renameGroups = [],
    taskTitle,
    routingTaskId = null,
    transactionId = null,
    allowCommittedJournalFailure = false,
    mutate
  }) {
    return withOperationLock(async () => {
      await init();
      const { task, index } = routingTaskId
        ? await ensureRoutedTaskUnlocked(routingTaskId, source, taskTitle)
        : await ensureActiveTaskUnlocked(source, taskTitle);
      const changeId = createId("change");
      const normalizedPaths = dedupePaths(paths.map((item) => validatePath(item)));
      const before = await mapWithConcurrency(
        normalizedPaths,
        snapshotConcurrency,
        (filePath) => capturePath(filePath, { changeId, side: "before", persist: true })
      );
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

      try {
        const after = await mapWithConcurrency(
          normalizedPaths,
          snapshotConcurrency,
          (filePath) => capturePath(filePath, { changeId, side: "after", persist: true })
        );
        const runtimeBytes = snapshotRuntimeBytes(before) + snapshotRuntimeBytes(after);
        const shouldDeferStats = Boolean(deferLineStats && (normalizedPaths.length > 4 || runtimeBytes >= deferLineStatsBytes));
        const record = buildRecord({
          changeId,
          workspaceId,
          source,
          before,
          after,
          renameGroups,
          computeStats: !shouldDeferStats,
          routingTaskId,
          transactionId
        });
        record.taskId = task.id;
        if (record.files.length > 0) {
          await saveRecord(record, { updateIndex: false });
          task.operationIds.push(record.id);
          task.updatedAt = record.updatedAt;
          index.changes = index.changes.filter((entry) => entry.id !== record.id);
          index.changes.unshift({ id: record.id, createdAt: record.createdAt, taskId: task.id });
          index.tasks = index.tasks.filter((entry) => entry.id !== task.id);
          index.tasks.unshift(taskIndexEntry(task));
          await Promise.all([saveTask(task, { updateIndex: false }), atomicWriteJson(indexPath, index)]);
          if (record.statsPending) scheduleLineStats(record.id);
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
          change: record.files.length > 0 ? publicRecord(record) : null,
          task: record.files.length > 0 ? aggregateTask(task, [...await readTaskOperations(task)]) : publicTask(task),
          journalError: null
        };
      } catch (error) {
        if (!allowCommittedJournalFailure) throw error;
        return {
          result: mutationResult,
          change: null,
          task: publicTask(task),
          journalError: {
            code: error?.code || "JOURNAL_PERSIST_FAILED",
            message: error?.message || String(error),
            routing_task_id: routingTaskId,
            transaction_id: transactionId
          }
        };
      }
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
    return withActivityLock(async () => {
      await init();
      const id = createId("activity");
      const createdAt = new Date().toISOString();
      const record = {
        id,
        schemaVersion: JOURNAL_SCHEMA_VERSION,
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
      await withIndexLock(async () => {
        const recordPath = path.join(activitiesDir, `${id}.json`);
        await atomicWriteJson(recordPath, record);
        const index = await readIndex();
        index.activities.unshift({ id, createdAt });
        await atomicWriteJson(indexPath, index);
      });
      return record;
    });
  }

  async function listChanges({ limit = 50, offset = 0, taskId = null } = {}) {
    await init();
    const parsedLimit = Number(limit);
    const boundedLimit = Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(500, parsedLimit))
      : 50;
    const parsedOffset = Number(offset);
    const boundedOffset = Number.isSafeInteger(parsedOffset)
      ? Math.max(0, Math.min(100_000, parsedOffset))
      : 0;
    const targetCount = boundedOffset + boundedLimit + 1;
    const index = await readIndex();
    const candidates = [];
    const groupedOperationIds = new Set();
    for (const entry of index.tasks) {
      if (taskId && entry.id !== taskId) continue;
      const task = await readTaskIfPresent(entry.id);
      if (!task || !task.operationIds.length) continue;
      task.operationIds.forEach((id) => groupedOperationIds.add(id));
      const aggregate = aggregateTask(task, await readTaskOperations(task));
      if (aggregate.files.length && candidates.length < targetCount) {
        candidates.push(await publicRecordWithStats(aggregate, readSnapshotText));
      }
    }
    for (const entry of index.changes) {
      if (candidates.length >= targetCount) break;
      if (groupedOperationIds.has(entry.id)) continue;
      const record = await readRecordIfPresent(entry.id);
      if (record && (!taskId || record.routingTaskId === taskId || record.taskId === taskId)) {
        candidates.push(await publicRecordWithStats(record, readSnapshotText));
      }
    }
    const changes = candidates.slice(boundedOffset, boundedOffset + boundedLimit);
    return {
      count: changes.length,
      changes,
      pagination: {
        offset: boundedOffset,
        limit: boundedLimit,
        returned: changes.length,
        has_more: candidates.length > boundedOffset + changes.length,
        next_offset: candidates.length > boundedOffset + changes.length
          ? boundedOffset + changes.length
          : null
      }
    };
  }

  async function resolveChangeView(id, { taskId = null } = {}) {
    let view;
    if (String(id || "").startsWith("task_")) {
      const task = await readTask(id);
      view = aggregateTask(task, await readTaskOperations(task));
    } else {
      view = await readRecord(id);
    }
    if (
      taskId &&
      view.id !== taskId &&
      view.routingTaskId !== taskId &&
      view.taskId !== taskId
    ) {
      throw new ChangeJournalError(
        "change_task_mismatch",
        "Change does not belong to the active routing task.",
        { changeId: id, taskId },
        403
      );
    }
    return view;
  }

  async function getChange(id, { taskId = null } = {}) {
    await init();
    return publicRecordWithStats(await resolveChangeView(id, { taskId }), readSnapshotText);
  }

  async function getDiff(id, { path: selectedPath, taskId = null } = {}) {
    await init();
    const record = await resolveChangeView(id, { taskId });
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

  async function getContent(id, { path: selectedPath, side, taskId = null } = {}) {
    await init();
    const record = await resolveChangeView(id, { taskId });
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

  async function mutateTask(id, { paths } = {}, operation) {
    const task = await readTask(id);
    const records = await readTaskOperations(task);
    const aggregate = aggregateTask(task, records);
    const requested = expandTaskPaths(records, paths);
    const ordered = operation === "undo" ? [...records].reverse() : [...records];
    const expectedSide = operation === "undo" ? "after" : "before";
    const projectedSide = operation === "undo" ? "before" : "after";
    const projected = new Map();
    const conflicts = [];
    const plans = [];

    for (const record of ordered) {
      const selected = eligibleOperationFiles(record, requested, operation);
      if (!selected.length) continue;
      plans.push({ record, selected });
      for (const file of selected) {
        const key = normalizeAbsolute(validatePath(file.path));
        const expected = file[expectedSide];
        const current = projected.has(key)
          ? projected.get(key)
          : await capturePath(file.path, { persist: false });
        if (!snapshotMatches(current, expected)) {
          conflicts.push(conflictItem(file.path, expected, current));
        } else {
          projected.set(key, file[projectedSide]);
        }
      }
    }

    if (!plans.length) {
      throw new ChangeJournalError("change_not_applicable", `No paths are eligible for ${operation}.`, {}, 409);
    }
    if (conflicts.length) {
      const now = new Date().toISOString();
      task.updatedAt = now;
      task.lastOperation = { kind: operation, status: "conflict", at: now, conflicts };
      await saveTask(task);
      throw conflictError(task.id, conflicts);
    }

    for (const { record, selected } of plans) {
      for (const group of groupForApplication(selected)) {
        if (operation === "undo") await applyUndoGroup(group);
        else await applyReapplyGroup(group);
      }
      for (const file of selected) {
        file.undoStatus = file.undoable
          ? operation === "undo" ? "undone" : "applied"
          : "not_undoable";
      }
      const derived = deriveStatus(record.files);
      record.status = operation === "reapply" && derived === "applied" ? "reapplied" : derived;
      record.updatedAt = new Date().toISOString();
      record.lastOperation = { kind: operation, status: "ok", at: record.updatedAt, paths: selected.map((item) => item.path) };
      await saveRecord(record, { updateIndex: false });
    }

    task.updatedAt = new Date().toISOString();
    task.lastOperation = {
      kind: operation,
      status: "ok",
      at: task.updatedAt,
      paths: requested ? [...requested] : aggregate.files.map((file) => file.path)
    };
    await saveTask(task);
    return publicRecordWithStats(aggregateTask(task, records), readSnapshotText);
  }

  async function undo(id, { paths, taskId = null } = {}) {
    return withOperationLock(async () => {
      await init();
      await resolveChangeView(id, { taskId });
      if (String(id || "").startsWith("task_")) return mutateTask(id, { paths }, "undo");
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

  async function reapply(id, { paths, taskId = null } = {}) {
    return withOperationLock(async () => {
      await init();
      await resolveChangeView(id, { taskId });
      if (String(id || "").startsWith("task_")) return mutateTask(id, { paths }, "reapply");
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

  async function undoAll({ taskId = null } = {}) {
    return withOperationLock(async () => {
      await init();
      if (taskId) return mutateTask(taskId, {}, "undo");
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

  async function clear({ taskId = null } = {}) {
    return withOperationLock(async () => {
      await init();
      return withIndexLock(async () => {
        const index = await readIndex();
        if (taskId) {
          const task = await readTask(taskId);
          for (const operationId of task.operationIds || []) {
            await rm(path.join(recordsDir, `${operationId}.json`), { force: true });
            await rm(path.join(snapshotsDir, operationId), { recursive: true, force: true });
          }
          await rm(path.join(tasksDir, `${taskId}.json`), { force: true });
          index.tasks = index.tasks.filter((entry) => entry.id !== taskId);
          index.changes = index.changes.filter((entry) => !task.operationIds.includes(entry.id));
          if (index.activeTaskId === taskId) index.activeTaskId = null;
          await atomicWriteJson(indexPath, index);
          return { ok: true, deleted: task.operationIds.length ? 1 : 0, taskId };
        }
        const grouped = new Set();
        for (const entry of index.tasks) {
          const task = await readTaskIfPresent(entry.id);
          task?.operationIds?.forEach((id) => grouped.add(id));
        }
        const taskCount = index.tasks.filter((entry) => entry.operationCount > 0).length;
        const legacyCount = index.changes.filter((entry) => !grouped.has(entry.id)).length;
        const deleted = taskCount + legacyCount;
        await rm(recordsDir, { recursive: true, force: true });
        await rm(tasksDir, { recursive: true, force: true });
        await rm(snapshotsDir, { recursive: true, force: true });
        await rm(blobsDir, { recursive: true, force: true });
        await rm(activitiesDir, { recursive: true, force: true });
        await Promise.all([
          mkdir(recordsDir, { recursive: true }),
          mkdir(tasksDir, { recursive: true }),
          mkdir(snapshotsDir, { recursive: true }),
          mkdir(blobsDir, { recursive: true }),
          mkdir(activitiesDir, { recursive: true })
        ]);
        await atomicWriteJson(indexPath, emptyIndex());
        initialized = true;
        initPromise = Promise.resolve();
        return { ok: true, deleted };
      });
    });
  }

  async function saveRecord(record, { updateIndex = true } = {}) {
    const recordPath = path.join(recordsDir, `${record.id}.json`);
    await atomicWriteJson(recordPath, stripRuntimeFields(record));
    if (updateIndex) {
      await withIndexLock(async () => {
        const index = await readIndex();
        index.changes = index.changes.filter((entry) => entry.id !== record.id);
        index.changes.unshift({ id: record.id, createdAt: record.createdAt });
        await atomicWriteJson(indexPath, index);
      });
    }
  }

  async function saveTask(task, { updateIndex = true } = {}) {
    await atomicWriteJson(path.join(tasksDir, `${task.id}.json`), stripRuntimeFields(task));
    if (updateIndex) {
      await withIndexLock(async () => {
        const index = await readIndex();
        index.tasks = index.tasks.filter((entry) => entry.id !== task.id);
        index.tasks.unshift(taskIndexEntry(task));
        if (task.status === "active" && !task.routingTaskId) index.activeTaskId = task.id;
        else if (index.activeTaskId === task.id) index.activeTaskId = null;
        await atomicWriteJson(indexPath, index);
      });
    }
  }

  function scheduleLineStats(changeId) {
    statsQueue = statsQueue
      .then(() => new Promise((resolve) => setImmediate(resolve)))
      .then(async () => {
        const record = await readRecord(changeId);
        for (const file of record.files || []) {
          if (hasLineStats(file.stats)) continue;
          file.stats = await lineStatsFromStoredFile(file, readSnapshotText).catch(() => null);
        }
        record.stats = sumLineStats(record.files);
        record.statsPending = false;
        record.updatedAt = new Date().toISOString();
        await saveRecord(record, { updateIndex: false });
      })
      .catch(() => {});
  }

  async function readRecord(id) {
    validateId(id, "change");
    try {
      return JSON.parse(await readFile(path.join(recordsDir, `${id}.json`), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new ChangeJournalError("change_not_found", "Change not found.", { changeId: id }, 404);
      }
      throw new ChangeJournalError(
        "journal_corrupt",
        "A durable change record is unreadable.",
        { changeId: id, cause: error?.code || error?.name || "invalid_json" },
        409
      );
    }
  }

  async function readTask(id) {
    validateId(id, "task");
    try {
      const task = JSON.parse(await readFile(path.join(tasksDir, `${id}.json`), "utf8"));
      task.operationIds = Array.isArray(task.operationIds) ? task.operationIds : [];
      return task;
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new ChangeJournalError("change_not_found", "Task change set not found.", { changeId: id }, 404);
      }
      throw new ChangeJournalError(
        "journal_corrupt",
        "A durable task change set is unreadable.",
        { changeId: id, cause: error?.code || error?.name || "invalid_json" },
        409
      );
    }
  }

  async function readRecordIfPresent(id) {
    try {
      return await readRecord(id);
    } catch (error) {
      if (error instanceof ChangeJournalError && error.code === "change_not_found") return null;
      throw error;
    }
  }

  async function readTaskIfPresent(id) {
    try {
      return await readTask(id);
    } catch (error) {
      if (error instanceof ChangeJournalError && error.code === "change_not_found") return null;
      throw error;
    }
  }

  async function readTaskOperations(task) {
    const records = [];
    for (const id of task.operationIds || []) {
      try {
        records.push(await readRecord(id));
      } catch (error) {
        if (error instanceof ChangeJournalError && error.code === "change_not_found") {
          throw new ChangeJournalError(
            "journal_corrupt",
            "A task references a missing durable change record.",
            { taskId: task.id, changeId: id },
            409
          );
        }
        throw error;
      }
    }
    return records;
  }

  async function readIndex() {
    try {
      return normalizeIndex(JSON.parse(await readFile(indexPath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) {
        if (!indexRecoveryPromise) {
          indexRecoveryPromise = rebuildIndex().finally(() => {
            indexRecoveryPromise = null;
          });
        }
        return indexRecoveryPromise;
      }
      throw error;
    }
  }

  function normalizeIndex(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SyntaxError("Journal index must be an object.");
    }
    return {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      changes: Array.isArray(parsed.changes) ? parsed.changes : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      activeTaskId: typeof parsed.activeTaskId === "string" ? parsed.activeTaskId : null,
      activities: Array.isArray(parsed.activities) ? parsed.activities : []
    };
  }

  async function rebuildIndex() {
    const quarantine = path.join(
      dataDir,
      `index.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`
    );
    await rename(indexPath, quarantine).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    const readDirectoryRecords = async (directory, prefix) => {
      const output = [];
      const files = (await readdir(directory).catch(() => []))
        .filter((file) => file.startsWith(prefix) && file.endsWith(".json"))
        .sort();
      for (const file of files) {
        try {
          const value = JSON.parse(await readFile(path.join(directory, file), "utf8"));
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record is invalid");
          output.push(value);
        } catch (error) {
          throw new ChangeJournalError(
            "journal_corrupt",
            "Journal recovery found a damaged durable record.",
            { record: file, cause: error?.code || error?.name || "invalid_json" },
            409
          );
        }
      }
      return output;
    };
    const [tasks, records, activities] = await Promise.all([
      readDirectoryRecords(tasksDir, "task_"),
      readDirectoryRecords(recordsDir, "change_"),
      readDirectoryRecords(activitiesDir, "activity_")
    ]);
    tasks.sort(compareJournalRecords);
    records.sort(compareJournalRecords);
    activities.sort(compareJournalRecords);
    const activeTask = tasks.find((task) => task.status === "active" && !task.routingTaskId) || null;
    const rebuilt = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      changes: records.map((record) => ({ id: record.id, createdAt: record.createdAt })),
      tasks: tasks.map(taskIndexEntry),
      activeTaskId: activeTask?.id || null,
      activities: activities.map((activity) => ({ id: activity.id, createdAt: activity.createdAt }))
    };
    await atomicWriteJson(indexPath, rebuilt);
    return rebuilt;
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
      const desired = toFile[side];
      if (desired?.type === "file" && desired.undoable) {
        const current = await capturePath(toFile.path, { persist: false });
        if (!snapshotMatches(current, desired)) await restoreSnapshot(toFile.path, desired);
      }
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
    await atomicWriteBuffer(abs, buffer, {
      mode: Number.isInteger(snapshot.mode) ? snapshot.mode : 0o666
    });
  }

  async function readSnapshotBuffer(snapshot) {
    if (!snapshot.snapshot) throw new Error("Snapshot content is missing.");
    const metadataPath = resolveContainedPath(dataDir, snapshot.snapshot);
    const payload = JSON.parse(await readFile(metadataPath, "utf8"));
    if (!payload.blob) {
      // V3 and earlier stored base64 inline. Keep one-release recovery
      // compatibility so upgrades do not invalidate existing undo history.
      return Buffer.from(payload.content || "", payload.encoding || "base64");
    }
    const blobPath = resolveContainedPath(blobsDir, path.relative("blobs", payload.blob));
    const compressed = await readFile(blobPath);
    const buffer = payload.compression === "brotli"
      ? await decompressBrotli(compressed)
      : compressed;
    const expectedHash = String(payload.contentHash || payload.version || "");
    const actualHash = hashBuffer(buffer);
    if (
      !expectedHash ||
      actualHash !== expectedHash ||
      (Number.isFinite(Number(payload.size)) && buffer.length !== Number(payload.size))
    ) {
      throw new ChangeJournalError(
        "snapshot_corrupt",
        "Snapshot blob failed its content hash or size check.",
        { expectedHash, actualHash },
        409
      );
    }
    return buffer;
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
    beginTask,
    prepareTaskCompletion,
    completeTask,
    reopenTask,
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
