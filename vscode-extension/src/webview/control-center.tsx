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
  toolClass: string | null;
  fingerprint: string | null;
  purpose: string | null;
  purposeFingerprint: string | null;
  orchestrationEvent: string | null;
  runState: string | null;
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

export interface TaskOrchestrationView {
  suggested_profile?: "quick_edit" | "normal" | "complex" | null;
  scope_signal?: "expanded" | "reduced" | "aligned" | null;
  scope_reasons?: string[];
  phase?: string;
  evidence_status?: string;
  run_state?: "running" | "retrying" | "blocked" | "waiting_for_user";
  blocker?: {
    code?: string;
    step?: string;
    summary?: string;
    evidence?: string[];
    required_action?: string | null;
    retryable?: boolean;
    purpose?: string | null;
    target?: string | null;
  } | null;
  budgets?: { discovery_soft_limit?: number | null; total_soft_limit?: number | null };
  counters?: {
    total_calls?: number;
    unique_calls?: number;
    duplicate_calls?: number;
    discovery_calls?: number;
    status_only_calls?: number;
    failed_calls?: number;
    mutations?: number;
    semantic_duplicate_calls?: number;
    blockers_detected?: number;
    transient_retries?: number;
    retry_exhausted?: number;
    tasks_resumed?: number;
  };
  last_notice?: {
    code?: string;
    severity?: string;
    message?: string;
    recommended_transition?: string | null;
  } | null;
}

export interface ControlTaskView {
  id: string;
  title: string;
  objective: string | null;
  requestedProfile: "quick_edit" | "normal" | "complex" | null;
  effectiveProfile: "quick_edit" | "normal" | "complex" | null;
  profileConfidence: number | null;
  orchestration: TaskOrchestrationView | null;
  status: string;
  sessionBound: boolean | null;
  detachedAt: string | null;
  closedReason: string | null;
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
  const connectionLabel = control.serverOnline ? "Connected" : "Offline";
  const runtimeError = control.storageError || control.error;
  const runtimeTitle = runtimeError || [
    connectionLabel,
    control.version ? `v${control.version}` : null,
    syncMode === "sse" ? "Live" : syncMode === "polling" ? "Polling" : null,
  ].filter(Boolean).join(" · ");

  return (
    <header className="workspace-header">
      <div className="workspace-heading">
        <div className="eyebrow">LOCAL CODING AGENT</div>
        <div className="header-status-row">
          <div className="status-chip status-summary" role="status" title={runtimeTitle}>
            <span className={`status-dot ${control.serverOnline ? "connected" : "disconnected"}`} />
            <span>{connectionLabel}</span>
            {control.version && <span className="muted">v{control.version}</span>}
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
          {currentWorkspace && !registered && (
            <>
              <span className="header-warning">Not connected</span>
              <button
                className="compact-action primary"
                type="button"
                disabled={!trusted || Boolean(busyAction)}
                onClick={onConnect}
              >
                <Icon name="plug" /> Connect
              </button>
            </>
          )}
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
  onSelect,
  onAction,
  onViewHistory,
}: {
  control: ControlStateView;
  currentWorkspace?: WorkspaceOptionView;
  trusted: boolean;
  busyAction?: string;
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
  toolCallCount: number;
  redundantCallCount: number;
  usefulCallCount: number;
  elapsedMs: number | null;
  activeToolTimeMs: number;
  betweenCallsMs: number | null;
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
      const verification = latestVisibleVerification(activities);
      const timing = taskTiming(task, activities);
      const observedRedundantCallCount = activities.filter(isRedundantActivity).length;
      const orchestrationCalls = task.orchestration?.counters?.total_calls || 0;
      const toolCallCount = Math.max(activities.length, orchestrationCalls);
      const redundantCallCount = Math.max(
        observedRedundantCallCount,
        task.orchestration?.counters?.duplicate_calls || 0,
      );
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
        toolCallCount,
        redundantCallCount,
        usefulCallCount: Math.max(0, toolCallCount - redundantCallCount),
        ...timing,
      };
    })
    .sort(compareTaskFeedItems);
}

