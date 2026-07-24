// Safe Control Center projection of the rotating runtime audit log.
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

const MAX_EVENTS = 20_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_CACHE = new Map();

export async function readControlActivities({ auditPath, enabled, runtimeId = null }) {
  if (!enabled || !auditPath) {
    return { available: false, enabled: Boolean(enabled), currentRuntimeId: runtimeId, activities: [] };
  }
  try {
    const files = await auditFiles(auditPath);
    const fileInfo = await Promise.all(files.map(async (file) => ({ file, info: await stat(file) })));
    const sourceRevision = fileInfo.map(({ file, info }) => [file, info.size, info.mtimeMs]).join("\n");
    const cached = SNAPSHOT_CACHE.get(auditPath);
    if (cached?.sourceRevision === sourceRevision && cached.runtimeId === runtimeId) return cached.snapshot;
    const events = [];
    for (const { file, info } of fileInfo) {
      if (!info.isFile()) continue;
      const start = Math.max(0, info.size - MAX_FILE_BYTES);
      const length = info.size - start;
      const fileHandle = await open(file, "r");
      let source;
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await fileHandle.read(buffer, 0, length, start);
        source = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await fileHandle.close();
      }
      if (start > 0) source = source.replace(/^[^\n]*\n?/, "");
      for (const line of source.split("\n")) {
        const event = projectLine(line);
        if (event) events.push(event);
      }
    }
    const cutoff = Date.now() - RETENTION_MS;
    const retained = events
      .filter((event) => Date.parse(event.ts) >= cutoff)
      .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts))
      .slice(-MAX_EVENTS);
    const activities = buildActivities(retained);
    const snapshot = {
      available: true,
      enabled: true,
      currentRuntimeId: latestRuntimeId(retained) || runtimeId,
      activities,
      revision: createHash("sha256").update(JSON.stringify(activities.map((activity) => [
        activity.invocationId,
        activity.status,
        activity.startedAt,
        activity.finishedAt,
        activity.taskId,
        activity.workspaceIds
      ]))).digest("hex").slice(0, 16),
      updatedAt: new Date().toISOString()
    };
    SNAPSHOT_CACHE.set(auditPath, { sourceRevision, runtimeId, snapshot });
    return snapshot;
  } catch (error) {
    return {
      available: false,
      enabled: true,
      currentRuntimeId: runtimeId,
      activities: [],
      error: error?.message || "Audit log is unavailable.",
      updatedAt: new Date().toISOString()
    };
  }
}

async function auditFiles(auditPath) {
  const directory = path.dirname(auditPath);
  const base = path.basename(auditPath);
  return (await readdir(directory))
    .filter((name) => name === base || new RegExp(`^${escapeRegex(base)}\\.\\d+$`).test(name))
    .sort((left, right) => rotationIndex(right, base) - rotationIndex(left, base))
    .map((name) => path.join(directory, name));
}

function projectLine(line) {
  if (!line.trim()) return null;
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const ts = safeTimestamp(value?.ts);
  if (!ts) return null;
  if (value.kind === "runtime") {
    const phase = value.phase === "started" ? "started" : value.phase === "stopped" ? "finished" : null;
    const runtimeId = safeIdentifier(value.runtime_id, 160);
    return phase && runtimeId ? { kind: "runtime", phase, ts, runtimeId } : null;
  }
  if (value.kind !== "tool") return null;
  const tool = safeTool(value.tool);
  if (!tool) return null;
  const rawPhase = String(value.phase || "finished");
  const phase = ["started", "finished", "failed"].includes(rawPhase) ? rawPhase : "finished";
  const requestId = safeIdentifier(value.request_id ?? value.requestId, 180);
  const invocationId = safeIdentifier(value.invocation_id, 180) || `legacy:${requestId || "none"}:${tool}:${ts}`;
  return {
    kind: "tool",
    phase,
    ts,
    invocationId,
    runtimeId: safeIdentifier(value.runtime_id, 180),
    tool,
    taskId: safeTaskId(value.task_id),
    workspaceIds: safeWorkspaceIds(value.workspace_ids),
    ok: typeof value.ok === "boolean" ? value.ok : null,
    durationMs: safeNumber(value.duration_ms ?? value.durationMs),
    errorCode: safeEnumCode(value.error_code),
    verification: safeVerification(value.verification),
    changeCount: safeCount(value.change_count),
    fileCount: safeCount(value.file_count),
    toolClass: safeLowerIdentifier(value.tool_class),
    fingerprint: safeIdentifier(value.fingerprint, 80),
    purpose: safeLowerIdentifier(value.purpose),
    purposeFingerprint: safeIdentifier(value.purpose_fingerprint, 80),
    orchestrationEvent: safeLowerIdentifier(value.orchestration_event),
    runState: safeLowerIdentifier(value.run_state),
    duplicate: value.duplicate === true,
    statusOnly: value.status_only === true,
    policySkip: value.policy_skip === true,
    cacheHit: value.cache_hit === true,
    evidenceDelta: value.evidence_delta === true,
    orchestrationNoticeCode: safeEnumCode(value.orchestration_notice_code),
    orchestrationPhaseBefore: safeLowerIdentifier(value.orchestration_phase_before),
    orchestrationPhaseAfter: safeLowerIdentifier(value.orchestration_phase_after),
    effectiveProfile: safeLowerIdentifier(value.effective_profile),
    evidenceStatus: safeLowerIdentifier(value.evidence_status)
  };
}

