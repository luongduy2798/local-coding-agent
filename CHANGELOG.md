# Changelog

All notable changes to Local Coding Agent are documented in this file.

## [4.5.0-pro] - 2026-07-16

### What's new

- Replaced the `compact` and `full` profiles with one stable production tool catalog. Specialized capabilities remain available, while aliases and wrappers fully covered by stronger aggregate tools are hidden.
- Added task-scoped Review Changes. All filesystem mutations for one user request are grouped into one task card while individual operations remain available internally for safe replay.
- Added `task_title` support to the first `apply_patch` of a request. A different title closes the previous active task and starts a new task automatically.
- Added task-level Undo and Reapply. Undo executes operations newest-to-oldest; Reapply executes them oldest-to-newest, including rename-then-edit workflows.
- Added focused evidence packs to `workspace_snapshot` and consolidated end-of-task reporting through `session_report`.
- Added request-level MCP telemetry with correlated request/tool IDs, request and response sizes, handler timing, transport timing, setup timing, output size, and total HTTP time.

### Performance

- Reduced the model-visible production catalog to 65 tools while retaining diagnostic, security, targeted-test, Figma, skill, note, policy, and profile capabilities.
- Added conservative output budgets for reads, searches, Git diffs, commands, and batched commands to reduce tunnel traffic and context growth.
- Added safe version-based read deduplication through `known_version` and `skip_if_unchanged`.
- Added bounded-concurrency `read_many`, snapshot capture, and change-journal processing.
- Deferred expensive line-stat calculation for large or multi-file mutations outside the mutation critical path.
- Reduced repeated payload fields and avoided duplicating app-only structured JSON in model-visible text.
- Combined Git state, change summary, heuristic review, doctor status, optional quality gates, and runtime metrics into one `session_report` call.

### Review Changes

- Review Changes now displays one card per user task instead of one card per `apply_patch`.
- Task cards aggregate final file state, additions/deletions, operation count, task title, and active/completed state.
- Operation records and snapshots remain separate internally so partial undo, conflicts, rename groups, and exact replay stay safe.
- Removed the header-level **Review** button from the task card. Review remains available per file.
- Added compatibility for legacy `change_...` records alongside new `task_...` records.

### Fixed and hardened

- Made delete approval for `apply_patch` path-specific instead of granting a broad generic delete action.
- Serialized task, operation, activity, and index updates to prevent concurrent mutations from dropping history entries.
- Preserved projected-state preflight for Undo All so conflicts cannot cause partial filesystem changes.
- Kept stale-file protection based on whole-file SHA-256 versions.
- Kept large files, binary files, and directory snapshots metadata-only rather than claiming unsafe automatic restoration.

### Tool catalog cleanup

The following redundant model-visible tools were removed from the production catalog while their stronger replacements remain:

- `ping`, `workspace_info` → `lca`
- `repo_overview` → `workspace_snapshot` / `repo_map`
- `write_file`, `replace_in_file`, `move_path`, `delete_path` → `apply_patch`
- `validate_patch` → `preview_patch`
- `detect_test_commands` → `quality_gate` with `dry_run`
- `run_tests`, `run_build`, `run_lint` → `quality_gate`

### Versions

- Local Coding Agent server: `4.5.0-pro`
- VS Code extension: `0.3.0`

### Upgrade notes

- Restart LCA after upgrading: `lca stop && lca`.
- Refresh the ChatGPT MCP connector once because the `apply_patch` schema and catalog changed.
- Reload the VS Code window so the Review Changes webview uses the new extension bundle.
- Existing legacy cards are not retroactively merged because older records do not contain a task ID. Clear Review Changes history when a clean view is preferred; clearing history does not change workspace files.

### Verification

- Backend safety, change journal, agent, Pro, performance, hardening, Figma, and security suites.
- VS Code extension TypeScript check and production build.
- Git diff whitespace validation and heuristic diff review.
