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

export interface HealthResponse {
  status: string;
  version: string;
  tier?: string;
  auth: "none" | "bearer";
  workspace: string;
  roots: string[];
  mcp_endpoint: string;
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

export interface ChangeRecord {
  id: string;
  source: string;
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
  count: number;
  changes: ChangeRecord[];
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
