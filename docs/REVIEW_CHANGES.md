# LCA Control Center and Review Changes

Local Coding Agent runtime groups `apply_patch` mutations into a backend-managed **task change
set**, partitioned by task and workspace. One task can produce workspace-specific Review
Changes cards even when the agent needs several patch calls or edits multiple registered
repositories. Each low-level mutation remains an operation record inside its workspace journal
for review and conflict checks. History mutation is deliberately limited to single-workspace
tasks; a cross-workspace task cannot be undone journal-by-journal as if that were one transaction.

A task is opened with `task_open` and closed with `task_close`. It has one primary workspace and
at most eight attached workspaces. Attach/detach
is allowed only before the first mutation; the workspace set is then frozen. Reconnecting uses
the returned `task_token`, while normal stateful MCP requests reuse the session binding. When the final binding disappears or the runtime restarts, an open task becomes detached rather than continuing to appear as actively running.

The MCP contract still contains `task_plan`, but the VS Code extension neither creates, edits nor
renders it. The Control Center reports observable runtime state plus the task's explicitly public
`objective` metadata. Objective is not a prompt or model thinking; prompts, private reasoning and
fabricated completion percentages are never exposed.

## Tracked operations

Operation records inside the active task are created for:

- `apply_patch` for `create`, `update`, `delete`, `rename`, and `mkdir`; create/rename can also create missing parent directories

An explicit `mkdir` is tracked, but an empty directory is metadata-only in Review Changes and is
not advertised as automatically undoable after the patch transaction has committed.

`run_command`, `run_commands`, `process`, and Git create privacy-preserving activity records. Activity
records contain counts, relative working directory, exit status, timeout status, and a
generic message. They never contain command text, stdout, stderr, environment variables,
or secrets.

Shell/Git mutations are not atomic or automatically undoable. If their before/after manifest
shows a tracked source change, the workspace becomes `unmanaged_changes`; `verify_changes`
returns `INCOMPLETE` until the diff is reviewed and explicitly adopted.

## Mutation pipeline

A dedicated mutation follows this pipeline:

```text
capture before
→ verify path and expected_version for every operation
→ acquire task/workspace transaction locks
→ stage changes and persist commit intent
→ perform the mutation
→ capture after
→ write an atomic operation record
→ append the operation to the routed task/workspace change set
→ update the known version
→ return change_id, task_id, transaction_id, workspace_id and relative path
```

Operation and task-index writes are serialized in-process so concurrent mutations cannot
overwrite each other's entries. JSON files are written to a temporary file and renamed
atomically.

Cross-workspace `apply_patch` uses a durable transaction coordinator. Locks are acquired in
workspace-ID order with fencing tokens, staged operations and commit intent are persisted, and
recovery uses that manifest to finish or roll back when it can prove a safe action. If it cannot,
the transaction is left `in_doubt` and affected workspaces reject new mutations rather than
reporting a false success. This is a recovery protocol, not a promise that arbitrary external
filesystem failures can never require intervention.

Filesystem commit and the per-workspace Review Changes journal are separate durable layers.
If the filesystem transaction commits but a journal write fails, the response reports
`journal_complete=false`/`journal_errors` and marks the workspace unmanaged; it must not claim
that the unjournaled change is safely undoable.

## Storage

Change history is scoped by workspace ID:

```text
<AGENT_DATA_DIR>/runtime/workspaces/<workspace-id>/changes/
├── index.json
├── records/       # individual mutation operations
├── tasks/         # one task change set per user request
├── snapshots/
└── activities/
```

It does not depend on Git and does not use the Git index. Only paths named by a mutation are
inspected; the whole repository is never scanned for a snapshot.

## Read versions and `STALE_FILE`

`read_file` and every successful `read_many` item return a SHA-256 `version` for the whole
file, including partial line reads.

When a later mutation targets a file that has been read, the backend compares the current
before snapshot with the remembered version. A mismatch is rejected:

```json
{
  "error": "STALE_FILE",
  "code": "STALE_FILE",
  "path": "src/file.js",
  "knownVersion": "old-sha256",
  "currentVersion": "new-sha256",
  "message": "The file changed after it was read. Reread the file and retry the mutation."
}
```

