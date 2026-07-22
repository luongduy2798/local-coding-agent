import { realpath } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import type { ChangeRecord, ChangedFile, ReviewScope } from "../api/api-types.js";
import { LcaApiError } from "../api/lca-client.js";
import { ConnectionManager } from "../connection/connection-manager.js";
import { connectLcaToWorkspace } from "../connection/lca-cli.js";
import { createSnapshotUri, REVIEW_SCHEME } from "./change-content-provider.js";
import { ReviewChangesStore } from "./review-changes-store.js";

export class ReviewChangesActions {
  constructor(
    private readonly connection: ConnectionManager,
    private readonly store: ReviewChangesStore,
  ) {}

  async connect(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      throw new Error("Trust this workspace before registering or starting LCA.");
    }
    const folder = this.connection.preferredWorkspaceFolder;
    if (!folder) throw new Error("Open a workspace before connecting LCA.");
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Connecting LCA to ${folder.name}`,
        cancellable: false,
      },
      async () => {
        await connectLcaToWorkspace(folder.uri.fsPath);
        for (let attempt = 0; attempt < 20; attempt++) {
          await delay(500);
          const state = await this.connection.check();
          if (state.kind !== "connected") continue;
          if (await this.connection.isWorkspaceRegistered(folder, state.health)) return;
        }
        throw new Error("LCA started but did not register this workspace.");
      },
    );
    await this.store.refresh();
  }

  async openDiff(changeId: string, filePath: string, workspaceId?: string): Promise<void> {
    const { change, file } = this.requireFile(changeId, filePath, workspaceId);
    let beforePath = file.path;
    let afterPath = file.path;
    let beforeFile = file;
    let afterFile = file;
    let title = `Review Changes: ${file.path}`;

    if (file.group) {
      const group = change.renameGroups.find((item) => item.id === file.group);
      if (group) {
        beforePath = group.from;
        afterPath = group.to;
        beforeFile = change.files.find((item) => item.path === group.from) || file;
        afterFile = change.files.find((item) => item.path === group.to) || file;
        title = `Review Changes: ${group.from} → ${group.to}`;
      }
    }

    if (!snapshotHasText(beforeFile.before) || !snapshotHasText(afterFile.after)) {
      throw new Error("This change only contains metadata, so its diff is unavailable.");
    }

    await vscode.commands.executeCommand(
      "vscode.diff",
      createSnapshotUri(change.id, beforePath, "before", scopeFor(change)),
      createSnapshotUri(change.id, afterPath, "after", scopeFor(change)),
      title,
      { preview: true },
    );
  }

  async openCurrentFile(changeId: string, filePath: string, workspaceId?: string): Promise<void> {
    const { change } = this.requireFile(changeId, filePath, workspaceId);
    const state = await this.connection.check();
    if (state.kind !== "connected") throw new Error(state.message);
    const folder = this.store.current.workspaceOptions.find(
      (workspace) => (
        (change.workspace_id && workspace.workspaceId === change.workspace_id) ||
        (change.workspace_key && workspace.key === change.workspace_key)
      ),
    );
    if (
      change.workspace_id &&
      (!folder || !folder.registered || !folder.available || !folder.opened)
    ) {
      throw new Error("The change workspace is not an available folder in this VS Code window.");
    }
    const root = folder?.root || this.connection.workspaceRootFor(
      state.health,
      change.workspace_id,
    );
    const target = path.resolve(root, filePath);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`The recorded path is outside its workspace: ${filePath}`);
    }
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      realpath(root),
      realpath(target),
    ]).catch(() => {
      throw new Error(`The current file does not exist: ${filePath}`);
    });
    const canonicalRelative = path.relative(canonicalRoot, canonicalTarget);
    if (canonicalRelative.startsWith("..") || path.isAbsolute(canonicalRelative)) {
      throw new Error(`The current file resolves outside its workspace: ${filePath}`);
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(canonicalTarget));
    await vscode.window.showTextDocument(document, { preview: true });
  }

  async undoChange(changeId: string, workspaceId?: string): Promise<void> {
    const change = this.requireChange(changeId, workspaceId);
    const affected = change.files.filter(
      (file) => file.undoable && file.undoStatus === "applied",
    ).length;
    const answer = await vscode.window.showWarningMessage(
      `Undo this change? ${affected} file${affected === 1 ? "" : "s"} will be affected.`,
      { modal: true },
      "Undo",
    );
    if (answer !== "Undo") return;
    await this.mutate(change.workspace_id, () => this.connection.client.undo(
      change.id,
      undefined,
      scopeFor(change),
    ));
    await closeReviewDiffs({ changeId: change.id, workspaceId: change.workspace_id });
  }

  async undoFile(changeId: string, filePath: string, workspaceId?: string): Promise<void> {
    const { change, file } = this.requireFile(changeId, filePath, workspaceId);
    const group = file.group
      ? change.renameGroups.find((item) => item.id === file.group)
      : undefined;
    const detail = group
      ? `This is an atomic rename. Both ${group.from} and ${group.to} will be affected.`
      : file.path;
    const answer = await vscode.window.showWarningMessage(
      `Undo this file change?\n${detail}`,
      { modal: true },
      "Undo",
    );
    if (answer !== "Undo") return;
    await this.mutate(change.workspace_id, () => this.connection.client.undo(
      change.id,
      [file.path],
      scopeFor(change),
    ));
    await closeReviewDiffs({
      changeId: change.id,
      workspaceId: change.workspace_id,
      paths: group ? [group.from, group.to] : [file.path],
    });
  }

  async reapplyChange(changeId: string, workspaceId?: string): Promise<void> {
    const change = this.requireChange(changeId, workspaceId);
    const answer = await vscode.window.showWarningMessage(
      "Reapply this change?",
      { modal: true },
      "Reapply",
    );
    if (answer !== "Reapply") return;
    await this.mutate(change.workspace_id, () => this.connection.client.reapply(
      change.id,
      undefined,
      scopeFor(change),
    ));
    await closeReviewDiffs({ changeId: change.id, workspaceId: change.workspace_id });
  }

  async reapplyFile(changeId: string, filePath: string, workspaceId?: string): Promise<void> {
    const { change, file } = this.requireFile(changeId, filePath, workspaceId);
    const group = file.group
      ? change.renameGroups.find((item) => item.id === file.group)
      : undefined;
    const answer = await vscode.window.showWarningMessage(
      `Reapply the recorded change for ${file.path}?`,
      { modal: true },
      "Reapply",
    );
    if (answer !== "Reapply") return;
    await this.mutate(change.workspace_id, () => this.connection.client.reapply(
      change.id,
      [file.path],
      scopeFor(change),
    ));
    await closeReviewDiffs({
      changeId: change.id,
      workspaceId: change.workspace_id,
      paths: group ? [group.from, group.to] : [file.path],
    });
  }

  async undoAll(): Promise<void> {
    const scope = this.requireBulkWorkspaceScope("Undo All");
    const answer = await vscode.window.showWarningMessage(
      "Undo all applicable LCA changes? Changes are processed newest to oldest and this does not use Git.",
      { modal: true },
      "Undo All",
    );
    if (answer !== "Undo All") return;
    this.assertBulkWorkspaceScope(scope, "Undo All");
    await this.mutate(scope.workspaceId, () => this.connection.client.undoAll(scope));
    await closeReviewDiffs();
  }

  async clearHistory(): Promise<void> {
    const scope = this.requireBulkWorkspaceScope("Clear History");
    const answer = await vscode.window.showWarningMessage(
      "Clear Review Changes history? Workspace files will not be changed.",
      { modal: true },
      "Clear History",
    );
    if (answer !== "Clear History") return;
    this.assertBulkWorkspaceScope(scope, "Clear History");
    await this.mutate(scope.workspaceId, () => this.connection.client.clear(scope));
    await closeReviewDiffs();
  }

  private requireChange(changeId: string, workspaceId?: string): ChangeRecord {
    const change = this.store.current.changes.find(
      (item) => item.id === changeId &&
        (!workspaceId || item.workspace_id === workspaceId),
    );
    if (!change) throw new Error("This change is no longer available. Refresh Review Changes.");
    return change;
  }

  private requireFile(
    changeId: string,
    filePath: string,
    workspaceId?: string,
  ): { change: ChangeRecord; file: ChangedFile } {
    const change = this.requireChange(changeId, workspaceId);
    const file = change.files.find((item) => item.path === filePath);
    if (!file) throw new Error("This file change is no longer available. Refresh Review Changes.");
    return { change, file };
  }

  private async mutate(
    workspaceId: string | undefined,
    action: () => Promise<unknown>,
  ): Promise<void> {
    await this.connection.ensureMutationAllowed(workspaceId);
    try {
      await action();
      await this.store.refresh({ cancelCurrent: true });
    } catch (error) {
      if (error instanceof LcaApiError && error.status === 409) {
        const paths = error.body.files?.map((file) => file.path).join(", ");
        throw new Error(
          paths
            ? `These files changed outside LCA: ${paths}. No files were modified.`
            : `${error.message} No files were modified.`,
        );
      }
      throw error;
    }
  }

  private requireBulkWorkspaceScope(action: string): ReviewScope {
    const state = this.store.current;
    if (!state.selectedTaskId) {
      throw new Error(
        `Select one task before using ${action}.`,
      );
    }
    const selected = state.workspaceOptions.find(
      (workspace) => workspace.key === state.selectedWorkspaceKey,
    );
    if (!selected) {
      throw new Error(`Select one workspace before using ${action}.`);
    }
    if (!selected.registered || !selected.available || !selected.opened || !selected.workspaceId) {
      throw new Error(
        `${action} requires an available workspace with a verified workspace ID.`,
      );
    }
    const task = state.taskOptions.find((item) => item.taskId === state.selectedTaskId);
    if (!task?.apiTaskId) {
      throw new Error(`${action} requires a V5 task ID.`);
    }
    return { workspaceId: selected.workspaceId, taskId: task.apiTaskId };
  }

  private assertBulkWorkspaceScope(scope: ReviewScope, action: string): void {
    const selected = this.store.current.workspaceOptions.find(
      (workspace) => workspace.key === this.store.current.selectedWorkspaceKey,
    );
    if (
      !this.store.current.selectedTaskId ||
      !selected?.registered ||
      !selected.available ||
      !selected.opened ||
      selected.workspaceId !== scope.workspaceId ||
      this.store.current.taskOptions.find(
        (item) => item.taskId === this.store.current.selectedTaskId,
      )?.apiTaskId !== scope.taskId
    ) {
      throw new Error(
        `The review context changed while confirming ${action}. No request was sent.`,
      );
    }
  }
}

function scopeFor(change: ChangeRecord): ReviewScope {
  return {
    workspaceId: change.workspace_id,
    taskId: change.task_id,
  };
}

function snapshotHasText(snapshot: { exists: boolean; type: string; undoable: boolean }): boolean {
  return !snapshot.exists || (snapshot.type === "file" && snapshot.undoable);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ReviewDiffFilter {
  changeId?: string;
  workspaceId?: string;
  paths?: readonly string[];
}

async function closeReviewDiffs(filter: ReviewDiffFilter = {}): Promise<void> {
  const requestedPaths = filter.paths ? new Set(filter.paths) : undefined;
  const tabs: vscode.Tab[] = [];

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputTextDiff)) continue;
      const reviewUris = [tab.input.original, tab.input.modified].filter(
        (uri) => uri.scheme === REVIEW_SCHEME,
      );
      if (!reviewUris.length) continue;

      const descriptors = reviewUris.map((uri) => {
        const params = new URLSearchParams(uri.query);
        return {
          changeId: params.get("change"),
          workspaceId: params.get("workspace"),
          path: params.get("path"),
        };
      });

      if (filter.changeId && !descriptors.some((item) => item.changeId === filter.changeId)) {
        continue;
      }
      if (
        filter.workspaceId &&
        !descriptors.some((item) => item.workspaceId === filter.workspaceId)
      ) {
        continue;
      }
      if (requestedPaths && !descriptors.some((item) => item.path && requestedPaths.has(item.path))) {
        continue;
      }
      tabs.push(tab);
    }
  }

  if (!tabs.length) return;
  await vscode.window.tabGroups.close(tabs, true).then(undefined, () => false);
}
