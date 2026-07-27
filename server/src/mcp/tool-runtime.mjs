// Local Coding Agent MCP tool execution wrapper
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { TaskRouterError } from "../workspace/task-router.mjs";
import { operationalPayloadSuccess } from "../workspace/task-blockers.mjs";
import { withDiscoveryGroups } from "./discovery-groups.mjs";
import {
  advanceTaskOrchestration,
  inspectTaskTool,
  publicTaskOrchestration
} from "../workspace/task-orchestration.mjs";

export function createToolRegistrar({
  audit,
  auditEnabled,
  currentTask,
  defaultResponseBytes,
  enforcePolicy,
  firstText,
  getStorageError,
  isoNow,
  maxResponseBytes,
  modelSafeError,
  recoverTaskCloseIntent,
  requestContext,
  resultBytes,
  resultLen,
  roundMs,
  runtimeId,
  storageRequiredTools,
  taskActivityTools,
  taskContextTools,
  taskRouter,
  testRuntimeDiagnostics,
  toolMetrics,
  truncateUtf8
}) {
  const taskOperations = new Map();
  const evidenceCache = new Map();
  const evidenceCacheLimit = 128;

  function enforceResultBudget(result, maxBytes) {
    const boundedMax = Math.max(1_024, Math.min(
      maxResponseBytes,
      Number(maxBytes) || defaultResponseBytes
    ));
    const resultMax = Math.max(512, boundedMax - 1_024);
    const originalBytes = resultBytes(result);
    if (originalBytes <= resultMax) return result;
    let source;
    try {
      source = firstText(result) || JSON.stringify(result);
    } catch {
      source = "";
    }
    let previewBytes = Math.max(0, resultMax - 1_024);
    let replacement;
    do {
      const payload = {
        response_truncated: true,
        code: "RESPONSE_BUDGET_EXCEEDED",
        original_bytes: originalBytes,
        original_chars: source.length,
        max_bytes: boundedMax,
        max_chars: boundedMax,
        preview: truncateUtf8(source, previewBytes),
        guidance: "Narrow the query or request the next page with a cursor."
      };
      replacement = structuredResult(payload, result?.isError === true);
      if (resultBytes(replacement) <= resultMax) break;
      previewBytes = Math.floor(previewBytes * 0.75);
    } while (previewBytes > 0);
    const requestMetrics = requestContext.getStore();
    if (requestMetrics) {
      requestMetrics.responseTruncated = true;
      requestMetrics.originalResponseBytes = originalBytes;
    }
    return replacement;
  }

  function acquireTaskOperation(taskId, { closing, toolName }) {
    const state = taskOperations.get(taskId) || { active: 0, closing: false };
    if (closing) {
      if (state.closing || state.active > 0) {
        throw new TaskRouterError(
          "TASK_BUSY",
          `Task ${taskId} has an active operation; retry task_close after it finishes.`,
          { task_id: taskId, active_operations: state.active }
        );
      }
      state.closing = true;
    } else {
      if (state.closing) {
        throw new TaskRouterError(
          "TASK_CLOSE_IN_PROGRESS",
          `Task ${taskId} is being closed and cannot start ${toolName}.`,
          { task_id: taskId, tool: toolName }
        );
      }
      state.active++;
    }
    taskOperations.set(taskId, state);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (closing) state.closing = false;
      else state.active = Math.max(0, state.active - 1);
      if (!state.closing && state.active === 0) taskOperations.delete(taskId);
    };
  }

  async function withTaskOperation(toolName, args, operation) {
    const closing = toolName === "task_close";
    if (!closing && !taskActivityTools.has(toolName)) return operation();
    const task = await currentTask({ taskToken: args?.task_token, required: false });
    if (!task) return operation();
    const recovery = await recoverTaskCloseIntent(task);
    if (!recovery.ok) {
      throw new TaskRouterError(
        recovery.reason || "TASK_CLOSE_RECOVERY_REQUIRED",
        `Task ${task.id} has an unresolved close transaction and cannot continue.`,
        { task_id: task.id }
      );
    }
    const release = acquireTaskOperation(task.id, { closing, toolName });
    try {
      return await operation();
    } finally {
      release();
    }
  }

  return function reg(mcp, name, definition, handler) {
    mcp.registerTool(name, withDiscoveryGroups(name, definition), async (args, extra) => {
      const startedAt = isoNow();
      const startedMs = performance.now();
      const invocationId = randomUUID();
      const taskBefore = await resolveCurrentTask(currentTask, taskRouter, name, args);
      if (name === "task_close" && taskBefore && taskBefore.status !== "open") {
        return structuredResult({
          ok: true,
          status: "already_closed",
          idempotent: true,
          task: taskBefore,
          review_changes_tasks: []
        });
      }
      let inspection = taskBefore ? inspectTaskTool({ task: taskBefore, tool: name, args: args ?? {} }) : null;
      const initialWorkspaceIds = collectWorkspaceIds(args, taskBefore);
      if (auditEnabled) {
        audit({
          ts: startedAt,
          kind: "tool",
          phase: "started",
          invocation_id: invocationId,
          runtime_id: runtimeId,
          request_id: requestContext.getStore()?.requestId || null,
          tool: name,
          tool_class: inspection?.tool_class || null,
          fingerprint: inspection?.fingerprint || null,
          purpose: inspection?.purpose?.purpose || null,
          purpose_fingerprint: inspection?.purpose?.fingerprint || null,
          duplicate: inspection?.duplicate === true,
          task_id: taskBefore?.id || null,
          effective_profile: taskBefore?.effective_profile || null,
          orchestration_phase_before: taskBefore?.orchestration?.phase || null,
          workspace_ids: initialWorkspaceIds,
          started_at: startedAt
        });
      }
      let result;
      let ok = true;
      let skipped = false;
      let cacheHit = false;
      let observation = null;
      if (taskBefore && name === "task_close") {
        observation = advanceTaskOrchestration({
          task: taskBefore,
          tool: name,
          args: args ?? {},
          success: true,
          resultPayload: null,
          invocationId,
          finishedAt: startedAt,
          inspection,
          skipped: false
        });
        await taskRouter?.updateOrchestration({
          taskId: taskBefore.id,
          orchestration: observation.state,
          effectiveProfile: observation.state.effective_profile,
          profileConfidence: observation.state.confidence
        }).catch(() => {});
      }
      try {
        const storageError = getStorageError();
        if (storageError && storageRequiredTools.has(name)) {
          throw new TaskRouterError(
            "RUNTIME_STORAGE_UNAVAILABLE",
            "Task-scoped operation is disabled because runtime storage failed integrity or capability checks.",
            storageError
          );
        }
        if (!testRuntimeDiagnostics && taskContextTools.has(name)) {
          await currentTask({ taskToken: args?.task_token, required: true });
        }
        const requestMetrics = requestContext.getStore();
        if (requestMetrics) {
          const requestedBudget = Math.max(
            Number(args?.max_output_chars || 0),
            Number(args?.max_total_output_chars || 0),
            Number(args?.max_total_chars || 0)
          );
          requestMetrics.responseBudget = requestedBudget > 0
            ? Math.min(maxResponseBytes, requestedBudget)
            : defaultResponseBytes;
        }
        const cacheKey = taskBefore && inspection
          ? `${taskBefore.id}:${inspection.fingerprint}`
          : null;
        const cached = cacheKey && inspection?.duplicate && !inspection.evidence_gap && isVersionedEvidenceTool(name)
          ? evidenceCache.get(cacheKey)
          : null;
        if (inspection?.skip) {
          skipped = true;
          result = structuredResult(inspection.response || {
            ok: true,
            skipped: true,
            code: inspection.notice?.code || "TASK_ORCHESTRATION_SKIP",
            message: inspection.notice?.message || "The repeated operation was skipped.",
            previous_invocation_id: inspection.previous?.invocation_id || null
          });
        } else if (cached) {
          await enforcePolicy(name, args ?? {});
          const validationArgs = cachedEvidenceValidationArgs(name, args ?? {}, cached, firstText);
          const validationResult = validationArgs
            ? await withTaskOperation(name, validationArgs, () => handler(validationArgs, extra))
            : null;
          if (validationResult && cachedEvidenceUnchanged(name, validationResult, firstText)) {
            skipped = true;
            if (inspection.notice?.code === "TASK_LOOP_DETECTED") {
              result = structuredResult({
                ok: true,
                skipped: true,
                code: inspection.notice.code,
                message: inspection.notice.message,
                previous_invocation_id: inspection.previous?.invocation_id || null
              });
            } else {
              cacheHit = true;
              result = appendPayloadMetadata(cloneToolResult(cached), {
                cached: true,
                duplicate: true,
                previous_invocation_id: inspection.previous?.invocation_id || null
              }, firstText);
            }
          } else if (validationResult) {
            inspection = { ...inspection, duplicate: false, previous: null, notice: null, skip: false, source_changed: true };
            result = mergeValidatedEvidence(name, cached, validationResult, firstText);
            if (!result?.isError) rememberEvidence(evidenceCache, cacheKey, result, evidenceCacheLimit);
          } else {
            result = await withTaskOperation(name, args ?? {}, () => handler(args ?? {}, extra));
            rememberEvidence(evidenceCache, cacheKey, result, evidenceCacheLimit);
          }
        } else {
          await enforcePolicy(name, args ?? {});
          result = await withTaskOperation(name, args ?? {}, () => handler(args ?? {}, extra));
          if (cacheKey && isVersionedEvidenceTool(name) && !result?.isError) {
            rememberEvidence(evidenceCache, cacheKey, result, evidenceCacheLimit);
          }
        }
      } catch (error) {
        ok = false;
        result = structuredResult(await modelSafeError(error), true);
      }

      const finishedAt = isoNow();
      let payload = parseStructuredPayload(result, firstText);
      const operationalSuccess = ok && !result?.isError && operationalPayloadSuccess(payload);
      if (taskBefore && name !== "task_close") {
        observation = advanceTaskOrchestration({
          task: taskBefore,
          tool: name,
          args: args ?? {},
          success: operationalSuccess,
          resultPayload: payload,
          invocationId,
          finishedAt,
          inspection,
          skipped
        });
        await taskRouter?.updateOrchestration({
          taskId: taskBefore.id,
          orchestration: observation.state,
          effectiveProfile: observation.state.effective_profile,
          profileConfidence: observation.state.confidence
        }).catch(() => {});
        result = appendOrchestration(result, observation.public, firstText);
        payload = parseStructuredPayload(result, firstText);
      } else if (taskBefore && name === "task_close" && observation) {
        result = appendOrchestration(result, observation.public, firstText);
        payload = parseStructuredPayload(result, firstText);
      } else if (name === "task_open" && payload?.task?.orchestration) {
        result = appendOrchestration(
          result,
          publicTaskOrchestration(payload.task.orchestration, payload.task.effective_profile),
          firstText
        );
        payload = parseStructuredPayload(result, firstText);
      }

      const requestMetrics = requestContext.getStore();
      const responseBudget = Math.min(
        maxResponseBytes,
        Number(requestMetrics?.responseBudget || defaultResponseBytes)
      );
      result = enforceResultBudget(result, responseBudget);
      const success = operationalSuccess && !result?.isError;
      const outChars = resultLen(result);
      const outBytes = resultBytes(result);
      const durationMs = roundMs(performance.now() - startedMs);
      const resultMetadata = toolResultMetadata(result, {
        args,
        firstText,
        taskBefore,
        transportSuccess: success
      });
      if (requestMetrics) {
        Object.assign(requestMetrics, {
          tool: name,
          handlerMs: durationMs,
          outChars,
          outBytes,
          success
        });
      }
      toolMetrics.calls++;
      toolMetrics.outputChars += outChars;
      toolMetrics.outputBytes += outBytes;
      if (!success) toolMetrics.errors++;
      if (outChars > toolMetrics.largestOutputChars) {
        toolMetrics.largestOutputChars = outChars;
        toolMetrics.largestOutputTool = name;
      }
      if (outBytes > toolMetrics.largestOutputBytes) {
        toolMetrics.largestOutputBytes = outBytes;
        toolMetrics.largestOutputTool = name;
      }
      const resultTask = objectValue(payload?.task) || objectValue(payload?.checkpoint?.task);
      const publicOrchestration = observation?.public || resultTask?.orchestration || payload?.orchestration || null;
      audit({
        ts: finishedAt,
        kind: "tool",
        phase: success ? "finished" : "failed",
        invocation_id: invocationId,
        runtime_id: runtimeId,
        request_id: requestMetrics?.requestId || null,
        tool: name,
        tool_class: observation?.tool_class || inspection?.tool_class || null,
        fingerprint: observation?.fingerprint || inspection?.fingerprint || null,
        purpose: observation?.purpose || inspection?.purpose?.purpose || null,
        purpose_fingerprint: observation?.purpose_fingerprint || inspection?.purpose?.fingerprint || null,
        orchestration_event: observation?.orchestration_event || null,
        run_state: observation?.run_state || publicOrchestration?.run_state || null,
        duplicate: observation?.duplicate === true || inspection?.duplicate === true,
        status_only: observation?.status_only === true,
        policy_skip: !cacheHit && (observation?.policy_skip === true || skipped),
        cache_hit: cacheHit,
        evidence_delta: observation?.evidence_delta === true,
        orchestration_notice_code: observation?.notice?.code || inspection?.notice?.code || null,
        orchestration_phase_before: observation?.phase_before || taskBefore?.orchestration?.phase || null,
        orchestration_phase_after: observation?.phase_after || publicOrchestration?.phase || null,
        effective_profile: observation?.state?.effective_profile || resultTask?.effective_profile || taskBefore?.effective_profile || null,
        evidence_status: publicOrchestration?.evidence_status || null,
        task_id: resultMetadata.taskId,
        workspace_ids: resultMetadata.workspaceIds,
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: durationMs,
        error_code: resultMetadata.errorCode,
        verification: resultMetadata.verification,
        change_count: resultMetadata.changeCount,
        file_count: resultMetadata.fileCount,
        out_chars: outChars,
        out_bytes: outBytes
      });
      return result;
    });
  };
}

