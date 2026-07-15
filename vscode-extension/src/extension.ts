import * as vscode from "vscode";
import { registerCommands } from "./commands/register-commands.js";
import { ConnectionManager } from "./connection/connection-manager.js";
import {
  ChangeContentProvider,
  REVIEW_SCHEME,
} from "./review-changes/change-content-provider.js";
import { ReviewChangesActions } from "./review-changes/review-changes-actions.js";
import { ReviewChangesStore } from "./review-changes/review-changes-store.js";
import { ReviewChangesWebviewProvider } from "./review-changes/review-changes-webview-provider.js";

export function activate(context: vscode.ExtensionContext): void {
  const connection = new ConnectionManager(context);
  const store = new ReviewChangesStore(connection);
  const actions = new ReviewChangesActions(connection, store);
  const webviewProvider = new ReviewChangesWebviewProvider(
    context,
    connection,
    store,
    actions,
  );
  const contentProvider = new ChangeContentProvider(connection);

  context.subscriptions.push(
    store,
    webviewProvider,
    vscode.window.registerWebviewViewProvider(
      "lca.reviewChanges",
      webviewProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, contentProvider),
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        if (uri.path !== "/review-changes") return;
        await webviewProvider.focus();
      },
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("lca")) {
        store.restartPolling();
        void store.refresh();
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void store.refresh()),
  );

  registerCommands(context, connection, store, actions, webviewProvider);
}

export function deactivate(): void {}
