// Local Coding Agent MCP verification tools
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { TaskRouterError } from "../../workspace/task-router.mjs";

const ALL_GATES = ["lint", "typecheck", "test", "build"];
const VERIFY_STRATEGIES = ["required", "impacted", "full"];

export function registerVerificationTools(mcp, dependencies) {
  const {
    assertCommandAllowed,
    currentTask,
    dedupe,
    freezeTaskForMutation,
    getTestCommandsMerged,
    impactedTestStrategy,
    jsonResult,
    markUnmanagedChange,
    mutationFingerprintChanged,
    persistTaskVerificationEvidence,
    reg,
    resolveWorkspacePath,
    runGatedCommand,
    selectWorkspace,
    taskWorkspaceBaseline,
    transactionInDoubt,
    unmanagedChangeState,
    verifyWorkspaceChanges,
    workspaceMutationFingerprint
  } = dependencies;

  reg(
    mcp,
    "verify_changes",
    {
      title: "Verify changes",
      description: "Canonical verification tool. Use strategy=required for every required gate, impacted for package-aware affected tests only, or full to request lint/typecheck/test/build explicitly. It persists completion-guard evidence and returns PASS, FAIL, DRY_RUN, or INCOMPLETE; raw run_command output is not a substitute.",
      inputSchema: {
        strategy: z.enum(VERIFY_STRATEGIES).optional().describe("required (default), impacted tests only, or full lint/typecheck/test/build."),
        cwd: z.string().optional(),
        workspace_id: z.string().optional(),
        task_token: z.string().optional(),
        include: z.array(z.enum(ALL_GATES)).optional().describe("Optional gate filter for strategy=required/full. strategy=impacted always selects tests."),
        timeout_ms: z.number().int().min(1000).max(600000).optional(),
        stop_on_failure: z.boolean().optional(),
        dry_run: z.boolean().optional(),
        adopt_unmanaged: z.boolean().optional().describe("After reviewing the reported diff, explicitly adopt shell-made tracked changes into this task.")
      }
    },
    async (input) => {
      const strategy = input.strategy || "required";
      if (strategy === "impacted") return jsonResult(await runImpactedVerification(input));

      const routedTask = await currentTask({ taskToken: input.task_token, required: false });
      const workspaceIds = input.workspace_id
        ? [input.workspace_id]
        : routedTask?.workspace_ids?.length
          ? routedTask.workspace_ids
          : [(await selectWorkspace({ taskToken: input.task_token })).workspace.id];
      const include = strategy === "full" && !input.include?.length ? ALL_GATES : input.include;
      const results = [];
      for (const workspaceId of workspaceIds) {
        results.push(await verifyWorkspaceChanges({ ...input, include, workspace_id: workspaceId }));
      }
      if (results.length === 1) return jsonResult({ ...results[0], requested_strategy: strategy });
      const status = results.some((result) => result.status === "FAIL")
        ? "FAIL"
        : input.dry_run && results.every((result) => ["PASS", "DRY_RUN"].includes(result.status))
          ? "DRY_RUN"
          : results.every((result) => result.status === "PASS")
            ? "PASS"
            : "INCOMPLETE";
      return jsonResult({
        ok: status === "PASS",
        status,
        requested_strategy: strategy,
        task_id: routedTask?.id || null,
        workspaces: results,
        summary: {
          total: results.length,
          pass: results.filter((result) => result.status === "PASS").length,
          fail: results.filter((result) => result.status === "FAIL").length,
          incomplete: results.filter((result) => result.status === "INCOMPLETE").length
        }
      });
    }
  );

  async function runImpactedVerification({
    cwd = ".",
    workspace_id,
    task_token,
    timeout_ms = 120_000,
    stop_on_failure = true,
    dry_run = false
  }) {
    const routedTask = await currentTask({ taskToken: task_token, required: false });
    if (!workspace_id && routedTask?.workspace_ids?.length > 1) {
      if (cwd !== ".") {
        throw new TaskRouterError(
          "WORKSPACE_CONTEXT_REQUIRED",
          "cwd is ambiguous for a multi-workspace task; pass workspace_id or use cwd='.'."
        );
      }
      const workspaces = [];
      for (const workspaceId of routedTask.workspace_ids) {
        workspaces.push(await verifyWorkspaceChanges({
          cwd: ".",
          workspace_id: workspaceId,
          task_token,
          include: ["test"],
          timeout_ms,
          stop_on_failure,
          dry_run
        }));
      }
      const status = workspaces.some((result) => result.status === "FAIL")
        ? "FAIL"
        : workspaces.every((result) => result.status === "PASS" || result.status === "DRY_RUN")
          ? (dry_run ? "DRY_RUN" : "PASS")
          : "INCOMPLETE";
      return {
        ok: status === "PASS",
        status,
        requested_strategy: "impacted",
        strategy: "multi_workspace_impacted_tests",
        task_id: routedTask.id,
        workspaces
      };
    }

    const selected = await resolveWorkspacePath(cwd, { workspaceId: workspace_id, taskToken: task_token });
    const rootDir = selected.path;
    const unmanagedBefore = await unmanagedChangeState(selected.workspace.id, selected.task?.id || null);
    const initialPlan = await selected.runtime.verification.plan({
      include: ["test"],
      unmanaged_changes: unmanagedBefore.detected === true && unmanagedBefore.adopted !== true,
      unmanaged_state_unknown: unmanagedBefore.unknown === true,
      transaction_in_doubt: transactionInDoubt(selected.workspace.id),
      refresh: true,
      base_head: selected.task
        ? taskWorkspaceBaseline(selected.task, selected.workspace.id).base_head
        : null,
      require_baseline: Boolean(selected.task)
    });
    const plannedGates = [...initialPlan.gates];
    if (initialPlan.changes.dirty_unknown && plannedGates.length === 0) {
      const fallback = await getTestCommandsMerged(rootDir);
      if (fallback.test) {
        plannedGates.push({
          id: `${selected.workspace.id}:unknown-change-set:test`,
          workspace_id: selected.workspace.id,
          kind: "test",
          cwd: { workspace_id: selected.workspace.id, path: "." },
          command: fallback.test,
          command_scope: "full_workspace_unknown_changes",
          required: true,
          status: "pending",
          reason: "Git change scope is unavailable; run the full workspace test command."
        });
      }
    }
    const executableGates = plannedGates.filter((gate) => gate.command && gate.status !== "missing");
    const changedFiles = initialPlan.changes.files.map((entry) => entry.location).filter(Boolean);
    const testFiles = dedupe(plannedGates.flatMap((gate) =>
      (gate.impact?.required_tests || []).map((location) => location.path)
    )).map((file) => ({ workspace_id: selected.workspace.id, path: file }));

    if (dry_run) {
      return {
        workspace_id: selected.workspace.id,
        ok: false,
        status: "DRY_RUN",
        requested_strategy: "impacted",
        strategy: impactedTestStrategy(plannedGates),
        changed_files: changedFiles,
        test_files: testFiles,
        plan: { ...initialPlan, gates: plannedGates }
      };
    }

    if (executableGates.length === 0) {
      let evidence = null;
      let evidenceStatus = initialPlan.status;
      let evidenceReasons = [...(initialPlan.reasons || [])];
      try {
        evidence = await persistTaskVerificationEvidence({
          selected,
          source: "verify_changes",
          status: evidenceStatus,
          verification: { ...initialPlan, gates: plannedGates }
        });
        if (evidenceStatus === "PASS" && evidence?.status !== "PASS") {
          evidenceStatus = "INCOMPLETE";
          evidenceReasons = dedupe([...evidenceReasons, "VERIFICATION_STATE_UNKNOWN"]);
        }
      } catch {
        if (evidenceStatus === "PASS") evidenceStatus = "INCOMPLETE";
        evidenceReasons = dedupe([...evidenceReasons, "VERIFICATION_EVIDENCE_PERSIST_FAILED"]);
      }
      return {
        workspace_id: selected.workspace.id,
        ok: evidenceStatus === "PASS",
        status: evidenceStatus,
        requested_strategy: "impacted",
        strategy: changedFiles.length ? "incomplete_no_test_gate" : "no_changes",
        changed_files: changedFiles,
        test_files: testFiles,
        verification: { ...initialPlan, status: evidenceStatus, reasons: evidenceReasons },
        verification_evidence: {
          persisted: Boolean(evidence),
          state_known: evidence?.state?.state_known === true
        },
        unmanaged_changes: initialPlan.unmanaged_changes
      };
    }

    await freezeTaskForMutation(task_token);
    const beforeMutation = await workspaceMutationFingerprint(selected.workspace.canonicalRoot);
    const results = {};
    const executed = [];
    for (const gate of executableGates) {
      assertCommandAllowed(gate.command);
      const gateDirectory = await resolveWorkspacePath(gate.cwd?.path || ".", {
        workspaceId: selected.workspace.id,
        taskToken: task_token
      });
      const startedAt = Date.now();
      const result = await runGatedCommand(
        gate.command,
        gateDirectory.path,
        timeout_ms,
        selected.workspace.canonicalRoot
      );
      const normalized = {
        id: gate.id,
        kind: "test",
        cwd: gate.cwd,
        status: result.ok ? "pass" : "fail",
        command: gate.command,
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        duration_ms: Date.now() - startedAt,
        summary: result.summary,
        failures: result.failures
      };
      results[gate.id] = normalized;
      executed.push(normalized);
      if (!result.ok && stop_on_failure) break;
    }
    const afterMutation = await workspaceMutationFingerprint(selected.workspace.canonicalRoot);
    const unmanagedChanges = mutationFingerprintChanged(beforeMutation, afterMutation);
    if (unmanagedChanges) {
      await markUnmanagedChange({
        workspaceId: selected.workspace.id,
        taskId: selected.task?.id || null,
        source: "verify_changes",
        before: beforeMutation,
        after: afterMutation
      });
    }
    const finalUnmanaged = await unmanagedChangeState(selected.workspace.id, selected.task?.id || null);
    const evaluated = selected.runtime.verification.evaluate(
      { ...initialPlan, gates: plannedGates },
      results,
      {
        unmanaged_changes: finalUnmanaged.detected === true && finalUnmanaged.adopted !== true,
        unmanaged_state_unknown: finalUnmanaged.unknown === true,
        transaction_in_doubt: transactionInDoubt(selected.workspace.id)
      }
    );
    let evidence = null;
    let finalStatus = evaluated.status;
    let finalReasons = [...(evaluated.reasons || [])];
    const finalVerification = { ...evaluated, executed };
    try {
      evidence = await persistTaskVerificationEvidence({
        selected,
        source: "verify_changes",
        status: finalStatus,
        verification: finalVerification
      });
      if (finalStatus === "PASS" && evidence?.status !== "PASS") {
        finalStatus = "INCOMPLETE";
        finalReasons = dedupe([...finalReasons, "VERIFICATION_STATE_UNKNOWN"]);
      }
    } catch {
      if (finalStatus === "PASS") finalStatus = "INCOMPLETE";
      finalReasons = dedupe([...finalReasons, "VERIFICATION_EVIDENCE_PERSIST_FAILED"]);
    }
    finalVerification.status = finalStatus;
    finalVerification.reasons = finalReasons;
    return {
      workspace_id: selected.workspace.id,
      ok: finalStatus === "PASS",
      status: finalStatus,
      requested_strategy: "impacted",
      strategy: impactedTestStrategy(plannedGates),
      test_files: testFiles,
      changed_files: changedFiles,
      executed,
      verification: finalVerification,
      verification_evidence: {
        persisted: Boolean(evidence),
        state_known: evidence?.state?.state_known === true
      },
      unmanaged_changes: finalUnmanaged.detected === true && finalUnmanaged.adopted !== true,
      unmanaged_state_unknown: finalUnmanaged.unknown === true
    };
  }
}
