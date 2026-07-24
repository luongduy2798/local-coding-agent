import {
  DEFAULT_HOST_CAPABILITIES,
  type ControlCenterHostCapabilities,
  type ControlCenterHostKind,
  type ControlCenterRequest,
  type ControlCenterStateMessage,
  type ControlCenterViewState,
} from "./protocol.js";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

interface JetBrainsApi {
  postMessage(message: unknown): void;
  getState?(): unknown;
  setState?(state: unknown): void;
  capabilities?: Partial<ControlCenterHostCapabilities>;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
    __LCA_HOST_KIND__?: ControlCenterHostKind;
    __LCA_JETBRAINS__?: JetBrainsApi;
  }
}

export interface ControlCenterHostBridge {
  readonly kind: ControlCenterHostKind;
  readonly capabilities: ControlCenterHostCapabilities;
  postMessage(message: ControlCenterRequest): void;
  getState(): unknown;
  setState(state: unknown): void;
  subscribe(listener: (message: ControlCenterStateMessage) => void): () => void;
  dispose(): void;
}

export function createControlCenterHostBridge(): ControlCenterHostBridge {
  if (typeof window.acquireVsCodeApi === "function") {
    return createMessageHost("vscode", window.acquireVsCodeApi(), DEFAULT_HOST_CAPABILITIES.vscode);
  }
  if (window.__LCA_JETBRAINS__) {
    const api = window.__LCA_JETBRAINS__;
    return createMessageHost(
      "jetbrains",
      {
        postMessage: (message) => api.postMessage(message),
        getState: () => api.getState?.(),
        setState: (state) => api.setState?.(state),
      },
      { ...DEFAULT_HOST_CAPABILITIES.jetbrains, ...api.capabilities },
    );
  }
  return new BrowserControlCenterHost();
}

function createMessageHost(
  kind: "vscode" | "jetbrains",
  api: VsCodeApi,
  capabilities: ControlCenterHostCapabilities,
): ControlCenterHostBridge {
  return {
    kind,
    capabilities,
    postMessage: (message) => api.postMessage(message),
    getState: () => api.getState(),
    setState: (state) => api.setState(state),
    subscribe(listener) {
      const handler = (event: MessageEvent<ControlCenterStateMessage>) => {
        if (event.data?.type === "state") listener(event.data);
      };
      window.addEventListener("message", handler);
      return () => window.removeEventListener("message", handler);
    },
    dispose() {},
  };
}

class BrowserControlCenterHost implements ControlCenterHostBridge {
  readonly kind = "browser" as const;
  readonly capabilities = DEFAULT_HOST_CAPABILITIES.browser;
  private readonly listeners = new Set<(message: ControlCenterStateMessage) => void>();
  private selectedWorkspaceKey: string | undefined;
  private selectedTaskId: string | undefined;
  private current: ControlCenterViewState | undefined;
  private eventSource: EventSource | undefined;
  private refreshTimer: number | undefined;
  private disposed = false;

  constructor() {
    document.documentElement.classList.add("lca-browser-host");
    const saved = this.getState() as { selectedWorkspaceKey?: string; selectedTaskId?: string } | undefined;
    this.selectedWorkspaceKey = saved?.selectedWorkspaceKey;
    this.selectedTaskId = saved?.selectedTaskId;
  }

  postMessage(message: ControlCenterRequest): void {
    void this.handle(message).catch((error) => {
      this.emitError(error instanceof Error ? error.message : "Control Center action failed.");
    });
  }