async function resolveCurrentTask(currentTask, taskRouter, toolName, args) {
  try {
    const task = await currentTask({ taskToken: args?.task_token, required: false });
    if (task) return task;
  } catch {
    // A closed task token is no longer session-bound; task_close handles it idempotently below.
  }
  if (toolName === "task_close" && args?.task_token && taskRouter?.getTaskByToken) {
    return taskRouter.getTaskByToken(args.task_token).catch(() => null);
  }
  return null;
}

function isVersionedEvidenceTool(tool) {
  return tool === "read_file" || tool === "read_many";
}

function cachedEvidenceValidationArgs(tool, args, cachedResult, firstText) {
  const payload = parseStructuredPayload(cachedResult, firstText);
  if (tool === "read_file" && payload?.version) {
    return { ...args, known_version: payload.version, skip_if_unchanged: true };
  }
  if (tool !== "read_many" || !Array.isArray(payload?.files)) return null;
  const sourceRequests = Array.isArray(args.requests)
    ? args.requests
    : Array.isArray(args.paths)
      ? args.paths.map((path) => ({ path }))
      : [];
  if (!sourceRequests.length || sourceRequests.length !== payload.files.length) return null;
  const requests = sourceRequests.map((request, index) => ({
    ...request,
    known_version: payload.files[index]?.version,
    skip_if_unchanged: Boolean(payload.files[index]?.version)
  }));
  if (requests.some((request) => !request.known_version)) return null;
  const { paths: _paths, ...rest } = args;
  return { ...rest, requests };
}

