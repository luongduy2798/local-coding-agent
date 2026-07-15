import { access } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import type { ChangeRecord, ChangedFile } from "../api/api-types.js";
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
          if (state.kind === "connected") return;
        }
        throw new Error("LCA started but did not connect to this workspace.");
      },
    );
    await this.store.refresh();
  }

  async openDiff(changeId: string, filePath: string): Promise<void> {
    const { change, file } = this.requireFile(changeId, filePath);
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
      createSnapshotUri(change.id, beforePath, "before"),
      createSnapshotUri(change.id, afterPath, "after"),
      title,
      { preview: true },
    );
  }

  async openCurrentFile(changeId: string, filePath: string): Promise<void> {
    this.requireFile(changeId, filePath);
    const state = await this.connection.check();
    if (state.kind !== "connected") throw new Error(state.message);
    const target = path.resolve(state.health.workspace, filePath);
    await access(target).catch(() => {
      throw new Error(`The current file does not exist: ${filePath}`);
    });
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(document, { preview: true });
  }

  async undoChange(changeId: string): Promise<void> {
    const change = this.requireChange(changeId);
    const affected = change.files.filter(
      (file) => file.undoable && file.undoStatus === "applied",
    ).length;
    const answer = await vscode.window.showWarningMessage(
      `Undo this change? ${affected} file${affected === 1 ? "" : "s"} will be affected.`,
      { modal: true },
      "Undo",
    );
    if (answer !== "Undo") return;
    await this.mutate(() => this.connection.client.undo(change.id));
    await closeReviewDiffs({ changeId: change.id });
  }

  async undoFile(changeId: string, filePath: string): Promise<void> {
    const { change, file } = this.requireFile(changeId, filePath);
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
    await this.mutate(() => this.connection.client.undo(change.id, [file.path]));
    await closeReviewDiffs({
      changeId: change.id,
      paths: group ? [group.from, group.to] : [file.path],
    });
  }

  async reapplyChange(changeId: string): Promise<void> {
    const change = this.requireChange(changeId);
    const answer = await vscode.window.showWarningMessage(
      "Reapply this change?",
      { modal: true },
      "Reapply",
    );
    if (answer !== "Reapply") return;
    await this.mutate(() => this.connection.client.reapply(change.id));
    await closeReviewDiffs({ changeId: change.id });
  }

  async reapplyFile(changeId: string, filePath: string): Promise<void> {
    const { change, file } = this.requireFile(changeId, filePath);
    const group = file.group
      ? change.renameGroups.find((item) => item.id === file.group)
      : undefined;
    const answer = await vscode.window.showWarningMessage(
      `Reapply the recorded change for ${file.path}?`,
      { modal: true },
      "Reapply",
    );
    if (answer !== "Reapply") return;
    await this.mutate(() => this.connection.client.reapply(change.id, [file.path]));
    await closeReviewDiffs({
      changeId: change.id,
      paths: group ? [group.from, group.to] : [file.path],
    });
  }

  async undoAll(): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      "Undo all applicable LCA changes? Changes are processed newest to oldest and this does not use Git.",
      { modal: true },
      "Undo All",
    );
    if (answer !== "Undo All") return;
    await this.mutate(() => this.connection.client.undoAll());
    await closeReviewDiffs();
  }

  async clearHistory(): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      "Clear Review Changes history? Workspace files will not be changed.",
      { modal: true },
      "Clear History",
    );
    if (answer !== "Clear History") return;
    await this.mutate(() => this.connection.client.clear());
    await closeReviewDiffs();
  }

  private requireChange(changeId: string): ChangeRecord {
    const change = this.store.current.changes.find((item) => item.id === changeId);
    if (!change) throw new Error("This change is no longer available. Refresh Review Changes.");
    return change;
  }

  private requireFile(changeId: string, filePath: string): { change: ChangeRecord; file: ChangedFile } {
    const change = this.requireChange(changeId);
    const file = change.files.find((item) => item.path === filePath);
    if (!file) throw new Error("This file change is no longer available. Refresh Review Changes.");
    return { change, file };
  }

  private async mutate(action: () => Promise<unknown>): Promise<void> {
    await this.connection.ensureMutationAllowed();
    try {
      await action();
      await this.store.refresh();
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
}

function snapshotHasText(snapshot: { exists: boolean; type: string; undoable: boolean }): boolean {
  return !snapshot.exists || (snapshot.type === "file" && snapshot.undoable);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ReviewDiffFilter {
  changeId?: string;
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
          path: params.get("path"),
        };
      });

      if (filter.changeId && !descriptors.some((item) => item.changeId === filter.changeId)) {
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