  getState(): unknown {
    try {
      const raw = sessionStorage.getItem("lca.controlCenter.hostState");
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  }

  setState(state: unknown): void {
    try {
      sessionStorage.setItem("lca.controlCenter.hostState", JSON.stringify(state));
    } catch {
      // Session persistence is optional.
    }
  }

  subscribe(listener: (message: ControlCenterStateMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.eventSource?.close();
    if (this.refreshTimer !== undefined) window.clearInterval(this.refreshTimer);
    this.listeners.clear();
  }

  private async handle(message: ControlCenterRequest): Promise<void> {
    switch (message.type) {
      case "ready":
        await this.refresh();
        this.startLiveUpdates();
        return;
      case "refresh":
        await this.refresh();
        return;
      case "selectWorkspace":
        this.selectedWorkspaceKey = message.value || undefined;
        this.selectedTaskId = undefined;
        this.persistSelection();
        await this.refresh();
        return;
      case "selectTask":
        this.selectedTaskId = message.value || undefined;
        this.persistSelection();
        await this.refresh();
        return;
      case "viewWorkspaceHistory":
        this.selectedWorkspaceKey = message.workspaceId
          ? `workspace:${message.workspaceId}`
          : this.selectedWorkspaceKey;
        this.selectedTaskId = undefined;
        this.persistSelection();
        await this.refresh();
        return;
      case "closeDetachedTask":
        await this.mutate(`/tasks/${encodeURIComponent(message.value || "")}/close-detached?workspace_id=${encodeURIComponent(message.workspaceId || "")}`, "POST");
        return this.refresh();
      case "deleteTask":
        if (!window.confirm("Delete this task and its LCA history? Source files remain unchanged.")) return;
        await this.mutate(`/tasks/${encodeURIComponent(message.value || "")}?workspace_id=${encodeURIComponent(message.workspaceId || "")}`, "DELETE");
        return this.refresh();
      case "deleteWorkspaceTasks":
        if (!window.confirm("Delete all closed task history for this workspace? Source files remain unchanged.")) return;
        await this.mutate(`/tasks?workspace_id=${encodeURIComponent(message.workspaceId || "")}`, "DELETE");
        return this.refresh();
      case "undoChange":
      case "reapplyChange":
      case "undoFile":
      case "reapplyFile":
        await this.changeMutation(message);
        return this.refresh();
      case "undoAll":
        await this.mutate(`/changes/undo-all?${this.scopeQuery()}`, "POST");
        return this.refresh();
      case "clear":
        if (!window.confirm("Clear saved Review Changes history? Workspace files remain unchanged.")) return;
        await this.mutate(`/changes?${this.scopeQuery()}`, "DELETE");
        return this.refresh();
      case "openDiff":
        window.open(this.diffUrl(message), "_blank", "noopener,noreferrer");
        return;
      case "openCurrentFile":
        await navigator.clipboard?.writeText(message.path || "");
        this.emitError("The local web host copied the file path. Open it in your editor.");
        return;
      case "connect":
      case "setToken":
      case "startLca":
      case "stopLca":
      case "makeDefaultWorkspace":
      case "archiveWorkspace":
      case "restoreWorkspace":
      case "removeWorkspace":
        this.emitError("This action requires an IDE adapter or the local `lca` CLI.");
        return;
    }
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return;
    const query = new URLSearchParams();
    if (this.selectedWorkspaceKey) query.set("workspace_key", this.selectedWorkspaceKey);
    if (this.selectedTaskId) query.set("task_id", this.selectedTaskId);
    const state = await this.fetchJson<ControlCenterViewState>(`/control/state?${query.toString()}`);
    this.selectedWorkspaceKey = state.selectedWorkspaceKey;
    this.selectedTaskId = state.selectedTaskId;
    this.persistSelection();
    this.current = state;
    this.emit({ type: "state", state });
  }

  private startLiveUpdates(): void {
    this.eventSource?.close();
    try {
      this.eventSource = new EventSource("/control/events");
      this.eventSource.addEventListener("revision", () => void this.refresh());
      this.eventSource.onerror = () => {
        this.eventSource?.close();
        this.eventSource = undefined;
      };
    } catch {
      this.eventSource = undefined;
    }
    if (this.refreshTimer === undefined) {
      this.refreshTimer = window.setInterval(() => void this.refresh(), 5_000);
    }
  }

  private async changeMutation(message: ControlCenterRequest): Promise<void> {
    const action = message.type.startsWith("undo") ? "undo" : "reapply";
    const taskId = this.taskIdForChange(message.changeId, message.workspaceId);
    const query = this.scopeQuery(message.workspaceId, taskId);
    await this.mutate(
      `/changes/${encodeURIComponent(message.changeId || "")}/${action}?${query}`,
      "POST",
      message.path ? { paths: [message.path] } : undefined,
    );
  }

  private scopeQuery(workspaceId?: string, taskId = this.selectedTaskId): string {
    const query = new URLSearchParams();
    const resolvedWorkspaceId = workspaceId || this.selectedWorkspaceKey?.replace(/^workspace:/, "");
    if (resolvedWorkspaceId) query.set("workspace_id", resolvedWorkspaceId);
    if (taskId) query.set("task_id", taskId);
    return query.toString();
  }

  private taskIdForChange(changeId?: string, workspaceId?: string): string | undefined {
    const change = this.current?.changes.find((item) => (
      item.id === changeId && (!workspaceId || item.workspace_id === workspaceId)
    ));
    return change?.task_id || change?.routingTaskId || change?.routing_task_id || this.selectedTaskId;
  }

  private diffUrl(message: ControlCenterRequest): string {
    const query = new URLSearchParams();
    if (message.workspaceId) query.set("workspace_id", message.workspaceId);
    const taskId = this.taskIdForChange(message.changeId, message.workspaceId);
    if (taskId) query.set("task_id", taskId);
    if (message.path) query.set("path", message.path);
    query.set("change_id", message.changeId || "");
    return `/control/diff?${query.toString()}`;
  }

  private async mutate(path: string, method: string, body?: unknown): Promise<void> {
    const headers = new Headers({ "x-lca-control-request": "1" });
    if (body !== undefined) headers.set("content-type", "application/json");
    await this.fetchJson(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async fetchJson<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(path, { ...init, credentials: "same-origin" });
    const text = await response.text();
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text };
      }
    }
    if (!response.ok) {
      const errorBody = body as { message?: string; error?: string };
      throw new Error(errorBody.message || errorBody.error || `LCA request failed with HTTP ${response.status}.`);
    }
    return body as T;
  }

  private persistSelection(): void {
    this.setState({
      ...(this.getState() as Record<string, unknown> | undefined),
      selectedWorkspaceKey: this.selectedWorkspaceKey,
      selectedTaskId: this.selectedTaskId,
    });
  }

  private emit(message: ControlCenterStateMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  private emitError(message: string): void {
    if (!this.current) return;
    const state = { ...this.current, scopeError: message, revision: this.current.revision + 1 };
    this.current = state;
    this.emit({ type: "state", state });
  }
}
