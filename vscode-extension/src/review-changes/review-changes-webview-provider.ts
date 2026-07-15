import * as vscode from "vscode";
import type { ChangeRecord } from "../api/api-types.js";
import type { ConnectionState } from "../connection/connection-manager.js";
import { ConnectionManager } from "../connection/connection-manager.js";
import { ReviewChangesActions } from "./review-changes-actions.js";
import { ReviewChangesStore } from "./review-changes-store.js";

interface WebviewMessage {
  type: string;
  changeId?: string;
  path?: string;
}

interface WebviewState {
  loading: boolean;
  busyAction?: string;
  trusted: boolean;
  currentWorkspace?: string;
  connection?: SerializableConnectionState;
  changes: ChangeRecord[];
}

type SerializableConnectionState =
  | { kind: "connected"; workspace: string; version: string }
  | { kind: "server_offline"; message: string }
  | { kind: "workspace_mismatch"; message: string; workspace: string }
  | { kind: "unauthorized"; message: string }
  | { kind: "no_workspace"; message: string }
  | { kind: "remote_blocked"; message: string };

export class ReviewChangesWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private busyAction: string | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connection: ConnectionManager,
    private readonly store: ReviewChangesStore,
    private readonly actions: ReviewChangesActions,
  ) {
    this.subscriptions.push(
      this.store.onDidChange(() => void this.postState()),
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
        if (view.visible) void this.postState();
      }),
    );

    this.store.setVisible(view.visible);
    void this.store.refresh();
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.lca");
    await vscode.commands.executeCommand("lca.reviewChanges.focus");
    await this.store.refresh();
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    const changeId = message.changeId || "";
    const filePath = message.path || "";
    switch (message.type) {
      case "ready":
      case "refresh":
        await this.run(message.type, () => this.store.refresh());
        return;
      case "connect":
        await this.run("connect", () => this.actions.connect());
        return;
      case "setToken":
        await this.run("setToken", async () => {
          if (await this.connection.setToken()) await this.store.refresh();
        });
        return;
      case "undoChange":
        await this.run(`undo:${changeId}`, () => this.actions.undoChange(changeId));
        return;
      case "reapplyChange":
        await this.run(`reapply:${changeId}`, () => this.actions.reapplyChange(changeId));
        return;
      case "undoFile":
        await this.run(`undo:${changeId}:${filePath}`, () => this.actions.undoFile(changeId, filePath));
        return;
      case "reapplyFile":
        await this.run(`reapply:${changeId}:${filePath}`, () => this.actions.reapplyFile(changeId, filePath));
        return;
      case "openDiff":
        await this.run(`diff:${changeId}:${filePath}`, () => this.actions.openDiff(changeId, filePath));
        return;
      case "openCurrentFile":
        await this.run(`open:${changeId}:${filePath}`, () => this.actions.openCurrentFile(changeId, filePath));
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
    const state: WebviewState = {
      loading: current.loading,
      busyAction: this.busyAction,
      trusted: vscode.workspace.isTrusted,
      currentWorkspace: this.connection.preferredWorkspaceFolder?.uri.fsPath,
      connection: serializeConnection(current.connection),
      changes: current.changes,
    };
    await this.view.webview.postMessage({ type: "state", state });
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
  <title>Review Changes</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function serializeConnection(state: ConnectionState | undefined): SerializableConnectionState | undefined {
  if (!state) return undefined;
  if (state.kind === "connected") {
    return { kind: state.kind, workspace: state.health.workspace, version: state.health.version };
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
