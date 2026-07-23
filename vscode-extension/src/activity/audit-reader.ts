import { watch, type FSWatcher } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";

const MAX_EVENTS = 20_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const AUDIT_FALLBACK_INTERVAL_MS = 10_000;

export type ActivityStatus = "started" | "finished" | "failed" | "interrupted";

export interface ToolActivity {
  invocationId: string;
  runtimeId: string | null;
  tool: string;
  taskId: string | null;
  workspaceIds: string[];
  status: ActivityStatus;
  ok: boolean | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorCode: string | null;
  verification: "PASS" | "INCOMPLETE" | "FAIL" | null;
  changeCount: number | null;
  fileCount: number | null;
  toolClass: string | null;
  fingerprint: string | null;
  duplicate: boolean;
  statusOnly: boolean;
  policySkip: boolean;
  cacheHit: boolean;
  evidenceDelta: boolean;
  orchestrationNoticeCode: string | null;
  orchestrationPhaseBefore: string | null;
  orchestrationPhaseAfter: string | null;
  effectiveProfile: string | null;
  evidenceStatus: string | null;
}

export interface AuditActivitySnapshot {
  available: boolean;
  enabled: boolean;
  path?: string;
  currentRuntimeId: string | null;
  activities: ToolActivity[];
  error?: string;
  updatedAt?: string;
}

interface ProjectedEvent {
  key: string;
  ts: string;
  kind: "tool" | "runtime";
  phase: ActivityStatus;
  invocationId?: string;
  runtimeId: string | null;
  tool?: string;
  taskId?: string | null;
  workspaceIds?: string[];
  ok?: boolean | null;
  durationMs?: number | null;
  errorCode?: string | null;
  verification?: "PASS" | "INCOMPLETE" | "FAIL" | null;
  changeCount?: number | null;
  fileCount?: number | null;
  toolClass?: string | null;
  fingerprint?: string | null;
  duplicate?: boolean;
  statusOnly?: boolean;
  policySkip?: boolean;
  cacheHit?: boolean;
  evidenceDelta?: boolean;
  orchestrationNoticeCode?: string | null;
  orchestrationPhaseBefore?: string | null;
  orchestrationPhaseAfter?: string | null;
  effectiveProfile?: string | null;
  evidenceStatus?: string | null;
}

interface FileCursor {
  identity: string;
  offset: number;
  remainder: string;
}