function cachedEvidenceUnchanged(tool, result, firstText) {
  const payload = parseStructuredPayload(result, firstText);
  if (tool === "read_file") return payload?.unchanged === true;
  return tool === "read_many" && Array.isArray(payload?.files) && payload.files.length > 0 &&
    payload.files.every((file) => file?.unchanged === true);
}

function mergeValidatedEvidence(tool, cachedResult, validationResult, firstText) {
  if (tool !== "read_many") return validationResult;
  const cachedPayload = parseStructuredPayload(cachedResult, firstText);
  const validationPayload = parseStructuredPayload(validationResult, firstText);
  if (!Array.isArray(cachedPayload?.files) || !Array.isArray(validationPayload?.files)) return validationResult;
  const files = validationPayload.files.map((file, index) => file?.unchanged === true
    ? cachedPayload.files[index]
    : file);
  const charsReturned = files.reduce((total, file) => total + String(file?.content || "").length, 0);
  return replaceFirstText(validationResult, JSON.stringify({
    ...validationPayload,
    chars_returned: charsReturned,
    files
  }));
}

function appendPayloadMetadata(result, metadata, firstText) {
  const payload = parseStructuredPayload(result, firstText);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return result;
  return replaceFirstText(result, JSON.stringify({ ...payload, ...metadata }));
}

