import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
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
  source: string;
  status: ChangeStatus;
  createdAt: string;
  files: ChangedFile[];
  stats: LineChangeStats;
  renameGroups: RenameGroup[];
  undoable: boolean;
}

type ConnectionState =
  | { kind: "connected"; workspace: string; version: string }
  | { kind: "server_offline"; message: string }
  | { kind: "workspace_mismatch"; message: string; workspace: string }
  | { kind: "unauthorized"; message: string }
  | { kind: "no_workspace"; message: string }
  | { kind: "remote_blocked"; message: string };

interface ViewState {
  loading: boolean;
  busyAction?: string;
  trusted: boolean;
  currentWorkspace?: string;
  connection?: ConnectionState;
  changes: ChangeRecord[];
}

interface HostMessage {
  type: "state";
  state: ViewState;
}

const initialState: ViewState = {
  loading: true,
  trusted: true,
  changes: [],
};

function App(): React.JSX.Element {
  const [state, setState] = useState<ViewState>(initialState);

  useEffect(() => {
    const listener = (event: MessageEvent<HostMessage>) => {
      if (event.data?.type === "state") setState(event.data.state);
    };
    window.addEventListener("message", listener);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", listener);
  }, []);

  const connected = state.connection?.kind === "connected";
  const latestChange = state.changes[0];
  const hasChanges = connected && Boolean(latestChange);

  return (
    <main className="app-shell">
      <Header
        state={state}
        hasChanges={hasChanges}
        onRefresh={() => post("refresh")}
        onUndoAll={() => post("undoAll")}
        onClear={() => post("clear")}
      />

      {!state.trusted && (
        <div className="trust-banner">
          <Icon name="lock" />
          <span>Trust this workspace to undo or reapply file changes.</span>
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

      {connected && !state.loading && state.changes.length === 0 && <EmptyState />}

      {connected && latestChange && (
        <section className="change-list" aria-label="Latest review change">
          <ChangeCard key={latestChange.id} change={latestChange} state={state} />
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

function Header({
  state,
  hasChanges,
  onRefresh,
  onUndoAll,
  onClear,
}: {
  state: ViewState;
  hasChanges: boolean;
  onRefresh: () => void;
  onUndoAll: () => void;
  onClear: () => void;
}): React.JSX.Element {
  const connection = state.connection;
  const connected = connection?.kind === "connected";
  return (
    <header className="page-header">
      <div>
        <div className="eyebrow">LOCAL CODING AGENT</div>
        <h1>Review Changes</h1>
        <div className="connection-line">
          <span className={`status-dot ${connected ? "connected" : "disconnected"}`} />
          <span>{connected ? "Connected" : "Not connected"}</span>
          {connected && <span className="muted">v{connection.version}</span>}
        </div>
      </div>
      <div className="header-actions">
        {hasChanges && (
          <>
            <IconButton
              title="Undo all changes"
              icon="undo"
              disabled={!state.trusted || Boolean(state.busyAction)}
              onClick={onUndoAll}
            />
            <IconButton
              title="Clear history"
              icon="clear"
              disabled={!state.trusted || Boolean(state.busyAction)}
              onClick={onClear}
            />
          </>
        )}
        <IconButton
          title="Refresh"
          icon="refresh"
          spinning={state.loading}
          disabled={Boolean(state.busyAction)}
          onClick={onRefresh}
        />
      </div>
    </header>
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
        {mismatch && <Field label="LCA Workspace" value={connection.workspace} />}
        <Field label="Status" value={connectionMessage(connection)} wrap />
      </div>

      <div className="card-actions connection-actions">
        {canConnect && (
          <Button
            variant="primary"
            icon="plug"
            loading={state.busyAction === "connect"}
            disabled={busy}
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
          Connecting stops the current LCA process and starts it for this VS Code workspace.
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

function ChangeCard({ change, state }: { change: ChangeRecord; state: ViewState }): React.JSX.Element {
  const [expanded, setExpanded] = useState(true);
  const title = useMemo(() => changeTitle(change), [change]);
  const canUndoChange = ["applied", "reapplied", "partially_undone"].includes(change.status);
  const canReapplyChange = ["undone", "partially_undone"].includes(change.status);
  const firstReviewable = change.files.find((file) => file.undoable);
  const disabled = Boolean(state.busyAction);

  return (
    <Card className={`change-card status-${change.status}`}>
      <div className="change-header">
        <div className="change-heading">
          <div className="change-icon"><Icon name={statusIcon(change.status)} /></div>
          <div className="change-title-wrap">
            <div className="change-title-row">
              <h2>{title}</h2>
              <StatusBadge status={change.status} />
            </div>
            <LineStats stats={change.stats} className="change-line-stats" />
            <div className="change-meta">
              <span>{relativeTime(change.createdAt)}</span>
              <span>•</span>
              <span>{change.source}</span>
            </div>
          </div>
        </div>

        <div className="change-actions">
          {canUndoChange && (
            <Button
              variant="ghost"
              icon="undo"
              compact
              disabled={!state.trusted || disabled}
              loading={state.busyAction === `undo:${change.id}`}
              onClick={() => post("undoChange", change.id)}
            >
              Undo
            </Button>
          )}
          {canReapplyChange && (
            <Button
              variant="ghost"
              icon="redo"
              compact
              disabled={!state.trusted || disabled}
              loading={state.busyAction === `reapply:${change.id}`}
              onClick={() => post("reapplyChange", change.id)}
            >
              Reapply
            </Button>
          )}
          {firstReviewable && (
            <Button
              variant="secondary"
              icon="review"
              compact
              disabled={disabled}
              onClick={() => post("openDiff", change.id, firstReviewable.path)}
            >
              Review
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

  return (
    <div className="file-row">
      <button
        className="file-main"
        type="button"
        disabled={!file.undoable || disabled}
        onClick={() => post("openDiff", change.id, file.path)}
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
          disabled={disabled || file.operation === "deleted"}
          onClick={() => post("openCurrentFile", change.id, file.path)}
        />
        <IconButton
          title="Review diff"
          icon="review"
          disabled={disabled || !file.undoable}
          onClick={() => post("openDiff", change.id, file.path)}
        />
        {canUndo && (
          <Button
            variant="ghost"
            icon="undo"
            compact
            disabled={!state.trusted || disabled}
            loading={state.busyAction === `undo:${change.id}:${file.path}`}
            onClick={() => post("undoFile", change.id, file.path)}
          >
            Undo
          </Button>
        )}
        {canReapply && (
          <Button
            variant="ghost"
            icon="redo"
            compact
            disabled={!state.trusted || disabled}
            loading={state.busyAction === `reapply:${change.id}:${file.path}`}
            onClick={() => post("reapplyFile", change.id, file.path)}
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
    chevronUp: <path d="m5 12 5-5 5 5"/>,
    chevronDown: <path d="m5 8 5 5 5-5"/>,
  };
  return <svg className="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function post(type: string, changeId?: string, path?: string): void {
  vscode.postMessage({ type, changeId, path });
}

function changeTitle(change: ChangeRecord): string {
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
