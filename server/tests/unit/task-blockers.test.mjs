// Local Coding Agent task blocker tests
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceTaskExecutionControl,
  commandPurpose,
  createTaskExecutionControl,
  inspectTaskExecutionControl,
  operationalPayloadSuccess,
  resumeTaskExecutionControl
} from "../../src/workspace/task-blockers.mjs";

const task = {
  primary_workspace_id: "ws_aaaaaaaaaaaaaaaa",
  orchestration: null
};

function orchestration(control = createTaskExecutionControl(), overrides = {}) {
  return {
    mutation_epoch: 0,
    phase: "decision_ready",
    ...control,
    ...overrides
  };
}

function intent(purpose, target, expectedEvidence = "Collect the requested evidence.") {
  return {
    purpose,
    target,
    expected_evidence: expectedEvidence,
    idempotent: true
  };
}

test("equivalent file existence commands share one semantic purpose", () => {
  const state = orchestration();
  const commands = [
    "test -f /mnt/data/export.zip",
    "ls -l /mnt/data/export.zip",
    "stat /mnt/data/export.zip",
    "find /mnt/data -name export.zip"
  ];
  const purposes = commands.map((command) => commandPurpose(
    "run_command",
    { command, workspace_id: task.primary_workspace_id },
    task,
    state
  ));
  assert.ok(purposes.every(Boolean));
  assert.deepEqual(new Set(purposes.map((item) => item.purpose)), new Set(["check_file_exists"]));
  assert.deepEqual(new Set(purposes.map((item) => item.target)), new Set(["/mnt/data/export.zip"]));
  assert.equal(new Set(purposes.map((item) => item.fingerprint)).size, 1);
});

test("distinct forensic purposes remain independent even after many calls", () => {
  const state = orchestration();
  const purposes = [
    "read_task_record",
    "read_audit_timeline",
    "inspect_change_journal",
    "decode_after_snapshot",
    "inspect_current_git_state"
  ].map((purpose) => commandPurpose(
    "run_command",
    {
      command: "node forensic-script.mjs",
      workspace_id: task.primary_workspace_id,
      intent: intent(purpose, "task_123")
    },
    task,
    state
  ));
  assert.equal(new Set(purposes.map((item) => item.fingerprint)).size, purposes.length);
});

test("structured command failures are operational failures", () => {
  assert.equal(operationalPayloadSuccess({ ok: false, exit_code: 1 }), false);
  assert.equal(operationalPayloadSuccess({ ok: true, exit_code: 0 }), true);
  assert.equal(operationalPayloadSuccess({
    ok: true,
    results: [{ exit_code: 0 }, { exit_code: 1 }]
  }), false);
  assert.equal(operationalPayloadSuccess({
    ok: true,
    results: [{ exit_code: 0 }, { exit_code: 0 }]
  }), true);
});

test("missing ChatGPT attachment becomes waiting_for_user and hard-stops later tools", () => {
  const state = orchestration();
  const args = {
    command: "test -f /mnt/data/export.zip",
    workspace_id: task.primary_workspace_id,
    intent: intent(
      "check_file_exists",
      "/mnt/data/export.zip",
      "Determine whether the uploaded asset ZIP exists on the Macmini host."
    )
  };
  const inspection = inspectTaskExecutionControl({ task, orchestration: state, tool: "run_command", args });
  const advanced = advanceTaskExecutionControl({
    orchestration: state,
    inspection,
    tool: "run_command",
    args,
    success: false,
    resultPayload: { ok: false, exit_code: 1, timed_out: false, stdout: "", stderr: "" },
    invocationId: "invocation-missing",
    finishedAt: "2026-07-24T00:00:00.000Z"
  });
  assert.equal(advanced.state.run_state, "waiting_for_user");
  assert.equal(advanced.state.blocker.code, "missing_file");
  assert.match(advanced.state.blocker.summary, /Chat attachments are not automatically mounted/);
  assert.match(advanced.state.blocker.required_action, /Copy the attachment/);

  const blockedTask = { ...task, orchestration: orchestration(advanced.state) };
  const blocked = inspectTaskExecutionControl({
    task: blockedTask,
    orchestration: blockedTask.orchestration,
    tool: "run_command",
    args: {
      command: "node -e \"console.log('must not execute')\"",
      intent: intent("inspect_other_state", "other")
    }
  });
  assert.equal(blocked.halt, true);
  assert.equal(blocked.skip, true);
  assert.equal(blocked.response.code, "TASK_WAITING_FOR_USER");
  assert.equal(blocked.response.user_update_required, true);
});

