import React, { useEffect, useMemo, useRef, useState } from "react";

export type WorkspaceRoute =
  | { kind: "tasks" }
  | { kind: "history" };

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

export interface WorkspaceOptionView {
  key: string;
  label: string;
  root: string;
  workspaceId?: string;
  available: boolean;
  registered: boolean;
  trusted: boolean;
  opened: boolean;
  registrationState: "active" | "archived";
}

export interface ChangeSummaryView {
  id: string;
  workspace_id?: string;
  task_id?: string;
  files: unknown[];
  status?: string;
  createdAt?: string;
  stats?: { additions: number; deletions: number };
}

export interface WorkspaceShellProps {
  control: ControlStateView;
  currentWorkspace?: WorkspaceOptionView;
  syncMode: "idle" | "sse" | "polling";
  trusted: boolean;
  busyAction?: string;
  onRefresh: () => void;
  onConnect: () => void;
  onRuntimeAction: (type: string, value?: string) => void;
  onWorkspaceAction: (type: string, workspaceId?: string) => void;
  onSelectWorkspace: (key: string) => void;
  onViewHistory: (workspaceId: string) => void;
}

export function WorkspaceHeader({
  control,
  currentWorkspace,
  syncMode,
  trusted,
  busyAction,
  onRefresh,
  onConnect,
  onRuntimeAction,
  onWorkspaceAction,
  onSelectWorkspace,
  onViewHistory,
}: WorkspaceShellProps): React.JSX.Element {
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);

  useDismiss(workspacesOpen, () => setWorkspacesOpen(false), workspaceRef);

  const registered = currentWorkspace?.registered;
  const title = currentWorkspace?.label || "No workspace";
  const connectionLabel = control.serverOnline ? "Connected" : "Offline";
  const runtimeError = control.storageError || control.error;
  const runtimeTitle = runtimeError || [
    connectionLabel,
    control.version ? `v${control.version}` : null,
    `Sessions ${control.sessions.active}/${control.sessions.max}`,
    syncMode === "sse" ? "Live" : syncMode === "polling" ? "Polling" : null,
  ].filter(Boolean).join(" · ");

  return (
    <header className="workspace-header">
      <div className="workspace-heading">
        <div className="eyebrow">LOCAL CODING AGENT</div>
        <div className="workspace-title-row">
          <h1 title={currentWorkspace?.root}>{title}</h1>
          {currentWorkspace && !registered && <span className="header-warning">Not connected</span>}
        </div>
        <div className="header-status-row">
          <div className="status-chip status-summary" role="status" title={runtimeTitle}>
            <span className={`status-dot ${control.serverOnline ? "connected" : "disconnected"}`} />
            <span>{connectionLabel}</span>
            {control.version && <span className="muted">v{control.version}</span>}
            <span className="muted">Sessions {control.sessions.active}/{control.sessions.max}</span>
            {syncMode !== "idle" && (
              <span className={syncMode === "sse" ? "sync-sse" : "muted"}>
                {syncMode === "sse" ? "Live" : "Polling"}
              </span>
            )}
            {runtimeError && <Icon name="warning" />}
          </div>

          <div className="popover-anchor" ref={workspaceRef}>
            <button
              className="workspace-chip"
              type="button"
              aria-expanded={workspacesOpen}
              onClick={() => setWorkspacesOpen((value) => !value)}
              title="Manage LCA workspaces"
            >
              <Icon name="workspace" />
              <span>{currentWorkspace?.label || "Workspaces"}</span>
              {control.workspaces.find((workspace) => workspace.id === currentWorkspace?.workspaceId)?.isDefault && (
                <Icon name="starFilled" />
              )}
              <Icon name="chevronDown" />
            </button>
            {workspacesOpen && (
              <WorkspacePopover
                control={control}
                currentWorkspace={currentWorkspace}
                trusted={trusted}
                busyAction={busyAction}
                onConnect={onConnect}
                onSelect={(key) => {
                  setWorkspacesOpen(false);
                  onSelectWorkspace(key);
                }}
                onAction={onWorkspaceAction}
                onViewHistory={(workspaceId) => {
                  setWorkspacesOpen(false);
                  onViewHistory(workspaceId);
                }}
              />
            )}
          </div>
        </div>
      </div>

      <div className="header-actions" aria-label="Runtime controls">
        <IconButton
          title={control.serverOnline ? "Stop LCA" : "Start LCA"}
          icon={control.serverOnline ? "stop" : "play"}
          danger={control.serverOnline}
          disabled={!trusted || Boolean(busyAction)}
          onClick={() => onRuntimeAction(control.serverOnline ? "stopLca" : "startLca")}
        />
        <IconButton
          title="Refresh"
          icon="refresh"
          spinning={control.loading}
          disabled={Boolean(busyAction)}
          onClick={onRefresh}
        />
      </div>
    </header>
  );
}

