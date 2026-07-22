import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import type { HealthResponse } from "../api/api-types.js";
import { LcaApiError, LcaClient } from "../api/lca-client.js";
import { readLcaInstanceNonce } from "./lca-cli.js";

const TOKEN_KEY = "lca.authToken";
const SELECTED_FOLDER_KEY = "lca.selectedWorkspaceFolder";
export const ALL_AVAILABLE_WORKSPACES_KEY = "__all_available_workspaces__";

export type ConnectionState =
  | {
      kind: "connected";
      health: HealthResponse;
      workspaceFolder?: vscode.WorkspaceFolder;
      workspaceFolders: vscode.WorkspaceFolder[];
    }
  | { kind: "server_offline"; message: string }
  | { kind: "workspace_mismatch"; health: HealthResponse; message: string }
  | { kind: "unauthorized"; health?: HealthResponse; message: string }
  | { kind: "no_workspace"; message: string }
  | { kind: "remote_blocked"; message: string };

export interface WorkspaceFolderChoice {
  key: string;
  label: string;
  root: string;
  folderUri?: string;
  workspaceId?: string;
  available: boolean;
  registered: boolean;
  trusted: boolean;
  opened: boolean;
  registrationState: "active" | "archived";
}

export class ConnectionManager {
  private lastHealth: HealthResponse | undefined;
  private selectedWorkspaceFolderUri: string | undefined;
  private instanceNonce: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.selectedWorkspaceFolderUri = context.workspaceState.get<string>(SELECTED_FOLDER_KEY);
  }

  get client(): LcaClient {
    return new LcaClient(
      this.serverUrl,
      async () => this.context.secrets.get(TOKEN_KEY),
      (refresh = false) => this.getInstanceNonce(refresh),
    );
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

  get lastKnownHealth(): HealthResponse | undefined {
    return this.lastHealth;
  }

  get selectedReviewWorkspaceKey(): string {
    return this.selectedWorkspaceFolderUri || ALL_AVAILABLE_WORKSPACES_KEY;
  }

  get preferredWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
      const activeFolder = vscode.workspace.getWorkspaceFolder(activeUri);
      if (activeFolder) return activeFolder;
    }
    return vscode.workspace.workspaceFolders?.[0];
  }

  async selectWorkspaceFolder(folderUri: string | undefined): Promise<void> {
    const key = folderUri || ALL_AVAILABLE_WORKSPACES_KEY;
    this.selectedWorkspaceFolderUri = key;
    await this.context.workspaceState.update(SELECTED_FOLDER_KEY, key);
  }

  async workspaceChoices(health = this.lastHealth): Promise<WorkspaceFolderChoice[]> {
    const folders = vscode.workspace.workspaceFolders || [];
    const descriptors = healthWorkspaceDescriptors(health).filter(
      (descriptor) => descriptor.available && descriptor.registrationState === "active",
    );
    const descriptorRoots = await Promise.all(descriptors.map(async (descriptor) => ({
      ...descriptor,
      normalizedRoot: await canonicalPath(descriptor.root),
    })));
    const folderRoots = await Promise.all(folders.map(async (folder) => ({
      folder,
      root: await canonicalPath(folder.uri.fsPath),
    })));
    const choices: WorkspaceFolderChoice[] = [{
      key: ALL_AVAILABLE_WORKSPACES_KEY,
      label: "All available workspaces",
      root: "",
      workspaceId: "all",
      available: true,
      registered: true,
      trusted: true,
      opened: false,
      registrationState: "active",
    }];
    for (const descriptor of descriptorRoots) {
      if (!descriptor.workspaceId) continue;
      const opened = folderRoots.find((item) => item.root === descriptor.normalizedRoot)?.folder;
      choices.push({
        key: `workspace:${descriptor.workspaceId}`,
        label: descriptor.label || opened?.name || path.basename(descriptor.root),
        root: descriptor.root,
        folderUri: opened?.uri.toString(),
        workspaceId: descriptor.workspaceId,
        available: descriptor.available,
        registered: true,
        trusted: descriptor.trusted,
        opened: Boolean(opened),
        registrationState: descriptor.registrationState,
      });
    }
    return choices;
  }

  workspaceRootFor(health: HealthResponse, workspaceId?: string): string {
    if (workspaceId) {
      const descriptor = healthWorkspaceDescriptors(health).find(
        (item) => item.workspaceId === workspaceId,
      );
      if (!descriptor) {
        throw new Error("LCA did not provide a canonical root for this workspace ID.");
      }
      if (!descriptor.available) {
        throw new Error("This LCA workspace is unavailable.");
      }
      return descriptor.root;
    }
    return health.workspace;
  }

  async isWorkspaceRegistered(
    folder: vscode.WorkspaceFolder,
    health: HealthResponse,
  ): Promise<boolean> {
    const direct = (await this.workspaceChoices(health)).find(
      (choice) => choice.folderUri === folder.uri.toString(),
    );
    return Boolean(direct?.registered && direct.available && direct.trusted);
  }

  async check(signal?: AbortSignal): Promise<ConnectionState> {
    if (!this.isAllowedServerUrl()) {
      return {
        kind: "remote_blocked",
        message: "Remote LCA server URLs are blocked. Enable lca.allowRemoteServer to continue.",
      };
    }

    let health: HealthResponse;
    try {
      health = await this.client.health(signal);
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

    const folders = vscode.workspace.workspaceFolders || [];
    const serverRoots = new Set(
      await Promise.all(healthWorkspaceDescriptors(health)
        .filter((descriptor) => descriptor.available)
        .map((descriptor) => canonicalPath(descriptor.root))),
    );
    const matched: vscode.WorkspaceFolder[] = [];
    for (const folder of folders) {
      if (serverRoots.has(await canonicalPath(folder.uri.fsPath))) matched.push(folder);
    }
    const preferred = this.preferredWorkspaceFolder;
    const workspaceFolder = matched.find(
      (folder) => folder.uri.toString() === preferred?.uri.toString(),
    ) || matched[0];
    return { kind: "connected", health, workspaceFolder, workspaceFolders: matched };
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

  private async getInstanceNonce(refresh: boolean): Promise<string | undefined> {
    if (!refresh && this.instanceNonce) return this.instanceNonce;
    const workspace = this.preferredWorkspaceFolder?.uri.fsPath || os.homedir();
    this.instanceNonce = await readLcaInstanceNonce(workspace);
    return this.instanceNonce;
  }

  async ensureMutationAllowed(
    workspaceId?: string,
  ): Promise<Extract<ConnectionState, { kind: "connected" }>> {
    if (!vscode.workspace.isTrusted) {
      throw new Error("Trust this workspace before changing files from Review Changes.");
    }
    const state = await this.check();
    if (state.kind !== "connected") throw new Error(state.message);
    if (workspaceId) {
      const choice = (await this.workspaceChoices(state.health)).find(
        (workspace) => workspace.workspaceId === workspaceId,
      );
      if (!choice?.opened) {
        throw new Error(
          "Open this workspace in the current trusted VS Code window before Undo or Reapply.",
        );
      }
    }
    try {
      await this.client.listChanges(1, { workspaceId });
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

function healthWorkspaceDescriptors(
  health: HealthResponse | undefined,
): Array<{
  workspaceId?: string;
  root: string;
  label?: string;
  available: boolean;
  trusted: boolean;
  registrationState: "active" | "archived";
}> {
  if (!health) return [];
  const descriptors: Array<{
    workspaceId?: string;
    root: string;
    label?: string;
    available: boolean;
    trusted: boolean;
    registrationState: "active" | "archived";
  }> =
    (health.workspaces || []).flatMap((workspace) => {
      const root = workspace.canonical_root ||
        workspace.canonicalRoot ||
        workspace.root ||
        workspace.path;
      return root
        ? [{
            workspaceId: workspace.workspace_id || workspace.id,
            root,
            label: workspace.label || workspace.metadata?.label,
            available: workspace.available !== false &&
              workspace.availability !== "unavailable",
            trusted: workspace.trusted === true ||
              workspace.trust_state === "trusted" ||
              workspace.metadata?.trusted === true,
            registrationState: workspace.registration_state ||
              workspace.registrationState ||
              "active",
          }]
        : [];
    });
  if (!descriptors.some((item) => path.resolve(item.root) === path.resolve(health.workspace))) {
    descriptors.unshift({
      workspaceId: health.workspace_id || health.selected_workspace_id,
      root: health.workspace,
      label: path.basename(health.workspace),
      available: true,
      trusted: true,
      registrationState: "active",
    });
  }
  return descriptors;
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