function buildActivities(events) {
  const calls = new Map();
  const runtimeStops = new Map();
  const runtimeStarts = new Map();
  for (const event of events) {
    if (event.kind === "runtime") {
      if (event.phase === "started") runtimeStarts.set(event.runtimeId, event.ts);
      else runtimeStops.set(event.runtimeId, event.ts);
      continue;
    }
    const existing = calls.get(event.invocationId);
    if (event.phase === "started") {
      calls.set(event.invocationId, activityFrom(event, {
        status: "started",
        ok: null,
        startedAt: event.ts,
        finishedAt: null,
        durationMs: null
      }));
      continue;
    }
    const durationMs = event.durationMs ?? existing?.durationMs ?? null;
    const startedAt = existing?.startedAt || (durationMs === null
      ? event.ts
      : new Date(Date.parse(event.ts) - durationMs).toISOString());
    calls.set(event.invocationId, activityFrom(event, {
      existing,
      status: event.phase,
      ok: event.ok ?? (event.phase === "failed" ? false : true),
      startedAt,
      finishedAt: event.ts,
      durationMs
    }));
  }
  const newestRuntime = [...runtimeStarts.entries()].sort((left, right) => Date.parse(right[1]) - Date.parse(left[1]))[0];
  for (const call of calls.values()) {
    if (call.status !== "started") continue;
    const stoppedAt = call.runtimeId ? runtimeStops.get(call.runtimeId) : null;
    const replacedAt = call.runtimeId && newestRuntime && newestRuntime[0] !== call.runtimeId ? newestRuntime[1] : null;
    const interruptedAt = [stoppedAt, replacedAt].filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    if (!interruptedAt) continue;
    call.status = "interrupted";
    call.ok = false;
    call.finishedAt = interruptedAt;
    call.durationMs = Math.max(0, Date.parse(interruptedAt) - Date.parse(call.startedAt));
    call.errorCode = "RUNTIME_INTERRUPTED";
  }
  return [...calls.values()].sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
}

function activityFrom(event, { existing, status, ok, startedAt, finishedAt, durationMs }) {
  return {
    invocationId: event.invocationId,
    runtimeId: event.runtimeId || existing?.runtimeId || null,
    tool: event.tool,
    taskId: event.taskId || existing?.taskId || null,
    workspaceIds: event.workspaceIds?.length ? event.workspaceIds : existing?.workspaceIds || [],
    status,
    ok,
    startedAt,
    finishedAt,
    durationMs,
    errorCode: event.errorCode || existing?.errorCode || null,
    verification: event.verification || existing?.verification || null,
    changeCount: event.changeCount ?? existing?.changeCount ?? null,
    fileCount: event.fileCount ?? existing?.fileCount ?? null,
    toolClass: event.toolClass || existing?.toolClass || null,
    fingerprint: event.fingerprint || existing?.fingerprint || null,
    purpose: event.purpose || existing?.purpose || null,
    purposeFingerprint: event.purposeFingerprint || existing?.purposeFingerprint || null,
    orchestrationEvent: event.orchestrationEvent || existing?.orchestrationEvent || null,
    runState: event.runState || existing?.runState || null,
    duplicate: event.duplicate === true || existing?.duplicate === true,
    statusOnly: event.statusOnly === true || existing?.statusOnly === true,
    policySkip: event.policySkip === true || existing?.policySkip === true,
    cacheHit: event.cacheHit === true || existing?.cacheHit === true,
    evidenceDelta: event.evidenceDelta === true || existing?.evidenceDelta === true,
    orchestrationNoticeCode: event.orchestrationNoticeCode || existing?.orchestrationNoticeCode || null,
    orchestrationPhaseBefore: event.orchestrationPhaseBefore || existing?.orchestrationPhaseBefore || null,
    orchestrationPhaseAfter: event.orchestrationPhaseAfter || existing?.orchestrationPhaseAfter || null,
    effectiveProfile: event.effectiveProfile || existing?.effectiveProfile || null,
    evidenceStatus: event.evidenceStatus || existing?.evidenceStatus || null
  };
}

function latestRuntimeId(events) {
  return events
    .filter((event) => event.kind === "runtime" && event.phase === "started")
    .sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts))[0]?.runtimeId || null;
}

function safeTimestamp(value) {
  const text = typeof value === "string" ? value : "";
  return Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}
function safeIdentifier(value, max = 180) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= max && /^[A-Za-z0-9_.:@/-]+$/.test(text) ? text : null;
}
function safeLowerIdentifier(value) {
  const text = safeIdentifier(value, 160);
  return text ? text.toLowerCase() : null;
}
function safeTaskId(value) {
  return safeIdentifier(value, 180);
}
function safeWorkspaceIds(value) {
  return Array.isArray(value) ? value.map((item) => safeIdentifier(item, 180)).filter(Boolean).slice(0, 8) : [];
}
function safeTool(value) {
  const text = safeIdentifier(value, 120);
  return text && /^[a-z][a-z0-9_]*$/.test(text) ? text : null;
}
function safeEnumCode(value) {
  const text = safeIdentifier(value, 120);
  return text ? text.toUpperCase() : null;
}
function safeVerification(value) {
  const text = String(value || "").toUpperCase();
  return ["PASS", "INCOMPLETE", "FAIL"].includes(text) ? text : null;
}
function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function safeCount(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}
function rotationIndex(name, base) {
  if (name === base) return 0;
  const value = Number(name.slice(base.length + 1));
  return Number.isInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
