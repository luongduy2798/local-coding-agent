import React, { useEffect, useMemo, useState } from "react";

export type ControlTab = "overview" | "workspaces" | "tasks" | "changes";

export interface ControlWorkspaceView {
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

export interface ToolActivityView {
  invocationId: string;
  runtimeId: string | null;
  tool: string;
  taskId: string | null;
  workspaceIds: string[];
  status: "started" | "finished" | "failed" | "interrupted";
  ok: boolean | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorCode: string | null;
  verification: "PASS" | "INCOMPLETE" | "FAIL" | null;
  changeCount: number | null;
  fileCount: number | null;
}

export interface ControlTaskView {
  id: string;
  title: string;
  status: string;
  primaryWorkspaceId: string | null;
  workspaceIds: string[];
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
}

export interface ControlStateView {
  loading: boolean;
  monitoringPaused: boolean;
  revision: number;
  serverOnline: boolean;
  supervisorOnline: boolean;
  tunnelOnline: boolean;
  tunnelReady: boolean;
  version?: string;
  runtimeId: string | null;
  sessions: { active: number; max: number };
  audit: {
    available: boolean;
    enabled: boolean;
    path?: string;
    currentRuntimeId: string | null;
    activities: ToolActivityView[];
    error?: string;
    updatedAt?: string;
  };
  workspaces: ControlWorkspaceView[];
  tasks: ControlTaskView[];
  processes: Array<{
    process_id: string;
    name?: string;
    status: string;
    exit_code?: number | null;
    task_id?: string | null;
    workspace_id?: string | null;
    started_at?: string | null;
  }>;
  storageError?: string;
  error?: string;
}

export function ControlHeader({
  control,
  activeTab,
  syncMode,
  busy,
  onTab,
  onRefresh,
}: {
  control: ControlStateView;
  activeTab: ControlTab;
  syncMode: "idle" | "sse" | "polling";
  busy: boolean;
  onTab: (tab: ControlTab) => void;
  onRefresh: () => void;
}): React.JSX.Element {
  return (
    <>
      <header className="control-header">
        <div>
          <div className="eyebrow">LOCAL CODING AGENT</div>
          <h1>Control Center</h1>
          <div className="connection-line">
            <span className={`status-dot ${control.serverOnline ? "connected" : "disconnected"}`} />
            <span>{control.serverOnline ? "Connected" : "Offline"}</span>
            {control.version && <span className="muted">v{control.version}</span>}
            {activeTab === "changes" && syncMode !== "idle" && (
              <span className={`sync-label sync-${syncMode}`}>
                • {syncMode === "sse" ? "Live" : "Polling"}
              </span>
            )}
            {control.monitoringPaused && <span className="muted">• Monitoring paused</span>}
          </div>
        </div>
        <button
          className={`icon-button ${control.loading ? "spin" : ""}`}
          type="button"
          title="Refresh Control Center"
          disabled={busy}
          onClick={onRefresh}
        >
          ↻
        </button>
      </header>
      <nav className="control-tabs" aria-label="Control Center sections">
        {(["overview", "workspaces", "tasks", "changes"] as ControlTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            className={activeTab === tab ? "active" : ""}
            onClick={() => onTab(tab)}
          >
            {tab[0].toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </nav>
    </>
  );
}

export function OverviewPanel({
  control,
  trusted,
  busyAction,
  send,
}: PanelProps): React.JSX.Element {
  const recent = control.audit.activities.slice(0, 8);
  return (
    <section className="control-panel" aria-label="LCA overview">
      <div className="metric-grid">
        <RuntimeMetric label="Supervisor" online={control.supervisorOnline} />
        <RuntimeMetric label="Server" online={control.serverOnline} detail={control.version} />
        <RuntimeMetric
          label="Tunnel"
          online={control.tunnelOnline}
          detail={control.tunnelReady ? "Ready" : control.tunnelOnline ? "Not ready" : undefined}
        />
        <RuntimeMetric
          label="Sessions"
          online={control.serverOnline}
          detail={`${control.sessions.active}/${control.sessions.max}`}
        />
      </div>
      <div className="control-actions-row">
        {!control.serverOnline ? (
          <ActionButton
            label="Start LCA"
            primary
            disabled={!trusted || Boolean(busyAction)}
            loading={busyAction === "startLca"}
            onClick={() => send("startLca")}
          />
        ) : (
          <ActionButton
            label="Stop LCA"
            danger
            disabled={!trusted || Boolean(busyAction)}
            loading={busyAction === "stopLca"}
            onClick={() => send("stopLca")}
          />
        )}
        <ActionButton
          label={control.monitoringPaused ? "Resume monitoring" : "Pause monitoring"}
          disabled={Boolean(busyAction)}
          onClick={() => send("pauseMonitoring", undefined, String(!control.monitoringPaused))}
        />
      </div>
      {control.storageError && <Notice kind="error">Storage: {control.storageError}</Notice>}
      {control.error && <Notice kind="error">{control.error}</Notice>}
      <section className="operational-card">
        <div className="section-heading">
          <h2>Operational activity</h2>
          <span>{control.audit.enabled ? control.audit.available ? "Audit live" : "Audit unavailable" : "Audit disabled"}</span>
        </div>
        {!control.audit.enabled ? (
          <p className="muted-block">Timeline is unavailable because audit logging is disabled.</p>
        ) : recent.length === 0 ? (
          <p className="muted-block">No tool activity has been recorded in the last seven days.</p>
        ) : (
          <ActivityList activities={recent} />
        )}
      </section>
    </section>
  );
}

export function WorkspacesPanel({
  control,
  trusted,
  busyAction,
  send,
  onViewHistory,
}: PanelProps & { onViewHistory: (workspaceId: string) => void }): React.JSX.Element {
  return (
    <section className="control-panel" aria-label="LCA workspaces">
      <div className="section-heading">
        <div>
          <h2>Workspace registry</h2>
          <p>{control.workspaces.length} registered workspace{control.workspaces.length === 1 ? "" : "s"}</p>
        </div>
        <ActionButton
          label="Connect current folder"
          primary
          disabled={!trusted || Boolean(busyAction)}
          loading={busyAction === "connect"}
          onClick={() => send("connect")}
        />
      </div>
      <div className="workspace-control-list">
        {control.workspaces.map((workspace) => {
          const archived = workspace.registrationState === "archived";
          const protectedWorkspace = workspace.isDefault || workspace.isConfiguredStartup;
          return (
            <article className="workspace-control-card" key={workspace.id}>
              <div className="workspace-card-copy">
                <div className="workspace-title-line">
                  <h3>{workspace.label}</h3>
                  <Badge value={archived ? "Archived" : workspace.availability === "available" ? "Active" : "Unavailable"} />
                  {workspace.isDefault && <Badge value="Default" />}
                  {workspace.opened && <Badge value="Open" />}
                </div>
                <code title={workspace.root}>{workspace.root}</code>
                <span className="workspace-id">{workspace.id}</span>
              </div>
              <div className="workspace-actions">
                {!archived && workspace.availability === "available" && !workspace.isDefault && (
                  <ActionButton
                    label="Make default"
                    disabled={!trusted || Boolean(busyAction)}
                    loading={busyAction === `default:${workspace.id}`}
                    onClick={() => send("makeDefaultWorkspace", workspace.id)}
                  />
                )}
                {!archived && (
                  <ActionButton
                    label="Archive"
                    disabled={!trusted || protectedWorkspace || Boolean(busyAction)}
                    loading={busyAction === `archive:${workspace.id}`}
                    onClick={() => send("archiveWorkspace", workspace.id)}
                  />
                )}
                {archived && (
                  <>
                    <ActionButton
                      label="Restore"
                      primary
                      disabled={!trusted || Boolean(busyAction)}
                      loading={busyAction === `restore:${workspace.id}`}
                      onClick={() => send("restoreWorkspace", workspace.id)}
                    />
                    <ActionButton label="View history" onClick={() => onViewHistory(workspace.id)} />
                  </>
                )}
                <ActionButton
                  label="Remove permanently"
                  danger
                  disabled={!trusted || protectedWorkspace || Boolean(busyAction)}
                  loading={busyAction === `remove:${workspace.id}`}
                  onClick={() => send("removeWorkspace", workspace.id)}
                />
              </div>
            </article>
          );
        })}
        {control.workspaces.length === 0 && <p className="muted-block">No registered workspaces.</p>}
      </div>
    </section>
  );
}

export function TasksPanel({
  control,
  changes,
}: {
  control: ControlStateView;
  changes: Array<{ task_id?: string; files: unknown[] }>;
}): React.JSX.Element {
  const [, setClock] = useState(0);
  useEffect(() => {
    if (!control.audit.activities.some((activity) => activity.status === "started")) return;
    const timer = window.setInterval(() => setClock((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [control.audit.activities]);
  const workspaceLabels = useMemo(
    () => new Map(control.workspaces.map((workspace) => [workspace.id, workspace.label])),
    [control.workspaces],
  );
  return (
    <section className="control-panel" aria-label="LCA tasks">
      <div className="section-heading">
        <div>
          <h2>Task operations</h2>
          <p>Observed tool, verification, process, and change state only.</p>
        </div>
      </div>
      <div className="task-control-list">
        {control.tasks.map((task) => {
          const activities = control.audit.activities.filter((activity) => activity.taskId === task.id);
          const active = activities.filter((activity) => activity.status === "started");
          const completed = activities.filter((activity) => activity.status === "finished").length;
          const failed = activities.filter((activity) => ["failed", "interrupted"].includes(activity.status)).length;
          const verification = activities.find((activity) => activity.verification)?.verification || null;
          const taskChanges = changes.filter((change) => change.task_id === task.id);
          const visibleFileCount = taskChanges.reduce((count, change) => count + change.files.length, 0);
          const observedChangeCount = activities.reduce(
            (count, activity) => count + (activity.changeCount || 0),
            0,
          );
          const observedFileCount = activities.reduce(
            (count, activity) => count + (activity.fileCount || 0),
            0,
          );
          const changeCount = Math.max(taskChanges.length, observedChangeCount);
          const fileCount = Math.max(visibleFileCount, observedFileCount);
          const processes = control.processes.filter((process) => process.task_id === task.id);
          return (
            <article className="task-control-card" key={task.id}>
              <div className="task-title-line">
                <h3>{task.title}</h3>
                <Badge value={task.status} />
                {verification && <Badge value={verification} tone={verification.toLowerCase()} />}
              </div>
              <div className="task-workspaces">
                <span>Primary: {workspaceLabels.get(task.primaryWorkspaceId || "") || shortId(task.primaryWorkspaceId)}</span>
                {task.workspaceIds.length > 1 && (
                  <span>Attached: {task.workspaceIds.slice(1).map((id) => workspaceLabels.get(id) || shortId(id)).join(", ")}</span>
                )}
              </div>
              <div className="task-metrics">
                <span>{active.length} running</span>
                <span>{completed} completed</span>
                <span>{failed} failed/interrupted</span>
                <span>{changeCount} changes / {fileCount} files</span>
                <span>{processes.filter((process) => process.status === "running").length} processes</span>
              </div>
              {active.length > 0 && <ActivityList activities={active} />}
              {activities.length > active.length && (
                <details className="task-history">
                  <summary>Tool history</summary>
                  <ActivityList activities={activities.filter((activity) => activity.status !== "started").slice(0, 20)} />
                </details>
              )}
            </article>
          );
        })}
        {control.tasks.length === 0 && <p className="muted-block">No task records are available.</p>}
      </div>
    </section>
  );
}

interface PanelProps {
  control: ControlStateView;
  trusted: boolean;
  busyAction?: string;
  send: (type: string, workspaceId?: string, value?: string) => void;
}

function RuntimeMetric({ label, online, detail }: { label: string; online: boolean; detail?: string }): React.JSX.Element {
  return (
    <div className="runtime-metric">
      <span className={`status-dot ${online ? "connected" : "disconnected"}`} />
      <div><strong>{label}</strong><span>{detail || (online ? "Online" : "Offline")}</span></div>
    </div>
  );
}

function ActivityList({ activities }: { activities: ToolActivityView[] }): React.JSX.Element {
  return (
    <div className="activity-list">
      {activities.map((activity) => (
        <div className="activity-row" key={activity.invocationId}>
          <span className={`activity-state activity-${activity.status}`} />
          <div className="activity-copy">
            <strong>{activity.tool}</strong>
            <span>
              {activity.status}
              {activity.verification ? ` • ${activity.verification}` : ""}
              {activity.errorCode ? ` • ${activity.errorCode}` : ""}
            </span>
          </div>
          <time>{formatDuration(activity)}</time>
        </div>
      ))}
    </div>
  );
}

function ActionButton({
  label,
  primary = false,
  danger = false,
  disabled = false,
  loading = false,
  onClick,
}: {
  label: string;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`control-button ${primary ? "primary" : ""} ${danger ? "danger" : ""}`}
      disabled={disabled || loading}
      onClick={onClick}
    >
      {loading ? "Working…" : label}
    </button>
  );
}

function Badge({ value, tone = "" }: { value: string; tone?: string }): React.JSX.Element {
  return <span className={`control-badge ${tone}`}>{value}</span>;
}

function Notice({ children, kind }: { children: React.ReactNode; kind: "error" }): React.JSX.Element {
  return <div className={`control-notice ${kind}`}>{children}</div>;
}

function formatDuration(activity: ToolActivityView): string {
  const milliseconds = activity.durationMs ?? (
    activity.status === "started" ? Math.max(0, Date.now() - Date.parse(activity.startedAt)) : 0
  );
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1_000)}s`;
}

function shortId(value: string | null): string {
  if (!value) return "Unknown";
  return value.length > 14 ? value.slice(0, 12) : value;
}
