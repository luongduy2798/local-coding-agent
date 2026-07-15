# Review Changes

Local Coding Agent tracks dedicated workspace mutations automatically. Review Changes is
backend-managed and does not require a task lifecycle or a separate change set.

## Tracked operations

Filesystem change records are created for:

- `write_file`
- `replace_in_file`
- `apply_patch`
- `make_dir`
- `move_path`
- `delete_path`

`run_command` and `run_commands` create privacy-preserving activity records. Activity
records contain counts, relative working directory, exit status, timeout status, and a
generic message. They never contain command text, stdout, stderr, environment variables,
or secrets.

## Mutation pipeline

A dedicated mutation follows this pipeline:

```text
capture before
→ verify the last read version
→ perform the mutation
→ capture after
→ write an atomic change record
→ update the known version
→ return the normal tool result with change_id
```

Change-record writes are serialized in-process so concurrent mutations cannot overwrite each
other's index entries. JSON files are written to a temporary file and renamed atomically.

## Storage

Change history is scoped by workspace ID:

```text
<AGENT_DATA_DIR>/workspaces/<workspace-id>/changes/
├── index.json
├── records/
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

## Rename groups

`move_path` and structured patch rename operations store source and destination as one
atomic group. Undo or Reapply preflights both ends. Selecting either path for Partial Undo
expands the request to the whole rename group.

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

For a multi-file record:

```json
{
  "paths": ["README.md"]
}
```

Only selected undoable files are restored. The record becomes `partially_undone` until all
undoable files are undone. Per-file states are `applied`, `undone`, or `not_undoable`.
Rename groups remain atomic.

## HTTP API

The Changes API uses the same bearer authentication and browser-origin policy as `/mcp`.

```text
GET    /changes?limit=50
GET    /changes/:id
GET    /changes/:id/diff
GET    /changes/:id/diff?path=src/file.js
GET    /changes/:id/content?path=src/file.js&side=before
GET    /changes/:id/content?path=src/file.js&side=after
POST   /changes/:id/undo
POST   /changes/:id/reapply
POST   /changes/undo-all
DELETE /changes
```

Limits are clamped to 1–200. `DELETE /changes` removes records, snapshots, and activities
without changing workspace files.

Undo All processes changes newest to oldest and preflights a projected filesystem state
before applying anything.

## VS Code extension

The extension in `vscode-extension/` exposes **Review Changes** in the Activity Bar. It:

- verifies `GET /healthz` against every open VS Code workspace folder;
- lists changes from `GET /changes`;
- opens before/after snapshots in the native VS Code diff editor;
- supports Undo, Partial Undo, Reapply, Undo All, and Clear History;
- stores an optional bearer token with VS Code SecretStorage;
- disables filesystem mutations in untrusted workspaces;
- polls only while the Review Changes view is visible.

Run `lca` inside the project before opening the view. Snapshot content is loaded from the
change record only; the virtual diff provider cannot read arbitrary filesystem paths.

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
```

`AGENT_DATA_DIR` is especially important for tests so test change histories and audit logs never
write into the real runtime data directory.

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
