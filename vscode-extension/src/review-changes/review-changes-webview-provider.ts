import * as vscode from "vscode";
import type { ApiRevision, ChangeRecord } from "../api/api-types.js";
import type { ConnectionState } from "../connection/connection-manager.js";
import { ConnectionManager } from "../connection/connection-manager.js";
import { ControlCenterActions } from "../control-center/control-center-actions.js";
import type { ControlCenterState } from "../control-center/control-center-store.js";
import { ControlCenterStore } from "../control-center/control-center-store.js";
import { ReviewChangesActions } from "./review-changes-actions.js";
import { ReviewChangesStore } from "./review-changes-store.js";

interface WebviewMessage {
  type: string;
  changeId?: string;
  path?: string;
  workspaceId?: string;
  value?: string;
  requestId?: string;
  revision?: number;
}

const REVISION_FENCED_MESSAGES = new Set([
  "selectWorkspace",
  "selectTask",
  "connect",
  "undoChange",
  "reapplyChange",
  "undoFile",
  "reapplyFile",
  "openDiff",
  "openCurrentFile",
  "undoAll",
  "clear",
  "startLca",
  "stopLca",
  "makeDefaultWorkspace",
  "archiveWorkspace",
  "restoreWorkspace",
  "removeWorkspace",
  "viewWorkspaceHistory",
]);

interface WebviewState {
  loading: boolean;
  revision: number;
  serverRevision?: ApiRevision;
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
  connection?: SerializableConnectionState;
  changes: ChangeRecord[];
  control: ControlCenterState;
}

type SerializableConnectionState =
  | { kind: "connected"; workspace: string; version: string; workspaceCount: number }
  | { kind: "server_offline"; message: string }
  | { kind: "workspace_mismatch"; message: string; workspace: string }
  | { kind: "unauthorized"; message: string }
  | { kind: "no_workspace"; message: string }
  | { kind: "remote_blocked"; message: string };

