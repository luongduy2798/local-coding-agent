// Local Coding Agent task blocker and semantic-purpose guards.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import path from "node:path";

const RUN_STATES = new Set(["running", "retrying", "blocked", "waiting_for_user"]);
const BLOCKER_CODES = new Set([
  "missing_input",
  "missing_file",
  "workspace_mismatch",
  "permission_denied",
  "tool_unavailable",
  "repeated_no_progress",
  "command_timeout",
  "unknown"
]);
const ALLOWED_WHILE_BLOCKED = new Set([
  "task_open",
  "task_state",
  "task_checkpoint",
  "task_close",
  "lca_status"
]);
const MAX_PURPOSE_PROGRESS = 64;
const MAX_TRANSIENT_RETRIES = 1;

export function createTaskExecutionControl() {
  return {
    run_state: "running",
    blocker: null,
    input_epoch: 0,
    purpose_progress: []
  };
}

export function normalizeTaskExecutionControl(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    run_state: RUN_STATES.has(source.run_state) ? source.run_state : "running",
    blocker: normalizeBlocker(source.blocker),
    input_epoch: nonNegativeInteger(source.input_epoch),
    purpose_progress: normalizePurposeProgress(source.purpose_progress)
  };
}

export function publicTaskExecutionControl(value) {
  const state = normalizeTaskExecutionControl(value);
  return {
    run_state: state.run_state,
    blocker: state.blocker
  };
}

export function operationalPayloadSuccess(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return true;
  if (payload.ok === false) return false;
  if (Array.isArray(payload.results)) {
    return payload.results.every((entry) => {
      if (!entry || typeof entry !== "object") return true;
      if (entry.ok === false || entry.timed_out === true) return false;
      return !Number.isInteger(entry.exit_code) || entry.exit_code === 0;
    });
  }
  return true;
}

export function commandPurpose(tool, args = {}, task = null, orchestration = null) {
  const name = String(tool || "");
  let source = args;
  if (name === "run_commands") {
    const commands = Array.isArray(args.commands) ? args.commands : [];
    if (commands.length !== 1) return null;
    source = { ...commands[0], workspace_id: commands[0]?.workspace_id || args.workspace_id };
  } else if (name !== "run_command") {
    return null;
  }

  const explicit = normalizeIntent(source.intent || source);
  const commandInferred = inferCommandIntent(source.command);
  const inferred = explicit
    ? {
        ...commandInferred,
        ...explicit,
        target: explicit.target || commandInferred?.target || null,
        expected_evidence: explicit.expected_evidence || commandInferred?.expected_evidence || null,
        idempotent: explicit.idempotent || commandInferred?.idempotent || false
      }
    : commandInferred;
  if (!inferred) return null;
  const control = normalizeTaskExecutionControl(orchestration);
  const workspaceId = normalizeText(source.workspace_id || task?.primary_workspace_id, 160);
  const stateVersion = [
    nonNegativeInteger(orchestration?.mutation_epoch),
    control.input_epoch,
    normalizeText(inferred.state_version, 160) || ""
  ].join(":");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      purpose: inferred.purpose,
      target: inferred.target,
      workspace_id: workspaceId,
      state_version: stateVersion
    }))
    .digest("hex")
    .slice(0, 24);
  return {
    ...inferred,
    workspace_id: workspaceId,
    state_version: stateVersion,
    fingerprint
  };
}

export function inspectTaskExecutionControl({ task, orchestration, tool, args = {} } = {}) {
  const state = normalizeTaskExecutionControl(orchestration);
  const purpose = commandPurpose(tool, args, task, orchestration);
  const previous = purpose
    ? state.purpose_progress.find((entry) => entry.fingerprint === purpose.fingerprint) || null
    : null;
  const sameState = Boolean(previous && previous.state_version === purpose?.state_version);
  const evidenceGap = purpose?.evidence_gap || normalizeText(args.evidence_gap, 1_000);

  if (["blocked", "waiting_for_user"].includes(state.run_state) && !ALLOWED_WHILE_BLOCKED.has(String(tool || ""))) {
    const blocker = state.blocker || repeatedNoProgressBlocker({ purpose, invocationId: null });
    return {
      halt: true,
      skip: true,
      semantic_duplicate: sameState,
      purpose,
      previous,
      evidence_gap: evidenceGap,
      notice: blockerNotice(state.run_state, blocker),
      response: {
        ok: true,
        blocked: true,
        halt: true,
        user_update_required: true,
        code: state.run_state === "waiting_for_user" ? "TASK_WAITING_FOR_USER" : "TASK_BLOCKED",
        run_state: state.run_state,
        blocker
      }
    };
  }

  return {
    halt: false,
    skip: false,
    semantic_duplicate: sameState,
    purpose,
    previous,
    evidence_gap: evidenceGap,
    notice: null,
    response: null
  };
}

