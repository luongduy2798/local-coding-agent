import path from "node:path";
import * as vscode from "vscode";
import type {
  ApiRevision,
  ChangeListResponse,
  ChangeRecord,
  HealthResponse,
  ReviewScope,
  TaskDescriptor,
  WorkspaceDescriptor,
} from "../api/api-types.js";
import { LcaApiError } from "../api/lca-client.js";
import type {
  ConnectionState,
  WorkspaceFolderChoice,
} from "../connection/connection-manager.js";
import { ConnectionManager } from "../connection/connection-manager.js";

export interface TaskFilterOption {
  taskId: string;
  apiTaskId?: string;
  title: string;
  status?: string;
}

export interface ReviewChangesState {
  connection?: ConnectionState;
  changes: ChangeRecord[];
  loading: boolean;
  revision: number;
  serverRevision?: ApiRevision;
  syncMode: "idle" | "sse" | "polling";
  workspaceOptions: WorkspaceFolderChoice[];
  taskOptions: TaskFilterOption[];
  selectedWorkspaceKey?: string;
  selectedTaskId?: string;
  scopeError?: string;
}

interface ActiveLoad {
  revision: number;
  controller: AbortController;
  promise: Promise<void>;
}

export class ReviewChangesStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ReviewChangesState>();
  readonly onDidChange = this.emitter.event;

  private state: ReviewChangesState = {
    changes: [],
    loading: true,
    revision: 0,
    syncMode: "idle",
    workspaceOptions: [],
    taskOptions: [],
  };
  private viewRevision = 0;
  private requestRevision = 0;
  private activeLoad: ActiveLoad | undefined;
  private refreshQueued = false;
  private pollingTimer: NodeJS.Timeout | undefined;
  private streamController: AbortController | undefined;
  private liveKey: string | undefined;
  private visible = false;
  private disposed = false;

  constructor(private readonly connection: ConnectionManager) {
    this.state.selectedWorkspaceKey = connection.selectedReviewWorkspaceKey;
  }

  get current(): ReviewChangesState {
    return this.state;
  }

  get currentScope(): ReviewScope {
    const workspace = this.state.workspaceOptions.find(
      (item) => item.key === this.state.selectedWorkspaceKey,
    );
    return {
      workspaceId: workspace?.workspaceId,
      taskId: this.state.taskOptions.find(
        (task) => task.taskId === this.state.selectedTaskId,
      )?.apiTaskId,
    };
  }

  private get currentListScope(): ReviewScope {
    const workspace = this.state.workspaceOptions.find(
      (item) => item.key === this.state.selectedWorkspaceKey,
    );
    return {
      workspaceId: workspace?.workspaceId,
      taskId: this.state.taskOptions.find(
        (task) => task.taskId === this.state.selectedTaskId,
      )?.apiTaskId,
    };
  }

  async refresh(
    options: { cancelCurrent?: boolean; queueIfBusy?: boolean } = {},
  ): Promise<void> {
    const active = this.activeLoad;
    if (active) {
      if (!options.cancelCurrent) {
        if (options.queueIfBusy) this.refreshQueued = true;
        return active.promise;
      }
      this.refreshQueued = false;
      active.controller.abort();
      await active.promise.catch(() => undefined);
    }

    const revision = ++this.requestRevision;
    const controller = new AbortController();
    const promise = this.load(revision, controller.signal).finally(() => {
      if (this.activeLoad?.revision !== revision) return;
      this.activeLoad = undefined;
      if (this.refreshQueued && !this.disposed) {
        this.refreshQueued = false;
        void this.refresh();
      }
    });
    this.activeLoad = { revision, controller, promise };
    return promise;
  }

  async selectWorkspace(workspaceKey: string | undefined): Promise<void> {
    const selectedKey = workspaceKey;
    if (!selectedKey) throw new Error("Select a workspace to review.");
    if (!this.state.workspaceOptions.some((item) => item.key === selectedKey)) {
      throw new Error("The selected workspace is no longer available.");
    }
    await this.connection.selectWorkspaceFolder(selectedKey);
    this.state = {
      ...this.state,
      selectedWorkspaceKey: selectedKey,
      selectedTaskId: undefined,
      changes: [],
      serverRevision: undefined,
      scopeError: undefined,
    };
    this.emit();
    this.stopLiveUpdates();
    await this.refresh({ cancelCurrent: true });
  }

  async selectTask(taskId: string | undefined): Promise<void> {
    if (taskId && !this.state.taskOptions.some((item) => item.taskId === taskId)) {
      throw new Error("The selected task is no longer available.");
    }
    this.state = {
      ...this.state,
      selectedTaskId: taskId,
      changes: [],
      serverRevision: undefined,
      scopeError: undefined,
    };
    this.emit();
    this.stopLiveUpdates();
    await this.refresh({ cancelCurrent: true });
  }

  async viewArchivedWorkspaceHistory({
    workspaceId,
    label,
    root,
    opened,
  }: {
    workspaceId: string;
    label: string;
    root: string;
    opened: boolean;
  }): Promise<void> {
    const key = `archived-history:${workspaceId}`;
    const historyChoice: WorkspaceFolderChoice = {
      key,
      label: `${label} (Archived — read only)`,
      root,
      workspaceId,
      available: true,
      registered: true,
      trusted: true,
      opened,
      registrationState: "archived",
    };
    this.state = {
      ...this.state,
      workspaceOptions: [
        ...this.state.workspaceOptions.filter((item) => !item.key.startsWith("archived-history:")),
        historyChoice,
      ],
      selectedWorkspaceKey: key,
      selectedTaskId: undefined,
      changes: [],
      serverRevision: undefined,
      scopeError: undefined,
    };
    this.emit();
    this.stopLiveUpdates();
    await this.refresh({ cancelCurrent: true });
  }

  async workspaceFoldersChanged(): Promise<void> {
    await this.connection.selectWorkspaceFolder(undefined);
    this.state = {
      ...this.state,
      selectedWorkspaceKey: undefined,
      selectedTaskId: undefined,
      changes: [],
      serverRevision: undefined,
      scopeError: undefined,
    };
    this.stopLiveUpdates();
    await this.refresh({ cancelCurrent: true });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      this.stopLiveUpdates();
      return;
    }
    void this.refresh();
    this.ensureLiveUpdates();
  }

  restartPolling(): void {
    this.stopLiveUpdates();
    if (this.visible) this.ensureLiveUpdates();
  }

  dispose(): void {
    this.disposed = true;
    this.activeLoad?.controller.abort();
    this.stopLiveUpdates();
    this.emitter.dispose();
  }

  private async load(revision: number, signal: AbortSignal): Promise<void> {
    this.state = { ...this.state, loading: true, scopeError: undefined };
    this.emit();

    let connectionState = await this.connection.check(signal);
    if (signal.aborted || revision !== this.requestRevision) return;

    let changes: ChangeRecord[] = [];
    let serverRevision = this.state.serverRevision;
    let workspaceOptions = await this.connection.workspaceChoices(
      connectionState.kind === "connected" ? connectionState.health : undefined,
    );
    const selectedArchivedHistory = this.state.workspaceOptions.find(
      (workspace) => workspace.key === this.state.selectedWorkspaceKey &&
        workspace.registrationState === "archived",
    );
    if (selectedArchivedHistory) workspaceOptions.push(selectedArchivedHistory);
    workspaceOptions = workspaceOptions.map((workspace) => {
      const previous = this.state.workspaceOptions.find(
        (item) => item.key === workspace.key,
      );
      return previous?.workspaceId && !workspace.workspaceId
        ? {
            ...workspace,
            workspaceId: previous.workspaceId,
            registered: previous.registered,
            trusted: previous.trusted,
          }
        : workspace;
    });
    let taskOptions: TaskFilterOption[] = [];
    let selectedWorkspaceKey = this.state.selectedWorkspaceKey;
    let selectedTaskId = this.state.selectedTaskId;
    let scopeError: string | undefined;

    if (
      selectedWorkspaceKey &&
      !workspaceOptions.some((item) => item.key === selectedWorkspaceKey)
    ) {
      selectedWorkspaceKey = undefined;
      selectedTaskId = undefined;
    }
    selectedWorkspaceKey ||= workspaceOptions[0]?.key;
    if (selectedWorkspaceKey !== this.state.selectedWorkspaceKey) {
      await this.connection.selectWorkspaceFolder(selectedWorkspaceKey);
    }

    if (connectionState.kind === "connected") {
      const health = connectionState.health;
      try {
        const selected = workspaceOptions.find((item) => item.key === selectedWorkspaceKey);
        const selectedTask = taskOptions.find((item) => item.taskId === selectedTaskId) ||
          this.state.taskOptions.find((item) => item.taskId === selectedTaskId);
        if (!selected?.registered || !selected.workspaceId) {
          changes = [];
          taskOptions = [];
          serverRevision = undefined;
        } else {
          const requestWorkspaceId = selected.workspaceId;
          const response = await this.connection.client.listChanges(
            100,
            {
              workspaceId: requestWorkspaceId,
              taskId: selectedTask?.apiTaskId,
            },
            {
              signal,
              sinceRevision: this.state.serverRevision,
            },
          );
          if (signal.aborted || revision !== this.requestRevision) return;
          if (
            response.workspace_id &&
            response.workspace_id !== requestWorkspaceId
          ) {
            throw new LcaApiError(409, {
              code: "WORKSPACE_ID_MISMATCH",
              message: "LCA returned changes for a different workspace than requested.",
            });
          }
          if (response.notModified) {
            changes = this.state.changes;
            taskOptions = this.state.taskOptions;
          } else {
            workspaceOptions = mergeWorkspaceOptions(
              workspaceOptions,
              health,
              response,
              { flatWorkspaceRoot: selected.root },
            );
            changes = normalizeChanges(response, health, workspaceOptions);
            taskOptions = normalizeTasks(
              response,
              health,
              changes,
              requestWorkspaceId,
            );
            if (selectedTaskId && !taskOptions.some((item) => item.taskId === selectedTaskId)) {
              const previousTask = this.state.taskOptions.find(
                (item) => item.taskId === selectedTaskId,
              );
              taskOptions.push(previousTask || {
                taskId: selectedTaskId,
                title: `Task ${shortId(selectedTaskId)}`,
              });
            }
            changes = filterChanges(changes, {
              workspaceKey: selectedWorkspaceKey,
              workspaceId: requestWorkspaceId,
              taskId: selectedTaskId,
            });
          }
          serverRevision = response.revision ?? serverRevision;
        }
      } catch (error) {
        if (signal.aborted || revision !== this.requestRevision) return;
        if (
          error instanceof LcaApiError &&
          [
            "WORKSPACE_UNAVAILABLE",
            "WORKSPACE_NOT_FOUND",
            "WORKSPACE_ID_MISMATCH",
            "TASK_CONTEXT_REQUIRED",
            "STALE_TASK_TOKEN",
          ]
            .includes(error.body.code || "")
        ) {
          scopeError = error.message;
          if ((error.body.code || "").startsWith("WORKSPACE_") && selectedWorkspaceKey) {
            workspaceOptions = workspaceOptions.map((workspace) => (
              workspace.key === selectedWorkspaceKey
                ? { ...workspace, available: false }
                : workspace
            ));
          }
        } else {
          connectionState = error instanceof LcaApiError && error.status === 401
            ? { kind: "unauthorized", message: "The LCA authentication token is invalid." }
            : {
                kind: "server_offline",
                message: error instanceof Error ? error.message : "Unable to load Review Changes.",
              };
        }
      }
    }

    if (signal.aborted || revision !== this.requestRevision) return;
    this.state = {
      connection: connectionState,
      changes,
      loading: false,
      revision: this.state.revision,
      serverRevision,
      syncMode: this.state.syncMode,
      workspaceOptions,
      taskOptions,
      selectedWorkspaceKey,
      selectedTaskId,
      scopeError,
    };
    this.emit();
    this.ensureLiveUpdates();
  }

  private ensureLiveUpdates(): void {
    if (!this.visible || this.disposed) return;
    const config = vscode.workspace.getConfiguration("lca.reviewChanges");
    if (!config.get<boolean>("autoRefresh", true)) {
      this.setSyncMode("idle");
      return;
    }

    const connection = this.state.connection;
    if (connection?.kind !== "connected") {
      this.startPolling("offline");
      return;
    }

    const selectedWorkspace = this.state.workspaceOptions.find(
      (workspace) => workspace.key === this.state.selectedWorkspaceKey,
    );
    if (!selectedWorkspace?.registered || !selectedWorkspace.workspaceId) {
      this.stopLiveUpdates();
      return;
    }

    const endpoint = connection.health.change_events_endpoint || "/changes/events";
    const scope = this.currentListScope;
    const key = [
      this.connection.serverUrl,
      endpoint,
      scope.workspaceId || "*",
      scope.taskId || "*",
    ].join("|");
    if (this.liveKey === key && (this.streamController || this.pollingTimer)) return;

    this.stopLiveUpdates();
    this.liveKey = key;
    const controller = new AbortController();
    this.streamController = controller;
    this.setSyncMode("sse");
    void this.connection.client.watchChangeEvents({
      scope,
      sinceRevision: this.state.serverRevision,
      endpoint,
      signal: controller.signal,
      onEvent: (event) => {
        const dataType = event.data && typeof event.data === "object"
          ? (event.data as { type?: string }).type
          : undefined;
        const eventType = event.event === "message" && dataType
          ? dataType
          : event.event;
        if (
          controller.signal.aborted ||
          ["heartbeat", "open", "ready"].includes(eventType)
        ) return;
        if (
          event.revision !== undefined &&
          String(event.revision) === String(this.state.serverRevision)
        ) return;
        void this.refresh({ queueIfBusy: true });
      },
    }).then((result) => {
      if (controller.signal.aborted || this.streamController !== controller) return;
      this.streamController = undefined;
      if (result === "unsupported" || this.visible) this.startPolling(key);
    }, () => {
      if (controller.signal.aborted || this.streamController !== controller) return;
      this.streamController = undefined;
      this.startPolling(key);
    });
  }

  private startPolling(key: string): void {
    if (!this.visible || this.disposed || this.pollingTimer) return;
    this.liveKey = key;
    this.setSyncMode("polling");
    const config = vscode.workspace.getConfiguration("lca.reviewChanges");
    const interval = Math.max(1000, config.get<number>("refreshInterval", 2000));
    let reconnectTicks = 0;
    this.pollingTimer = setInterval(() => {
      void this.refresh();
      reconnectTicks++;
      if (reconnectTicks < 5 || !this.pollingTimer) return;
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
      this.liveKey = undefined;
      this.ensureLiveUpdates();
    }, interval);
  }

  private stopLiveUpdates(): void {
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    this.pollingTimer = undefined;
    this.streamController?.abort();
    this.streamController = undefined;
    this.liveKey = undefined;
    this.setSyncMode("idle");
  }

  private setSyncMode(syncMode: ReviewChangesState["syncMode"]): void {
    if (this.state.syncMode === syncMode) return;
    this.state = { ...this.state, syncMode };
    this.emit();
  }

  private emit(): void {
    this.state = { ...this.state, revision: ++this.viewRevision };
    this.emitter.fire(this.state);
  }
}

