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

export type TaskComplexityProfile = "quick_edit" | "normal" | "complex";

export interface TaskBlockerDescriptor {
  code?: "missing_input" | "missing_file" | "workspace_mismatch" | "permission_denied" | "tool_unavailable" | "repeated_no_progress" | "command_timeout" | "unknown";
  step?: string;
  summary?: string;
  evidence?: string[];
  required_action?: string | null;
  retryable?: boolean;
  purpose?: string | null;
  target?: string | null;
  detected_at?: string;
  source_invocation_id?: string | null;
}

export interface TaskOrchestrationDescriptor {
  suggested_profile?: TaskComplexityProfile | null;
  scope_signal?: "expanded" | "reduced" | "aligned" | null;
  scope_reasons?: string[];
  phase?: "opened" | "discovering" | "decision_ready" | "mutating" | "confirming" | "blocked" | "closing";
  evidence_status?: "not_started" | "insufficient" | "likely_sufficient" | "target_confirmed" | "mutation_applied" | "confirmation_complete";
  run_state?: "running" | "retrying" | "blocked" | "waiting_for_user";
  blocker?: TaskBlockerDescriptor | null;
  budgets?: {
    discovery_soft_limit?: number | null;
    total_soft_limit?: number | null;
  };
  counters?: {
    total_calls?: number;
    unique_calls?: number;
    duplicate_calls?: number;
    discovery_calls?: number;
    status_only_calls?: number;
    failed_calls?: number;
    mutations?: number;
    semantic_duplicate_calls?: number;
    blockers_detected?: number;
    transient_retries?: number;
    retry_exhausted?: number;
    tasks_resumed?: number;
  };
  last_notice?: {
    code?: string;
    severity?: "info" | "warning" | "error";
    message?: string;
    recommended_transition?: string | null;
  } | null;
}

export interface TaskDescriptor {
  task_id?: string;
  routingTaskId?: string;
  routing_task_id?: string;
  id?: string;
  title?: string;
  objective?: string | null;
  requested_profile?: TaskComplexityProfile | null;
  effective_profile?: TaskComplexityProfile;
  profile_confidence?: number;
  orchestration?: TaskOrchestrationDescriptor | null;
  status?: "open" | "active" | "completed" | "closed" | "failed";
  session_bound?: boolean;
  detached_at?: string | null;
  closed_reason?: string | null;
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

export interface ControlActivitySnapshot {
  available: boolean;
  enabled: boolean;
  currentRuntimeId: string | null;
  activities: Array<{
    invocationId: string;
    runtimeId: string | null;
    tool: string;
    taskId: string | null;
    workspaceIds: string[];
    status: "started" | "finished" | "failed" | "interrupted";
    ok: boolean | null;
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
    errorCode: string | null;
    verification: "PASS" | "INCOMPLETE" | "FAIL" | null;
    changeCount: number | null;
    fileCount: number | null;
    toolClass: string | null;
    fingerprint: string | null;
    purpose: string | null;
    purposeFingerprint: string | null;
    orchestrationEvent: string | null;
    runState: string | null;
    duplicate: boolean;
    statusOnly: boolean;
    policySkip: boolean;
    cacheHit: boolean;
    evidenceDelta: boolean;
    orchestrationNoticeCode: string | null;
    orchestrationPhaseBefore: string | null;
    orchestrationPhaseAfter: string | null;
    effectiveProfile: string | null;
    evidenceStatus: string | null;
  }>;
  revision?: string;
  error?: string;
  updatedAt?: string;
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
  control_activity?: ControlActivitySnapshot;
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