export function advanceTaskExecutionControl({
  orchestration,
  inspection,
  tool,
  args = {},
  success,
  resultPayload,
  invocationId,
  finishedAt,
  skipped = false
} = {}) {
  const control = normalizeTaskExecutionControl(orchestration);
  const observed = inspection || inspectTaskExecutionControl({ orchestration, tool, args });
  if (observed.halt || skipped || !observed.purpose) {
    return {
      state: control,
      notice: observed.notice || null,
      event: observed.halt ? "tool.duplicate_rejected" : null,
      phase_override: observed.halt ? "blocked" : null,
      evidence_delta: null,
      semantic_duplicate: Boolean(observed.semantic_duplicate),
      blocker_detected: false,
      retry_started: false,
      retry_exhausted: false
    };
  }

  const purpose = observed.purpose;
  const previous = observed.previous && observed.previous.state_version === purpose.state_version
    ? observed.previous
    : null;
  const candidate = detectBlocker({
    task: null,
    tool,
    args,
    purpose,
    success,
    payload: resultPayload,
    invocationId,
    finishedAt
  });
  const signature = resultSignature(resultPayload, candidate, success);
  const sameResult = Boolean(previous && previous.result_signature === signature);
  const attempts = previous ? previous.attempts + 1 : 1;
  const noProgress = sameResult ? previous.consecutive_no_progress + 1 : 0;
  let transientRetries = previous?.transient_retry_count || 0;
  let runState = control.run_state;
  let blocker = control.blocker;
  let notice = null;
  let event = sameResult ? "tool.no_progress" : null;
  let blockerDetected = false;
  let retryStarted = false;
  let retryExhausted = false;

  if (success && sameResult && previous && !observed.evidence_gap) {
    runState = "blocked";
    blocker = repeatedNoProgressBlocker({ purpose, invocationId, finishedAt });
    blockerDetected = true;
    event = "tool.duplicate_rejected";
    notice = blockerNotice(runState, blocker);
    transientRetries = 0;
  } else if (success) {
    if (runState === "retrying") runState = "running";
    if (runState === "running") blocker = null;
    transientRetries = 0;
  } else if (candidate?.code === "command_timeout" && purpose.idempotent) {
    if (transientRetries < MAX_TRANSIENT_RETRIES) {
      transientRetries++;
      runState = "retrying";
      blocker = null;
      retryStarted = true;
      event = "tool.retry_started";
      notice = buildNotice(
        "TOOL_TRANSIENT_RETRY",
        "warning",
        "A transient tool failure may be retried once for this purpose.",
        "retry_once_or_report_blocker"
      );
    } else {
      runState = "blocked";
      blocker = candidate;
      blockerDetected = true;
      retryExhausted = true;
      event = "tool.retry_exhausted";
      notice = blockerNotice(runState, blocker);
    }
  } else if (candidate) {
    runState = candidate.code === "tool_unavailable" ? "blocked" : "waiting_for_user";
    blocker = candidate;
    blockerDetected = true;
    event = runState === "waiting_for_user" ? "task.waiting_for_user" : "task.blocker_detected";
    notice = blockerNotice(runState, blocker);
  } else if (sameResult && previous && !observed.evidence_gap) {
    runState = "blocked";
    blocker = repeatedNoProgressBlocker({ purpose, invocationId, finishedAt });
    blockerDetected = true;
    event = "tool.duplicate_rejected";
    notice = blockerNotice(runState, blocker);
  }

  const entry = {
    fingerprint: purpose.fingerprint,
    purpose: purpose.purpose,
    target: purpose.target,
    state_version: purpose.state_version,
    attempts,
    consecutive_no_progress: noProgress,
    transient_retry_count: transientRetries,
    result_signature: signature,
    blocker_code: candidate?.code || null,
    last_invocation_id: normalizeText(invocationId, 180),
    observed_at: normalizeTimestamp(finishedAt) || new Date().toISOString()
  };
  const progress = control.purpose_progress.filter((item) => item.fingerprint !== entry.fingerprint);
  progress.unshift(entry);
  progress.splice(MAX_PURPOSE_PROGRESS);

  return {
    state: {
      run_state: runState,
      blocker,
      input_epoch: control.input_epoch,
      purpose_progress: progress
    },
    notice,
    event,
    phase_override: ["blocked", "waiting_for_user"].includes(runState)
      ? "blocked"
      : success && orchestration?.phase === "blocked"
        ? "decision_ready"
        : null,
    evidence_delta: previous ? !sameResult : true,
    semantic_duplicate: Boolean(previous),
    blocker_detected: blockerDetected,
    retry_started: retryStarted,
    retry_exhausted: retryExhausted
  };
}