export class AuditReader implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<AuditActivitySnapshot>();
  readonly onDidChange = this.emitter.event;
  private snapshot: AuditActivitySnapshot = {
    available: false,
    enabled: false,
    currentRuntimeId: null,
    activities: [],
  };
  private auditPath: string | undefined;
  private cursors = new Map<string, FileCursor>();
  private events = new Map<string, ProjectedEvent>();
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private refreshPromise: Promise<void> | undefined;

  get current(): AuditActivitySnapshot {
    return this.snapshot;
  }

  async configure(auditPath: string | undefined, enabled: boolean): Promise<void> {
    const normalized = auditPath ? path.resolve(auditPath) : undefined;
    if (this.auditPath !== normalized) {
      this.stopWatching();
      this.auditPath = normalized;
      this.cursors.clear();
      this.events.clear();
    }
    this.snapshot = {
      ...this.snapshot,
      enabled,
      path: normalized,
      available: enabled && Boolean(normalized),
      error: enabled && !normalized ? "Audit path is unavailable." : undefined,
    };
    if (!enabled || !normalized) {
      this.stopWatching();
      this.emit();
      return;
    }
    this.startWatching();
    await this.refresh();
  }

  refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.readAvailableFiles().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  dispose(): void {
    this.stopWatching();
    this.emitter.dispose();
  }

  private startWatching(): void {
    if (!this.auditPath || this.watcher) return;
    try {
      this.watcher = watch(path.dirname(this.auditPath), { persistent: false }, (_event, name) => {
        if (!name || String(name).startsWith(path.basename(this.auditPath!))) void this.refresh();
      });
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      this.watcher = undefined;
    }
    this.timer = setInterval(() => void this.refresh(), AUDIT_FALLBACK_INTERVAL_MS);
    this.timer.unref?.();
  }

  private stopWatching(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async readAvailableFiles(): Promise<void> {
    if (!this.auditPath || !this.snapshot.enabled) return;
    try {
      const files = await auditFiles(this.auditPath);
      for (const file of files) await this.readFileDelta(file);
      const existing = new Set(files);
      for (const file of this.cursors.keys()) {
        if (!existing.has(file)) this.cursors.delete(file);
      }
      this.prune();
      this.snapshot = {
        available: true,
        enabled: true,
        path: this.auditPath,
        currentRuntimeId: latestRuntimeId(this.events.values()),
        activities: buildActivities(this.events.values()),
        updatedAt: new Date().toISOString(),
      };
      this.emit();
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        available: false,
        error: error instanceof Error ? error.message : "Audit log is unavailable.",
        updatedAt: new Date().toISOString(),
      };
      this.emit();
    }
  }

  private async readFileDelta(file: string): Promise<void> {
    const info = await stat(file);
    if (!info.isFile()) return;
    const identity = `${String(info.dev)}:${String(info.ino)}`;
    let cursor = this.cursors.get(file);
    if (!cursor || cursor.identity !== identity || info.size < cursor.offset) {
      cursor = { identity, offset: 0, remainder: "" };
    }
    if (info.size === cursor.offset) {
      this.cursors.set(file, cursor);
      return;
    }
    const length = info.size - cursor.offset;
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, cursor.offset);
      const text = cursor.remainder + buffer.subarray(0, bytesRead).toString("utf8");
      const lines = text.split("\n");
      cursor.remainder = lines.pop() || "";
      cursor.offset += bytesRead;
      for (const line of lines) this.acceptLine(line);
      this.cursors.set(file, cursor);
    } finally {
      await handle.close();
    }
  }

  private acceptLine(line: string): void {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const event = projectAuditEvent(raw);
    if (event) this.events.set(event.key, event);
  }

  private prune(): void {
    const cutoff = Date.now() - RETENTION_MS;
    const retained = [...this.events.values()]
      .filter((event) => Date.parse(event.ts) >= cutoff)
      .sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts))
      .slice(0, MAX_EVENTS);
    this.events = new Map(retained.map((event) => [event.key, event]));
  }

  private emit(): void {
    this.emitter.fire(this.snapshot);
  }
}

async function auditFiles(auditPath: string): Promise<string[]> {
  const directory = path.dirname(auditPath);
  const base = path.basename(auditPath);
  const names = await readdir(directory);
  return names
    .filter((name) => name === base || new RegExp(`^${escapeRegex(base)}\\.\\d+$`).test(name))
    .sort((left, right) => rotationIndex(right, base) - rotationIndex(left, base))
    .map((name) => path.join(directory, name));
}

