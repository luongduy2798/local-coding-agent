// Local Coding Agent change journal task lifecycle.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ChangeJournalError } from "./journal-contract.mjs";
import {
  aggregateTask,
  atomicWriteJson,
  createTaskRecord,
  normalizeTaskTitle,
  publicTask,
  sourceTitle,
  taskIndexEntry,
  validateId
} from "./journal-helpers.mjs";

export function createJournalTaskService({
  indexPath,
  init,
  readIndex,
  readTaskIfPresent,
  readTaskOperations,
  saveTask,
  withOperationLock,
  workspaceId
}) {
  async function beginTask({ title, forceNew = false } = {}) {
    return withOperationLock(async () => {
      await init();
      const index = await readIndex();
      const existing = index.activeTaskId ? await readTaskIfPresent(index.activeTaskId) : null;
      const normalizedTitle = normalizeTaskTitle(title);
      if (existing?.status === "active" && !forceNew) {
        const shouldStartNew = normalizedTitle
          && existing.operationIds.length > 0
          && existing.title !== "LCA task"
          && existing.title !== normalizedTitle;
        if (!shouldStartNew) {
          if (normalizedTitle && existing.title !== normalizedTitle) {
            existing.title = normalizedTitle;
            existing.updatedAt = new Date().toISOString();
            await saveTask(existing);
          }
          return publicTask(existing);
        }
      }
      if (existing?.status === "active") await completeTaskUnlocked(existing, index);
      const task = createTaskRecord({ workspaceId, title: normalizedTitle });
      index.activeTaskId = task.id;
      index.tasks = index.tasks.filter((entry) => entry.id !== task.id);
      index.tasks.unshift(taskIndexEntry(task));
      await Promise.all([saveTask(task, { updateIndex: false }), atomicWriteJson(indexPath, index)]);
      return publicTask(task);
    });
  }

  async function completeTask({ title, taskId } = {}) {
    return withOperationLock(async () => {
      await init();
      const index = await readIndex();
      const selectedTaskId = taskId || index.activeTaskId;
      if (!selectedTaskId) return null;
      const task = await readTaskIfPresent(selectedTaskId);
      if (!task) {
        if (!taskId) index.activeTaskId = null;
        await atomicWriteJson(indexPath, index);
        return null;
      }
      const normalizedTitle = normalizeTaskTitle(title);
      if (normalizedTitle) task.title = normalizedTitle;
      await completeTaskUnlocked(task, index);
      return task.operationIds.length ? aggregateTask(task, await readTaskOperations(task)) : publicTask(task);
    });
  }

  async function prepareTaskCompletion({ taskId } = {}) {
    return withOperationLock(async () => {
      await init();
      const index = await readIndex();
      const selectedTaskId = taskId || index.activeTaskId;
      if (!selectedTaskId) return null;
      const task = await readTaskIfPresent(selectedTaskId);
      if (!task) return null;
      if (task.status !== "active" && task.status !== "completed") {
        throw new ChangeJournalError(
          "change_task_state_invalid",
          `Task change set cannot be completed from status ${task.status}.`,
          { taskId: selectedTaskId, status: task.status },
          409
        );
      }
      const operations = await readTaskOperations(task);
      return task.operationIds.length ? aggregateTask(task, operations) : publicTask(task);
    });
  }

  async function reopenTask({ taskId } = {}) {
    return withOperationLock(async () => {
      await init();
      validateId(taskId, "task");
      const index = await readIndex();
      const task = await readTaskIfPresent(taskId);
      if (!task) return null;
      if (task.status === "active") return publicTask(task);
      if (task.status !== "completed") {
        throw new ChangeJournalError(
          "change_task_reopen_invalid",
          `Task change set cannot be reopened from status ${task.status}.`,
          { taskId, status: task.status },
          409
        );
      }
      if (index.activeTaskId && index.activeTaskId !== taskId) {
        const active = await readTaskIfPresent(index.activeTaskId);
        if (active?.status === "active") {
          throw new ChangeJournalError(
            "change_task_reopen_conflict",
            "Another change task is already active.",
            { taskId, activeTaskId: active.id },
            409
          );
        }
      }
      const now = new Date().toISOString();
      task.status = "active";
      task.completedAt = null;
      task.updatedAt = now;
      index.activeTaskId = task.id;
      index.tasks = index.tasks.filter((entry) => entry.id !== task.id);
      index.tasks.unshift(taskIndexEntry(task));
      await Promise.all([saveTask(task, { updateIndex: false }), atomicWriteJson(indexPath, index)]);
      return publicTask(task);
    });
  }

  async function completeTaskUnlocked(task, index) {
    const now = new Date().toISOString();
    task.status = "completed";
    task.completedAt = now;
    task.updatedAt = now;
    index.activeTaskId = index.activeTaskId === task.id ? null : index.activeTaskId;
    index.tasks = index.tasks.filter((entry) => entry.id !== task.id);
    index.tasks.unshift(taskIndexEntry(task));
    await Promise.all([saveTask(task, { updateIndex: false }), atomicWriteJson(indexPath, index)]);
  }

  async function ensureActiveTaskUnlocked(source, taskTitle) {
    const index = await readIndex();
    const normalizedTitle = normalizeTaskTitle(taskTitle);
    if (index.activeTaskId) {
      const current = await readTaskIfPresent(index.activeTaskId);
      if (current?.status === "active") {
        const shouldStartNew = normalizedTitle
          && current.operationIds.length > 0
          && current.title !== "LCA task"
          && current.title !== normalizedTitle;
        if (!shouldStartNew) {
          if (normalizedTitle && current.title !== normalizedTitle) {
            current.title = normalizedTitle;
            current.updatedAt = new Date().toISOString();
            index.tasks = index.tasks.filter((entry) => entry.id !== current.id);
            index.tasks.unshift(taskIndexEntry(current));
            await Promise.all([saveTask(current, { updateIndex: false }), atomicWriteJson(indexPath, index)]);
          }
          return { task: current, index };
        }
        await completeTaskUnlocked(current, index);
      }
      index.activeTaskId = null;
    }
    const task = createTaskRecord({ workspaceId, title: normalizedTitle || sourceTitle(source) });
    index.activeTaskId = task.id;
    index.tasks = index.tasks.filter((entry) => entry.id !== task.id);
    index.tasks.unshift(taskIndexEntry(task));
    await Promise.all([saveTask(task, { updateIndex: false }), atomicWriteJson(indexPath, index)]);
    return { task, index };
  }

  async function ensureRoutedTaskUnlocked(routingTaskId, source, taskTitle) {
    validateId(routingTaskId, "task");
    const index = await readIndex();
    let task = await readTaskIfPresent(routingTaskId);
    const normalizedTitle = normalizeTaskTitle(taskTitle);
    if (!task) {
      task = {
        ...createTaskRecord({ workspaceId, title: normalizedTitle || sourceTitle(source) }),
        id: routingTaskId,
        routingTaskId
      };
    } else if (task.status !== "active") {
      throw new ChangeJournalError(
        "change_task_closed",
        `Task change set is already ${task.status}.`,
        { taskId: routingTaskId },
        409
      );
    } else if (normalizedTitle && task.title !== normalizedTitle) {
      task.title = normalizedTitle;
      task.updatedAt = new Date().toISOString();
    }
    index.tasks = index.tasks.filter((entry) => entry.id !== task.id);
    index.tasks.unshift(taskIndexEntry(task));
    await Promise.all([saveTask(task, { updateIndex: false }), atomicWriteJson(indexPath, index)]);
    return { task, index };
  }

  return {
    beginTask,
    completeTask,
    ensureActiveTaskUnlocked,
    ensureRoutedTaskUnlocked,
    prepareTaskCompletion,
    reopenTask
  };
}

