import * as vscode from "vscode";
import {
  archiveWorkspace,
  inspectWorkspaceRemoval,
  makeDefaultWorkspace,
  removeWorkspacePermanently,
  restoreWorkspace,
  startLca,
  stopLca,
} from "../connection/lca-cli.js";
import { ConnectionManager } from "../connection/connection-manager.js";
import type { ControlWorkspace } from "./control-center-store.js";
import { ControlCenterStore } from "./control-center-store.js";

export class ControlCenterActions {
  constructor(
    private readonly connection: ConnectionManager,
    private readonly store: ControlCenterStore,
  ) {}

  async start(): Promise<void> {
    this.assertTrusted();
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Starting Local Coding Agent",
        cancellable: false,
      },
      async () => {
        await startLca(this.cwd());
        await this.waitFor((state) => state.serverOnline);
        await this.store.refresh({ refreshCli: true });
      },
    );
  }

  async stop({ confirm = true }: { confirm?: boolean } = {}): Promise<void> {
    this.assertTrusted();
    if (confirm) {
      const answer = await vscode.window.showWarningMessage(
        "Stop the LCA server, supervisor, and tunnel? Open MCP sessions will disconnect.",
        { modal: true },
        "Stop LCA",
      );
      if (answer !== "Stop LCA") return;
    }
    await stopLca(this.cwd());
    await this.store.refresh({ refreshCli: true });
  }

  async makeDefault(workspaceId: string): Promise<void> {
    this.assertTrusted();
    const workspace = this.workspace(workspaceId);
    if (workspace.registrationState !== "active" || workspace.availability !== "available") {
      throw new Error("Only an active, available workspace can become the default for new tasks.");
    }
    await makeDefaultWorkspace(workspace.id, this.cwd(workspace));
    await this.store.refresh({ refreshCli: true });
  }

  async archive(workspaceId: string): Promise<void> {
    this.assertTrusted();
    const workspace = this.workspace(workspaceId);
    if (workspace.registrationState === "archived") return;
    this.assertNotDefaultOrConfigured(workspace, "archive");
    const openTasks = this.store.current.tasks.filter(
      (task) => task.status === "open" && task.workspaceIds.includes(workspace.id),
    );
    if (openTasks.length) {
      throw new Error(`Close ${openTasks.length} open task(s) before archiving this workspace.`);
    }
    const answer = await vscode.window.showWarningMessage(
      `Archive ${workspace.label}? Its LCA history and workspace ID will be preserved.`,
      { modal: true },
      this.store.current.serverOnline ? "Stop LCA and Archive" : "Archive",
    );
    if (!answer) return;
    if (this.store.current.serverOnline) await this.stop({ confirm: false });
    await archiveWorkspace(workspace.id, this.cwd(workspace));
    await this.store.refresh({ refreshCli: true });
  }

  async restore(workspaceId: string): Promise<void> {
    this.assertTrusted();
    const workspace = this.workspace(workspaceId);
    if (workspace.registrationState === "active") return;
    await restoreWorkspace(workspace.id, this.cwd(workspace));
    await this.store.refresh({ refreshCli: true });
  }

  async removePermanently(workspaceId: string): Promise<void> {
    this.assertTrusted();
    const workspace = this.workspace(workspaceId);
    this.assertNotDefaultOrConfigured(workspace, "remove permanently");
    const multiWorkspaceTasks = this.store.current.tasks.filter(
      (task) => task.workspaceIds.includes(workspace.id) && task.workspaceIds.length > 1,
    );
    if (multiWorkspaceTasks.length) {
      throw new Error(
        `Permanent removal is blocked by ${multiWorkspaceTasks.length} multi-workspace task(s).`,
      );
    }
    const summary = await inspectWorkspaceRemoval(workspace.id, this.cwd(workspace));
    const confirmation = await vscode.window.showInputBox({
      title: `Permanently remove ${workspace.label}`,
      prompt: [
        `${summary.task_count} task(s), ${formatBytes(summary.data_bytes)} total`,
        `${formatBytes(summary.journal_bytes)} journal`,
        `${formatBytes(summary.blob_bytes)} blobs`,
        `${formatBytes(summary.index_bytes)} index`,
        "Source repository files remain unchanged.",
      ].join(" • "),
      placeHolder: `Type ${workspace.label} to confirm`,
      ignoreFocusOut: true,
      validateInput: (value) => value === workspace.label
        ? undefined
        : `Type ${workspace.label} exactly.`,
    });
    if (confirmation === undefined) return;
    if (confirmation !== workspace.label) throw new Error("Workspace label confirmation did not match.");
    if (this.store.current.serverOnline) await this.stop({ confirm: false });
    await removeWorkspacePermanently(
      workspace.id,
      workspace.label,
      this.cwd(workspace),
    );
    await this.store.refresh({ refreshCli: true });
  }

  async closeDetachedTask(taskId: string, workspaceId: string): Promise<void> {
    this.assertTrusted();
    const workspace = this.workspace(workspaceId);
    const task = this.store.current.tasks.find((item) => item.id === taskId);
    if (!task || !task.workspaceIds.includes(workspace.id)) {
      throw new Error("This task is no longer available in the selected workspace.");
    }
    if (task.status !== "open" || task.sessionBound !== false) {
      throw new Error("This task is no longer detached.");
    }
    const answer = await vscode.window.showWarningMessage(
      `Close detached task “${task.title}”? It can no longer be resumed, but its activity, Review Changes history, snapshots and Undo remain available.`,
      { modal: true },
      "Close Detached Task",
    );
    if (answer !== "Close Detached Task") return;
    await this.connection.client.closeDetachedTask(task.id, workspace.id);
    await this.store.refresh({ refreshCli: true });
  }

  async deleteTask(taskId: string, workspaceId: string): Promise<void> {
    this.assertTrusted();
    const workspace = this.workspace(workspaceId);
    const task = this.store.current.tasks.find((item) => item.id === taskId);
    if (!task || !task.workspaceIds.includes(workspace.id)) {
      throw new Error("This task is no longer available in the selected workspace.");
    }
    if (task.status === "open") throw new Error("Close this task before deleting it.");
    const crossWorkspaceNote = task.workspaceIds.length > 1
      ? ` It will also disappear from ${task.workspaceIds.length - 1} other attached workspace(s).`
      : "";
    const answer = await vscode.window.showWarningMessage(
      `Delete task “${task.title}”? Its task activity and Review Changes history will be removed.${crossWorkspaceNote} Source files and Git state remain unchanged.`,
      { modal: true },
      "Delete Task",
    );
    if (answer !== "Delete Task") return;
    await this.connection.client.deleteTask(task.id, workspace.id);
    await this.store.refresh({ refreshCli: true });
  }

  async deleteWorkspaceTasks(workspaceId: string): Promise<void> {
    this.assertTrusted();
    const workspace = this.workspace(workspaceId);
    const tasks = this.store.current.tasks.filter((task) => task.workspaceIds.includes(workspace.id));
    if (!tasks.length) return;
    const openTasks = tasks.filter((task) => task.status === "open");
    if (openTasks.length) {
      throw new Error(`Close ${openTasks.length} open task(s) before deleting all task history for this workspace.`);
    }
    const multiWorkspaceCount = tasks.filter((task) => task.workspaceIds.length > 1).length;
    const crossWorkspaceNote = multiWorkspaceCount
      ? ` ${multiWorkspaceCount} multi-workspace task(s) will also disappear from their other attached workspaces.`
      : "";
    const answer = await vscode.window.showWarningMessage(
      `Delete all task history for ${workspace.label}? Task activity and Review Changes history will be removed.${crossWorkspaceNote} Source files and Git state remain unchanged.`,
      { modal: true },
      "Delete All Tasks",
    );
    if (answer !== "Delete All Tasks") return;
    await this.connection.client.deleteWorkspaceTasks(workspace.id);
    await this.store.refresh({ refreshCli: true });
  }

  private workspace(workspaceId: string): ControlWorkspace {
    const workspace = this.store.current.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) throw new Error("This workspace is no longer registered with LCA.");
    return workspace;
  }

  private assertNotDefaultOrConfigured(workspace: ControlWorkspace, action: string): void {
    if (workspace.isDefault || workspace.isConfiguredStartup) {
      throw new Error(
        `Make another workspace the default for new tasks before attempting to ${action} ${workspace.label}.`,
      );
    }
  }

  private assertTrusted(): void {
    if (!vscode.workspace.isTrusted) {
      throw new Error("Trust this VS Code window before changing LCA operational state.");
    }
  }

  private cwd(workspace?: ControlWorkspace): string | undefined {
    if (workspace?.opened) return workspace.root;
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private async waitFor(predicate: (state: ControlCenterStore["current"]) => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
      await delay(500);
      await this.store.refresh();
      if (predicate(this.store.current)) return;
    }
    throw new Error("LCA did not reach the requested state before the startup deadline.");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(value: number): string {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index++;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
}
