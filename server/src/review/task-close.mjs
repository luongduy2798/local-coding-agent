// Local Coding Agent durable task-close coordination.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function createTaskCloseService({
  atomicWriteJson,
  captureVerificationWorkspaceState,
  dedupe,
  getChangeJournal,
  getPrimaryWorkspaceId,
  getWorkspaceRuntime,
  isoNow,
  processes,
  readTaskVerificationEvidence,
  runtimeDataDir,
  taskArtifactPath,
  taskWorkspaceBaseline,
  transactionInDoubt,
  unmanagedChangeState,
  verificationGateSignature
}) {
  const faultedTasks = new Set();

  async function preflightTaskClose(task) {
    const workspaceResults = [];
    const runningProcesses = taskRunningProcesses(task.id);
    for (const workspaceId of task.workspace_ids) {
      const reasons = [];
      const transactionBlocked = transactionInDoubt(workspaceId);
      if (transactionBlocked) reasons.push("TRANSACTION_IN_DOUBT");

      let unmanaged = { detected: false, adopted: false, unknown: true };
      try {
        unmanaged = await unmanagedChangeState(workspaceId, task.id);
        if (unmanaged.unknown === true) reasons.push("UNMANAGED_STATE_UNKNOWN");
        else if (unmanaged.detected === true && unmanaged.adopted !== true) reasons.push("UNMANAGED_CHANGES");
      } catch {
        reasons.push("UNMANAGED_STATE_UNKNOWN");
      }

      let verification = null;
      try {
        const runtime = await getWorkspaceRuntime(workspaceId);
        const baseline = taskWorkspaceBaseline(task, workspaceId);
        const currentPlan = await runtime.verification.plan({
          unmanaged_changes: unmanaged.detected === true && unmanaged.adopted !== true,
          unmanaged_state_unknown: unmanaged.unknown === true,
          transaction_in_doubt: transactionBlocked,
          refresh: true,
          base_head: baseline.known === true ? baseline.base_head : null,
          require_baseline: true
        });
        const currentState = await captureVerificationWorkspaceState(runtime.workspace, currentPlan.changes);
        const evidence = await readTaskVerificationEvidence(task.id, workspaceId);
        if (!evidence.ok) {
          reasons.push(evidence.reason);
        } else {
          const artifact = evidence.artifact;
          const requestedGatesMatch = JSON.stringify(artifact.requested_gates) === JSON.stringify(currentPlan.requested_gates);
          const signatureMatches = JSON.stringify(artifact.gate_signature) === JSON.stringify(
            verificationGateSignature(currentPlan.gates)
          );
          const stateMatches = artifact.state?.state_known === true && currentState.state_known === true &&
            artifact.state.head === currentState.head && artifact.state.fingerprint === currentState.fingerprint;
          if (!requestedGatesMatch) reasons.push("VERIFICATION_SCOPE_INCOMPLETE");
          if (!signatureMatches || !stateMatches) reasons.push("VERIFICATION_EVIDENCE_STALE");
          if (artifact.status !== "PASS") reasons.push("VERIFICATION_NOT_PASS");

          const gateResults = Object.fromEntries(artifact.gates.map((gate) => [gate.id, {
            status: gate.status,
            exit_code: gate.exit_code,
            timed_out: gate.timed_out,
            duration_ms: gate.duration_ms
          }]));
          const evaluated = runtime.verification.evaluate(currentPlan, gateResults, {
            unmanaged_changes: unmanaged.detected === true && unmanaged.adopted !== true,
            unmanaged_state_unknown: unmanaged.unknown === true,
            transaction_in_doubt: transactionBlocked
          });
          if (evaluated.status !== "PASS") reasons.push("VERIFICATION_NOT_PASS", ...(evaluated.reasons || []));
          verification = {
            status: evaluated.status,
            recorded_at: artifact.recorded_at,
            state_matches: stateMatches,
            evidence_hash: createHash("sha256").update(JSON.stringify(artifact)).digest("hex"),
            gate_summary: evaluated.gate_summary,
            baseline_head: currentPlan.changes.baseline_head || null,
            current_head: currentPlan.changes.head || null,
            head_changed: currentPlan.changes.head_changed === true,
            change_summary: currentPlan.changes.summary,
            files: (currentPlan.changes.files || []).slice(0, 1_000).map((entry) => ({
              workspace_id: workspaceId,
              path: entry.location?.path || null,
              original_path: entry.original_location?.path || null,
              staged: entry.staged === true,
              unstaged: entry.unstaged === true,
              untracked: entry.untracked === true,
              committed: entry.committed === true,
              deleted: entry.deleted === true
            })),
            files_truncated: (currentPlan.changes.files || []).length > 1_000
          };
        }
      } catch {
        reasons.push("VERIFICATION_PREFLIGHT_FAILED");
      }

      workspaceResults.push({
        workspace_id: workspaceId,
        ok: reasons.length === 0,
        transaction_in_doubt: transactionBlocked,
        unmanaged_changes: unmanaged.detected === true && unmanaged.adopted !== true,
        unmanaged_state_known: unmanaged.unknown !== true,
        baseline: taskWorkspaceBaseline(task, workspaceId),
        verification,
        reasons: dedupe(reasons)
      });
    }

    const incompleteReasons = dedupe([
      ...(runningProcesses.length ? ["TASK_PROCESS_RUNNING"] : []),
      ...workspaceResults.flatMap((workspace) => workspace.reasons)
    ]);
    return {
      ok: incompleteReasons.length === 0,
      status: incompleteReasons.length ? "INCOMPLETE" : "PASS",
      task_id: task.id,
      workspaces: workspaceResults,
      running_processes: runningProcesses,
      incomplete_reasons: incompleteReasons
    };
  }

  function taskRunningProcesses(taskId) {
    return [...processes.values()]
      .filter((item) => item.taskId === taskId && (item.status === "running" || item.finalizing === true))
      .map((item) => ({
        id: item.id,
        workspace_id: item.workspaceId || getPrimaryWorkspaceId(),
        status: item.status
      }));
  }

  function taskCloseIntentPath(taskId) {
    return taskArtifactPath({ id: taskId }, "close-intent.json", null);
  }

  async function prepareTaskJournals(task) {
    const settled = await Promise.allSettled(task.workspace_ids.map(async (workspaceId) => {
      const journal = await getChangeJournal(workspaceId);
      const prepared = await journal.prepareTaskCompletion({ taskId: task.id });
      return { workspace_id: workspaceId, journal, prepared };
    }));
    const entries = [];
    const failedWorkspaceIds = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") entries.push(result.value);
      else failedWorkspaceIds.push(task.workspace_ids[index]);
    });
    return { ok: failedWorkspaceIds.length === 0, entries, failed_workspace_ids: failedWorkspaceIds };
  }

  async function rollbackCompletedTaskJournals(taskId, entries, completedWorkspaceIds) {
    const completed = new Set(completedWorkspaceIds);
    const failed = [];
    for (const entry of [...entries].reverse()) {
      if (!completed.has(entry.workspace_id)) continue;
      try {
        await entry.journal.reopenTask({ taskId });
      } catch {
        failed.push(entry.workspace_id);
      }
    }
    return { ok: failed.length === 0, failed_workspace_ids: failed.reverse() };
  }

  async function recoverTaskCloseIntent(task) {
    const intentPath = taskCloseIntentPath(task.id);
    let intent;
    try {
      intent = JSON.parse(await readFile(intentPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return { ok: true, recovered: false, intent: null };
      return { ok: false, recovered: false, reason: "TASK_CLOSE_INTENT_CORRUPT" };
    }
    if (intent?.version !== 1 || intent.task_id !== task.id || !Array.isArray(intent.workspace_ids) ||
      !Array.isArray(intent.completed_workspace_ids)) {
      return { ok: false, recovered: false, reason: "TASK_CLOSE_INTENT_CORRUPT" };
    }
    if (["complete", "rolled_back"].includes(intent.status)) return { ok: true, recovered: false, intent };
    const entries = [];
    try {
      for (const workspaceId of intent.workspace_ids) {
        entries.push({ workspace_id: workspaceId, journal: await getChangeJournal(workspaceId) });
      }
      if (task.status === "open") {
        const rolledBack = await rollbackCompletedTaskJournals(task.id, entries, intent.completed_workspace_ids);
        if (!rolledBack.ok) throw new Error("journal rollback failed");
        intent.status = "rolled_back";
        intent.recovered_at = isoNow();
        intent.recovery_action = "restore_all_before";
      } else {
        for (const entry of entries) {
          if (intent.completed_workspace_ids.includes(entry.workspace_id)) continue;
          await entry.journal.completeTask({ taskId: task.id });
          intent.completed_workspace_ids.push(entry.workspace_id);
        }
        intent.status = "complete";
        intent.recovered_at = isoNow();
        intent.recovery_action = "finish_all_after";
      }
      await atomicWriteJson(intentPath, intent);
      return { ok: true, recovered: true, intent };
    } catch {
      intent.status = "in_doubt";
      intent.recovery_failed_at = isoNow();
      await atomicWriteJson(intentPath, intent).catch(() => {});
      return { ok: false, recovered: false, reason: "TASK_CLOSE_RECOVERY_REQUIRED", intent };
    }
  }

  async function applyTaskCloseTestDelay(task) {
    if (!process.env.LCA_TEST_RUN_ID) return;
    const expectedTitle = String(process.env.LCA_TEST_TASK_CLOSE_DELAY_TITLE || "");
    if (!expectedTitle || task.title !== expectedTitle) return;
    const delayMs = Math.max(0, Math.min(5_000, Number(process.env.LCA_TEST_TASK_CLOSE_DELAY_MS) || 0));
    if (delayMs === 0) return;
    const readyPath = String(process.env.LCA_TEST_TASK_CLOSE_DELAY_READY_PATH || "");
    if (readyPath) await writeFile(readyPath, `${task.id}\n`, "utf8");
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  async function injectTaskCloseJournalCorruptionForTest(taskId, workspaceId, workspaceIndex) {
    if (!process.env.LCA_TEST_RUN_ID || faultedTasks.has(taskId)) return;
    const requestedIndex = Number(process.env.LCA_TEST_TASK_CLOSE_CORRUPT_WORKSPACE_TASK);
    if (!Number.isInteger(requestedIndex) || requestedIndex < 0 || requestedIndex !== workspaceIndex) return;
    faultedTasks.add(taskId);
    const taskPath = path.join(runtimeDataDir, "workspaces", workspaceId, "changes", "tasks", `${taskId}.json`);
    await writeFile(taskPath, "{ injected task-close durable-record corruption", "utf8");
  }

  return {
    applyTaskCloseTestDelay,
    injectTaskCloseJournalCorruptionForTest,
    preflightTaskClose,
    prepareTaskJournals,
    recoverTaskCloseIntent,
    rollbackCompletedTaskJournals,
    taskCloseIntentPath,
    taskRunningProcesses
  };
}
