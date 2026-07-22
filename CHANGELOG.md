# Changelog

All notable changes to Local Coding Agent are documented in this file.

## [5.0.0-pro] - 2026-07-22

### Runtime and lifecycle

- Raised the runtime requirement to Node.js `>=22.13.0` and moved SQLite access behind a storage-worker abstraction.
- Added one idempotent supervisor for the server/tunnel pair with verified process identity, separate readiness, bounded restart, startup rollback, and ownership-safe shutdown.
- Added a fail-closed V4.5 upgrade bridge: PID-only legacy state is adopted only when health version, PID, config ID, endpoint, executable, command marker, and available start-time evidence all agree; unrelated listeners remain untouched.
- Fixed setup/start ordering so legacy runtime data is transactionally activated before the CLI opens the workspace registry, preventing an unmarked `data/runtime` directory from conflicting with the retained `data/v5` backup. Restored tunnel-profile directory creation after the CLI module split.
- Added stateful MCP sessions with a fixed registry built once per runtime. The defaults are 32 sessions and a 30-minute idle TTL, with a stateless reconnect compatibility path.
- Added MCP, handler, serialization, storage, index, payload, event-loop, and memory telemetry plus bounded response budgets.
- Added explicit stateful-dispatch and server-total performance gates. Cached control-plane health/workspace reads keep warm status calls off the SQLite worker path for one second; in-process register/select invalidates the cache immediately.
- Activated stable `data/runtime` storage with WAL/foreign-key/busy-timeout initialization, transactional migration from legacy `data/v5`, integrity checks, audit rotation, and recoverable transaction metadata. Migration now refuses to start while the configured runtime port is active; the legacy source is retained as a backup.
- Made activation survive legitimate filesystem device-ID changes after a macOS reboot/remount while still requiring the canonical path, inode, mode, and modification identity to match. Migration intents retain the stricter same-mount identity check.

### Multi-workspace tasks

- Added durable workspace IDs, canonical roots, explicit trust, availability tracking, and fail-closed handling for moved/deleted roots, overlap, and unsafe symlinks.
- Added `lca workspace list|use|archive|restore|remove`. Archive/Restore preserves workspace identity and history; `remove` is a durable permanent LCA-data purge that never deletes the source repository and fails closed on default/configured, multi-workspace-history, active-runtime, or incomplete-transaction conflicts.
- Added task-scoped primary/attached workspaces. Each task has one primary and up to eight attached workspaces; the set freezes on the first mutation.
- Bound MCP sessions to task tokens and added isolation tests for two chats working in separate repositories without sharing reads, writes, process ownership, or journals.
- Qualified runtime file locations with `workspace_id` and relative paths instead of returning ambiguous absolute paths in coding results.

### Fixed 35-tool catalog

- Replaced the prior 65-tool surface with one immutable 35-tool catalog. `lca_status` reports `catalog_version=5` and a catalog hash.
- Consolidated file mutations in `apply_patch`, repository intelligence in `workspace_snapshot`/`code_query`, Git actions in `git`, verification in `verify_changes`, background processes in `process`, and integrations behind action-based tools.
- Removed legacy tool registration and alias execution entirely. Stale clients receive an unknown-tool/catalog-refresh error instead of being routed to a replacement implicitly.
- Kept app-only autocomplete helpers outside the model-visible catalog.

### Coding intelligence and verification

- Added an incremental packed/disk-backed `WorkspaceGraph` with file metadata, manifests, package/dependency relationships, symbols/imports/references, watcher reconciliation, fingerprints, bounded hot-workspace LRU, and idle unload. Snapshot/review joins Git state without duplicating it in the disposable graph.
- Added fast-first lexical/graph `code_query` modes for text, symbols, definitions, references, imports, callers, callees, and types with engine/freshness/completeness/confidence metadata.
- Added a bounded project-local TypeScript Language Service adapter for JavaScript/TypeScript definitions, references, types, callers, and callees. It discovers only `<workspace>/node_modules/typescript`, rejects package/entrypoint realpath escapes, loads lazily, never installs or uses a global compiler, and reports explicit partial/fallback metadata when a budget is reached.
- Added a hard-preemptible built-in structural parser for JavaScript/TypeScript/TSX, Python, Go, Rust, Java/Kotlin, C#, and Dart. Its worker is materialized in the LCA data directory from a release-pinned SHA-256 manifest; corrupt regular artifacts are replaced and symlinks fail closed.
- Moved synchronous TypeScript semantic work to an isolated worker so timeout/cancellation can terminate a blocked compiler call without stalling MCP dispatch.
- Exposed sanitized semantic-adapter availability, version, warm state, discovery failure, and hard-preemption capability through `index_control status`.
- Made large lexical scans cooperative and allowed a bounded fingerprint mismatch to incrementally adopt a small exact changed-path set. This keeps 100k-file query/event-loop/freshness work bounded while preserving non-authoritative metadata when no healthy watcher proves whole-workspace coverage.
- Kept aggregate workspace fingerprints canonical across incremental replacement, debounced persistence, restart, and independent full refresh paths. Large searches now abandon a stale pass when watcher invalidation arrives, retry after reconciliation, and surface matching evidence from the small exact changed-path set before considering an unchanged-workspace scan.
- Made `WorkspaceGraph.close()` an idempotent lifecycle barrier: it waits for already accepted mutations, flushes their final canonical index, stops any watcher started by queued work, and rejects new operations once shutdown begins.
- Serialized runtime eviction per workspace. Reopen waits for the prior graph's prewarm, semantic-adapter shutdown, and final index flush, preventing an old and replacement runtime from writing the same persisted index concurrently; `lca_status` exposes the active eviction count.
- Added monorepo-aware verification planning across changed, staged, and untracked files. Missing or unsupported required gates produce `INCOMPLETE`, never a false `PASS`.
- Added changed-test selection, aggregate review output, security/todo scans, and workspace-qualified findings.

