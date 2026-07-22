export type ChangeStatus =
  | "applied"
  | "partially_undone"
  | "undone"
  | "reapplied"
  | "conflict"
  | "failed";

export type ChangeOperation =
  | "created"
  | "modified"
  | "deleted"
  | "renamed"
  | "metadata_only";

export type ApiRevision = string | number;

export interface WorkspaceDescriptor {
  workspace_id?: string;
  id?: string;
  label?: string;
  root?: string;
  canonical_root?: string;
  canonicalRoot?: string;
  path?: string;
  available?: boolean;
  availability?: string;
  trusted?: boolean;
  trust_state?: string;
  registration_state?: "active" | "archived";
  registrationState?: "active" | "archived";
  archived_at?: string | null;
  archivedAt?: string | null;
  metadata?: {
    label?: string;
    trusted?: boolean;
  };
}

export interface TaskDescriptor {
  task_id?: string;
  routingTaskId?: string;
  routing_task_id?: string;
  id?: string;
  title?: string;
  status?: "open" | "active" | "completed" | "closed" | "failed";
  primary_workspace_id?: string;
  workspace_ids?: string[];
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  workspace_set_frozen?: boolean;
}

export interface ProcessDescriptor {
  process_id: string;
  name?: string;
  status: string;
  exit_code?: number | null;
  task_id?: string | null;
  workspace_id?: string | null;
  started_at?: string | null;
}

export interface AuditStatus {
  enabled: boolean;
  path?: string;
  exists?: boolean;
  bytes?: number;
  rotating?: boolean;
  queued_entries?: number;
  last_entry_at?: string | null;
  updated_at?: string | null;
}

export interface HealthResponse {
  status: string;
  version: string;
  tier?: string;
  auth: "none" | "bearer";
  workspace: string;
  roots: string[];
  mcp_endpoint: string;
  workspace_id?: string;
  selected_workspace_id?: string;
  global_default_workspace_id?: string;
  runtime_id?: string;
  workspaces?: WorkspaceDescriptor[];
  tasks?: TaskDescriptor[];
  processes?: ProcessDescriptor[];
  audit?: AuditStatus;
  mcp_sessions?: {
    active?: number;
    max?: number;
    total_requests?: number;
  };
  revision?: ApiRevision;
  change_events_endpoint?: string;
}

export interface LineChangeStats {
  additions: number;
  deletions: number;
}

export interface ChangeSnapshot {
  exists: boolean;
  type: string;
  size: number;
  version: string | null;
  snapshot: string | null;
  undoable: boolean;
  reason?: string | null;
}

export interface ChangedFile {
  path: string;
  workspace_id?: string;
  operation: ChangeOperation;
  before: ChangeSnapshot;
  after: ChangeSnapshot;
  undoable: boolean;
  undoStatus: "applied" | "undone" | "not_undoable";
  group: string | null;
  stats: LineChangeStats | null;
}

export interface RenameGroup {
  id: string;
  atomic: boolean;
  from: string;
  to: string;
}

export interface ChangeOperationRecord {
  id: string;
  source: string;
  createdAt: string;
  paths: string[];
}

export interface ChangeRecord {
  id: string;
  workspace?: string;
  workspace_id?: string;
  workspace_key?: string;
  workspace_label?: string;
  task_id?: string;
  routingTaskId?: string;
  routing_task_id?: string;
  task_title?: string;
  source: string;
  title?: string;
  taskStatus?: "active" | "completed";
  completedAt?: string | null;
  operationCount?: number;
  operationIds?: string[];
  operations?: ChangeOperationRecord[];
  status: ChangeStatus;
  createdAt: string;
  updatedAt: string;
  files: ChangedFile[];
  stats: LineChangeStats;
  renameGroups: RenameGroup[];
  undoable: boolean;
  lastOperation?: unknown;
}

export interface ChangeListResponse {
  count?: number;
  changes?: ChangeRecord[];
  workspace_id?: string;
  label?: string;
  revision?: ApiRevision;
  notModified?: boolean;
  workspaces?: Array<WorkspaceDescriptor & {
    changes?: ChangeRecord[] | {
      count?: number;
      changes: ChangeRecord[];
      revision?: ApiRevision;
    };
  }>;
  tasks?: TaskDescriptor[];
}

export interface ChangeContentResponse {
  changeId: string;
  path: string;
  side: "before" | "after";
  exists: boolean;
  type: string;
  undoable: boolean;
  version: string | null;
  reason: string | null;
  content: string | null;
}

export interface ChangeMutationResponse {
  change: ChangeRecord;
  revision?: ApiRevision;
}

export interface ReviewScope {
  workspaceId?: string;
  taskId?: string;
}

export interface ChangeEvent {
  event: string;
  revision?: ApiRevision;
  data?: unknown;
}

export interface ConflictFile {
  path: string;
  expectedVersion: string | null;
  currentVersion: string | null;
  expectedExists: boolean;
  currentExists: boolean;
}

export interface ApiErrorBody {
  error?: string;
  code?: string;
  message?: string;
  changeId?: string;
  files?: ConflictFile[];
  filesystemChanged?: boolean;
}
