import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChronologicalTaskFeed,
  WorkspaceHeader,
  buildWorkspaceTasks,
  makeUnassignedPresentation,
  type ControlStateView,
  type WorkspaceRoute,
} from "./control-center.js";
import "./styles.css";

interface LineChangeStats {
  additions: number;
  deletions: number;
}

function LineStats({
  stats,
  compact = false,
  className = "",
}: {
  stats: LineChangeStats | null | undefined;
  compact?: boolean;
  className?: string;
}): React.JSX.Element {
  if (!stats) return <span className={`line-stats unavailable ${className}`}>—</span>;
  const showZero = stats.additions === 0 && stats.deletions === 0;
  return (
    <span className={`line-stats ${compact ? "compact" : ""} ${className}`}>
      {(stats.additions > 0 || showZero) && (
        <span className="line-additions">+{stats.additions}</span>
      )}
      {(stats.deletions > 0 || showZero) && (
        <span className="line-deletions">-{stats.deletions}</span>
      )}
    </span>
  );
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

type ChangeStatus =
  | "applied"
  | "partially_undone"
  | "undone"
  | "reapplied"
  | "conflict"
  | "failed";

type ChangeOperation =
  | "created"
  | "modified"
  | "deleted"
  | "renamed"
  | "metadata_only";

interface ChangeSnapshot {
  exists: boolean;
  type: string;
  size: number;
  undoable: boolean;
}

interface ChangedFile {
  path: string;
  workspace_id?: string;
  operation: ChangeOperation;
  before: ChangeSnapshot;
  after: ChangeSnapshot;
  undoable: boolean;
  undoStatus: "applied" | "undone" | "not_undoable";
  group: string | null;
  stats: LineChangeStats | null;
}

interface RenameGroup {
  id: string;
  from: string;
  to: string;
}

interface ChangeRecord {
  id: string;
  workspace_id?: string;
  workspace_label?: string;
  task_id?: string;
  task_title?: string;
  source: string;
  title?: string;
  taskStatus?: "active" | "completed";
  operationCount?: number;
  status: ChangeStatus;
  createdAt: string;
  files: ChangedFile[];
  stats: LineChangeStats;
  renameGroups: RenameGroup[];
  undoable: boolean;
}

type ConnectionState =
  | { kind: "connected"; workspace: string; version: string; workspaceCount: number }
  | { kind: "server_offline"; message: string }
  | { kind: "workspace_mismatch"; message: string; workspace: string }
  | { kind: "unauthorized"; message: string }
  | { kind: "no_workspace"; message: string }
  | { kind: "remote_blocked"; message: string };

interface ViewState {
  loading: boolean;
  revision: number;
  serverRevision?: string | number;
  syncMode: "idle" | "sse" | "polling";
  busyAction?: string;
  trusted: boolean;
  currentWorkspace?: string;
  selectedWorkspaceKey?: string;
  selectedTaskId?: string;
  scopeError?: string;
  workspaceOptions: Array<{
    key: string;
    label: string;
    root: string;
    workspaceId?: string;
    available: boolean;
    registered: boolean;
    trusted: boolean;
    opened: boolean;
    registrationState: "active" | "archived";
  }>;
  taskOptions: Array<{
    taskId: string;
    title: string;
    status?: string;
  }>;
  connection?: ConnectionState;
  changes: ChangeRecord[];
  control: ControlStateView;
}

interface HostMessage {
  type: "state";
  state: ViewState;
}

const initialState: ViewState = {
  loading: true,
  revision: 0,
  syncMode: "idle",
  trusted: true,
  workspaceOptions: [],
  taskOptions: [],
  changes: [],
  control: {
    loading: true,
    revision: 0,
    serverOnline: false,
    supervisorOnline: false,
    tunnelOnline: false,
    tunnelReady: false,
    runtimeId: null,
    sessions: { active: 0, max: 32 },
    audit: {
      available: false,
      enabled: false,
      currentRuntimeId: null,
      activities: [],
    },
    workspaces: [],
    tasks: [],
    processes: [],
  },
};

function App(): React.JSX.Element {
  const [state, setState] = useState<ViewState>(initialState);
  const [route, setRoute] = useState<WorkspaceRoute>(() => {
    const saved = vscode.getState() as { route?: { kind?: string } } | undefined;
    return saved?.route?.kind === "history" ? { kind: "history" } : { kind: "tasks" };
  });
  const [historyReturnKey, setHistoryReturnKey] = useState<string | undefined>();

  useEffect(() => {
    const listener = (event: MessageEvent<HostMessage>) => {
      if (event.data?.type !== "state") return;
      latestViewRevision = Math.max(latestViewRevision, event.data.state.revision);
      setState((current) => (
        event.data.state.revision < current.revision ? current : event.data.state
      ));
    };
    window.addEventListener("message", listener);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", listener);
  }, []);

  useEffect(() => {
    vscode.setState({ route });
  }, [route]);

  useEffect(() => {
    if (state.selectedTaskId) post("selectTask", undefined, undefined, undefined);
  }, [state.selectedTaskId]);

  const connected = state.connection?.kind === "connected";
  const currentWorkspace = state.workspaceOptions.find(
    (workspace) => workspace.key === state.selectedWorkspaceKey,
  ) || state.workspaceOptions[0];
  const currentWorkspaceId = currentWorkspace?.workspaceId;
  const tasks = useMemo(
    () => buildWorkspaceTasks(state.control, state.changes, currentWorkspaceId),
    [state.control, state.changes, currentWorkspaceId],
  );
  const unassigned = useMemo(
    () => makeUnassignedPresentation(state.control, state.changes, currentWorkspaceId),
    [state.control, state.changes, currentWorkspaceId],
  );
  const selectWorkspace = (key: string) => {
    setRoute({ kind: "tasks" });
    post("selectWorkspace", undefined, undefined, key);
  };

  return (
    <main className={`app-shell workspace-shell ${connected && route.kind === "tasks" ? "feed-mode" : ""}`}>
      <WorkspaceHeader
        control={state.control}
        currentWorkspace={currentWorkspace}
        syncMode={state.syncMode}
        trusted={state.trusted}
        busyAction={state.busyAction}
        onRefresh={() => post("refresh")}
        onConnect={() => post("connect")}
        onRuntimeAction={(type, value) => post(type, undefined, undefined, value)}
        onWorkspaceAction={(type, workspaceId) => post(type, undefined, undefined, undefined, workspaceId)}
        onSelectWorkspace={selectWorkspace}
        onViewHistory={(workspaceId) => {
          setHistoryReturnKey(state.selectedWorkspaceKey);
          setRoute({ kind: "history" });
          post("viewWorkspaceHistory", undefined, undefined, undefined, workspaceId);
        }}
      />

      {!state.trusted && (
        <div className="trust-banner">
          <Icon name="lock" />
          <span>Trust this workspace to connect LCA or mutate files.</span>
        </div>
      )}

      {state.scopeError && (
        <div className="scope-error-banner">
          <Icon name="warning" />
          <span>{state.scopeError}</span>
        </div>
      )}

      {!connected && (
        <ConnectionCard
          state={state}
          onConnect={() => post("connect")}
          onRefresh={() => post("refresh")}
          onSetToken={() => post("setToken")}
        />
      )}

      {connected && route.kind === "tasks" && (
        <ChronologicalTaskFeed
          tasks={tasks}
          unassigned={unassigned}
          workspaceLabel={currentWorkspace?.label || "Current workspace"}
          workspaceKey={currentWorkspaceId || currentWorkspace?.key}
          workspaceId={currentWorkspaceId}
          busyAction={state.busyAction}
          onDeleteTask={(taskId) => post("deleteTask", undefined, undefined, taskId, currentWorkspaceId)}
          onDeleteAll={() => post("deleteWorkspaceTasks", undefined, undefined, undefined, currentWorkspaceId)}
          renderChanges={(item) => (
            <div className="change-list inline-change-list" aria-label={`Changes for ${item.task.title}`}>
              {item.changes.map((change) => (
                <ChangeCard
                  key={`${change.workspace_id || "legacy"}:${change.id}`}
                  change={change as ChangeRecord}
                  state={state}
                  compact
                />
              ))}
            </div>
          )}
        />
      )}

      {connected && route.kind === "history" && (
        <section className="history-route">
          <button
            className="back-button"
            type="button"
            onClick={() => {
              setRoute({ kind: "tasks" });
              if (historyReturnKey) post("selectWorkspace", undefined, undefined, historyReturnKey);
            }}
          >
            <Icon name="chevronUp" /> Back to workspace tasks
          </button>
          <div className="list-heading">
            <div><h2>Workspace history</h2><p>Read-only archived changes</p></div>
            <span>{state.changes.length}</span>
          </div>
          {!state.loading && state.changes.length === 0 && <EmptyState />}
          {state.changes.length > 0 && (
            <div className="change-list" aria-label="Workspace history">
              {state.changes.map((change) => (
                <ChangeCard
                  key={`${change.workspace_id || "legacy"}:${change.id}`}
                  change={change}
                  state={state}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {state.loading && !state.connection && (
        <div className="loading-state">
          <Spinner />
          <span>Connecting to Local Coding Agent…</span>
        </div>
      )}
    </main>
  );
}

function ContextFilters({
  state,
  showRegistration,
  onWorkspace,
  onTask,
  onConnect,
}: {
  state: ViewState;
  showRegistration: boolean;
  onWorkspace: (value: string | undefined) => void;
  onTask: (value: string | undefined) => void;
  onConnect: () => void;
}): React.JSX.Element {
  const selected = state.workspaceOptions.find(
    (workspace) => workspace.key === state.selectedWorkspaceKey,
  );
  return (
    <>
      <section className="context-filters" aria-label="Review context">
        <label className="context-filter">
          <span>Workspace</span>
          <select
            value={state.selectedWorkspaceKey || ""}
            disabled={Boolean(state.busyAction)}
            onChange={(event) => onWorkspace(event.target.value || undefined)}
          >
            {state.workspaceOptions.length === 0 && (
              <option value="" disabled>No workspace available</option>
            )}
            {state.workspaceOptions.map((workspace) => (
              <option
                key={workspace.key}
                value={workspace.key}
                disabled={!workspace.available}
              >
                {workspace.label}
                {!workspace.registered ? " (not registered)" : ""}
                {!workspace.available ? " (unavailable)" : ""}
                {workspace.registrationState === "archived" ? " (read only)" : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="context-filter">
          <span>Task</span>
          <select
            value={state.selectedTaskId || ""}
            disabled={Boolean(state.busyAction) || state.taskOptions.length === 0}
            onChange={(event) => onTask(event.target.value || undefined)}
          >
            <option value="">All tasks</option>
            {state.taskOptions.map((task) => (
              <option key={task.taskId} value={task.taskId}>
                {task.title}{task.status ? ` (${task.status})` : ""}
              </option>
            ))}
          </select>
        </label>
      </section>
      {showRegistration && selected && !selected.registered && (
        <div className="workspace-registration-banner">
          <span><Icon name="workspace" /> {selected.label} is not registered with LCA.</span>
          <Button
            variant="secondary"
            icon="plug"
            compact
            loading={state.busyAction === "connect"}
            disabled={!state.trusted || Boolean(state.busyAction)}
            onClick={onConnect}
          >
            Connect
          </Button>
        </div>
      )}
    </>
  );
}

function connectionMessage(connection: ConnectionState): string {
  return connection.kind === "connected"
    ? `Connected to ${connection.workspace}`
    : connection.message;
}

function ConnectionCard({
  state,
  onConnect,
  onRefresh,
  onSetToken,
}: {
  state: ViewState;
  onConnect: () => void;
  onRefresh: () => void;
  onSetToken: () => void;
}): React.JSX.Element {
  const connection = state.connection;
  const busy = Boolean(state.busyAction);

  if (!connection) {
    return (
      <Card className="connection-card">
        <CardTitle icon="plug" title="LCA Connection" subtitle="Checking local connection…" />
        <div className="card-loading"><Spinner /> Connecting…</div>
      </Card>
    );
  }

  const mismatch = connection.kind === "workspace_mismatch";
  const offline = connection.kind === "server_offline";
  const unauthorized = connection.kind === "unauthorized";
  const canConnect = mismatch || offline;
  const title = mismatch
    ? "Connected to another workspace"
    : offline
      ? "LCA is not running"
      : unauthorized
        ? "Authentication required"
        : connection.kind === "no_workspace"
          ? "No workspace is open"
          : "Connection blocked";

  return (
    <Card className="connection-card">
      <CardTitle
        icon={unauthorized ? "key" : offline ? "offline" : "plug"}
        title="LCA Connection"
        subtitle={title}
      />

      <div className="field-grid">
        <Field label="Current Workspace" value={state.currentWorkspace || "Not available"} />
        {state.workspaceOptions.length > 1 && (
          <Field
            label="Open Folders"
            value={state.workspaceOptions.map((workspace) => workspace.label).join(", ")}
            wrap
          />
        )}
        {mismatch && <Field label="LCA Workspace" value={connection.workspace} />}
        <Field label="Status" value={connectionMessage(connection)} wrap />
      </div>

      <div className="card-actions connection-actions">
        {canConnect && (
          <Button
            variant="primary"
            icon="plug"
            loading={state.busyAction === "connect"}
            disabled={!state.trusted || busy}
            onClick={onConnect}
          >
            Connect to This Workspace
          </Button>
        )}
        {unauthorized && (
          <Button
            variant="primary"
            icon="key"
            loading={state.busyAction === "setToken"}
            disabled={busy}
            onClick={onSetToken}
          >
            Set Authentication Token
          </Button>
        )}
        <Button variant="secondary" icon="refresh" disabled={busy} onClick={onRefresh}>
          Refresh
        </Button>
      </div>

      {canConnect && (
        <p className="card-note">
          Connecting registers and selects this folder for new tasks while preserving the
          existing supervisor and tunnel when they are already running.
        </p>
      )}
    </Card>
  );
}

function EmptyState(): React.JSX.Element {
  return (
    <Card className="empty-card">
      <div className="empty-icon"><Icon name="changes" /></div>
      <h2>No changes to review</h2>
      <p>Changes made through LCA filesystem tools will appear here automatically.</p>
    </Card>
  );
}

function ChangeCard({
  change,
  state,
  compact = false,
}: {
  change: ChangeRecord;
  state: ViewState;
  compact?: boolean;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(!compact);
  const title = useMemo(() => changeTitle(change), [change]);
  const canUndoChange = ["applied", "reapplied", "partially_undone"].includes(change.status);
  const canReapplyChange = ["undone", "partially_undone"].includes(change.status);
  const disabled = Boolean(state.busyAction);
  const workspace = state.workspaceOptions.find((item) => item.workspaceId === change.workspace_id);
  const mutationAllowed = workspace?.registrationState === "active" && workspace.opened;

  return (
    <Card className={`change-card status-${change.status} ${compact ? "compact-change-card" : ""}`}>
      <div className="change-header">
        <div className="change-heading">
          <div className="change-icon"><Icon name={statusIcon(change.status)} /></div>
          <div className="change-title-wrap">
            <div className="change-title-row">
              <h2>{title}</h2>
              <StatusBadge status={change.status} />
            </div>
            {!compact && (change.workspace_label || change.workspace_id || change.task_id || change.taskStatus) && (
              <div className="context-badges">
                {(change.workspace_label || change.workspace_id) && (
                  <span
                    className="context-badge workspace-badge"
                    title={change.workspace_id || change.workspace_label}
                  >
                    <Icon name="workspace" />
                    {change.workspace_label || shortId(change.workspace_id || "")}
                  </span>
                )}
                {(change.task_id || change.taskStatus) && (
                  <span
                    className="context-badge task-badge"
                    title={change.task_id || change.taskStatus}
                  >
                    <Icon name="task" />
                    {change.task_title ||
                      (change.task_id
                        ? `Task ${shortId(change.task_id)}`
                        : change.taskStatus === "active"
                          ? "Active task"
                          : "Completed task")}
                  </span>
                )}
              </div>
            )}
            <div className="change-summary-line">
              <span>
                {change.operationCount !== undefined
                  ? `${change.operationCount} operation${change.operationCount === 1 ? "" : "s"}`
                  : change.source}
              </span>
              <span>•</span>
              <span>{change.files.length} file{change.files.length === 1 ? "" : "s"}</span>
              <span>•</span>
              <LineStats stats={change.stats} compact className="change-line-stats" />
            </div>
            <div className="change-meta">
              <span>{relativeTime(change.createdAt)}</span>
              {change.taskStatus === "active" && <><span>•</span><span>In progress</span></>}
            </div>
          </div>
        </div>

        <div className="change-actions">
          {canUndoChange && (
            <Button
              variant="ghost"
              icon="undo"
              compact
              disabled={!state.trusted || !mutationAllowed || disabled}
              loading={state.busyAction === `undo:${change.workspace_id || ""}:${change.id}`}
              onClick={() => post(
                "undoChange",
                change.id,
                undefined,
                undefined,
                change.workspace_id,
              )}
            >
              Undo
            </Button>
          )}
          {canReapplyChange && (
            <Button
              variant="ghost"
              icon="redo"
              compact
              disabled={!state.trusted || !mutationAllowed || disabled}
              loading={state.busyAction === `reapply:${change.workspace_id || ""}:${change.id}`}
              onClick={() => post(
                "reapplyChange",
                change.id,
                undefined,
                undefined,
                change.workspace_id,
              )}
            >
              Reapply
            </Button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="file-list">
          {change.files.map((file) => (
            <FileRow key={`${change.id}:${file.path}`} change={change} file={file} state={state} />
          ))}
        </div>
      )}

      <button className="collapse-button" type="button" onClick={() => setExpanded((value) => !value)}>
        <span>{expanded ? "Collapse files" : `Show ${change.files.length} files`}</span>
        <Icon name={expanded ? "chevronUp" : "chevronDown"} />
      </button>
    </Card>
  );
}

function FileRow({
  change,
  file,
  state,
}: {
  change: ChangeRecord;
  file: ChangedFile;
  state: ViewState;
}): React.JSX.Element {
  const disabled = Boolean(state.busyAction);
  const canUndo = file.undoable && file.undoStatus === "applied";
  const canReapply = file.undoable && file.undoStatus === "undone";
  const operation = operationDetails(file.operation);
  const workspace = state.workspaceOptions.find((item) => item.workspaceId === change.workspace_id);
  const mutationAllowed = workspace?.registrationState === "active" && workspace.opened;

  return (
    <div className="file-row">
      <button
        className="file-main"
        type="button"
        disabled={!file.undoable || disabled}
        onClick={() => post(
          "openDiff",
          change.id,
          file.path,
          undefined,
          change.workspace_id,
        )}
        title={file.undoable ? `Review ${file.path}` : "Diff unavailable for this file"}
      >
        <span className={`operation-badge operation-${file.operation}`}>{operation.marker}</span>
        <span className="file-copy">
          <span className="file-name">{file.path}</span>
          <span className="file-subtitle">
            {operation.label}
            {file.group ? " • Atomic rename" : ""}
          </span>
        </span>
        <LineStats stats={file.stats} compact className="file-line-stats" />
      </button>

      <div className="file-actions">
        <IconButton
          title="Open current file"
          icon="open"
          disabled={disabled || !workspace?.opened || file.operation === "deleted"}
          onClick={() => post(
            "openCurrentFile",
            change.id,
            file.path,
            undefined,
            change.workspace_id,
          )}
        />
        <IconButton
          title="Review diff"
          icon="review"
          disabled={disabled || !file.undoable}
          onClick={() => post(
            "openDiff",
            change.id,
            file.path,
            undefined,
            change.workspace_id,
          )}
        />
        {canUndo && (
          <Button
            variant="ghost"
            icon="undo"
            compact
            disabled={!state.trusted || !mutationAllowed || disabled}
            loading={
              state.busyAction ===
              `undo:${change.workspace_id || ""}:${change.id}:${file.path}`
            }
            onClick={() => post(
              "undoFile",
              change.id,
              file.path,
              undefined,
              change.workspace_id,
            )}
          >
            Undo
          </Button>
        )}
        {canReapply && (
          <Button
            variant="ghost"
            icon="redo"
            compact
            disabled={!state.trusted || !mutationAllowed || disabled}
            loading={
              state.busyAction ===
              `reapply:${change.workspace_id || ""}:${change.id}:${file.path}`
            }
            onClick={() => post(
              "reapplyFile",
              change.id,
              file.path,
              undefined,
              change.workspace_id,
            )}
          >
            Reapply
          </Button>
        )}
      </div>
    </div>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return <section className={`card ${className}`}>{children}</section>;
}

function CardTitle({ icon, title, subtitle }: { icon: IconName; title: string; subtitle: string }): React.JSX.Element {
  return (
    <div className="card-title">
      <div className="card-title-icon"><Icon name={icon} /></div>
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
    </div>
  );
}

function Field({ label, value, wrap = false }: { label: string; value: string; wrap?: boolean }): React.JSX.Element {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <div className={`field-value ${wrap ? "wrap" : ""}`} title={value}>{value}</div>
    </div>
  );
}

function Button({
  children,
  variant,
  icon,
  compact = false,
  loading = false,
  disabled = false,
  onClick,
}: {
  children: React.ReactNode;
  variant: "primary" | "secondary" | "ghost";
  icon?: IconName;
  compact?: boolean;
  loading?: boolean;
  disabled?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      className={`button button-${variant} ${compact ? "button-compact" : ""}`}
      type="button"
      disabled={disabled || loading}
      onClick={onClick}
    >
      {loading ? <Spinner small /> : icon ? <Icon name={icon} /> : null}
      <span>{children}</span>
    </button>
  );
}

function IconButton({
  title,
  icon,
  disabled = false,
  spinning = false,
  onClick,
}: {
  title: string;
  icon: IconName;
  disabled?: boolean;
  spinning?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button className="icon-button" type="button" title={title} disabled={disabled} onClick={onClick}>
      <span className={spinning ? "spin" : ""}><Icon name={icon} /></span>
    </button>
  );
}

function StatusBadge({ status }: { status: ChangeStatus }): React.JSX.Element {
  const labels: Record<ChangeStatus, string> = {
    applied: "Applied",
    partially_undone: "Partial",
    undone: "Undone",
    reapplied: "Reapplied",
    conflict: "Conflict",
    failed: "Failed",
  };
  return <span className={`status-badge status-badge-${status}`}>{labels[status]}</span>;
}

function Spinner({ small = false }: { small?: boolean }): React.JSX.Element {
  return <span className={`spinner ${small ? "spinner-small" : ""}`} aria-label="Loading" />;
}

type IconName =
  | "changes"
  | "plug"
  | "offline"
  | "key"
  | "lock"
  | "refresh"
  | "clear"
  | "undo"
  | "redo"
  | "review"
  | "open"
  | "history"
  | "warning"
  | "check"
  | "workspace"
  | "task"
  | "chevronUp"
  | "chevronDown";

function Icon({ name }: { name: IconName }): React.JSX.Element {
  const paths: Record<IconName, React.ReactNode> = {
    changes: <><path d="M4 4h12v12H4z"/><path d="M7 8h6M7 11h4"/></>,
    plug: <><path d="M8 3v4M12 3v4M6 7h8v2a4 4 0 0 1-4 4v4M7 17h6"/></>,
    offline: <><path d="M5 5a7 7 0 0 1 10 10M3 10a7 7 0 0 0 7 7M3 3l14 14"/></>,
    key: <><circle cx="7" cy="10" r="3"/><path d="M10 10h7M14 10v3M17 10v2"/></>,
    lock: <><rect x="5" y="9" width="10" height="8" rx="2"/><path d="M7 9V7a3 3 0 0 1 6 0v2"/></>,
    refresh: <><path d="M15 6V3l3 3-3 3V6a6 6 0 1 0 1 7"/></>,
    clear: <><path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11M9 9v5M11 9v5"/></>,
    undo: <><path d="M7 7H3l3-3M3 7h8a5 5 0 0 1 0 10H8"/></>,
    redo: <><path d="M13 7h4l-3-3M17 7H9a5 5 0 0 0 0 10h3"/></>,
    review: <><path d="M3 10s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5Z"/><circle cx="10" cy="10" r="2"/></>,
    open: <><path d="M11 4h5v5M16 4l-7 7"/><path d="M14 11v5H4V6h5"/></>,
    history: <><path d="M4 5v4h4"/><path d="M5 8a6 6 0 1 1 1 6M10 6v4l3 2"/></>,
    warning: <><path d="M10 3 2 17h16L10 3Z"/><path d="M10 8v4M10 15h.01"/></>,
    check: <path d="m4 10 4 4 8-8"/>,
    workspace: <><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M3 8h14M7 4v4"/></>,
    task: <><path d="M6 4h8v13H6z"/><path d="M8 3h4v3H8zM8 10l1.5 1.5L12 9M8 14h4"/></>,
    chevronUp: <path d="m5 12 5-5 5 5"/>,
    chevronDown: <path d="m5 8 5 5 5-5"/>,
  };
  return <svg className="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

let latestViewRevision = 0;
let messageSequence = 0;
const recentMessages = new Map<string, number>();

function post(
  type: string,
  changeId?: string,
  path?: string,
  value?: string,
  workspaceId?: string,
): void {
  const key = [type, workspaceId || "", changeId || "", path || "", value || ""].join(":");
  const now = Date.now();
  const previous = recentMessages.get(key) || 0;
  if (now - previous < 500) return;
  recentMessages.set(key, now);
  if (recentMessages.size > 100) {
    for (const [messageKey, createdAt] of recentMessages) {
      if (now - createdAt > 2000) recentMessages.delete(messageKey);
    }
  }
  vscode.postMessage({
    type,
    changeId,
    path,
    value,
    workspaceId,
    revision: latestViewRevision,
    requestId: `${now}-${++messageSequence}`,
  });
}

function changeTitle(change: ChangeRecord): string {
  const explicitTitle = change.title?.trim();
  if (explicitTitle && explicitTitle !== "LCA task") return explicitTitle;
  if (change.renameGroups.length === 1) {
    const rename = change.renameGroups[0];
    return `Renamed ${rename.from} → ${rename.to}`;
  }
  if (change.files.length === 1) {
    const file = change.files[0];
    const verb: Record<ChangeOperation, string> = {
      created: "Created",
      modified: "Edited",
      deleted: "Deleted",
      renamed: "Renamed",
      metadata_only: "Changed",
    };
    return `${verb[file.operation]} ${file.path}`;
  }
  const taskTitle = change.task_title?.trim();
  if (taskTitle && taskTitle !== "LCA task") return taskTitle;
  return `Edited ${change.files.length} files`;
}

function relativeTime(value: string): string {
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function shortId(value: string): string {
  return value.length > 10 ? value.slice(0, 8) : value;
}

function statusIcon(status: ChangeStatus): IconName {
  if (status === "conflict" || status === "failed") return "warning";
  if (status === "undone") return "undo";
  if (status === "reapplied") return "redo";
  if (status === "applied") return "check";
  return "history";
}

function operationDetails(operation: ChangeOperation): { marker: string; label: string } {
  const values: Record<ChangeOperation, { marker: string; label: string }> = {
    created: { marker: "A", label: "Added" },
    modified: { marker: "M", label: "Modified" },
    deleted: { marker: "D", label: "Deleted" },
    renamed: { marker: "R", label: "Renamed" },
    metadata_only: { marker: "•", label: "Metadata only" },
  };
  return values[operation];
}

const root = document.getElementById("root");
if (!root) throw new Error("Review Changes root element was not found.");
createRoot(root).render(<App />);
