import { realpath } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import type { HealthResponse } from "../api/api-types.js";
import { LcaApiError, LcaClient } from "../api/lca-client.js";

const TOKEN_KEY = "lca.authToken";

export type ConnectionState =
  | { kind: "connected"; health: HealthResponse; workspaceFolder: vscode.WorkspaceFolder }
  | { kind: "server_offline"; message: string }
  | { kind: "workspace_mismatch"; health: HealthResponse; message: string }
  | { kind: "unauthorized"; health?: HealthResponse; message: string }
  | { kind: "no_workspace"; message: string }
  | { kind: "remote_blocked"; message: string };

export class ConnectionManager {
  private lastHealth: HealthResponse | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  get client(): LcaClient {
    return new LcaClient(this.serverUrl, async () => this.context.secrets.get(TOKEN_KEY));
  }

  get serverUrl(): string {
    const configured = vscode.workspace
      .getConfiguration("lca")
      .get<string>("serverUrl", "http://127.0.0.1:8789");
    return configured.replace(/\/+$/, "");
  }

  get workspaceRoot(): string | undefined {
    return this.lastHealth?.workspace;
  }

  get preferredWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
      const activeFolder = vscode.workspace.getWorkspaceFolder(activeUri);
      if (activeFolder) return activeFolder;
    }
    return vscode.workspace.workspaceFolders?.[0];
  }

  async check(): Promise<ConnectionState> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      return { kind: "no_workspace", message: "Open a workspace to use Review Changes." };
    }

    if (!this.isAllowedServerUrl()) {
      return {
        kind: "remote_blocked",
        message: "Remote LCA server URLs are blocked. Enable lca.allowRemoteServer to continue.",
      };
    }

    let health: HealthResponse;
    try {
      health = await this.client.health();
      this.lastHealth = health;
    } catch (error) {
      return {
        kind: "server_offline",
        message: error instanceof Error ? error.message : "Unable to connect to LCA.",
      };
    }

    if (health.auth === "bearer" && !(await this.context.secrets.get(TOKEN_KEY))) {
      return {
        kind: "unauthorized",
        health,
        message: "LCA requires an authentication token.",
      };
    }

    const serverWorkspace = await canonicalPath(health.workspace);
    for (const folder of folders) {
      if ((await canonicalPath(folder.uri.fsPath)) === serverWorkspace) {
        return { kind: "connected", health, workspaceFolder: folder };
      }
    }

    return {
      kind: "workspace_mismatch",
      health,
      message: `LCA is running for ${health.workspace}, not the current VS Code workspace.`,
    };
  }

  async setToken(): Promise<boolean> {
    const token = await vscode.window.showInputBox({
      title: "Set LCA Authentication Token",
      prompt: "The token is stored in VS Code SecretStorage.",
      password: true,
      ignoreFocusOut: true,
    });
    if (!token) return false;
    await this.context.secrets.store(TOKEN_KEY, token.trim());
    return true;
  }

  async removeToken(): Promise<void> {
    await this.context.secrets.delete(TOKEN_KEY);
  }

  async ensureMutationAllowed(): Promise<Extract<ConnectionState, { kind: "connected" }>> {
    if (!vscode.workspace.isTrusted) {
      throw new Error("Trust this workspace before changing files from Review Changes.");
    }
    const state = await this.check();
    if (state.kind !== "connected") throw new Error(state.message);
    try {
      await this.client.listChanges(1);
    } catch (error) {
      if (error instanceof LcaApiError && error.status === 401) {
        throw new Error("The LCA authentication token is missing or invalid.");
      }
      throw error;
    }
    return state;
  }

  private isAllowedServerUrl(): boolean {
    let parsed: URL;
    try {
      parsed = new URL(this.serverUrl);
    } catch {
      return false;
    }
    const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
    return local || vscode.workspace.getConfiguration("lca").get<boolean>("allowRemoteServer", false);
  }
}

async function canonicalPath(value: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(value);
  } catch {
    resolved = path.resolve(value);
  }
  const normalized = path.normalize(resolved).replace(/[\\/]+$/, "");
  return process.platform === "win32" || process.platform === "darwin"
    ? normalized.toLowerCase()
    : normalized;
}
