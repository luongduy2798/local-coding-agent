// Local Coding Agent MCP system and task lifecycle tools
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { TaskRouterError } from "../../workspace/task-router.mjs";

export function registerSystemTools(mcp, dependencies) {
  const {
    CHANGE_JOURNAL,
    CHECKPOINT_PATH,
    MAX_PROCS,
    PROC_BUFFER,
    TASK_PLAN_PATH,
    applyTaskCloseTestDelay,
    assertCommandAllowed,
    atomicWriteJson,
    currentMcpSessionId,
    currentTask,
    decodePageCursor,
    freezeTaskForMutation,
    getChangeJournal,
    historyPagination,
    injectTaskCloseJournalCorruptionForTest,
    isoNow,
    jsonResult,
    killProcessTree,
    markUnmanagedChange,
    mutationFingerprintChanged,
    pageScope,
    preflightTaskClose,
    prepareTaskJournals,
    primaryWorkspaceId,
    processes,
    qualifiedPath,
    reg,
    resolveWorkspacePath,
    rollbackCompletedTaskJournals,
    selectWorkspace,
    startBackground,
    taskArtifactPath,
    taskCloseIntentPath,
    taskRouter,
    taskRunningProcesses,
    toWorkspaceRel,
    workspaceInfoPayload,
    workspaceMutationFingerprint
  } = dependencies;
  reg(
    mcp,
    "lca_status",
    {
      title: "LCA status",
      description: "Default entry point for bare `lca` or `call lca` requests. Return runtime health, catalog, active sessions, effective selected workspace, performance, policy and safety.",
      inputSchema: {}
    },
    async () => jsonResult(await workspaceInfoPayload({ sessionId: currentMcpSessionId() }))
  );

  reg(
    mcp,
    "task_checkpoint",
    {
      title: "Task checkpoint",
      description: "Save a compact resumable checkpoint for the active task.",
      inputSchema: {
        summary: z.string().min(1),
        task_token: z.string().optional(),
        next_steps: z.array(z.string()).optional(),
        files: z.array(z.object({
          workspace_id: z.string().optional(),
          path: z.string().min(1),
          note: z.string().optional()
        })).optional()
      }
    },
    async ({ summary, task_token, next_steps = [], files = [] }) => {
      const routedTask = await currentTask({
        taskToken: task_token,
        required: Boolean(taskRouter)
      });
      if (routedTask) {
        for (const file of files) {
          const workspaceId = file.workspace_id || routedTask.primary_workspace_id;
          if (!routedTask.workspace_ids.includes(workspaceId)) {
            throw new TaskRouterError(
              "WORKSPACE_NOT_ATTACHED",
              `Checkpoint path refers to unattached workspace ${workspaceId}.`
            );
          }
          await resolveWorkspacePath(file.path, { workspaceId, taskToken: task_token });
          file.workspace_id = workspaceId;
        }
      }
      const planPath = taskArtifactPath(routedTask, "plan.json", TASK_PLAN_PATH);
      const checkpointPath = taskArtifactPath(routedTask, "checkpoint.json", CHECKPOINT_PATH);
      let plan = null;
      try { plan = JSON.parse(await readFile(planPath, "utf8")); } catch {}
      const checkpoint = { version: 5, saved_at: isoNow(), summary, next_steps, files, plan, task: routedTask };
      await mkdir(path.dirname(checkpointPath), { recursive: true });
      await atomicWriteJson(checkpointPath, checkpoint);
      return jsonResult({ ok: true, checkpoint });
    }
  );

  reg(
    mcp,
    "task_close",
    {
      title: "Close task",
      description: "Close the active Review Changes task after verification and return its final summary.",
      inputSchema: {
        title: z.string().max(180).optional(),
        status: z.enum(["complete", "incomplete", "failed"]).optional(),
        task_token: z.string().optional()
      }
    },
    async ({ title, status = "complete", task_token }) => {
      if (!taskRouter) {
        const reviewTasks = [{
          workspace_id: primaryWorkspaceId,
          task: await CHANGE_JOURNAL.completeTask({ title })
        }].filter((entry) => entry.task);
        return jsonResult({ ok: true, status, task: null, review_changes_tasks: reviewTasks });
      }

      const openTask = await currentTask({ taskToken: task_token, required: true });
      await applyTaskCloseTestDelay(openTask);
      const preflight = await preflightTaskClose(openTask);
      const hardBlockers = preflight.incomplete_reasons.filter((reason) =>
        ["TASK_PROCESS_RUNNING", "TRANSACTION_IN_DOUBT"].includes(reason)
      );
      if (!preflight.ok && (status === "complete" || hardBlockers.length > 0)) {
        return jsonResult({
          ok: false,
          status: "INCOMPLETE",
          requested_status: status,
          task: openTask,
          review_changes_tasks: [],
          completion_guard: preflight,
          incomplete_reasons: preflight.incomplete_reasons
        });
      }

      // Recheck immediately before journal finalization so a process started
      // during the workspace preflight cannot be hidden by a stale first read.
      const runningProcesses = taskRunningProcesses(openTask.id);
      if (runningProcesses.length) {
        return jsonResult({
          ok: false,
          status: "INCOMPLETE",
          requested_status: status,
          task: openTask,
          review_changes_tasks: [],
          completion_guard: {
            ...preflight,
            ok: false,
            status: "INCOMPLETE",
            running_processes: runningProcesses,
            incomplete_reasons: ["TASK_PROCESS_RUNNING"]
          },
          incomplete_reasons: ["TASK_PROCESS_RUNNING"]
        });
      }

      // Validate every journal before publishing a durable close intent. This
      // keeps ordinary corruption failures in all-before state.
      const prepared = await prepareTaskJournals(openTask);
      if (!prepared.ok) {
        return jsonResult({
          ok: false,
          status: "INCOMPLETE",
          requested_status: status,
          task: openTask,
          review_changes_tasks: [],
          completion_guard: {
            ...preflight,
            ok: false,
            status: "INCOMPLETE",
            journal_finalization_failed_workspace_ids: prepared.failed_workspace_ids,
            incomplete_reasons: ["JOURNAL_FINALIZATION_FAILED"]
          },
          incomplete_reasons: ["JOURNAL_FINALIZATION_FAILED"]
        });
      }

      const intentPath = taskCloseIntentPath(openTask.id);
      const intent = {
        version: 1,
        task_id: openTask.id,
        workspace_ids: [...openTask.workspace_ids],
        completed_workspace_ids: [],
        requested_status: status,
        status: "committing",
        created_at: isoNow(),
        updated_at: isoNow()
      };
      try {
        await atomicWriteJson(intentPath, intent);
      } catch {
        return jsonResult({
          ok: false,
          status: "INCOMPLETE",
          requested_status: status,
          task: openTask,
          review_changes_tasks: [],
          completion_guard: preflight,
          incomplete_reasons: ["TASK_CLOSE_INTENT_PERSIST_FAILED"]
        });
      }

      const finalized = [];
      let journalFailureWorkspaceId = null;
      try {
        for (let workspaceIndex = 0; workspaceIndex < prepared.entries.length; workspaceIndex++) {
          const entry = prepared.entries[workspaceIndex];
          await injectTaskCloseJournalCorruptionForTest(
            openTask.id,
            entry.workspace_id,
            workspaceIndex
          );
          const completedTask = await entry.journal.completeTask({ title, taskId: openTask.id });
          finalized.push({ workspace_id: entry.workspace_id, task: completedTask });
          intent.completed_workspace_ids.push(entry.workspace_id);
          intent.updated_at = isoNow();
          await atomicWriteJson(intentPath, intent);
        }
      } catch {
        journalFailureWorkspaceId = prepared.entries.find((entry) =>
          !intent.completed_workspace_ids.includes(entry.workspace_id)
        )?.workspace_id || intent.completed_workspace_ids.at(-1) || "unknown";
      }
      if (journalFailureWorkspaceId) {
        const rolledBack = await rollbackCompletedTaskJournals(
          openTask.id,
          prepared.entries,
          intent.completed_workspace_ids
        );
        intent.status = rolledBack.ok ? "rolled_back" : "in_doubt";
        intent.updated_at = isoNow();
        intent.failed_workspace_id = journalFailureWorkspaceId;
        intent.rollback_failed_workspace_ids = rolledBack.failed_workspace_ids;
        await atomicWriteJson(intentPath, intent).catch(() => {});
        return jsonResult({
          ok: false,
          status: "INCOMPLETE",
          requested_status: status,
          task: openTask,
          review_changes_tasks: [],
          completion_guard: preflight,
          incomplete_reasons: [
            rolledBack.ok ? "JOURNAL_FINALIZATION_FAILED" : "TASK_CLOSE_RECOVERY_REQUIRED"
          ]
        });
      }

      let routedTask;
      try {
        routedTask = await taskRouter.closeTask({
          taskToken: task_token,
          sessionId: currentMcpSessionId(),
          status: status === "failed" ? "failed" : "closed"
        });
      } catch {
        const rolledBack = await rollbackCompletedTaskJournals(
          openTask.id,
          prepared.entries,
          intent.completed_workspace_ids
        );
        intent.status = rolledBack.ok ? "rolled_back" : "in_doubt";
        intent.updated_at = isoNow();
        intent.rollback_failed_workspace_ids = rolledBack.failed_workspace_ids;
        await atomicWriteJson(intentPath, intent).catch(() => {});
        return jsonResult({
          ok: false,
          status: "INCOMPLETE",
          requested_status: status,
          task: openTask,
          review_changes_tasks: [],
          completion_guard: preflight,
          incomplete_reasons: [
            rolledBack.ok ? "TASK_ROUTER_CLOSE_FAILED" : "TASK_CLOSE_RECOVERY_REQUIRED"
          ]
        });
      }
      intent.status = "complete";
      intent.updated_at = isoNow();
      intent.router_status = routedTask.status;
      const intentDurable = await atomicWriteJson(intentPath, intent).then(() => true, () => false);
      return jsonResult({
        ok: true,
        status,
        task: routedTask,
        completion_guard: preflight,
        close_transaction: {
          status: intentDurable ? "complete" : "recovery_pending",
          workspace_count: intent.workspace_ids.length
        },
        review_changes_tasks: finalized.filter((entry) => entry.task)
      });
    }
  );

  reg(
    mcp,
    "process",
    {
      title: "Background process",
      description: "Start, list, inspect or stop background processes owned by LCA.",
      inputSchema: {
        action: z.enum(["start", "list", "output", "stop"]),
        id: z.string().optional(),
        command: z.string().optional(),
        cwd: z.string().optional(),
        workspace_id: z.string().optional(),
        task_token: z.string().optional(),
        shell: z.enum(["cmd", "powershell", "bash", "sh", "zsh"]).optional(),
        name: z.string().optional(),
        tail_chars: z.number().int().min(1).max(PROC_BUFFER).optional()
      }
    },
    async ({ action, id, command, cwd = ".", workspace_id, task_token, shell, name, tail_chars }) => {
      const routedTask = await currentTask({
        taskToken: task_token,
        required: Boolean(taskRouter)
      });
      const sessionId = currentMcpSessionId();
      const ownedProcesses = [...processes.values()].filter((item) =>
        routedTask
          ? item.taskId === routedTask.id
          : item.sessionId && item.sessionId === sessionId
      );
      if (action === "list") {
        return jsonResult({
          task_id: routedTask?.id || null,
          processes: ownedProcesses.map((item) => ({
            id: item.id,
            workspace_id: item.workspaceId || primaryWorkspaceId,
            name: item.name,
            command: item.command,
            cwd: item.workspaceId && item.cwd
              ? { workspace_id: item.workspaceId, path: item.cwd }
              : undefined,
            status: item.status,
            exit_code: item.exitCode,
            pid: item.child?.pid,
            started_at: item.startedAt,
            unmanaged_changes: item.unmanagedChanges === true
          }))
        });
      }
      if (action === "start") {
        if (!command) throw new Error("command is required for action=start");
        assertCommandAllowed(command);
        await freezeTaskForMutation(task_token);
        const running = [...processes.values()].filter((item) => item.status === "running").length;
        if (running >= MAX_PROCS) throw new Error(`Too many running processes (max ${MAX_PROCS}).`);
        const selected = await resolveWorkspacePath(cwd, {
          workspaceId: workspace_id,
          taskToken: task_token,
          requireTask: Boolean(taskRouter)
        });
        const workdir = selected.path;
        const beforeMutation = await workspaceMutationFingerprint(
          workdir,
          selected.workspace.canonicalRoot
        );
        const proc = startBackground(
          command,
          workdir,
          shell,
          name,
          selected.workspace.canonicalRoot
        );
        proc.workspaceId = selected.workspace.id;
        proc.cwd = toWorkspaceRel(selected.workspace, workdir);
        proc.taskId = selected.task?.id || null;
        proc.sessionId = sessionId;
        proc.unmanagedChanges = false;
        proc.finalizing = true;
        proc.finalizationPromise = new Promise((resolve) => { proc.resolveFinalization = resolve; });
        proc.child.once("close", async () => {
          try {
            const afterMutation = await workspaceMutationFingerprint(
              workdir,
              selected.workspace.canonicalRoot
            ).catch(() => null);
            if (!afterMutation || mutationFingerprintChanged(beforeMutation, afterMutation)) {
              proc.unmanagedChanges = true;
              await markUnmanagedChange({
                workspaceId: selected.workspace.id,
                taskId: selected.task?.id || null,
                source: "process",
                before: beforeMutation,
                after: afterMutation,
                details: { process_id: proc.id }
              }).catch(() => {});
            }
          } finally {
            proc.finalizing = false;
            proc.resolveFinalization?.();
            proc.resolveFinalization = null;
          }
        });
        return jsonResult({
          ok: true,
          id: proc.id,
          workspace_id: selected.workspace.id,
          name: proc.name,
          command,
          cwd: qualifiedPath(selected.workspace, workdir),
          pid: proc.child.pid
        });
      }
      if (!id) throw new Error(`id is required for action=${action}`);
      const proc = processes.get(id);
      if (!proc) throw new Error(`No process with id ${id}`);
      if (
        (routedTask && proc.taskId !== routedTask.id) ||
        (!routedTask && (!proc.sessionId || proc.sessionId !== sessionId))
      ) {
        throw new TaskRouterError(
          "PROCESS_NOT_OWNED",
          `Process ${id} does not belong to the active task/session.`
        );
      }
      if (action === "stop") {
        killProcessTree(proc);
        if (proc.finalizationPromise) {
          await Promise.race([
            proc.finalizationPromise,
            new Promise((resolve) => setTimeout(resolve, 5_000))
          ]);
        }
        return jsonResult({ ok: true, id, status: proc.status });
      }
      const tail = (value) => tail_chars && value.length > tail_chars ? value.slice(-tail_chars) : value;
      return jsonResult({
        id,
        workspace_id: proc.workspaceId || primaryWorkspaceId,
        status: proc.status,
        exit_code: proc.exitCode,
        stdout: tail(proc.stdout),
        stderr: tail(proc.stderr),
        unmanaged_changes: proc.unmanagedChanges === true
      });
    }
  );

  reg(
    mcp,
    "change_history",
    {
      title: "Change history",
      description: "List, inspect, diff, undo or reapply tracked filesystem changes.",
      inputSchema: {
        action: z.enum(["list", "get", "diff", "content", "undo", "reapply", "undo_all", "clear"]).optional(),
        id: z.string().optional(),
        path: z.string().optional(),
        side: z.enum(["before", "after"]).optional(),
        paths: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        cursor: z.string().max(2048).optional(),
        workspace_id: z.string().optional(),
        task_token: z.string().optional()
      }
    },
    async ({ action = "list", id, path: selectedPath, side, paths, limit = 50, cursor, workspace_id, task_token }) => {
      const routedTask = await currentTask({
        taskToken: task_token,
        required: Boolean(taskRouter)
      });
      if (action === "list" && !workspace_id && routedTask?.workspace_ids.length > 1) {
        if (cursor) {
          throw new TaskRouterError(
            "WORKSPACE_CONTEXT_REQUIRED",
            "Paginating multi-workspace history requires workspace_id from the page being continued."
          );
        }
        const histories = await Promise.all(routedTask.workspace_ids.map(async (workspaceId) => {
          const journal = await getChangeJournal(workspaceId);
          const scope = pageScope("change_history", {
            workspace_id: workspaceId,
            task_id: routedTask.id
          });
          const history = await journal.listChanges({ limit, offset: 0, taskId: routedTask.id });
          return {
            workspace_id: workspaceId,
            ...history,
            pagination: historyPagination(history, { scope })
          };
        }));
        return jsonResult({ task_id: routedTask.id, workspaces: histories });
      }
      if (
        routedTask?.workspace_ids.length > 1 &&
        ["undo", "reapply", "undo_all", "clear"].includes(action)
      ) {
        throw new TaskRouterError(
          "CROSS_WORKSPACE_HISTORY_ATOMICITY_REQUIRED",
          `${action} is blocked for multi-workspace tasks until the whole transaction can be recovered atomically.`,
          {
            task_id: routedTask.id,
            workspace_ids: routedTask.workspace_ids,
            guidance: "Open a single-workspace task for local history mutation, or apply a new compensating patch across all attached workspaces."
          }
        );
      }
      const selected = await selectWorkspace({ workspaceId: workspace_id, taskToken: task_token });
      const journal = await getChangeJournal(selected.workspace.id);
      if (action === "list") {
        const scope = pageScope("change_history", {
          workspace_id: selected.workspace.id,
          task_id: routedTask?.id || null
        });
        const offset = decodePageCursor(cursor, { kind: "change_history", scope });
        const history = await journal.listChanges({
          limit,
          offset,
          taskId: routedTask?.id || null
        });
        return jsonResult({
          workspace_id: selected.workspace.id,
          ...history,
          pagination: historyPagination(history, { scope })
        });
      }
      if (action === "undo_all") {
        return jsonResult({
          workspace_id: selected.workspace.id,
          result: await journal.undoAll({ taskId: routedTask?.id || null })
        });
      }
      if (action === "clear") {
        return jsonResult({
          workspace_id: selected.workspace.id,
          result: await journal.clear({ taskId: routedTask?.id || null })
        });
      }
      if (!id) throw new Error(`id is required for action=${action}`);
      if (action === "get") {
        return jsonResult({
          workspace_id: selected.workspace.id,
          change: await journal.getChange(id, { taskId: routedTask?.id || null })
        });
      }
      if (action === "diff") {
        return jsonResult({
          workspace_id: selected.workspace.id,
          ...(await journal.getDiff(id, {
            path: selectedPath,
            taskId: routedTask?.id || null
          }))
        });
      }
      if (action === "content") {
        return jsonResult({
          workspace_id: selected.workspace.id,
          ...(await journal.getContent(id, {
            path: selectedPath,
            side,
            taskId: routedTask?.id || null
          }))
        });
      }
      if (action === "undo") {
        return jsonResult({
          workspace_id: selected.workspace.id,
          change: await journal.undo(id, {
            paths,
            taskId: routedTask?.id || null
          })
        });
      }
      return jsonResult({
        workspace_id: selected.workspace.id,
        change: await journal.reapply(id, {
          paths,
          taskId: routedTask?.id || null
        })
      });
    }
  );

}