test("same-purpose unchanged result blocks but a new evidence gap can proceed", () => {
  const initial = orchestration();
  const args = {
    command: "node inspect.mjs",
    intent: intent("inspect_task_record", "task_123")
  };
  const firstInspection = inspectTaskExecutionControl({ task, orchestration: initial, tool: "run_command", args });
  const first = advanceTaskExecutionControl({
    orchestration: initial,
    inspection: firstInspection,
    tool: "run_command",
    args,
    success: true,
    resultPayload: { ok: true, stdout: "same task record", stderr: "" },
    invocationId: "invocation-first",
    finishedAt: "2026-07-24T00:00:00.000Z"
  });
  assert.equal(first.state.run_state, "running");

  const secondState = orchestration(first.state);
  const secondInspection = inspectTaskExecutionControl({ task, orchestration: secondState, tool: "run_command", args });
  const second = advanceTaskExecutionControl({
    orchestration: secondState,
    inspection: secondInspection,
    tool: "run_command",
    args,
    success: true,
    resultPayload: { ok: true, stdout: "same task record", stderr: "" },
    invocationId: "invocation-second",
    finishedAt: "2026-07-24T00:00:01.000Z"
  });
  assert.equal(second.state.run_state, "blocked");
  assert.equal(second.state.blocker.code, "repeated_no_progress");

  const gapArgs = {
    ...args,
    intent: {
      ...args.intent,
      evidence_gap: "Need the owner session field that the first script did not emit."
    }
  };
  const gapInspection = inspectTaskExecutionControl({
    task,
    orchestration: secondState,
    tool: "run_command",
    args: gapArgs
  });
  assert.equal(gapInspection.halt, false);
});

test("idempotent timeout retries once and then blocks", () => {
  const args = {
    command: "node slow-read.mjs",
    intent: intent("read_remote_metadata", "metadata")
  };
  const initial = orchestration();
  const firstInspection = inspectTaskExecutionControl({ task, orchestration: initial, tool: "run_command", args });
  const first = advanceTaskExecutionControl({
    orchestration: initial,
    inspection: firstInspection,
    tool: "run_command",
    args,
    success: false,
    resultPayload: { ok: false, timed_out: true, exit_code: 124 },
    invocationId: "timeout-first",
    finishedAt: "2026-07-24T00:00:00.000Z"
  });
  assert.equal(first.state.run_state, "retrying");
  assert.equal(first.retry_started, true);

  const retryState = orchestration(first.state);
  const secondInspection = inspectTaskExecutionControl({ task, orchestration: retryState, tool: "run_command", args });
  const second = advanceTaskExecutionControl({
    orchestration: retryState,
    inspection: secondInspection,
    tool: "run_command",
    args,
    success: false,
    resultPayload: { ok: false, timed_out: true, exit_code: 124 },
    invocationId: "timeout-second",
    finishedAt: "2026-07-24T00:00:01.000Z"
  });
  assert.equal(second.state.run_state, "blocked");
  assert.equal(second.state.blocker.code, "command_timeout");
  assert.equal(second.retry_exhausted, true);
});

test("new user input clears the affected blocker state and purpose cache", () => {
  const blocked = {
    run_state: "waiting_for_user",
    blocker: {
      code: "missing_file",
      step: "Import asset",
      summary: "The file is missing.",
      evidence: [],
      required_action: "Provide a path.",
      retryable: true,
      purpose: "check_file_exists",
      target: "/mnt/data/export.zip",
      detected_at: "2026-07-24T00:00:00.000Z"
    },
    input_epoch: 3,
    purpose_progress: [{
      fingerprint: "aaaaaaaaaaaaaaaaaaaaaaaa",
      purpose: "check_file_exists",
      target: "/mnt/data/export.zip",
      state_version: "0:3:",
      attempts: 1,
      consecutive_no_progress: 0,
      transient_retry_count: 0,
      result_signature: "bbbbbbbbbbbbbbbbbbbbbbbb",
      blocker_code: "missing_file",
      last_invocation_id: "missing",
      observed_at: "2026-07-24T00:00:00.000Z"
    }]
  };
  const resumed = resumeTaskExecutionControl(blocked, {
    resolved_blocker_code: "missing_file",
    changed_targets: ["/mnt/data/export.zip"],
    new_input: { assetPath: "/Users/me/project/assets/export.zip" }
  });
  assert.equal(resumed.run_state, "running");
  assert.equal(resumed.blocker, null);
  assert.equal(resumed.input_epoch, 4);
  assert.deepEqual(resumed.purpose_progress, []);
});