export function resumeTaskExecutionControl(value, resume = {}) {
  const control = normalizeTaskExecutionControl(value);
  if (!["blocked", "waiting_for_user", "retrying"].includes(control.run_state)) return control;
  const resolvedCode = normalizeText(resume.resolved_blocker_code, 80);
  if (resolvedCode && control.blocker?.code && resolvedCode !== control.blocker.code) {
    throw new TypeError(`Resolved blocker ${resolvedCode} does not match ${control.blocker.code}.`);
  }
  const changedTargets = [...new Set((Array.isArray(resume.changed_targets) ? resume.changed_targets : [])
    .map(normalizeTarget)
    .filter(Boolean))];
  const blockerTarget = normalizeTarget(control.blocker?.target);
  const affectedTargets = changedTargets.length ? changedTargets : blockerTarget ? [blockerTarget] : [];
  const purposeProgress = affectedTargets.length
    ? control.purpose_progress.filter((entry) => !affectedTargets.some((target) => targetsOverlap(entry.target, target)))
    : [];
  return {
    run_state: "running",
    blocker: null,
    input_epoch: control.input_epoch + 1,
    purpose_progress: purposeProgress
  };
}

function detectBlocker({ purpose, success, payload, invocationId, finishedAt }) {
  if (success) return null;
  const code = String(payload?.code || payload?.error_code || "").toUpperCase();
  const text = [payload?.message, payload?.stderr, payload?.stdout, payload?.error]
    .filter(Boolean)
    .join("\n");
  if (payload?.timed_out === true || code.includes("TIMEOUT")) {
    return makeBlocker({
      code: "command_timeout",
      purpose,
      summary: "The command timed out before producing the expected evidence.",
      evidence: [purpose?.expected_evidence, timeoutEvidence(payload)].filter(Boolean),
      requiredAction: "Confirm whether the operation is safe to retry or provide a different command or environment.",
      retryable: true,
      invocationId,
      finishedAt
    });
  }
  if (purpose?.purpose === "check_file_exists") {
    return missingFileBlocker({ purpose, payload, invocationId, finishedAt });
  }
  if (code.includes("WORKSPACE") && (code.includes("MISMATCH") || code.includes("UNAVAILABLE"))) {
    return makeBlocker({
      code: "workspace_mismatch",
      purpose,
      summary: "The requested operation targets a workspace that is not available to this task.",
      evidence: [code],
      requiredAction: "Open or resume the task in the correct workspace and provide the matching workspace or path.",
      retryable: false,
      invocationId,
      finishedAt
    });
  }
  if (/permission denied|eacces|eperm/i.test(`${code}\n${text}`)) {
    return makeBlocker({
      code: "permission_denied",
      purpose,
      summary: "The Local Coding Agent host does not have permission to access the required target.",
      evidence: compactEvidence(text, code),
      requiredAction: "Grant access on the host or provide an accessible path.",
      retryable: false,
      invocationId,
      finishedAt
    });
  }
  if (/command not found|module not found|enoent/i.test(`${code}\n${text}`) && /command|tool|module|executable/i.test(text)) {
    return makeBlocker({
      code: "tool_unavailable",
      purpose,
      summary: "A required executable or runtime dependency is unavailable on the Local Coding Agent host.",
      evidence: compactEvidence(text, code),
      requiredAction: "Install or enable the required tool, or provide an alternative that is already available.",
      retryable: false,
      invocationId,
      finishedAt
    });
  }
  return null;
}

