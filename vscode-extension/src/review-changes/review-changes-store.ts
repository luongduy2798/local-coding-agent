import * as vscode from "vscode";
import type { ChangeRecord } from "../api/api-types.js";
import { LcaApiError } from "../api/lca-client.js";
import type { ConnectionState } from "../connection/connection-manager.js";
import { ConnectionManager } from "../connection/connection-manager.js";

export interface ReviewChangesState {
  connection?: ConnectionState;
  changes: ChangeRecord[];
  loading: boolean;
}

export class ReviewChangesStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ReviewChangesState>();
  readonly onDidChange = this.emitter.event;

  private state: ReviewChangesState = {
    changes: [],
    loading: true,
  };
  private refreshPromise: Promise<void> | undefined;
  private pollingTimer: NodeJS.Timeout | undefined;
  private visible = false;

  constructor(private readonly connection: ConnectionManager) {}

  get current(): ReviewChangesState {
    return this.state;
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.load().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.restartPolling();
    if (visible) void this.refresh();
  }

  restartPolling(): void {
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    this.pollingTimer = undefined;
    const config = vscode.workspace.getConfiguration("lca.reviewChanges");
    if (!this.visible || !config.get<boolean>("autoRefresh", true)) return;
    const interval = Math.max(1000, config.get<number>("refreshInterval", 2000));
    this.pollingTimer = setInterval(() => void this.refresh(), interval);
  }

  dispose(): void {
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    this.emitter.dispose();
  }

  private async load(): Promise<void> {
    this.state = { ...this.state, loading: true };
    this.emit();

    let connectionState = await this.connection.check();
    let changes: ChangeRecord[] = [];
    if (connectionState.kind === "connected") {
      try {
        const response = await this.connection.client.listChanges(1);
        changes = response.changes.slice(0, 1);
      } catch (error) {
        connectionState = error instanceof LcaApiError && error.status === 401
          ? { kind: "unauthorized", message: "The LCA authentication token is invalid." }
          : {
              kind: "server_offline",
              message: error instanceof Error ? error.message : "Unable to load Review Changes.",
            };
      }
    }

    this.state = {
      connection: connectionState,
      changes,
      loading: false,
    };
    this.emit();
  }

  private emit(): void {
    this.emitter.fire(this.state);
  }
}