function WorkspacePopover({
  control,
  currentWorkspace,
  trusted,
  busyAction,
  onConnect,
  onSelect,
  onAction,
  onViewHistory,
}: {
  control: ControlStateView;
  currentWorkspace?: WorkspaceOptionView;
  trusted: boolean;
  busyAction?: string;
  onConnect: () => void;
  onSelect: (key: string) => void;
  onAction: (type: string, workspaceId?: string) => void;
  onViewHistory: (workspaceId: string) => void;
}): React.JSX.Element {
  const currentId = currentWorkspace?.workspaceId;
  const active = control.workspaces.filter((workspace) => workspace.registrationState === "active");
  const archived = control.workspaces.filter((workspace) => workspace.registrationState === "archived");
  const currentRows = active.filter((workspace) => workspace.id === currentId || workspace.opened);
  const otherRows = active.filter((workspace) => !currentRows.includes(workspace));

  return (
    <section className="header-popover workspace-popover" aria-label="Workspace manager">
      <div className="popover-heading-row">
        <div>
          <div className="popover-title">Workspaces</div>
          <div className="popover-subtitle">{control.workspaces.length} registered</div>
        </div>
        {currentWorkspace && !currentWorkspace.registered && (
          <button
            className="compact-action primary"
            type="button"
            disabled={!trusted || Boolean(busyAction)}
            onClick={onConnect}
          >
            <Icon name="plug" /> Connect
          </button>
        )}
      </div>
      <WorkspaceGroup
        title="Current window"
        rows={currentRows}
        currentId={currentId}
        trusted={trusted}
        busyAction={busyAction}
        onSelect={onSelect}
        onAction={onAction}
        onViewHistory={onViewHistory}
      />
      <WorkspaceGroup
        title="Other active"
        rows={otherRows}
        currentId={currentId}
        trusted={trusted}
        busyAction={busyAction}
        onSelect={onSelect}
        onAction={onAction}
        onViewHistory={onViewHistory}
      />
      <WorkspaceGroup
        title="Archived"
        rows={archived}
        currentId={currentId}
        trusted={trusted}
        busyAction={busyAction}
        onSelect={onSelect}
        onAction={onAction}
        onViewHistory={onViewHistory}
      />
    </section>
  );
}

function WorkspaceGroup({
  title,
  rows,
  currentId,
  trusted,
  busyAction,
  onSelect,
  onAction,
  onViewHistory,
}: {
  title: string;
  rows: ControlWorkspaceView[];
  currentId?: string;
  trusted: boolean;
  busyAction?: string;
  onSelect: (key: string) => void;
  onAction: (type: string, workspaceId?: string) => void;
  onViewHistory: (workspaceId: string) => void;
}): React.JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <div className="workspace-group">
      <div className="workspace-group-title">{title}</div>
      {rows.map((workspace) => {
        const archived = workspace.registrationState === "archived";
        const protectedWorkspace = workspace.isDefault || workspace.isConfiguredStartup;
        const selectable = !archived && workspace.availability === "available";
        return (
          <article
            className={`workspace-row ${workspace.isDefault ? "is-default" : ""} ${workspace.id === currentId ? "is-current" : ""}`}
            key={workspace.id}
          >
            <button
              type="button"
              className="workspace-row-main"
              disabled={!selectable}
              onClick={() => onSelect(`workspace:${workspace.id}`)}
              title={workspace.root}
            >
              <span className="workspace-row-icon"><Icon name={workspace.isDefault ? "starFilled" : "workspace"} /></span>
              <span className="workspace-row-copy">
                <strong>{workspace.label}</strong>
                <span>{workspace.root}</span>
              </span>
              <span className="workspace-row-badges">
                {workspace.isDefault && <Badge value="Default" tone="accent" />}
                {workspace.id === currentId && <Badge value="Current" />}
                {archived && <Badge value="Archived" />}
                {workspace.availability === "unavailable" && <Badge value="Unavailable" tone="fail" />}
              </span>
            </button>
            <div className="workspace-row-actions">
              {!archived && !workspace.isDefault && (
                <IconButton
                  title="Make default"
                  icon="star"
                  disabled={!trusted || Boolean(busyAction) || workspace.availability !== "available"}
                  onClick={() => onAction("makeDefaultWorkspace", workspace.id)}
                />
              )}
              <IconButton title="View history" icon="history" onClick={() => onViewHistory(workspace.id)} />
              {!archived && (
                <IconButton
                  title="Archive workspace"
                  icon="archive"
                  disabled={!trusted || protectedWorkspace || Boolean(busyAction)}
                  onClick={() => onAction("archiveWorkspace", workspace.id)}
                />
              )}
              {archived && (
                <IconButton
                  title="Restore workspace"
                  icon="restore"
                  disabled={!trusted || Boolean(busyAction)}
                  onClick={() => onAction("restoreWorkspace", workspace.id)}
                />
              )}
              <IconButton
                title="Remove workspace data permanently"
                icon="trash"
                danger
                disabled={!trusted || protectedWorkspace || Boolean(busyAction)}
                onClick={() => onAction("removeWorkspace", workspace.id)}
              />
            </div>
          </article>
        );
      })}
    </div>
  );
}

