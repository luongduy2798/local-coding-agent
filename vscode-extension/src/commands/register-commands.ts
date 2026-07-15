import * as vscode from "vscode";
import { ConnectionManager } from "../connection/connection-manager.js";
import { ReviewChangesActions } from "../review-changes/review-changes-actions.js";
import { ReviewChangesStore } from "../review-changes/review-changes-store.js";
import { ReviewChangesWebviewProvider } from "../review-changes/review-changes-webview-provider.js";

export function registerCommands(
  context: vscode.ExtensionContext,
  connection: ConnectionManager,
  store: ReviewChangesStore,
  actions: ReviewChangesActions,
  webviewProvider: ReviewChangesWebviewProvider,
): void {
  const register = (name: string, handler: (...args: unknown[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(name, handler));
  };

  register("lca.reviewChanges.refresh", () => store.refresh());
  register("lca.reviewChanges.connect", () => actions.connect());
  register("lca.reviewChanges.undoAll", () => actions.undoAll());
  register("lca.reviewChanges.clear", () => actions.clearHistory());
  register("lca.reviewChanges.setToken", async () => {
    if (await connection.setToken()) await store.refresh();
  });
  register("lca.reviewChanges.removeToken", async () => {
    await connection.removeToken();
    await store.refresh();
    void vscode.window.showInformationMessage("LCA authentication token removed.");
  });
  register("lca.reviewChanges.testConnection", async () => {
    const state = await connection.check();
    if (state.kind === "connected") {
      void vscode.window.showInformationMessage(
        `Connected to LCA ${state.health.version} for ${state.health.workspace}.`,
      );
    } else {
      void vscode.window.showWarningMessage(state.message);
    }
  });

  for (const command of [
    "lca.reviewChanges.openDiff",
    "lca.reviewChanges.openCurrentFile",
    "lca.reviewChanges.undoChange",
    "lca.reviewChanges.undoFile",
    "lca.reviewChanges.reapplyChange",
    "lca.reviewChanges.reapplyFile",
  ]) {
    register(command, async () => {
      await webviewProvider.focus();
      void vscode.window.showInformationMessage(
        "Use the action buttons inside the Review Changes card.",
      );
    });
  }
}
