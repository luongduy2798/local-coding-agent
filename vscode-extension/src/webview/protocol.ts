import type {
  ApiRevision,
  ChangeRecord,
  WorkspaceMemorySnapshot,
} from "../api/api-types.js";
import type { ControlStateView } from "./control-center.js";

export type ControlCenterHostKind = "vscode" | "jetbrains" | "browser";

export interface ControlCenterHostCapabilities {
  runtimeControl: boolean;
  workspaceManagement: boolean;
  taskManagement: boolean;
  changeMutation: boolean;
  memoryManagement: boolean;
  nativeOpenFile: boolean;
  nativeDiff: boolean;
  secretStorage: boolean;
}

export type SerializableConnectionState =
  | { kind: "connected"; workspace: string; version: string; workspaceCount: number }
  | { kind: "server_offline"; message: string }
  | { kind: "workspace_mismatch"; message: string; workspace: string }
  | { kind: "unauthorized"; message: string }
  | { kind: "no_workspace"; message: string }
  | { kind: "remote_blocked"; message: string };

export interface WorkspaceOptionState {
  key: string;
  label: string;
  root: string;
  workspaceId?: string;
  available: boolean;
  registered: boolean;
  trusted: boolean;
  opened: boolean;
  registrationState: "active" | "archived";
}

export interface TaskOptionState {
  taskId: string;
  title: string;
  status?: string;
}

export interface ControlCenterViewState {
  loading: boolean;
  revision: number;
  serverRevision?: ApiRevision;
  syncMode: "idle" | "sse" | "polling";
  busyAction?: string;
  trusted: boolean;
  currentWorkspace?: string;
  selectedWorkspaceKey?: string;
  selectedTaskId?: string;
  scopeError?: string;
  workspaceOptions: WorkspaceOptionState[];
  taskOptions: TaskOptionState[];
  connection?: SerializableConnectionState;
  changes: ChangeRecord[];
  memorySummary?: {
    workspace_id: string;
    revision: number;
    enabled: boolean;
    auto_load: boolean;
    include_recent_tasks: boolean;
    semantic_search: boolean;
    counts: { total: number; active: number; pinned: number; needs_review: number };
    outbox?: { pending: number; processing: number; retrying: number; failed: number; last_completed_at: string | null };
    read_only?: boolean;
  } | null;
  memory?: WorkspaceMemoryViewState;
  control: ControlStateView;
  host: {
    kind: ControlCenterHostKind;
    capabilities: ControlCenterHostCapabilities;
  };
}

export interface WorkspaceMemoryViewState extends WorkspaceMemorySnapshot {
  loading: boolean;
  error?: string;
}

export interface ControlCenterRequest {
  type: string;
  changeId?: string;
  memoryId?: string;
  path?: string;
  workspaceId?: string;
  value?: string;
  payload?: Record<string, unknown>;
  requestId?: string;
  revision?: number;
}

export interface ControlCenterStateMessage {
  type: "state";
  state: ControlCenterViewState;
}

export const DEFAULT_HOST_CAPABILITIES: Record<ControlCenterHostKind, ControlCenterHostCapabilities> = {
  vscode: {
    runtimeControl: true,
    workspaceManagement: true,
    taskManagement: true,
    changeMutation: true,
    memoryManagement: true,
    nativeOpenFile: true,
    nativeDiff: true,
    secretStorage: true,
  },
  jetbrains: {
    runtimeControl: false,
    workspaceManagement: false,
    taskManagement: true,
    changeMutation: true,
    memoryManagement: true,
    nativeOpenFile: false,
    nativeDiff: false,
    secretStorage: false,
  },
  browser: {
    runtimeControl: false,
    workspaceManagement: false,
    taskManagement: true,
    changeMutation: true,
    memoryManagement: true,
    nativeOpenFile: false,
    nativeDiff: false,
    secretStorage: false,
  },
};
