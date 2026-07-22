import * as vscode from "vscode";
import type { ReviewScope } from "../api/api-types.js";
import { ConnectionManager } from "../connection/connection-manager.js";

export const REVIEW_SCHEME = "lca-review";

export class ChangeContentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly connection: ConnectionManager) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const changeId = params.get("change");
    const filePath = params.get("path");
    const side = params.get("side");
    if (!changeId || !filePath || (side !== "before" && side !== "after")) {
      throw new Error("Invalid Review Changes document URI.");
    }
    const content = await this.connection.client.getContent(changeId, filePath, side, {
      workspaceId: params.get("workspace") || undefined,
      taskId: params.get("task") || undefined,
    });
    if (content.content === null) {
      return `Review Changes content is unavailable for ${filePath}.\nReason: ${content.reason || "content_unavailable"}\n`;
    }
    return content.content;
  }
}

export function createSnapshotUri(
  changeId: string,
  filePath: string,
  side: "before" | "after",
  scope: ReviewScope = {},
): vscode.Uri {
  const query = new URLSearchParams({ change: changeId, path: filePath, side });
  if (scope.workspaceId) query.set("workspace", scope.workspaceId);
  if (scope.taskId) query.set("task", scope.taskId);
  return vscode.Uri.from({
    scheme: REVIEW_SCHEME,
    authority: changeId,
    path: `/${side}/${filePath}`,
    query: query.toString(),
  });
}