function missingFileBlocker({ purpose, payload, invocationId, finishedAt }) {
  const target = purpose?.target || "the requested file";
  const chatAttachmentPath = String(target).replaceAll("\\", "/").startsWith("/mnt/data/");
  return makeBlocker({
    code: "missing_file",
    purpose,
    summary: chatAttachmentPath
      ? "The requested file is not available on the Local Coding Agent host. Chat attachments are not automatically mounted into the Mac workspace."
      : `The required file was not found on the Local Coding Agent host: ${target}`,
    evidence: [
      `${target} was checked on the Local Coding Agent host and was not found.`,
      Number.isInteger(payload?.exit_code) ? `The existence check exited with code ${payload.exit_code}.` : null
    ].filter(Boolean),
    requiredAction: chatAttachmentPath
      ? "Copy the attachment into the Mac workspace and provide its local Mac path."
      : "Copy the file into the workspace or provide an accessible local path.",
    retryable: true,
    invocationId,
    finishedAt
  });
}

function repeatedNoProgressBlocker({ purpose, invocationId, finishedAt }) {
  return makeBlocker({
    code: "repeated_no_progress",
    purpose,
    summary: "An equivalent investigation produced the same result without any relevant state change.",
    evidence: [
      purpose?.expected_evidence,
      purpose?.target ? `Target: ${purpose.target}` : null
    ].filter(Boolean),
    requiredAction: "Provide new input, identify a different evidence gap, or change the relevant workspace state before retrying.",
    retryable: true,
    invocationId,
    finishedAt
  });
}

function makeBlocker({ code, purpose, summary, evidence, requiredAction, retryable, invocationId, finishedAt }) {
  return normalizeBlocker({
    code,
    step: purpose?.expected_evidence || purpose?.purpose || "Task execution",
    summary,
    evidence,
    required_action: requiredAction,
    retryable,
    purpose: purpose?.purpose || null,
    target: purpose?.target || null,
    detected_at: normalizeTimestamp(finishedAt) || new Date().toISOString(),
    source_invocation_id: invocationId || null
  });
}

function blockerNotice(runState, blocker) {
  return buildNotice(
    runState === "waiting_for_user" ? "TASK_WAITING_FOR_USER" : "TASK_BLOCKED",
    "error",
    blocker?.summary || "The task is blocked.",
    runState === "waiting_for_user" ? "report_blocker_and_wait_for_user" : "report_blocker"
  );
}

function buildNotice(code, severity, message, recommendedTransition) {
  return {
    code,
    severity,
    message,
    recommended_transition: recommendedTransition
  };
}

function normalizeIntent(value) {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const purpose = canonicalPurpose(value.purpose || value.kind);
  if (!purpose) return null;
  const target = normalizeTarget(value.target);
  return {
    purpose,
    target,
    expected_evidence: normalizeText(value.expected_evidence || value.expectedEvidence, 1_000),
    evidence_gap: normalizeText(value.evidence_gap || value.evidenceGap, 1_000),
    state_version: normalizeText(value.state_version || value.stateVersion, 160),
    idempotent: value.idempotent === true
  };
}

