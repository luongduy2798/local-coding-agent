// Local Coding Agent MCP tool execution wrapper
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { TaskRouterError } from "../workspace/task-router.mjs";

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
  testRuntimeDiagnostics,
  toolMetrics,
  truncateUtf8
}) {
  const taskOperations = new Map();

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
      replacement = {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        ...(result?.isError ? { isError: true } : {})
      };
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
    mcp.registerTool(name, definition, async (args, extra) => {
      const startedAt = isoNow();
      const startedMs = performance.now();
      const invocationId = randomUUID();
      const taskBefore = await resolveCurrentTask(currentTask, args);
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
          task_id: taskBefore?.id || null,
          workspace_ids: initialWorkspaceIds,
          started_at: startedAt
        });
      }
      let result;
      let ok = true;
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
        await enforcePolicy(name, args ?? {});
        result = await withTaskOperation(name, args ?? {}, () => handler(args ?? {}, extra));
      } catch (error) {
        ok = false;
        result = {
          content: [{ type: "text", text: JSON.stringify(await modelSafeError(error)) }],
          isError: true
        };
      }
      const requestMetrics = requestContext.getStore();
      const responseBudget = Math.min(
        maxResponseBytes,
        Number(requestMetrics?.responseBudget || defaultResponseBytes)
      );
      result = enforceResultBudget(result, responseBudget);
      const success = ok && !result?.isError;
      const outChars = resultLen(result);
      const outBytes = resultBytes(result);
      const durationMs = roundMs(performance.now() - startedMs);
      const finishedAt = isoNow();
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
      audit({
        ts: finishedAt,
        kind: "tool",
        phase: success ? "finished" : "failed",
        invocation_id: invocationId,
        runtime_id: runtimeId,
        request_id: requestMetrics?.requestId || null,
        tool: name,
        ok: success && resultMetadata.operationalOk,
        transport_ok: success,
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

async function resolveCurrentTask(currentTask, args) {
  try {
    return await currentTask({ taskToken: args?.task_token, required: false });
  } catch {
    return null;
  }
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