### Transactions and Review Changes

- Added a durable cross-workspace patch coordinator with whole-batch preflight, deterministic workspace locking, staging, commit intent, fencing, heartbeat, manifest-based recovery, and an `in_doubt` mutation block when a safe state cannot be proven.
- Added `mkdir` to the consolidated `apply_patch` operations.
- Unified `apply_patch` preview, validate, and apply through one preflight path; non-mutating actions do not write or freeze task attachments.
- Added task/workspace/transaction IDs to change-journal records while preserving readable legacy journal data.
- Marked shell, process, and mutating Git changes as non-atomic and non-undoable. Tracked source changed outside `apply_patch` becomes `unmanaged_changes` and blocks a verification `PASS` until reviewed/adopted.
- Added bounded, root-confined content manifests for non-Git command/process workspaces so same-size source edits are detected; overflow, symlink races, and incomplete scans fail closed.
- Added a durable task-close intent across workspace journals. A partial close is rolled back to open state when possible and remains retryable; task mutation/close races fail with an explicit busy/closing error.
- Added revisioned `/changes` responses and an SSE change stream, including a real aggregate `workspace_id=all` stream. Detailed health and every `/changes` route require loopback plus the supervisor instance nonce in production; the MCP tunnel bearer has no companion authority and public `/healthz` is liveness-only.
- Blocked Undo, Reapply, Undo All, and Clear for multi-workspace tasks until history mutation has a transaction spanning every workspace journal.
- Rebuilt the VS Code extension as a four-tab Control Center (Overview, Workspaces, Tasks, Changes), while keeping task plans/model thinking out of the UI. It lists the complete registry independently of open VS Code folders, preserves the `All available workspaces` sentinel, monitors safe tool/verification/process metadata from rotating `audit.log`, and reconnects Polling back to Live.
- Added Control Center workspace actions for global-default selection, Archive, Restore and label-confirmed Permanent Remove. Archived history is read-only; Undo/Reapply/Open current file require the active repo to be open in a trusted VS Code window.

### CLI, setup, upgrade, and rollback

- Reduced normal setup to at most three non-credential prompts and added one-time consent before enabling `full/full` for a prior safer configuration.
- Expanded `lca status` with supervisor, connector, MCP session, task, workspace, and storage state.
- Added `lca update`: stop if running, snapshot CLI config/`.env.local`/runtime state, fast-forward update, install/validate, check storage, record a rollback point, and restore the previous running state.
- Added a durable upgrade/rollback coordinator with intent stages, a complete external CLI recovery bundle, next-invocation crash recovery, remembered pre-operation runtime state, and fail-closed dirty-checkout handling. Rollback preserves runtime data for a later retry.
- Moved active state beside the platform CLI configuration under `data/runtime`; an explicit `AGENT_DATA_DIR` uses `<AGENT_DATA_DIR>/runtime`.
- Split the 4,300-line CLI into stable `scripts/cli` domain modules and reduced `scripts/local-coding-agent.mjs` to a thin dispatcher.

### Versions

- Local Coding Agent server: `5.0.0-pro`
- VS Code extension: `0.5.0`
- Node.js: `>=22.13.0`

### Upgrade notes

- Ensure Node.js `>=22.13.0`, then run `lca update` from a clean Local Coding Agent checkout.
- Refresh the ChatGPT custom MCP connector once and open a new chat so it receives the fixed 35-tool schemas.
- Legacy `data/v5` is never deleted: a verified transactional copy is activated at `data/runtime` and the source remains a backup.
- If rollback is required, run `lca rollback`; runtime data remains preserved. Refresh the connector again if the rolled-back release exposes a different catalog.
- Reload the VS Code window after updating the optional extension.

### Verification