A successful mutation updates the remembered version. Undo and Reapply through HTTP do not
update it, so the next MCP mutation must reread the file.

## Snapshots

### Small text files

Files at or below `AGENT_MAX_SNAPSHOT_BYTES` are stored as content snapshots when they are
text. They support Undo, Reapply, and unified diff generation.

The default limit is 5 MiB.

### Large or binary files

Large and binary files keep metadata and SHA-256 only. They are tracked but are not
automatically undoable or reapplyable. Their reason is `snapshot_limit` or `binary_file`.

### Directories

Directories are metadata-only. Recursive directory deletion does not scan or archive the
tree and is not automatically undoable.

### Missing paths

A missing before state is undoable. Undoing a newly created small text file removes it;
Reapply recreates it from the after snapshot.

## Task aggregation and rename groups

The task card derives each file's **before** state from its first operation and its **after**
state from its last operation. Undo executes operation records newest to oldest; Reapply uses
oldest to newest. This preserves correctness when the same file is edited several times.

Structured `apply_patch` rename operations store source and destination as one atomic group.
Rename chains remain associated at task level, including a rename followed by later edits to
the destination. Selecting either path for Partial Undo expands the request to the whole
rename component.

The backend does not overwrite a source that was recreated or a destination that changed.

## Conflict handling

Undo requires the current state to equal the recorded after state. Reapply requires it to
equal the recorded before state. All selected paths are preflighted before filesystem
mutation.

A conflict returns HTTP 409:

```json
{
  "error": "change_conflict",
  "changeId": "change_...",
  "files": [
    {
      "path": "src/file.js",
      "expectedVersion": "sha256...",
      "currentVersion": "sha256..."
    }
  ],
  "filesystemChanged": false
}
```

## Partial Undo

For a multi-file task change set:

```json
{
  "paths": ["README.md"]
}
```

Only selected undoable files are restored. The record becomes `partially_undone` until all
undoable files are undone. Per-file states are `applied`, `undone`, or `not_undoable`.
Rename groups remain atomic.

## HTTP API

The Changes API is a trusted-local-companion API, not a public health surface. In production it
requires a loopback request plus the supervisor's `X-LCA-Instance-Nonce`; the MCP tunnel bearer
does not grant companion authority. The VS Code extension obtains the nonce through the local CLI;
do not hard-code or commit it. Runtime callers scope reads and mutations by workspace/task. Mutation
endpoints fail closed when task context is missing or does not own the requested record.

```text
GET    /changes?workspace_id=<id>&task_id=<id>&limit=50
GET    /changes?workspace_id=all&task_id=<id>&limit=50
GET    /changes/events?workspace_id=<id>&task_id=<id>&since_revision=<n>
GET    /changes/:id?workspace_id=<id>&task_id=<id>
GET    /changes/:id/diff?workspace_id=<id>&task_id=<id>
GET    /changes/:id/diff?workspace_id=<id>&task_id=<id>&path=src/file.js
GET    /changes/:id/content?workspace_id=<id>&task_id=<id>&path=src/file.js&side=before
GET    /changes/:id/content?workspace_id=<id>&task_id=<id>&path=src/file.js&side=after
POST   /changes/:id/undo?workspace_id=<id>&task_id=<id>
POST   /changes/:id/reapply?workspace_id=<id>&task_id=<id>
POST   /changes/undo-all?workspace_id=<id>&task_id=<id>
DELETE /changes?workspace_id=<id>&task_id=<id>
```

The list returns task-level records (`task_...`) for runtime work and remains read-compatible with
legacy operation records (`change_...`). Every bucket identifies its `workspace_id` and
canonical root; file locations remain relative. Limits are clamped to 1–200. `DELETE /changes`
removes only records in its authorized task/workspace scope and never changes workspace files.

`/changes/events` is an SSE revision stream. Clients send their last revision and reload only
when a newer task/workspace revision is available; polling is a compatibility fallback.

Undo All processes changes newest to oldest and preflights a projected filesystem state
before applying anything.