function projectAuditEvent(raw: unknown): ProjectedEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const ts = safeTimestamp(value.ts);
  if (!ts) return null;
  if (value.kind === "runtime") {
    const phase = value.phase === "started" ? "started" : value.phase === "stopped" ? "finished" : null;
    const runtimeId = safeIdentifier(value.runtime_id, 160);
    if (!phase || !runtimeId) return null;
    return {
      key: `runtime:${runtimeId}:${phase}`,
      ts,
      kind: "runtime",
      phase,
      runtimeId,
    };
  }
  if (value.kind !== "tool") return null;
  const tool = safeTool(value.tool);
  if (!tool) return null;
  const rawPhase = String(value.phase || "finished");
  const phase: ActivityStatus = ["started", "finished", "failed"].includes(rawPhase)
    ? rawPhase as ActivityStatus
    : "finished";
  const requestId = safeIdentifier(value.request_id ?? value.requestId, 180);
  const invocationId = safeIdentifier(value.invocation_id, 180) ||
    `legacy:${requestId || "none"}:${tool}:${ts}`;
  const runtimeId = safeIdentifier(value.runtime_id, 180);
  return {
    key: `tool:${invocationId}:${phase}`,
    ts,
    kind: "tool",
    phase,
    invocationId,
    runtimeId,
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
    duplicate: value.duplicate === true,
    statusOnly: value.status_only === true,
    policySkip: value.policy_skip === true,
    cacheHit: value.cache_hit === true,
    evidenceDelta: value.evidence_delta === true,
    orchestrationNoticeCode: safeEnumCode(value.orchestration_notice_code),
    orchestrationPhaseBefore: safeLowerIdentifier(value.orchestration_phase_before),
    orchestrationPhaseAfter: safeLowerIdentifier(value.orchestration_phase_after),
    effectiveProfile: safeLowerIdentifier(value.effective_profile),
    evidenceStatus: safeLowerIdentifier(value.evidence_status),
  };
}

function buildActivities(events: Iterable<ProjectedEvent>): ToolActivity[] {
  const ordered = [...events].sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
  const calls = new Map<string, ToolActivity>();
  const runtimeStops = new Map<string, string>();
  const runtimeStarts = new Map<string, string>();
  for (const event of ordered) {
    if (event.kind === "runtime" && event.runtimeId) {
      if (event.phase === "started") runtimeStarts.set(event.runtimeId, event.ts);
      else runtimeStops.set(event.runtimeId, event.ts);
      continue;
    }
    if (!event.invocationId || !event.tool) continue;
    const existing = calls.get(event.invocationId);
    if (event.phase === "started") {
      calls.set(event.invocationId, {
        invocationId: event.invocationId,
        runtimeId: event.runtimeId,
        tool: event.tool,
        taskId: event.taskId || null,
        workspaceIds: event.workspaceIds || [],
        status: "started",
        ok: null,
        startedAt: event.ts,
        finishedAt: null,
        durationMs: null,
        errorCode: null,
        verification: null,
        changeCount: null,
        fileCount: null,
        toolClass: event.toolClass || null,
        fingerprint: event.fingerprint || null,
        duplicate: event.duplicate === true,
        statusOnly: event.statusOnly === true,
        policySkip: event.policySkip === true,
        cacheHit: event.cacheHit === true,
        evidenceDelta: event.evidenceDelta === true,
        orchestrationNoticeCode: event.orchestrationNoticeCode || null,
        orchestrationPhaseBefore: event.orchestrationPhaseBefore || null,
        orchestrationPhaseAfter: event.orchestrationPhaseAfter || null,
        effectiveProfile: event.effectiveProfile || null,
        evidenceStatus: event.evidenceStatus || null,
      });
      continue;
    }
    const duration = event.durationMs ?? existing?.durationMs ?? null;
    const startedAt = existing?.startedAt || (
      duration === null ? event.ts : new Date(Date.parse(event.ts) - duration).toISOString()
    );
    calls.set(event.invocationId, {
      invocationId: event.invocationId,
      runtimeId: event.runtimeId || existing?.runtimeId || null,
      tool: event.tool,
      taskId: event.taskId || existing?.taskId || null,
      workspaceIds: event.workspaceIds?.length ? event.workspaceIds : existing?.workspaceIds || [],
      status: event.phase,
      ok: event.ok ?? (event.phase === "failed" ? false : true),
      startedAt,
      finishedAt: event.ts,
      durationMs: duration,
      errorCode: event.errorCode || null,
      verification: event.verification || null,
      changeCount: event.changeCount ?? null,
      fileCount: event.fileCount ?? existing?.fileCount ?? null,
      toolClass: event.toolClass || existing?.toolClass || null,
      fingerprint: event.fingerprint || existing?.fingerprint || null,
      duplicate: event.duplicate === true || existing?.duplicate === true,
      statusOnly: event.statusOnly === true || existing?.statusOnly === true,
      policySkip: event.policySkip === true || existing?.policySkip === true,
      cacheHit: event.cacheHit === true || existing?.cacheHit === true,
      evidenceDelta: event.evidenceDelta === true || existing?.evidenceDelta === true,
      orchestrationNoticeCode: event.orchestrationNoticeCode || existing?.orchestrationNoticeCode || null,
      orchestrationPhaseBefore: event.orchestrationPhaseBefore || existing?.orchestrationPhaseBefore || null,
      orchestrationPhaseAfter: event.orchestrationPhaseAfter || existing?.orchestrationPhaseAfter || null,
      effectiveProfile: event.effectiveProfile || existing?.effectiveProfile || null,
      evidenceStatus: event.evidenceStatus || existing?.evidenceStatus || null,
    });
  }
  const newestRuntime = [...runtimeStarts.entries()].sort(
    (left, right) => Date.parse(right[1]) - Date.parse(left[1]),
  )[0];
  for (const call of calls.values()) {
    if (call.status !== "started") continue;
    const stoppedAt = call.runtimeId ? runtimeStops.get(call.runtimeId) : undefined;
    const replacedAt = call.runtimeId && newestRuntime && newestRuntime[0] !== call.runtimeId
      ? newestRuntime[1]
      : undefined;
    const interruptedAt = [stoppedAt, replacedAt]
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
    if (!interruptedAt) continue;
    call.status = "interrupted";
    call.ok = false;
    call.finishedAt = interruptedAt;
    call.durationMs = Math.max(0, Date.parse(interruptedAt) - Date.parse(call.startedAt));
    call.errorCode = "RUNTIME_INTERRUPTED";
  }
  return [...calls.values()]
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, MAX_EVENTS);
}

