import path from "node:path";
import * as vscode from "vscode";
import type {
  AuditStatus,
  HealthResponse,
  ProcessDescriptor,
  TaskDescriptor,
  WorkspaceDescriptor,
} from "../api/api-types.js";
import {
  AuditReader,
  type AuditActivitySnapshot,
  type ToolActivity,
} from "../activity/audit-reader.js";
import { ConnectionManager } from "../connection/connection-manager.js";
import { readLcaStatus, type LcaCliStatus } from "../connection/lca-cli.js";

export interface ControlWorkspace {
  id: string;
  label: string;
  root: string;
  availability: "available" | "unavailable";
  registrationState: "active" | "archived";
  archivedAt: string | null;
  trusted: boolean;
  isDefault: boolean;
  isConfiguredStartup: boolean;
  opened: boolean;
}

export interface ControlTask {
  id: string;
  title: string;
  status: string;
  primaryWorkspaceId: string | null;
  workspaceIds: string[];
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
}

export interface ControlCenterState {
  loading: boolean;
  revision: number;
  serverOnline: boolean;
  supervisorOnline: boolean;
  tunnelOnline: boolean;
  tunnelReady: boolean;
  version?: string;
  runtimeId: string | null;
  sessions: { active: number; max: number };
  audit: AuditActivitySnapshot;
  workspaces: ControlWorkspace[];
  tasks: ControlTask[];
  processes: ProcessDescriptor[];
  storageError?: string;
  error?: string;
}

export class ControlCenterStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ControlCenterState>();
  readonly onDidChange = this.emitter.event;
  private readonly auditReader = new AuditReader();
  private state: ControlCenterState = {
    loading: true,
    revision: 0,
    serverOnline: false,
    supervisorOnline: false,
    tunnelOnline: false,
    tunnelReady: false,
    runtimeId: null,
    sessions: { active: 0, max: 32 },
    audit: this.auditReader.current,
    workspaces: [],
    tasks: [],
    processes: [],
  };
  private visible = false;
  private disposed = false;
  private timer: NodeJS.Timeout | undefined;
  private refreshPromise: Promise<void> | undefined;
  private revision = 0;

  constructor(private readonly connection: ConnectionManager) {
    this.auditReader.onDidChange((audit) => {
      this.state = {
        ...this.state,
        audit: filterAuditForRegisteredWorkspaces(
          withOfflineInterruptions(audit, this.state.serverOnline),
          this.state.workspaces,
        ),
      };
      this.emit();
    });
  }

  get current(): ControlCenterState {
    return this.state;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.updateTimer();
    if (visible) void this.refresh();
  }

  refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.load().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.auditReader.dispose();
    this.emitter.dispose();
  }

  private async load(): Promise<void> {
    this.state = { ...this.state, loading: true };
    this.emit();
    const [statusResult, connectionResult] = await Promise.allSettled([
      readLcaStatus(this.connection.preferredWorkspaceFolder?.uri.fsPath),
      this.connection.check(),
    ]);
    const cliStatus = statusResult.status === "fulfilled" ? statusResult.value : undefined;
    const connectionState = connectionResult.status === "fulfilled" ? connectionResult.value : undefined;
    const health = connectionState?.kind === "connected" ? connectionState.health : undefined;
    const serverOnline = Boolean(health || cliStatus?.pids?.server_alive);
    const auditStatus = health?.audit || cliStatus?.audit;
    const workspaceFolders = await openFolderRoots();
    const workspaces = normalizeWorkspaces(health, cliStatus, workspaceFolders);
    const tasks = normalizeTasks(health, cliStatus);
    await this.auditReader.configure(auditStatus?.path, auditStatus?.enabled === true);
    this.state = {
      ...this.state,
      loading: false,
      serverOnline,
      supervisorOnline: Boolean(cliStatus?.pids?.supervisor_alive),
      tunnelOnline: Boolean(cliStatus?.pids?.tunnel_alive),
      tunnelReady: Boolean(cliStatus?.pids?.tunnel_ready),
      version: health?.version || stringValue(cliStatus?.server?.version),
      runtimeId: health?.runtime_id || cliStatus?.runtime_id || null,
      sessions: {
        active: Number(health?.mcp_sessions?.active ?? cliStatus?.sessions?.active ?? 0),
        max: Number(health?.mcp_sessions?.max ?? cliStatus?.sessions?.max ?? 32),
      },
      audit: filterAuditForRegisteredWorkspaces(
        withOfflineInterruptions(this.auditReader.current, serverOnline),
        workspaces,
      ),
      workspaces,
      tasks,
      processes: health?.processes || [],
      storageError: cliStatus?.storage_error || undefined,
      error: statusResult.status === "rejected" && !health
        ? statusResult.reason instanceof Error ? statusResult.reason.message : "LCA CLI status is unavailable."
        : undefined,
    };
    this.emit();
  }

  private updateTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.visible || this.disposed) return;
    this.timer = setInterval(() => void this.refresh(), 2_000);
    this.timer.unref?.();
  }

  private emit(): void {
    this.state = { ...this.state, revision: ++this.revision };
    this.emitter.fire(this.state);
  }
}