For a task attached to more than one workspace, the mutating routes—Undo, Reapply, Undo All,
and Clear—return HTTP 409 with `CROSS_WORKSPACE_HISTORY_ATOMICITY_REQUIRED`. The response does
not expose workspace roots. Reads may still be aggregated.
Use a compensating cross-workspace `apply_patch`, or perform history mutation from a separate
single-workspace task; selecting one journal from a multi-workspace task does not bypass this
restriction.

## VS Code Control Center

The extension in `vscode-extension/` exposes **Control Center** in the Activity Bar with four tabs:

- **Overview**: supervisor/server/tunnel/session state and Start/Stop/Pause controls;
- **Workspaces**: the complete registry, global default, availability and Archive/Restore/Permanent Remove;
- **Tasks**: the public Agent objective followed by real tool start/finish/failure/interruption timers, verification, process and change/file counts, including a Detached lifecycle state for open tasks without a live session;
- **Changes**: task/workspace-scoped review, snapshot diff and safe replay.

It also:

- uses public `GET /healthz` only for liveness, then authenticates `GET /healthz/details` with the supervisor instance nonce to verify canonical workspace identity;
- lists task/workspace-scoped cards with workspace badges and task/workspace filters;
- renders a non-duplicate objective in full as the first task-timeline item rather than as model thinking;
- opens the latest task's calls by default while retaining a user-controlled Show fewer/earlier calls disclosure for every task with more than three calls;
- uses animated `RotatingDots` in task headers and individual tool rows so running state remains visually distinct from a static circle;
- marks an open task as Detached only after its last session binding is gone, freezes elapsed time at `detached_at`, and offers a close action that preserves task activity, journals, snapshots and Undo;
- opens before/after snapshots in the native VS Code diff editor;
- supports task-level Undo/Reapply, per-file Partial Undo/Reapply, Undo All, and Clear History;
- refreshes the local instance nonce through the explicit `lca status --json --include-instance-nonce` machine-readable flow;
- disables filesystem mutations in untrusted workspaces;
- consumes `/changes/events` revisions—including `workspace_id=all`—while visible, falls back to bounded polling if SSE is unavailable, and reconnects automatically to return to Live;
- cancels stale requests so an older workspace/task response cannot overwrite a newer selection.

The displayed objective and detached lifecycle metadata come from the durable task record. Operational activity comes separately from the existing rotating runtime `audit.log`, with a seven-day/20,000-event UI bound. The reader handles rotation, partial lines and deduplication. Only invocation/tool/task/workspace IDs, phase, timestamps, duration, safe error code, verification enum and counts are projected from audit data; args, commands, output, prompt, token, thinking and error content never enter the webview.

Archived workspaces stay visible in Workspaces/Tasks and their history remains readable, but replay is disabled until Restore. Permanent Remove uses a durable quarantine/intent transaction, leaves source files untouched, and cannot remove a workspace referenced by multi-workspace task history.

Run `lca` inside each project you want to trust before opening the view. **Connect LCA to this
workspace** registers/selects that folder for new tasks without restarting the shared
server/tunnel. Snapshot content is loaded from the change record only; the virtual diff
provider cannot read arbitrary filesystem paths.

## Change states

A record may be:

- `applied`
- `partially_undone`
- `undone`
- `reapplied`
- `conflict`
- `failed`

File operations are `created`, `modified`, `deleted`, `renamed`, or `metadata_only`.

## Configuration

```env
AGENT_DATA_DIR=/temporary/or/custom/data
AGENT_MAX_SNAPSHOT_BYTES=5242880
AGENT_JOURNAL_SNAPSHOT_CONCURRENCY=4
AGENT_DEFER_LINE_STATS=1
AGENT_DEFER_LINE_STATS_BYTES=512000
```

`AGENT_DATA_DIR` is especially important for tests so test change histories and audit logs never
write into the real runtime data directory. Snapshot capture uses bounded concurrency while the
mutation remains transactionally serialized. Larger or multi-file changes may persist with pending
line statistics and calculate additions/deletions after the mutation response has returned.

## Verification

```bash
cd server
npm run test:safety
npm run test:changes
npm run test:hardening
```

The integration suite covers creation, overwrite, replace, delete, rename, atomic partial
rename undo, multi-file partial undo, stale reads, conflicts, large files, directory
metadata, diff filtering, concurrent records, command privacy, and change-history clearing.