function cloneToolResult(result) {
  return {
    ...result,
    content: Array.isArray(result?.content)
      ? result.content.map((entry) => entry && typeof entry === "object" ? { ...entry } : entry)
      : result?.content
  };
}

function rememberEvidence(cache, key, result, limit) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, cloneToolResult(result));
  while (cache.size > limit) cache.delete(cache.keys().next().value);
}

function appendOrchestration(result, orchestration, firstText) {
  const payload = parseStructuredPayload(result, firstText);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return result;
  return replaceFirstText(result, JSON.stringify({
    ...payload,
    orchestration: {
      ...(payload.orchestration && typeof payload.orchestration === "object" ? payload.orchestration : {}),
      ...orchestration
    }
  }));
}

function parseStructuredPayload(result, firstText) {
  try {
    const payload = JSON.parse(firstText(result));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function replaceFirstText(result, text) {
  let replaced = false;
  return {
    ...result,
    content: Array.isArray(result?.content) ? result.content.map((entry) => {
      if (!replaced && entry?.type === "text") {
        replaced = true;
        return { ...entry, text };
      }
      return entry;
    }) : [{ type: "text", text }]
  };
}

function structuredResult(payload, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {})
  };
}

function toolResultMetadata(result, { args, firstText, taskBefore, transportSuccess }) {
  let payload = null;
  try {
    payload = JSON.parse(firstText(result));
  } catch {
    // Tool output is not structured JSON; only transport metadata is recorded.
  }
  const resultTask = objectValue(payload?.task) || objectValue(payload?.checkpoint?.task);
  const taskId = safeTaskId(resultTask?.id) || safeTaskId(payload?.task_id) || safeTaskId(taskBefore?.id);
  const workspaceIds = collectWorkspaceIds(args, taskBefore, resultTask, payload);
  const verification = verificationStatus(payload);
  const operationalOk = payload?.ok !== false;
  return {
    taskId,
    workspaceIds,
    operationalOk,
    verification,
    errorCode: transportSuccess && operationalOk
      ? null
      : safeErrorCode(payload),
    changeCount: safeCount(payload?.change_count ?? payload?.changes?.length ?? payload?.summary?.change_count),
    fileCount: safeCount(
      payload?.file_count ??
      payload?.files?.length ??
      payload?.summary?.file_count ??
      changeFileCount(payload?.changes)
    )
  };
}