- Added isolated capability-named suites for session reuse, catalog shape and payload size, SQLite/storage registry, task routing, two-chat/two-workspace isolation, patch fault recovery, task-close rollback/retry, non-Git shell mutation, review completeness, and coding-intelligence freshness. Patch tests inject every coordinator fault hook (`after_manifest`, `after_stage_operation`, `before_commit`, partial/final `after_commit_operation`, and `after_commit`) and verify terminal all-before/all-after recovery.
- Added an isolated real-Git migration-recovery fixture that verifies interrupted update/rollback HEAD recovery while preserving runtime data, a crash-classification matrix for every durable migration stage, plus an idempotent supervisor lifecycle test.
- Added a real server restart/reconnect test: a new MCP session must fail closed before binding, reject a stale token, resume the original persisted task by `task_token`, restore its plan, and access only the original workspace.
- Expanded performance/evaluation coverage for warm dispatch, snapshots, code queries, retrieval, tool selection, impacted tests, and response budgets.
- Promoted stateful dispatch p95 `<0.5 ms` and warm trivial server-total p95 `<5 ms` from telemetry-only measurements to failing regression gates.
- Sized the forced audit-rotation performance fixture for paired tool start/completion events so all latency samples remain available across retained generations.
- Expanded the retrieval golden from one definition to eight independent definitions and eight imported-reference expectations. Added an eight-package monorepo gate that requires seeded impacted-test recall `>=95%` while selecting no more than 25% of the full test set.
- Moved the eval and Pro runners onto guarded Git-fixture cleanup flows so generated workspaces/data are removed through `safeRemove()` instead of being retained or hitting a rejected cleanup.
- Configured CI for Node.js 22.13 and 24 on Linux, macOS, and Windows, with separate VS Code extension typecheck, audit/control behavior tests, and build coverage.
- Added a scheduled/manual runtime reliability workflow that shards 10,000 verified supervisor/server/fake-tunnel lifecycle cycles across ten jobs, measures 1,000 reconnects, and stores canonical JSON plus raw cold-builder 10k/100k benchmark logs. No scale SLA failure is allow-listed.
- Scoped benchmark event-loop SLA measurement to runtime work after synthetic fixture generation; per-phase fixture metrics remain available separately.
- Continued to require isolated guarded fixtures, dynamic ports/data directories, and ownership-safe child cleanup for destructive and integration tests. The detached process-group fixture now self-terminates if its owning test process exits unexpectedly, preventing an interrupted test run from leaving the fixture alive.
- Anchored generated `tools`, config, temporary-workspace, runtime-data, and extension-build ignore rules to their intended repository-root locations. The architecture gate now fails if Git ignores any file under a source, test, documentation, evaluation, resource, skill, or CI tree.

### Measured release status and operational limits

- The fixed catalog measures 35 tools, 24,617 bytes raw, 4,109 bytes compressed-equivalent, and hash `96a7ec1d5fdf41d7`. The latest performance fixture measured stateful dispatch p95 0.005 ms and warm `lca_status` server-total p95 1.8 ms.
- The latest cold-builder 100k-file run on Node.js 23.11 measured index 10.03 seconds, warm snapshot 0.05 ms, warm-query p95 0.04 ms, freshness 243.77 ms, post-GC RSS 120.95 MB, two-hot-workspace cache 23.46 MB, forced-GC heap growth 2.90%, and event-loop p99 12.17 ms. Every measured 10k/100k SLA passed.
- The required 250k characterization measured index 24.11 seconds, warm snapshot/query p95 0.04/0.04 ms, freshness 547.79 ms, post-GC RSS 149.70 MB, cache 58.95 MB, heap growth 2.51%, and event-loop p99 11.96 ms. It is not represented as the 100k release target: freshness and live RSS identify the present 250k boundary, while closed-runtime RSS returned to 120.57 MB.
- Patch fault hooks, partial commit recovery, simulated `ENOSPC`, `SQLITE_BUSY`, corruption recovery, transaction-state fencing, and every durable migration stage have guarded tests. The scheduled 10,000-cycle lifecycle and hosted OS/Node matrix remain external workflow evidence that must be green before publishing.
- Structural parsing supplies bounded cross-language definitions/references/call evidence but is not represented as a compiler-grade type system for every language. Deeper adapters remain project-local and explicit; partial coverage returns `INCOMPLETE`/fallback metadata.
- Reorganized production code by stable domains under `server/src`; no source directory is namespaced by product version. `server/src/server.mjs` is a five-line bootstrap and the application composition root is under `server/src/app`.
- Split graph, journal, registry, semantic, transaction, verification, and CLI monoliths so every production module is at most 1,000 lines; bootstrap/CLI entrypoints are at most 300 lines. CI enforces line limits, forbids `src/vN`, and rejects import cycles with zero exceptions.

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