export interface TaskPresentation {
  task: ControlTaskView;
  activities: ToolActivityView[];
  changes: ChangeSummaryView[];
  processCount: number;
  runningProcessCount: number;
  changeCount: number;
  fileCount: number;
  latestAt: string | null;
  verification: "PASS" | "INCOMPLETE" | "FAIL" | null;
}

export function buildWorkspaceTasks(
  control: ControlStateView,
  changes: ChangeSummaryView[],
  workspaceId?: string,
): TaskPresentation[] {
  if (!workspaceId) return [];
  return control.tasks
    .filter((task) => task.workspaceIds.includes(workspaceId))
    .map((task) => {
      const activities = control.audit.activities
        .filter(
          (activity) => activity.taskId === task.id && (
            activity.workspaceIds.length === 0 || activity.workspaceIds.includes(workspaceId)
          ),
        )
        .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
      const taskChanges = changes.filter(
        (change) => change.task_id === task.id && (!change.workspace_id || change.workspace_id === workspaceId),
      );
      const processes = control.processes.filter(
        (process) => process.task_id === task.id && (!process.workspace_id || process.workspace_id === workspaceId),
      );
      const observedChangeCount = activities.reduce((count, activity) => count + (activity.changeCount || 0), 0);
      const observedFileCount = activities.reduce((count, activity) => count + (activity.fileCount || 0), 0);
      const visibleFileCount = taskChanges.reduce((count, change) => count + change.files.length, 0);
      const latestActivity = [...activities].sort((left, right) => activityTimestamp(right) - activityTimestamp(left))[0];
      const verification = [...activities]
        .sort((left, right) => activityTimestamp(right) - activityTimestamp(left))
        .find((activity) => activity.verification)?.verification || null;
      return {
        task,
        activities,
        changes: taskChanges,
        processCount: processes.length,
        runningProcessCount: processes.filter((process) => process.status === "running").length,
        changeCount: Math.max(taskChanges.length, observedChangeCount),
        fileCount: Math.max(visibleFileCount, observedFileCount),
        latestAt: latestActivity?.finishedAt || latestActivity?.startedAt || task.updatedAt,
        verification,
      };
    })
    .sort(compareTaskFeedItems);
}