function changeFileCount(changes) {
  if (!Array.isArray(changes) || !changes.length) return null;
  let total = 0;
  let observed = false;
  for (const change of changes) {
    const count = Array.isArray(change?.files)
      ? change.files.length
      : safeCount(change?.files ?? change?.file_count);
    if (count === null) continue;
    observed = true;
    total += count;
  }
  return observed ? total : null;
}

function collectWorkspaceIds(...sources) {
  const values = [];
  const visit = (value, key = "") => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (typeof value === "string") {
      if ((key === "workspace_id" || key === "workspace_ids") && /^ws_[A-Za-z0-9_-]{8,160}$/.test(value)) {
        values.push(value);
      }
      return;
    }
    if (typeof value !== "object") return;
    for (const field of ["workspace_id", "workspaceId"]) visit(value[field], "workspace_id");
    for (const field of ["workspace_ids", "workspaceIds"]) visit(value[field], "workspace_ids");
    if (Array.isArray(value.operations)) visit(value.operations);
    if (Array.isArray(value.workspaces)) visit(value.workspaces);
  };
  for (const source of sources) visit(source);
  return [...new Set(values)].sort();
}

function verificationStatus(payload) {
  const candidates = [
    payload?.verification,
    payload?.verification?.status,
    payload?.result?.status,
    payload?.report?.status,
    payload?.status
  ];
  for (const candidate of candidates) {
    const value = typeof candidate === "object" ? candidate?.status : candidate;
    const normalized = String(value || "").toUpperCase();
    if (["PASS", "INCOMPLETE", "FAIL"].includes(normalized)) return normalized;
  }
  return null;
}

function safeErrorCode(payload) {
  const candidates = [
    payload?.code,
    payload?.error_code,
    payload?.error,
    ...(Array.isArray(payload?.incomplete_reasons) ? payload.incomplete_reasons : [])
  ];
  for (const candidate of candidates) {
    const code = String(candidate || "").trim();
    if (/^[A-Z][A-Z0-9_]{1,80}$/.test(code)) return code;
  }
  return null;
}

function safeTaskId(value) {
  const id = String(value || "");
  return /^task_[A-Za-z0-9_-]{8,160}$/.test(id) ? id : null;
}

function safeCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
