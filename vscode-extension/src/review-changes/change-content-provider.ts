import * as vscode from "vscode";
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
    const content = await this.connection.client.getContent(changeId, filePath, side);
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
): vscode.Uri {
  const query = new URLSearchParams({ change: changeId, path: filePath, side }).toString();
  return vscode.Uri.from({
    scheme: REVIEW_SCHEME,
    authority: changeId,
    path: `/${side}/${filePath}`,
    query,
  });
}