export function ChronologicalTaskFeed({
  tasks,
  unassigned,
  workspaceLabel,
  workspaceKey,
  workspaceId,
  busyAction,
  onCloseDetachedTask,
  onDeleteTask,
  onDeleteAll,
  renderChanges,
}: {
  tasks: TaskPresentation[];
  unassigned?: TaskPresentation;
  workspaceLabel: string;
  workspaceKey?: string;
  workspaceId?: string;
  busyAction?: string;
  onCloseDetachedTask: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onDeleteAll: () => void;
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
  const latestTaskId = tasks[tasks.length - 1]?.task.id || null;
  const running = items.some((item) => !taskIsDetached(item) && (
    item.runningProcessCount > 0 || item.activities.some((activity) => activity.status === "started")
  ));
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
        <div className="task-feed-actions">
          <span>{items.length}</span>
          <IconButton
            title={tasks.some((item) => isOpenTask(item.task.status))
              ? "Close open tasks before deleting all"
              : "Delete all tasks for this workspace"}
            icon="trash"
            danger
            disabled={!workspaceId || tasks.length === 0 || Boolean(busyAction) || tasks.some((item) => isOpenTask(item.task.status))}
            onClick={onDeleteAll}
          />
        </div>
      </div>
      <div className="task-feed-frame">
        <div className="task-feed-scroll" ref={scrollRef} onScroll={handleScroll}>
          {items.length > 0 ? (
            <div className="task-thread">
              {items.map((item) => {
                const detached = taskIsDetached(item);
                return (
                  <TaskBlock
                    key={item.task.id}
                    item={item}
                    latest={item.task.id === latestTaskId}
                    detached={detached}
                    closeDetachedDisabled={Boolean(busyAction)}
                    deleteDisabled={Boolean(busyAction) || isOpenTask(item.task.status)}
                    onCloseDetached={item.task.id === "__unassigned__" || !detached
                      ? undefined
                      : () => onCloseDetachedTask(item.task.id)}
                    onDelete={item.task.id === "__unassigned__" ? undefined : () => onDeleteTask(item.task.id)}
                    renderChanges={renderChanges}
                  />
                );
              })}
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

export type TaskActivityDisclosure = "auto" | "expanded" | "collapsed";

export function taskActivitiesExpanded(
  disclosure: TaskActivityDisclosure,
  latest: boolean,
): boolean {
  return disclosure === "expanded" || (disclosure === "auto" && latest);
}

function TaskBlock({
  item,
  latest,
  detached,
  closeDetachedDisabled,
  deleteDisabled,
  onCloseDetached,
  onDelete,
  renderChanges,
}: {
  item: TaskPresentation;
  latest: boolean;
  detached: boolean;
  closeDetachedDisabled: boolean;
  deleteDisabled: boolean;
  onCloseDetached?: () => void;
  onDelete?: () => void;
  renderChanges: (item: TaskPresentation) => React.ReactNode;
}): React.JSX.Element {
  const [activityDisclosure, setActivityDisclosure] = useState<TaskActivityDisclosure>("auto");
  const running = item.activities.some((activity) => activity.status === "started");
  const changeCount = item.changes.length;
  const groupedActivities = groupRepeatedActivities(item.activities);
  const showAllActivities = taskActivitiesExpanded(activityDisclosure, latest);
  const visibleActivities = showAllActivities ? groupedActivities : groupedActivities.slice(-3);
  const hiddenActivityCount = Math.max(0, groupedActivities.length - visibleActivities.length);
  const earlierCallCount = groupedActivities
    .slice(0, hiddenActivityCount)
    .reduce((count, activity) => count + (activity.repeatCount || 1), 0);
  const profile = item.task.effectiveProfile;
  const runState = item.task.orchestration?.run_state;
  const displayStatus = taskDisplayStatus(
    item.task.status,
    running || item.runningProcessCount > 0,
    detached,
    runState,
  );
  const suggestedProfile = item.task.orchestration?.suggested_profile;
  const notice = item.task.orchestration?.last_notice;
  const blocker = item.task.orchestration?.blocker;
  const showNotice = isUserVisibleOrchestrationNoticeCode(notice?.code);
  const objective = visibleTaskObjective(item.task);

  return (
    <article className={`task-card ${latest ? "is-latest" : ""} ${["running", "retrying"].includes(displayStatus.stateTone) ? "is-running" : ""} ${displayStatus.stateTone === "waiting" ? "is-waiting" : ""} ${displayStatus.stateTone === "blocked" ? "is-blocked" : ""} ${detached ? "is-detached" : ""}`}>
      <div className="task-card-header">
        <span className={`task-state-icon state-${displayStatus.stateTone}`}>
          {displayStatus.icon
            ? <Icon name={displayStatus.icon} />
            : <RotatingDots label={displayStatus.stateTone === "retrying" ? "Task retrying" : "Task running"} />}
        </span>
        <div className="task-card-copy">
          <div className="task-card-title-row">
            <strong>{item.task.title}</strong>
            {profile && <Badge value={profileLabel(profile)} tone={profile === "quick_edit" ? "accent" : ""} />}
            <Badge value={displayStatus.label} tone={displayStatus.badgeTone} />
          </div>
          <div className="task-card-meta">
            {item.task.createdAt && <span>Started {relativeTime(item.task.createdAt)}</span>}
            {item.runningProcessCount > 0 && <span>{item.runningProcessCount} running process{item.runningProcessCount === 1 ? "" : "es"}</span>}
            {item.toolCallCount > 0 && <span>{item.toolCallCount} call{item.toolCallCount === 1 ? "" : "s"}</span>}
            {item.redundantCallCount > 0 && <span className="redundant-count">{item.redundantCallCount} redundant</span>}
            {item.elapsedMs !== null && (
              <span title={detached
                ? "Elapsed time from task open until its session detached."
                : "Elapsed time from task open to close, or to now while running."}>Total {formatDuration(item.elapsedMs)}</span>
            )}
            {item.activeToolTimeMs > 0 && (
              <span title="Measured time inside LCA tool handlers; overlapping calls are counted once.">Tools {formatDuration(item.activeToolTimeMs)}</span>
            )}
            {item.task.orchestration?.phase && <span>{humanizeTool(item.task.orchestration.phase)}</span>}
            {suggestedProfile && suggestedProfile !== profile && (
              <span className="orchestration-notice" title={item.task.orchestration?.scope_reasons?.join(" · ")}>
                Suggested {profileLabel(suggestedProfile)}
              </span>
            )}
            {item.task.workspaceIds.length > 1 && <span>Multi-workspace</span>}
            {showNotice && notice?.code && <span className="orchestration-notice" title={notice.message}>{humanizeTool(notice.code)}</span>}
          </div>
        </div>
        {(onCloseDetached || onDelete) && (
          <div className="task-card-actions">
            {onCloseDetached && (
              <IconButton
                title={`Close detached task ${item.task.title}`}
                icon="stop"
                disabled={closeDetachedDisabled}
                onClick={onCloseDetached}
              />
            )}
            {onDelete && <IconButton
              title={isOpenTask(item.task.status) ? "Close task before deleting it" : `Delete ${item.task.title}`}
              icon="trash"
              danger
              disabled={deleteDisabled}
              onClick={onDelete}
            />}
          </div>
        )}
      </div>

      {blocker?.summary && ["blocked", "waiting_for_user"].includes(runState || "") && (
        <section className={`task-blocker-card blocker-${runState}`} role="status">
          <strong>{runState === "waiting_for_user" ? "Waiting for input" : "Task blocked"}</strong>
          <p>{blocker.summary}</p>
          {blocker.evidence && blocker.evidence.length > 0 && (
            <ul>
              {blocker.evidence.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
            </ul>
          )}
          {blocker.required_action && (
            <p className="task-blocker-action"><span>Required:</span> {blocker.required_action}</p>
          )}
        </section>
      )}

      {(objective || latest || groupedActivities.length > 0) && (
        <div className="task-activity">
          {(objective || visibleActivities.length > 0) ? (
            <ol className="tool-timeline task-tool-timeline" id={`task-activity-${item.task.id}`}>
              {objective && (
                <li className="timeline-item task-objective" aria-label="Agent objective">
                  <span className="timeline-marker task-objective-marker" aria-hidden="true">
                    <Icon name="task" />
                  </span>
                  <div className="task-objective-copy">
                    <strong className="task-objective-label">Agent objective</strong>
                    <p>{objective}</p>
                  </div>
                </li>
              )}
              {visibleActivities.map((activity) => {
                const interruptedByDetach = detached && activity.status === "started";
                return (
                <li className={`timeline-item timeline-${interruptedByDetach ? "interrupted" : activity.status} ${activity.policySkip ? "timeline-skipped" : ""} ${activity.duplicate ? "timeline-duplicate" : ""}`} key={activity.invocationId}>
                  <span className="timeline-marker">
                    {activity.status === "started" && !interruptedByDetach
                      ? <RotatingDots compact label={`${activityLabel(activity.tool)} running`} />
                      : <Icon name={interruptedByDetach ? "stop" : activity.status === "finished" ? "check" : "warning"} />}
                  </span>
                  <div className="timeline-copy">
                    <strong>{activityPurposeLabel(activity)}{activity.repeatCount > 1 ? ` · ${activity.repeatCount} attempts` : ""}</strong>
                    <span title={activity.tool}>{activity.tool}</span>
                    <span>
                      {activity.cacheHit
                        ? `Cached duplicate · ${relativeTime(activity.finishedAt || activity.startedAt)}`
                        : activity.policySkip
                          ? `Skipped · ${relativeTime(activity.finishedAt || activity.startedAt)}`
                          : activity.duplicate
                            ? `Repeated evidence · ${formatDuration(activity.durationMs || 0)} · ${relativeTime(activity.finishedAt || activity.startedAt)}`
                          : interruptedByDetach
                            ? `Interrupted after ${formatDuration(detachedActivityDuration(activity, item.task.detachedAt || item.task.updatedAt))} · session detached ${relativeTime(item.task.detachedAt || item.task.updatedAt || activity.startedAt)}`
                          : activity.status === "started"
                            ? `Running ${formatDuration(liveDuration(activity))} · started ${relativeTime(activity.startedAt)}`
                            : `${formatDuration(activity.durationMs || 0)} · completed ${relativeTime(activity.finishedAt || activity.startedAt)}`}
                      {isUserVisibleOrchestrationNoticeCode(activity.orchestrationNoticeCode) ? ` · ${activity.orchestrationNoticeCode}` : ""}
                      {visibleActivityVerification(activity) ? ` · ${visibleActivityVerification(activity)}` : ""}
                      {activity.errorCode ? ` · ${activity.errorCode}` : ""}
                    </span>
                  </div>
                </li>
                );
              })}
              {groupedActivities.length > 3 && (
                <li className="task-summary-item">
                  <button
                    className="task-summary-button"
                    type="button"
                    aria-controls={`task-activity-${item.task.id}`}
                    aria-expanded={showAllActivities}
                    onClick={() => setActivityDisclosure(showAllActivities ? "collapsed" : "expanded")}
                  >
                    <span className="timeline-marker task-summary-marker" aria-hidden="true">
                      {showAllActivities ? "−" : "+"}
                    </span>
                    <span className="timeline-copy">
                      <strong>
                        {showAllActivities
                          ? "Show fewer calls"
                          : `${earlierCallCount} earlier call${earlierCallCount === 1 ? "" : "s"}`}
                      </strong>
                    </span>
                  </button>
                </li>
              )}
            </ol>
          ) : (
            <p className="task-waiting">Waiting for task activity…</p>
          )}
        </div>
      )}

      {changeCount > 0 && (
        <div className="task-changes">
          <div className="inline-changes-panel">
            <div className="inline-changes-scroll">{renderChanges(item)}</div>
          </div>
        </div>
      )}
    </article>
  );
}

export function visibleTaskObjective(
  task: Pick<ControlTaskView, "title" | "objective">,
): string | null {
  const objective = task.objective?.trim();
  if (!objective || objective === task.title.trim()) return null;
  return objective;
}

export function activityPurposeLabel(activity: Pick<ToolActivityView, "tool" | "purpose">): string {
  return activity.purpose ? humanizeTool(activity.purpose) : activityLabel(activity.tool);
}

export function activityLabel(tool: string): string {
  const labels: Record<string, string> = {
    lca_status: "Check LCA status",
    workspace_list: "List workspaces",
    workspace_select: "Select workspace",
    task_open: "Open task",
    task_reclassify: "Reclassify task",
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
      objective: null,
      requestedProfile: null,
      effectiveProfile: null,
      profileConfidence: null,
      orchestration: null,
      sessionBound: null,
      detachedAt: null,
      closedReason: null,
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
    toolCallCount: activities.length,
    redundantCallCount: activities.filter(isRedundantActivity).length,
    usefulCallCount: activities.filter((activity) => !isRedundantActivity(activity)).length,
    elapsedMs: null,
    activeToolTimeMs: mergedActivityDurationMs(activities),
    betweenCallsMs: null,
  };
}

export function Badge({ value, tone = "" }: { value: string; tone?: string }): React.JSX.Element {
  return <span className={`control-badge ${tone}`}>{value}</span>;
}

export function RotatingDots({
  label = "Running",
  compact = false,
}: {
  label?: string;
  compact?: boolean;
}): React.JSX.Element {
  return (
    <span
      className={`rotating-dots ${compact ? "rotating-dots-compact" : ""}`}
      role="status"
      aria-label={label}
    >
      <span aria-hidden="true" />
      <span aria-hidden="true" />
      <span aria-hidden="true" />
    </span>
  );
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

interface GroupedToolActivity extends ToolActivityView {
  repeatCount: number;
}

export function groupRepeatedActivities(activities: ToolActivityView[]): GroupedToolActivity[] {
  const grouped: GroupedToolActivity[] = [];
  for (const activity of activities) {
    const previous = grouped[grouped.length - 1];
    const samePurpose = Boolean(activity.purposeFingerprint) && previous?.purposeFingerprint === activity.purposeFingerprint;
    const groupable = Boolean(previous) && (
      samePurpose || (
        isRedundantActivity(activity) && isRedundantActivity(previous) &&
        previous.tool === activity.tool &&
        previous.orchestrationNoticeCode === activity.orchestrationNoticeCode
      )
    );
    if (!groupable) {
      grouped.push({ ...activity, repeatCount: 1 });
      continue;
    }
    previous.repeatCount++;
    previous.finishedAt = activity.finishedAt || previous.finishedAt;
    previous.durationMs = (previous.durationMs || 0) + (activity.durationMs || 0);
    previous.status = activity.status;
    previous.ok = activity.ok;
    previous.errorCode = activity.errorCode || previous.errorCode;
    previous.policySkip = previous.policySkip || activity.policySkip;
    previous.cacheHit = previous.cacheHit || activity.cacheHit;
    previous.duplicate = previous.duplicate || activity.duplicate;
  }
  return grouped;
}

function isRedundantActivity(activity: Pick<ToolActivityView, "duplicate" | "policySkip" | "cacheHit">): boolean {
  return activity.duplicate || activity.policySkip || activity.cacheHit;
}

function profileLabel(profile: "quick_edit" | "normal" | "complex"): string {
  return profile === "quick_edit" ? "Quick edit" : profile === "complex" ? "Complex" : "Normal";
}

function taskDisplayStatus(
  status: string,
  hasRunningActivity: boolean,
  detached: boolean,
  runState?: string | null,
): { label: string; badgeTone: string; stateTone: "running" | "retrying" | "waiting" | "blocked" | "detached" | "complete" | "failed"; icon: IconName | null } {
  const normalized = status.toLowerCase();
  if (runState === "waiting_for_user") {
    return { label: "Waiting for input", badgeTone: "incomplete", stateTone: "waiting", icon: "stop" };
  }
  if (runState === "blocked") {
    return { label: "Blocked", badgeTone: "fail", stateTone: "blocked", icon: "warning" };
  }
  if (runState === "retrying") {
    return { label: "Retrying", badgeTone: "incomplete", stateTone: "retrying", icon: null };
  }
  if (detached) {
    return { label: "Detached", badgeTone: "incomplete", stateTone: "detached", icon: "stop" };
  }
  if (hasRunningActivity || isOpenTask(normalized)) {
    return { label: "Running", badgeTone: "accent", stateTone: "running", icon: null };
  }
  if (normalized === "failed") {
    return { label: "Failed", badgeTone: "fail", stateTone: "failed", icon: "warning" };
  }
  // Internal close evidence such as `incomplete` is intentionally collapsed into
  // Completed. Detached is a lifecycle state for an open task without a live session.
  return { label: "Completed", badgeTone: "pass", stateTone: "complete", icon: "check" };
}

export function visibleActivityVerification(
  activity: Pick<ToolActivityView, "tool" | "verification">,
): ToolActivityView["verification"] {
  if (activity.tool === "task_close" && activity.verification === "INCOMPLETE") return null;
  return activity.verification;
}

function latestVisibleVerification(activities: ToolActivityView[]): ToolActivityView["verification"] {
  const latest = [...activities].sort((left, right) => activityTimestamp(right) - activityTimestamp(left));
  for (const activity of latest) {
    const verification = visibleActivityVerification(activity);
    if (verification) return verification;
  }
  return null;
}

function taskTiming(
  task: ControlTaskView,
  activities: ToolActivityView[],
): Pick<TaskPresentation, "elapsedMs" | "activeToolTimeMs" | "betweenCallsMs"> {
  const activityStarts = activities
    .map((activity) => Date.parse(activity.startedAt))
    .filter(Number.isFinite);
  const startedAt = finiteTimestamp(task.createdAt) ?? (activityStarts.length ? Math.min(...activityStarts) : null);
  const closedAt = finiteTimestamp(task.closedAt) ?? (
    !isOpenTask(task.status) ? finiteTimestamp(task.updatedAt) : null
  );
  const detachedAt = finiteTimestamp(task.detachedAt);
  const latestActivityAt = activities.reduce<number | null>((latest, activity) => {
    const timestamp = finiteTimestamp(activity.finishedAt || activity.startedAt);
    if (timestamp === null) return latest;
    return latest === null ? timestamp : Math.max(latest, timestamp);
  }, null);
  const effectiveDetachedAt = detachedAt !== null && (latestActivityAt === null || latestActivityAt <= detachedAt)
    ? detachedAt
    : null;
  const activeToolTimeMs = mergedActivityDurationMs(activities, effectiveDetachedAt);
  const endedAt = closedAt ?? effectiveDetachedAt ?? (startedAt !== null ? Date.now() : null);
  const elapsedMs = startedAt !== null && endedAt !== null
    ? Math.max(0, endedAt - startedAt)
    : null;
  return {
    elapsedMs,
    activeToolTimeMs,
    betweenCallsMs: elapsedMs === null ? null : Math.max(0, elapsedMs - activeToolTimeMs),
  };
}

function mergedActivityDurationMs(
  activities: ToolActivityView[],
  detachedAt: number | null = null,
): number {
  const now = Date.now();
  const intervals = activities.flatMap((activity) => {
    const start = Date.parse(activity.startedAt);
    if (!Number.isFinite(start)) return [];
    const finished = finiteTimestamp(activity.finishedAt);
    const durationEnd = activity.durationMs !== null && Number.isFinite(activity.durationMs)
      ? start + Math.max(0, activity.durationMs)
      : null;
    const end = finished ?? durationEnd ?? (activity.status === "started" ? detachedAt ?? now : start);
    return [[start, Math.max(start, end)] as const];
  }).sort((left, right) => left[0] - right[0]);
  if (!intervals.length) return 0;
  let total = 0;
  let [rangeStart, rangeEnd] = intervals[0];
  for (const [start, end] of intervals.slice(1)) {
    if (start <= rangeEnd) {
      rangeEnd = Math.max(rangeEnd, end);
      continue;
    }
    total += rangeEnd - rangeStart;
    rangeStart = start;
    rangeEnd = end;
  }
  return total + (rangeEnd - rangeStart);
}

function finiteTimestamp(value: string | null | undefined): number | null {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isUserVisibleOrchestrationNoticeCode(code: string | null | undefined): boolean {
  return Boolean(code) && !String(code).endsWith("_BUDGET_EXCEEDED");
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

export function taskIsDetached(item: Pick<TaskPresentation, "task" | "activities" | "runningProcessCount">): boolean {
  const detachedAt = finiteTimestamp(item.task.detachedAt);
  if (
    !isOpenTask(item.task.status)
    || item.task.sessionBound !== false
    || item.runningProcessCount > 0
    || detachedAt === null
  ) {
    return false;
  }
  return !item.activities.some((activity) => {
    const activityAt = finiteTimestamp(activity.finishedAt || activity.startedAt);
    return activityAt !== null && activityAt > detachedAt;
  });
}

function detachedActivityDuration(
  activity: ToolActivityView,
  detachedAt: string | null | undefined,
): number {
  if (activity.durationMs !== null && Number.isFinite(activity.durationMs)) {
    return Math.max(0, activity.durationMs);
  }
  const start = finiteTimestamp(activity.startedAt);
  const end = finiteTimestamp(detachedAt);
  return start !== null && end !== null ? Math.max(0, end - start) : 0;
}

function isOpenTask(status: string): boolean {
  return ["open", "active", "running"].includes(status.toLowerCase());
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