function latestRuntimeId(events: Iterable<ProjectedEvent>): string | null {
  return [...events]
    .filter((event) => event.kind === "runtime" && event.phase === "started" && event.runtimeId)
    .sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts))[0]?.runtimeId || null;
}

function safeTimestamp(value: unknown): string | null {
  const source = String(value || "");
  return Number.isFinite(Date.parse(source)) ? new Date(source).toISOString() : null;
}

function safeIdentifier(value: unknown, max: number): string | null {
  const source = String(value || "");
  return source && source.length <= max && /^[A-Za-z0-9_.:-]+$/.test(source) ? source : null;
}

function safeLowerIdentifier(value: unknown): string | null {
  const identifier = String(value || "");
  return /^[a-z][a-z0-9_]{0,79}$/.test(identifier) ? identifier : null;
}

function safeTool(value: unknown): string | null {
  const tool = String(value || "");
  return /^[a-z][a-z0-9_]{0,79}$/.test(tool) ? tool : null;
}

function safeTaskId(value: unknown): string | null {
  const id = String(value || "");
  return /^task_[A-Za-z0-9_-]{8,160}$/.test(id) ? id : null;
}

function safeWorkspaceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).filter((id) => /^ws_[A-Za-z0-9_-]{8,160}$/.test(id)))].sort();
}

function safeNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function safeCount(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function safeEnumCode(value: unknown): string | null {
  const code = String(value || "");
  return /^[A-Z][A-Z0-9_]{1,80}$/.test(code) ? code : null;
}

function safeVerification(value: unknown): "PASS" | "INCOMPLETE" | "FAIL" | null {
  const status = String(value || "").toUpperCase();
  return status === "PASS" || status === "INCOMPLETE" || status === "FAIL" ? status : null;
}

function rotationIndex(name: string, base: string): number {
  if (name === base) return 0;
  return Number(name.slice(base.length + 1)) || 0;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const auditReaderTestExports = {
  buildActivities,
  projectAuditEvent,
};