export class ReviewChangesWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private busyAction: string | undefined;
  private outboundRevision = 0;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly processedMessageIds = new Set<string>();
  private readonly processedMessageOrder: string[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connection: ConnectionManager,
    private readonly store: ReviewChangesStore,
    private readonly actions: ReviewChangesActions,
    private readonly controlStore: ControlCenterStore,
    private readonly controlActions: ControlCenterActions,
  ) {
    this.subscriptions.push(
      this.store.onDidChange(() => void this.postState()),
      this.controlStore.onDidChange(() => void this.postState()),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    view.webview.html = this.getHtml(view.webview);

    this.subscriptions.push(
      view.webview.onDidReceiveMessage((message: WebviewMessage) => this.handleMessage(message)),
      view.onDidChangeVisibility(() => {
        this.store.setVisible(view.visible);
        this.controlStore.setVisible(view.visible);
        if (view.visible) void this.postState();
      }),
    );

    this.store.setVisible(view.visible);
    this.controlStore.setVisible(view.visible);
    void this.store.refresh();
    void this.controlStore.refresh();
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.lca");
    await vscode.commands.executeCommand("lca.reviewChanges.focus");
    await this.store.refresh();
    await this.controlStore.refresh();
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (message.requestId && this.isDuplicateMessage(message.requestId)) return;
    if (
      REVISION_FENCED_MESSAGES.has(message.type) &&
      message.revision !== this.outboundRevision
    ) {
      // The workspace/task/change state advanced after this UI action was
      // created. Re-sync the view and never execute it against a new context.
      await this.postState();
      return;
    }
    const changeId = message.changeId || "";
    const filePath = message.path || "";
    const workspaceId = message.workspaceId || undefined;
    switch (message.type) {
      case "ready":
        await this.postState();
        return;
      case "refresh":
        await this.run(message.type, async () => {
          await Promise.all([
            this.store.refresh({ cancelCurrent: true }),
            this.controlStore.refresh(),
          ]);
        });
        return;
      case "selectWorkspace":
        await this.run("selectWorkspace", () => this.store.selectWorkspace(message.value || undefined));
        return;
      case "selectTask":
        await this.run("selectTask", () => this.store.selectTask(message.value || undefined));
        return;
      case "connect":
        await this.run("connect", () => this.actions.connect());
        return;
      case "startLca":
        await this.run("startLca", () => this.controlActions.start());
        return;
      case "stopLca":
        await this.run("stopLca", () => this.controlActions.stop());
        return;
      case "makeDefaultWorkspace":
        await this.run(`default:${workspaceId || ""}`, () => this.controlActions.makeDefault(workspaceId || ""));
        return;
      case "archiveWorkspace":
        await this.run(`archive:${workspaceId || ""}`, () => this.controlActions.archive(workspaceId || ""));
        return;
      case "restoreWorkspace":
        await this.run(`restore:${workspaceId || ""}`, () => this.controlActions.restore(workspaceId || ""));
        return;
      case "removeWorkspace":
        await this.run(`remove:${workspaceId || ""}`, () => this.controlActions.removePermanently(workspaceId || ""));
        return;
      case "viewWorkspaceHistory":
        await this.run(`history:${workspaceId || ""}`, async () => {
          const workspace = this.controlStore.current.workspaces.find((item) => item.id === workspaceId);
          if (!workspace) throw new Error("This workspace is no longer registered.");
          await this.store.viewArchivedWorkspaceHistory({
            workspaceId: workspace.id,
            label: workspace.label,
            root: workspace.root,
            opened: workspace.opened,
          });
        });
        return;
      case "setToken":
        await this.run("setToken", async () => {
          if (await this.connection.setToken()) await this.store.refresh();
        });
        return;
      case "undoChange":
        await this.run(
          `undo:${workspaceId || ""}:${changeId}`,
          () => this.actions.undoChange(changeId, workspaceId),
        );
        return;
      case "reapplyChange":
        await this.run(
          `reapply:${workspaceId || ""}:${changeId}`,
          () => this.actions.reapplyChange(changeId, workspaceId),
        );
        return;
      case "undoFile":
        await this.run(
          `undo:${workspaceId || ""}:${changeId}:${filePath}`,
          () => this.actions.undoFile(changeId, filePath, workspaceId),
        );
        return;
      case "reapplyFile":
        await this.run(
          `reapply:${workspaceId || ""}:${changeId}:${filePath}`,
          () => this.actions.reapplyFile(changeId, filePath, workspaceId),
        );
        return;
      case "openDiff":
        await this.run(
          `diff:${workspaceId || ""}:${changeId}:${filePath}`,
          () => this.actions.openDiff(changeId, filePath, workspaceId),
        );
        return;
      case "openCurrentFile":
        await this.run(
          `open:${workspaceId || ""}:${changeId}:${filePath}`,
          () => this.actions.openCurrentFile(changeId, filePath, workspaceId),
        );
        return;
      case "undoAll":
        await this.run("undoAll", () => this.actions.undoAll());
        return;
      case "clear":
        await this.run("clear", () => this.actions.clearHistory());
        return;
    }
  }

  private async run(name: string, action: () => Promise<void>): Promise<void> {
    if (this.busyAction) return;
    this.busyAction = name;
    await this.postState();
    try {
      await action();
    } catch (error) {
      void vscode.window.showErrorMessage(
        error instanceof Error ? error.message : "Review Changes operation failed.",
      );
    } finally {
      this.busyAction = undefined;
      await this.postState();
    }
  }

  private async postState(): Promise<void> {
    if (!this.view) return;
    const current = this.store.current;
    const selected = current.workspaceOptions.find(
      (item) => item.key === current.selectedWorkspaceKey,
    );
    const state: WebviewState = {
      loading: current.loading,
      revision: ++this.outboundRevision,
      serverRevision: current.serverRevision,
      syncMode: current.syncMode,
      busyAction: this.busyAction,
      trusted: vscode.workspace.isTrusted,
      currentWorkspace: selected?.root || this.connection.preferredWorkspaceFolder?.uri.fsPath,
      selectedWorkspaceKey: current.selectedWorkspaceKey,
      selectedTaskId: current.selectedTaskId,
      scopeError: current.scopeError,
      workspaceOptions: current.workspaceOptions,
      taskOptions: current.taskOptions,
      connection: serializeConnection(
        current.connection,
        current.workspaceOptions.filter(
          (workspace) => workspace.registered && workspace.available,
        ).length,
      ),
      changes: current.changes,
      control: this.controlStore.current,
    };
    await this.view.webview.postMessage({ type: "state", state });
  }

  private isDuplicateMessage(requestId: string): boolean {
    if (this.processedMessageIds.has(requestId)) return true;
    this.processedMessageIds.add(requestId);
    this.processedMessageOrder.push(requestId);
    if (this.processedMessageOrder.length > 200) {
      const oldest = this.processedMessageOrder.shift();
      if (oldest) this.processedMessageIds.delete(oldest);
    }
    return false;
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.css"),
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>LCA Control Center</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function serializeConnection(
  state: ConnectionState | undefined,
  registeredWorkspaceCount = 0,
): SerializableConnectionState | undefined {
  if (!state) return undefined;
  if (state.kind === "connected") {
    return {
      kind: state.kind,
      workspace: state.health.workspace,
      version: state.health.version,
      workspaceCount: Math.max(state.workspaceFolders.length, registeredWorkspaceCount),
    };
  }
  if (state.kind === "workspace_mismatch") {
    return { kind: state.kind, message: state.message, workspace: state.health.workspace };
  }
  return { kind: state.kind, message: state.message };
}

function getNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index++) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}