function mergeWorkspaceOptions(
  choices: WorkspaceFolderChoice[],
  health: HealthResponse,
  response: ChangeListResponse,
  options: { flatWorkspaceRoot?: string } = {},
): WorkspaceFolderChoice[] {
  const descriptors = [
    ...(health.workspaces || []),
    ...(response.workspaces || []),
    ...(response.workspace_id && options.flatWorkspaceRoot
      ? [{
          workspace_id: response.workspace_id,
          label: response.label,
          root: options.flatWorkspaceRoot,
        }]
      : []),
  ];
  return choices.map((choice) => {
    let descriptor = descriptors.find((item) => {
      const root = workspaceRoot(item);
      return root && comparablePath(root) === comparablePath(choice.root);
    });
    return descriptor
      ? {
          ...choice,
          workspaceId: workspaceIdOf(descriptor) || choice.workspaceId,
          available: descriptor.available !== false &&
            descriptor.availability !== "unavailable",
          registered: true,
          trusted: descriptor.trusted === true ||
            descriptor.trust_state === "trusted" ||
            descriptor.metadata?.trusted === true,
        }
      : choice;
  });
}

function normalizeChanges(
  response: ChangeListResponse,
  health: HealthResponse,
  workspaces: WorkspaceFolderChoice[],
): ChangeRecord[] {
  const records: ChangeRecord[] = (response.changes || []).map((change) => ({
    ...change,
    workspace_id: change.workspace_id || change.workspace || response.workspace_id,
    workspace_label: change.workspace_label || response.label,
  }));
  const openWorkspaceIds = new Set(
    workspaces.map((workspace) => workspace.workspaceId).filter(Boolean),
  );
  for (const bucket of response.workspaces || []) {
    const bucketWorkspaceId = workspaceIdOf(bucket);
    if (!bucketWorkspaceId || !openWorkspaceIds.has(bucketWorkspaceId)) continue;
    const bucketChanges = Array.isArray(bucket.changes)
      ? bucket.changes
      : bucket.changes?.changes || [];
    for (const change of bucketChanges) {
      records.push({
        ...change,
        workspace_id: change.workspace_id || change.workspace || bucketWorkspaceId,
        workspace_label: change.workspace_label || bucket.label || bucket.metadata?.label,
      });
    }
  }

  const descriptors = [
    ...(health.workspaces || []),
    ...(response.workspaces || []),
  ];
  const legacyWorkspace = workspaces.find(
    (workspace) => comparablePath(workspace.root) === comparablePath(health.workspace),
  );
  const legacyDescriptor = descriptors.find((descriptor) => {
    const root = workspaceRoot(descriptor);
    return root && comparablePath(root) === comparablePath(health.workspace);
  });
  const seen = new Set<string>();
  return records
    .map((change) => {
      const workspaceId = change.workspace_id ||
        change.workspace ||
        health.workspace_id ||
        (legacyDescriptor ? workspaceIdOf(legacyDescriptor) : undefined);
      const descriptor = descriptors.find(
        (item) => workspaceIdOf(item) === workspaceId,
      );
      const descriptorRoot = descriptor ? workspaceRoot(descriptor) : undefined;
      const folder = workspaceId
        ? workspaces.find((item) => item.workspaceId === workspaceId)
        : descriptorRoot
          ? workspaces.find(
              (item) => comparablePath(item.root) === comparablePath(descriptorRoot),
            )
          : legacyWorkspace;
      return {
        ...change,
        workspace_id: workspaceId,
        workspace_key: folder?.key,
        workspace_label: change.workspace_label ||
          descriptor?.label ||
          descriptor?.metadata?.label ||
          folder?.label,
        task_id: change.task_id ||
          change.routingTaskId ||
          change.routing_task_id,
      };
    })
    .filter((change) => {
      const key = `${change.workspace_id || change.workspace_key || "legacy"}:${change.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function normalizeTasks(
  response: ChangeListResponse,
  health: HealthResponse,
  changes: ChangeRecord[],
  workspaceId?: string,
): TaskFilterOption[] {
  const tasks = [...(health.tasks || []), ...(response.tasks || [])];
  const values = new Map<string, TaskFilterOption>();
  for (const task of tasks) {
    const taskId = taskIdOf(task);
    if (!taskId) continue;
    const workspaceIds = task.workspace_ids || (
      task.primary_workspace_id ? [task.primary_workspace_id] : []
    );
    if (workspaceId && workspaceIds.length && !workspaceIds.includes(workspaceId)) continue;
    values.set(taskId, {
      taskId,
      apiTaskId: taskId,
      title: task.title || `Task ${shortId(taskId)}`,
      status: task.status,
    });
  }
  for (const change of changes) {
    const taskId = changeTaskKey(change);
    if (!taskId || values.has(taskId)) continue;
    values.set(taskId, {
      taskId,
      apiTaskId: change.task_id || (change.taskStatus ? change.id : undefined),
      title: change.task_title ||
        change.title ||
        (change.task_id ? `Task ${shortId(change.task_id)}` : "LCA task"),
      status: change.taskStatus,
    });
  }
  return [...values.values()].sort((left, right) => left.title.localeCompare(right.title));
}

function filterChanges(
  changes: ChangeRecord[],
  {
    workspaceKey,
    workspaceId,
    taskId,
  }: {
    workspaceKey?: string;
    workspaceId?: string;
    taskId?: string;
  },
): ChangeRecord[] {
  return changes.filter((change) => {
    if (taskId && changeTaskKey(change) !== taskId) return false;
    if (workspaceId) return change.workspace_id === workspaceId;
    if (workspaceKey) return change.workspace_key === workspaceKey;
    return true;
  });
}

function changeTaskKey(change: ChangeRecord): string | undefined {
  if (change.task_id) return change.task_id;
  if (!change.taskStatus) return undefined;
  return `journal:${change.workspace_id || change.workspace || "legacy"}:${change.id}`;
}

function workspaceRoot(workspace: WorkspaceDescriptor): string | undefined {
  return workspace.canonical_root ||
    workspace.canonicalRoot ||
    workspace.root ||
    workspace.path;
}

function workspaceIdOf(workspace: WorkspaceDescriptor): string | undefined {
  return workspace.workspace_id || workspace.id;
}

function taskIdOf(task: TaskDescriptor): string | undefined {
  return task.task_id || task.id;
}

function comparablePath(value: string): string {
  const normalized = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" || process.platform === "darwin"
    ? normalized.toLowerCase()
    : normalized;
}

function shortId(value: string): string {
  return value.length > 10 ? value.slice(0, 8) : value;
}