export function ChronologicalTaskFeed({
  tasks,
  unassigned,
  workspaceLabel,
  workspaceKey,
  renderChanges,
}: {
  tasks: TaskPresentation[];
  unassigned?: TaskPresentation;
  workspaceLabel: string;
  workspaceKey?: string;
  renderChanges: (item: TaskPresentation) => React.ReactNode;
}): React.JSX.Element {
  const [, setClock] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [followingLatest, setFollowingLatest] = useState(true);
  const items = useMemo(
    () => [...tasks, ...(unassigned ? [unassigned] : [])]
      .sort((left, right) => taskFeedTimestamp(left) - taskFeedTimestamp(right)),
    [tasks, unassigned],
  );
  const latestTaskId = [...tasks]
    .reverse()
    .find((item) => isOpenTask(item.task.status))?.task.id || tasks[tasks.length - 1]?.task.id || null;
  const running = items.some((item) => item.activities.some((activity) => activity.status === "started"));
  const contentRevision = items.map((item) => {
    const latestActivity = item.activities[item.activities.length - 1];
    return [
      item.task.id,
      item.activities.length,
      latestActivity?.invocationId || "",
      latestActivity?.status || "",
      item.changes.length,
    ].join(":");
  }).join("|");

  useLiveClock(running, setClock);

  const scrollToLatest = (behavior: ScrollBehavior = "auto") => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
  };

  useEffect(() => {
    setFollowingLatest(true);
    const frame = window.requestAnimationFrame(() => scrollToLatest());
    return () => window.cancelAnimationFrame(frame);
  }, [workspaceKey]);

  useEffect(() => {
    if (!followingLatest) return;
    const frame = window.requestAnimationFrame(() => scrollToLatest());
    return () => window.cancelAnimationFrame(frame);
  }, [contentRevision, followingLatest]);

  const handleScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    setFollowingLatest(isScrollNearBottom(node));
  };

  return (
    <section className="task-feed" aria-label={`Tasks for ${workspaceLabel}`}>
      <div className="list-heading">
        <div>
          <h2>Activity</h2>
          <p>{workspaceLabel}</p>
        </div>
        <span>{items.length}</span>
      </div>
      <div className="task-feed-frame">
        <div className="task-feed-scroll" ref={scrollRef} onScroll={handleScroll}>
          {items.length > 0 ? (
            <div className="task-thread">
              {items.map((item) => (
                <TaskBlock
                  key={item.task.id}
                  item={item}
                  latest={item.task.id === latestTaskId}
                  renderChanges={renderChanges}
                  onLayoutChange={() => {
                    if (!followingLatest) return;
                    window.requestAnimationFrame(() => scrollToLatest());
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="task-empty">
              <Icon name="task" />
              <h3>No tasks for this workspace</h3>
              <p>New LCA tasks and their activity will appear here from oldest to newest.</p>
            </div>
          )}
        </div>
        {!followingLatest && items.length > 0 && (
          <button
            className="jump-to-latest"
            type="button"
            onClick={() => {
              setFollowingLatest(true);
              scrollToLatest("smooth");
            }}
          >
            Latest <Icon name="chevronDown" />
          </button>
        )}
      </div>
    </section>
  );
}

function TaskBlock({
  item,
  latest,
  renderChanges,
  onLayoutChange,
}: {
  item: TaskPresentation;
  latest: boolean;
  renderChanges: (item: TaskPresentation) => React.ReactNode;
  onLayoutChange: () => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [followingActivity, setFollowingActivity] = useState(true);
  const activityRef = useRef<HTMLDivElement>(null);
  const running = item.activities.some((activity) => activity.status === "started");
  const latestActivity = item.activities[item.activities.length - 1];
  const changeCount = item.changes.length;

  useEffect(() => {
    const node = activityRef.current;
    if (!node || !followingActivity) return;
    node.scrollTop = node.scrollHeight;
  }, [item.activities.length, latestActivity?.invocationId, latestActivity?.status, followingActivity]);

  return (
    <article className={`task-card ${latest ? "is-latest" : ""} ${running ? "is-running" : ""} ${expanded ? "is-expanded" : ""}`}>
      <div className="task-card-header">
        <span className={`task-state-icon state-${taskTone(item.task.status, running)}`}>
          <Icon name={running ? "spinner" : isOpenTask(item.task.status) ? "task" : "check"} />
        </span>
        <div className="task-card-copy">
          <div className="task-card-title-row">
            <strong>{item.task.title}</strong>
            <Badge value={item.task.status} />
            {latest && <Badge value="Latest" tone="accent" />}
            {item.verification && <Badge value={item.verification} tone={item.verification.toLowerCase()} />}
          </div>
          <div className="task-card-meta">
            {item.task.createdAt && <span>Started {relativeTime(item.task.createdAt)}</span>}
            {item.runningProcessCount > 0 && <span>{item.runningProcessCount} running process{item.runningProcessCount === 1 ? "" : "es"}</span>}
            {item.task.workspaceIds.length > 1 && <span>Multi-workspace</span>}
          </div>
        </div>
      </div>

      <div
        className="task-activity-scroll"
        ref={activityRef}
        onScroll={() => {
          const node = activityRef.current;
          if (node) setFollowingActivity(isScrollNearBottom(node, 24));
        }}
      >
        {item.activities.length > 0 ? (
          <ol className="tool-timeline task-tool-timeline">
            {item.activities.map((activity) => (
              <li className={`timeline-item timeline-${activity.status}`} key={activity.invocationId}>
                <span className="timeline-marker">
                  <Icon name={activity.status === "started" ? "spinner" : activity.status === "finished" ? "check" : "warning"} />
                </span>
                <div className="timeline-copy">
                  <strong>{activityLabel(activity.tool)}</strong>
                  <span title={activity.tool}>{activity.tool}</span>
                  <span>
                    {activity.status === "started"
                      ? `Running ${formatDuration(liveDuration(activity))} · started ${relativeTime(activity.startedAt)}`
                      : `${formatDuration(activity.durationMs || 0)} · completed ${relativeTime(activity.finishedAt || activity.startedAt)}`}
                    {activity.verification ? ` · ${activity.verification}` : ""}
                    {activity.errorCode ? ` · ${activity.errorCode}` : ""}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="task-waiting">Waiting for task activity…</p>
        )}
      </div>

      {changeCount > 0 && (
        <div className="task-changes">
          <button
            className="changes-toggle"
            type="button"
            aria-expanded={expanded}
            onClick={() => {
              setExpanded((value) => !value);
              window.requestAnimationFrame(onLayoutChange);
            }}
          >
            <span>Changes {changeCount}</span>
            <Icon name="chevronDown" />
          </button>
          {expanded && (
            <div className="inline-changes-panel">
              <div className="inline-changes-scroll">{renderChanges(item)}</div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export function activityLabel(tool: string): string {
  const labels: Record<string, string> = {
    lca_status: "Check LCA status",
    workspace_list: "List workspaces",
    workspace_select: "Select workspace",
    task_open: "Open task",
    task_plan: "Plan the work",
    task_state: "Update task progress",
    task_checkpoint: "Save task checkpoint",
    task_close: "Close task",
    workspace_snapshot: "Inspect workspace",
    project_profile: "Inspect project setup",
    code_query: "Inspect code structure",
    search_text: "Search relevant code",
    find_files: "Locate files",
    list_files: "Browse workspace files",
    read_file: "Read a file",
    read_many: "Read relevant files",
    apply_patch: "Apply changes",
    change_history: "Inspect change history",
    review_diff: "Review changes",
    run_changed_tests: "Run affected tests",
    verify_changes: "Verify changes",
    security_scan: "Scan for security issues",
    todo_scan: "Scan TODO items",
    git: "Run Git operation",
    run_command: "Run command",
    run_commands: "Run commands",
    process: "Manage background process",
  };
  return labels[tool] || humanizeTool(tool);
}

export function makeUnassignedPresentation(
  control: ControlStateView,
  changes: ChangeSummaryView[],
  workspaceId?: string,
): TaskPresentation | undefined {
  if (!workspaceId) return undefined;
  const activities = control.audit.activities
    .filter((activity) => !activity.taskId && activity.workspaceIds.includes(workspaceId))
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  const unassignedChanges = changes.filter(
    (change) => !change.task_id && (!change.workspace_id || change.workspace_id === workspaceId),
  );
  if (activities.length === 0 && unassignedChanges.length === 0) return undefined;
  const now = new Date().toISOString();
  return {
    task: {
      id: "__unassigned__",
      title: "Unassigned activity",
      status: activities.some((activity) => activity.status === "started") ? "open" : "observed",
      primaryWorkspaceId: workspaceId,
      workspaceIds: [workspaceId],
      createdAt: null,
      updatedAt: now,
      closedAt: null,
    },
    activities,
    changes: unassignedChanges,
    processCount: 0,
    runningProcessCount: 0,
    changeCount: unassignedChanges.length,
    fileCount: unassignedChanges.reduce((count, change) => count + change.files.length, 0),
    latestAt: [...activities].sort((left, right) => activityTimestamp(right) - activityTimestamp(left))[0]?.finishedAt || now,
    verification: null,
  };
}

export function Badge({ value, tone = "" }: { value: string; tone?: string }): React.JSX.Element {
  return <span className={`control-badge ${tone}`}>{value}</span>;
}

export type IconName =
  | "archive"
  | "arrowLeft"
  | "check"
  | "chevronDown"
  | "chevronRight"
  | "history"
  | "play"
  | "plug"
  | "refresh"
  | "restore"
  | "spinner"
  | "star"
  | "starFilled"
  | "stop"
  | "task"
  | "trash"
  | "warning"
  | "workspace";

export function IconButton({
  title,
  icon,
  disabled = false,
  spinning = false,
  danger = false,
  onClick,
}: {
  title: string;
  icon: IconName;
  disabled?: boolean;
  spinning?: boolean;
  danger?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      className={`icon-button ${danger ? "danger" : ""}`}
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      <span className={spinning ? "spin" : ""}><Icon name={icon} /></span>
    </button>
  );
}

export function Icon({ name }: { name: IconName }): React.JSX.Element {
  const paths: Record<IconName, React.ReactNode> = {
    archive: <><path d="M4 6h12v10H4z"/><path d="M3 4h14v3H3zM8 10h4"/></>,
    arrowLeft: <><path d="m9 4-6 6 6 6"/><path d="M3 10h14"/></>,
    check: <path d="m4 10 4 4 8-8"/>,
    chevronDown: <path d="m5 8 5 5 5-5"/>,
    chevronRight: <path d="m8 5 5 5-5 5"/>,
    history: <><path d="M4 5v4h4"/><path d="M5 8a6 6 0 1 1 1 6M10 6v4l3 2"/></>,
    play: <path d="m7 5 8 5-8 5Z"/>,
    plug: <><path d="M8 3v4M12 3v4M6 7h8v2a4 4 0 0 1-4 4v4M7 17h6"/></>,
    refresh: <><path d="M15 6V3l3 3-3 3V6a6 6 0 1 0 1 7"/></>,
    restore: <><path d="M4 5v4h4"/><path d="M5 8a6 6 0 1 1 1 6"/></>,
    spinner: <><circle cx="10" cy="10" r="6"/><path d="M10 4a6 6 0 0 1 6 6"/></>,
    star: <path d="m10 3 2.1 4.3 4.7.7-3.4 3.3.8 4.7-4.2-2.2L5.8 16l.8-4.7L3.2 8l4.7-.7L10 3Z"/>,
    starFilled: <path fill="currentColor" d="m10 3 2.1 4.3 4.7.7-3.4 3.3.8 4.7-4.2-2.2L5.8 16l.8-4.7L3.2 8l4.7-.7L10 3Z"/>,
    stop: <rect x="5" y="5" width="10" height="10" rx="1"/>,
    task: <><path d="M6 4h8v13H6z"/><path d="M8 3h4v3H8zM8 10h4M8 14h4"/></>,
    trash: <><path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11M9 9v5M11 9v5"/></>,
    warning: <><path d="M10 3 2 17h16L10 3Z"/><path d="M10 8v4M10 15h.01"/></>,
    workspace: <><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M3 8h14M7 4v4"/></>,
  };
  return (
    <svg className="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "unknown";
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 5_000) return "just now";
  const seconds = Math.floor(diff / 1_000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function activityTimestamp(activity: ToolActivityView): number {
  return Date.parse(activity.finishedAt || activity.startedAt || "") || 0;
}

function compareTaskFeedItems(left: TaskPresentation, right: TaskPresentation): number {
  const timestampDifference = taskFeedTimestamp(left) - taskFeedTimestamp(right);
  return timestampDifference || left.task.id.localeCompare(right.task.id);
}

export function isScrollNearBottom(
  node: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  threshold = 36,
): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= threshold;
}

function taskFeedTimestamp(item: TaskPresentation): number {
  const values = [
    item.task.createdAt,
    item.activities[0]?.startedAt,
    item.task.updatedAt,
    item.latestAt,
  ];
  for (const value of values) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function liveDuration(activity: ToolActivityView): number {
  return activity.durationMs ?? Math.max(0, Date.now() - Date.parse(activity.startedAt));
}

function humanizeTool(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part, index) => index === 0 ? part[0]?.toUpperCase() + part.slice(1) : part)
    .join(" ");
}

function isOpenTask(status: string): boolean {
  return ["open", "active", "running"].includes(status.toLowerCase());
}

function taskTone(status: string, running: boolean): string {
  if (running) return "running";
  const normalized = status.toLowerCase();
  if (["failed", "incomplete"].includes(normalized)) return "failed";
  if (isOpenTask(normalized)) return "open";
  return "complete";
}

function shortId(value: string): string {
  return value.length > 12 ? value.slice(0, 10) : value;
}

function useDismiss<T extends HTMLElement>(
  open: boolean,
  dismiss: () => void,
  ref: React.RefObject<T | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const listener = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) dismiss();
    };
    window.addEventListener("mousedown", listener);
    return () => window.removeEventListener("mousedown", listener);
  }, [open, dismiss, ref]);
}

function useLiveClock(active: boolean, update: React.Dispatch<React.SetStateAction<number>>): void {
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => update((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [active, update]);
}