function inferCommandIntent(commandValue) {
  const command = String(commandValue || "").trim();
  if (!command) return null;
  const findMatch = command.match(/^find\s+(["']?)([^\s"']+)\1[\s\S]*?-name\s+(["']?)([^\s"']+)\3(?:\s|$)/i);
  if (findMatch) {
    return {
      purpose: "check_file_exists",
      target: normalizeTarget(path.join(findMatch[2], findMatch[4])),
      expected_evidence: "Determine whether the requested file exists on the Local Coding Agent host.",
      evidence_gap: null,
      idempotent: true
    };
  }
  if (!/^\s*(?:test\s+-[efd]|\[\s*-[efd]|stat(?:\s|$)|ls(?:\s|$))/i.test(command)) return null;
  const target = extractExistenceTarget(command);
  if (!target) return null;
  return {
    purpose: "check_file_exists",
    target,
    expected_evidence: "Determine whether the requested file exists on the Local Coding Agent host.",
    evidence_gap: null,
    idempotent: true
  };
}

function extractExistenceTarget(command) {
  const absolute = [...command.matchAll(/(?:^|\s)(["']?)(\/[^ \s"';&|]+)\1(?=\s|$)/g)].at(-1)?.[2];
  if (absolute) return normalizeTarget(absolute);
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const ignored = new Set(["test", "[", "]", "stat", "ls", "-e", "-f", "-d", "-l", "-la", "-al"]);
  const target = [...tokens].reverse().find((token) => !ignored.has(token.toLowerCase()) && !token.startsWith("-"));
  const normalized = normalizeTarget(target);
  if (!normalized) return null;
  if (/^ls\b/i.test(command) && !normalized.includes("/") && !/\.[A-Za-z0-9]{1,12}$/.test(normalized)) return null;
  return normalized;
}

function canonicalPurpose(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  if (!normalized) return null;
  if (["check_existence", "file_exists", "check_file", "check_file_existence"].includes(normalized)) {
    return "check_file_exists";
  }
  return normalized;
}

function resultSignature(payload, blocker, success) {
  const compact = blocker
    ? { success, blocker: blocker.code, target: blocker.target }
    : compactPayload(payload, success);
  return createHash("sha256").update(JSON.stringify(compact)).digest("hex").slice(0, 24);
}

function compactPayload(payload, success) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { success };
  return {
    success,
    ok: payload.ok,
    code: payload.code || payload.error_code || null,
    exit_code: Number.isInteger(payload.exit_code) ? payload.exit_code : null,
    timed_out: payload.timed_out === true,
    status: payload.status || null,
    stdout: normalizeResultText(payload.stdout),
    stderr: normalizeResultText(payload.stderr),
    count: Number.isFinite(Number(payload.count)) ? Number(payload.count) : null
  };
}

function normalizeResultText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 500) : null;
}

function normalizeBlocker(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const code = BLOCKER_CODES.has(value.code) ? value.code : "unknown";
  const summary = normalizeText(value.summary, 1_000);
  if (!summary) return null;
  return {
    code,
    step: normalizeText(value.step, 500) || "Task execution",
    summary,
    evidence: Array.isArray(value.evidence)
      ? value.evidence.map((item) => normalizeText(item, 1_000)).filter(Boolean).slice(0, 12)
      : [],
    required_action: normalizeText(value.required_action || value.requiredAction, 1_000),
    retryable: value.retryable === true,
    purpose: normalizeText(value.purpose, 120),
    target: normalizeTarget(value.target),
    detected_at: normalizeTimestamp(value.detected_at || value.detectedAt) || new Date().toISOString(),
    source_invocation_id: normalizeText(value.source_invocation_id || value.sourceInvocationId, 180)
  };
}

function normalizePurposeProgress(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PURPOSE_PROGRESS).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const fingerprint = String(entry.fingerprint || "");
    if (!/^[a-f0-9]{24}$/.test(fingerprint)) return [];
    return [{
      fingerprint,
      purpose: normalizeText(entry.purpose, 120) || "unknown",
      target: normalizeTarget(entry.target),
      state_version: normalizeText(entry.state_version, 240) || "0:0:",
      attempts: Math.max(1, nonNegativeInteger(entry.attempts)),
      consecutive_no_progress: nonNegativeInteger(entry.consecutive_no_progress),
      transient_retry_count: nonNegativeInteger(entry.transient_retry_count),
      result_signature: /^[a-f0-9]{24}$/.test(String(entry.result_signature || ""))
        ? String(entry.result_signature)
        : createHash("sha256").update("unknown").digest("hex").slice(0, 24),
      blocker_code: BLOCKER_CODES.has(entry.blocker_code) ? entry.blocker_code : null,
      last_invocation_id: normalizeText(entry.last_invocation_id, 180),
      observed_at: normalizeTimestamp(entry.observed_at)
    }];
  });
}

function normalizeTarget(value) {
  const source = normalizeText(value, 2_000);
  if (!source) return null;
  const unquoted = source.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
  const normalized = path.normalize(unquoted).replaceAll("\\", "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function targetsOverlap(left, right) {
  const a = normalizeTarget(left);
  const b = normalizeTarget(right);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function compactEvidence(text, code) {
  return [normalizeResultText(text), normalizeText(code, 120)].filter(Boolean).slice(0, 4);
}

function timeoutEvidence(payload) {
  if (Number.isInteger(payload?.exit_code)) return `Exit code: ${payload.exit_code}.`;
  return payload?.timed_out === true ? "The command exceeded its configured timeout." : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function normalizeText(value, maxLength) {
  if (value === null || value === undefined || value === "") return null;
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLength) || null;
}

function normalizeTimestamp(value) {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