function normalizeWorkspaces(
  health: HealthResponse | undefined,
  status: LcaCliStatus | undefined,
  openRoots: Set<string>,
): ControlWorkspace[] {
  const descriptors = new Map<string, WorkspaceDescriptor>();
  for (const descriptor of [...(status?.workspaces || []), ...(health?.workspaces || [])]) {
    const id = workspaceId(descriptor);
    if (!id) continue;
    descriptors.set(id, { ...(descriptors.get(id) || {}), ...descriptor });
  }
  const defaultId = health?.global_default_workspace_id ||
    workspaceId(status?.selected_workspace) ||
    null;
  const configuredRoot = status?.configured_workspace || health?.workspace || "";
  return [...descriptors.entries()].map(([id, descriptor]) => {
    const root = workspaceRoot(descriptor);
    const metadata = descriptor.metadata || {};
    const registrationState = descriptor.registration_state ||
      descriptor.registrationState ||
      "active";
    const availability: ControlWorkspace["availability"] =
      descriptor.available === false || descriptor.availability === "unavailable"
        ? "unavailable"
        : "available";
    return {
      id,
      label: descriptor.label || metadata.label || path.basename(root),
      root,
      availability,
      registrationState,
      archivedAt: descriptor.archived_at || descriptor.archivedAt || null,
      trusted: descriptor.trusted === true || descriptor.trust_state === "trusted" || metadata.trusted === true,
      isDefault: id === defaultId,
      isConfiguredStartup: Boolean(configuredRoot && comparablePath(root) === comparablePath(configuredRoot)),
      opened: openRoots.has(comparablePath(root)),
    };
  }).sort((left, right) => {
    if (left.registrationState !== right.registrationState) return left.registrationState === "active" ? -1 : 1;
    if (left.availability !== right.availability) return left.availability === "available" ? -1 : 1;
    return left.label.localeCompare(right.label);
  });
}

function normalizeTasks(health: HealthResponse | undefined, status: LcaCliStatus | undefined): ControlTask[] {
  const descriptors = new Map<string, TaskDescriptor>();
  for (const descriptor of [
    ...(status?.recent_tasks || status?.active_tasks || []),
    ...(health?.tasks || []),
  ]) {
    const id = taskId(descriptor);
    if (!id) continue;
    descriptors.set(id, { ...(descriptors.get(id) || {}), ...descriptor });
  }
  return [...descriptors.entries()].map(([id, task]) => ({
    id,
    title: task.title || `Task ${id.slice(0, 12)}`,
    status: task.status || "unknown",
    primaryWorkspaceId: task.primary_workspace_id || task.workspace_ids?.[0] || null,
    workspaceIds: task.workspace_ids || (task.primary_workspace_id ? [task.primary_workspace_id] : []),
    createdAt: task.created_at || null,
    updatedAt: task.updated_at || null,
    closedAt: task.closed_at || null,
  })).sort((left, right) => Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || ""));
}

async function openFolderRoots(): Promise<Set<string>> {
  return new Set((vscode.workspace.workspaceFolders || []).map((folder) => comparablePath(folder.uri.fsPath)));
}

function workspaceId(descriptor: WorkspaceDescriptor | null | undefined): string | undefined {
  return descriptor?.workspace_id || descriptor?.id;
}

function workspaceRoot(descriptor: WorkspaceDescriptor): string {
  return descriptor.canonical_root || descriptor.canonicalRoot || descriptor.root || descriptor.path || "";
}

function taskId(descriptor: TaskDescriptor): string | undefined {
  return descriptor.task_id || descriptor.id;
}

function comparablePath(value: string): string {
  const normalized = path.resolve(value || ".").replace(/[\\/]+$/, "");
  return process.platform === "win32" || process.platform === "darwin"
    ? normalized.toLowerCase()
    : normalized;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function activitiesForTask(activities: ToolActivity[], taskId: string): ToolActivity[] {
  return activities.filter((activity) => activity.taskId === taskId);
}

function withOfflineInterruptions(
  audit: AuditActivitySnapshot,
  serverOnline: boolean,
): AuditActivitySnapshot {
  if (serverOnline || !audit.activities.some((activity) => activity.status === "started")) return audit;
  const interruptedAt = new Date().toISOString();
  return {
    ...audit,
    activities: audit.activities.map((activity) => {
      if (activity.status !== "started") return activity;
      return {
        ...activity,
        status: "interrupted" as const,
        ok: false,
        finishedAt: interruptedAt,
        durationMs: Math.max(0, Date.parse(interruptedAt) - Date.parse(activity.startedAt)),
        errorCode: "RUNTIME_INTERRUPTED",
      };
    }),
  };
}

export function filterAuditForRegisteredWorkspaces(
  audit: AuditActivitySnapshot,
  workspaces: Array<{ id: string }>,
): AuditActivitySnapshot {
  const registered = new Set(workspaces.map((workspace) => workspace.id));
  return {
    ...audit,
    activities: audit.activities.filter(
      (activity) => activity.workspaceIds.length === 0 ||
        activity.workspaceIds.every((workspaceId) => registered.has(workspaceId)),
    ),
  };
}
