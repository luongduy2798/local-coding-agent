# Runtime, Tasks, and Multi-workspace

Local Coding Agent runs one local supervisor for one server/tunnel pair. A workspace switch changes the default for a **new task**; it does not restart the connector and never reroutes a task that is already open.

## Requirements and storage

- Node.js `>=22.13.0` is required. SQLite runs through storage workers rather than doing synchronous database work on the MCP event loop.
- Runtime state lives outside the repository by default, beside the CLI config: `~/Library/Application Support/LocalCodingAgent/data/runtime` on macOS, `%APPDATA%\LocalCodingAgent\data\runtime` on Windows, and `${XDG_CONFIG_HOME:-~/.config}/LocalCodingAgent/data/runtime` on Linux. An explicit `AGENT_DATA_DIR` uses `<AGENT_DATA_DIR>/runtime`.
- `registry.sqlite` stores workspace registration/selection, task/session bindings, detached/closed lifecycle metadata, and the durable cross-workspace transaction coordinator view.
- Each workspace has an isolated `state.sqlite` and change-journal storage keyed by its workspace ID; durable patch intents and locks live in the transaction namespace.
- SQLite is opened with WAL, foreign keys, a busy timeout, transactional migrations, and integrity checks.
- If only a legacy `data/v5` directory exists, startup copies it transactionally into `data/runtime`, verifies it, activates the copy, and retains the source as a backup. If both directories exist without a valid activation marker, startup fails closed instead of merging them.

Do not edit SQLite files while LCA is running. Index data can be rebuilt with `index_control`; task, journal, and transaction data should be treated as durable state.

## Fixed 36-tool catalog

The runtime always publishes the same model-visible catalog:

```text
System/task
lca_status, workspace_list, workspace_register, workspace_select,
workspace_attach, workspace_detach, task_open, task_reclassify, task_state,
task_plan, task_checkpoint, task_close

Context
workspace_snapshot, code_query, search_text, find_files, list_files,
read_file, read_many, project_profile, index_control

Mutation/execution
apply_patch, change_history, git, run_command, run_commands, process,
run_changed_tests, verify_changes, review_diff, security_scan, todo_scan

Utilities/integration
skills, notes, figma, lca_input
```

The catalog does not change when mode or policy changes. Legacy tool names are not registered or callable; stale clients receive an unknown-tool/catalog-refresh error. `lca_status` reports `catalog_version=8` and `catalog_hash`.

After a catalog upgrade:

1. Run `lca update` or complete the documented upgrade.
2. Refresh the ChatGPT custom MCP connector once.
3. Open a new chat so it receives the current schemas.

## Registering and selecting workspaces

Use the local CLI to establish trust for a new root:

```bash
cd /path/to/repo
lca

lca workspace list
lca workspace use /path/to/another-repo
lca workspace archive <path|workspace-id>
lca workspace restore <path|workspace-id>
lca workspace remove <path|workspace-id>
```

`lca` uses the Git root when available. A non-Git directory must be explicitly registered. `workspace_register` inside ChatGPT can only register a root already trusted through CLI/config; the model cannot grant trust to an arbitrary absolute path.

`workspace_select` changes the default workspace for the next task in that MCP session. It does not modify an open task. A moved/deleted root, canonical-path change, overlap, or unsafe symlink is rejected; LCA never silently falls back to `cwd` or another workspace.

`archive` is reversible and preserves the workspace ID, task/journal/blob/index data, and read-only history. `restore` requires the original canonical filesystem/Git identity and explicit trust. `remove` means permanent LCA-data deletion, not source deletion: it requires a stopped runtime and exact label confirmation, and is blocked for the default/configured workspace, multi-workspace task history, or an incomplete transaction. Registering the same root after permanent removal creates a new workspace ID.

## Task binding and isolation

Open work explicitly:

```text
workspace_list
workspace_select(workspace_id)
task_open(primary_workspace_id, attached_workspace_ids[])
```

`task_open` accepts an optional short `title` for UI display, an optional durable and user-visible `objective` describing the intended result and task-specific constraints, and a model-selected `complexity_hint` (`quick_edit`, `normal`, or `complex`). Objective is task metadata, not private reasoning or an instruction channel for LCA; it must not contain secrets, unrelated conversation text, or general agent policy. Providing only title leaves objective `null`; when title is omitted, it may be derived from objective. If the model omits the complexity hint, the effective profile defaults to `normal`.

Session bindings are runtime-scoped. Startup clears bindings left by an earlier process and marks still-open tasks detached at their last durable update. Removing one of several bindings keeps the task active; only removal of the final binding sets `detached_at`. Resuming by task token clears detached state. The Control Center may close a detached task through a guarded HTTP action only when no process or incomplete patch transaction remains; this closes the routing task but deliberately preserves Review Changes journals and snapshots.

`task_open` returns:

- a stable `task_id`;
- a secret `task_token` for reconnect/resume;
- the primary workspace and attached workspace IDs;
- the selected effective profile and advisory orchestration state;
- base Git/dirty state and workspace-set version.

An MCP session binds to its task automatically. Pass `task_token` again only after reconnecting or when using the stateless compatibility path. Missing or ambiguous task context fails closed.

A task has exactly one primary workspace and at most eight attached workspaces. `workspace_attach` and `workspace_detach` are allowed only before the first mutation. The first mutation freezes the workspace set; close the task and open another one if its workspace scope must change.

## Task orchestration and complexity profiles

The model, not LCA, selects the effective profile. `quick_edit` is intended for localized direct edits, `normal` for bounded multi-step work, and `complex` for architectural, migration, or broad cross-workspace work. Profile budgets are soft guidance rather than hard execution limits. The default quick-edit guidance is five discovery calls and nine work calls. `task_open` and `task_close` remain visible in telemetry but do not consume the work-call budget. Exceeding a threshold produces a notice only while the task is still discovering and recent discovery calls are repeated or add no evidence; it does not stop the task or change its profile.

LCA updates an orchestration phase independently from the routing lifecycle: `opened`, `discovering`, `decision_ready`, `mutating`, `confirming`, `blocked`, and `closing`. It also tracks evidence status, call counters, mutation epochs, and fingerprints for repeated discovery requests. Routing status remains `open`, `closed`, or `failed`; orchestration phases do not replace it.

LCA may report `suggested_profile`, `scope_signal`, and `scope_reasons` from observable scope evidence such as multiple attached workspaces or the model creating a persistent multi-step plan. Objective text is not interpreted for complexity classification. Discovery-call count and raw search-result path count do not by themselves trigger a profile suggestion. These are advisory signals only. LCA never updates `effective_profile` from those signals. After evaluating the actual request and code context, the model may keep the current profile or call `task_reclassify(complexity, reason)` to confirm a change.

Repeated unchanged discovery calls are fingerprinted. For supported reads, LCA checks the source version before reusing cached evidence; changed files are read again. Repeated requests without new evidence can return advisory notices and eventually a loop guard. A model that genuinely needs a similar read should state the concrete unresolved evidence gap rather than narrating progress through repeated `task_state` calls.

For ChatGPT clients that dynamically load connector tools, every tool description publishes one or more exact `discovery-group:*` tags. The initial `api_tool.list_resources` call must use one routing group: `task-mutation`, `task-investigation`, `task-planning`, `task-code-change`, `task-verification`, `task-process`, `workspace-management`, `change-management`, or `figma-workflow`. Do not invent free-form queries such as `write` and do not silently load the full catalog if a group is missing. A second group is justified only when the requested scope genuinely changes.

A typical quick edit is one `task-mutation` discovery → `workspace_list`/`workspace_select` as needed → `task_open` → targeted read → model decision → `apply_patch` → `review_diff` → `task_close`. Persistent `task_plan`, progress narration, and unrelated `skills` discovery are normally unnecessary for this profile. Lint, test, typecheck, build, security audit, and other quality gates run only when explicitly requested. When they are not requested, call `task_close(status=incomplete)` once as an internal evidence state; the companion UI presents successfully closed work as Completed.

Every path returned by runtime coding tools is qualified by `workspace_id` and is relative to that workspace. Two sessions can therefore work on different repositories concurrently without changing each other's reads, writes, process handles, journals, or task selection.

## Index and coding intelligence

Each hot workspace owns an incremental, packed `WorkspaceGraph` containing file metadata, manifests, package/dependency information, and symbol/import/reference shards. Git state is joined by `workspace_snapshot`, verification, and review rather than duplicated inside the disposable index. runtime keeps at most two hot workspace runtimes by default and unloads idle runtimes after ten minutes. Lexical scans yield cooperatively on large graphs so a 100k-file query does not monopolize the event loop. If watcher invalidation arrives during a large search or fingerprint probe, that stale pass yields to exact-path reconciliation and retries; matching evidence from the small changed-path set is surfaced first. Aggregate fingerprints remain canonical across incremental replacement, persistence, restart, and independent full refresh. Without a healthy watcher, freshness remains explicitly non-authoritative until reconciliation. Runtime unload is an idempotent barrier that waits for accepted graph mutations and flushes their final index. Eviction is single-flight per workspace, and a replacement waits for old prewarm, semantic workers, and graph persistence to close.

`code_query` supports text, symbol, definition, references, imports, callers, callees, and type queries. The fast path is universal lexical/graph evidence. A built-in structural parser covers JavaScript/TypeScript/TSX, Python, Go, Rust, Java/Kotlin, C#, and Dart in a disposable worker; JSON/YAML/Shell use structural/lexical parsing. The parser worker is materialized under the LCA data directory from a release-pinned manifest and SHA-256, and a corrupt regular cached artifact is replaced before execution while symlinks fail closed.

For JavaScript/TypeScript, a bounded project-local TypeScript Language Service can provide compiler-grade definitions, references, types, callers, and callees. Discovery accepts only `<workspace>/node_modules/typescript`, verifies package and entrypoint realpaths, loads lazily, and never installs or searches for a global, ancestor, or PnP compiler. Both structural parsing and the synchronous TypeScript compiler run outside the MCP event loop; timeout or cancellation terminates the worker, so pathological semantic work is hard-preemptible and lexical evidence remains available. AST uses an 800 ms budget; warm/cold Language Service calls use 2/5 seconds and fall back rather than hanging.

Every result identifies its engine, freshness, completeness, confidence, and fallback reason. Use `index_control` to inspect, refresh, rebuild, or evict an index. Status reports adapter languages/version/warm state, pinned artifact identity, discovery errors, and hard-preemption without exposing absolute paths. Index state is disposable; task, journal, and transaction state are not.

## Mutation guarantees

`apply_patch` is the mutation boundary that can provide conflict checks and undo history. `action=preview|validate|apply` uses the same preflight/normalization path; preview and validate neither write nor freeze the task workspace set. Supported operations are `create`, `update`, `delete`, `rename`, and `mkdir`; each operation includes a `workspace_id`, relative path, and optional `expected_version` returned by `read_file`/`read_many`.

For a cross-workspace patch, runtime preflights every operation, acquires workspace locks in a deterministic order, stages changes on the target filesystems, and writes a durable commit intent. Recovery uses the recorded manifest to finish or roll back a disrupted commit when it can do so safely. It does not claim that every external filesystem failure is recoverable: if the coordinator cannot prove a safe state, the transaction becomes `in_doubt` and further mutation of the affected workspace remains blocked.

The filesystem transaction and each workspace's Review Changes journal are separate durable layers. A committed filesystem change whose journal write fails returns `journal_complete=false`/`journal_errors`, is marked unmanaged, and is not presented as safely undoable.

`change_history` and Review Changes remain task/workspace scoped. Do not assume a history ID from one task is usable from another task. History reads can be aggregated across attached workspaces, but Undo, Reapply, Undo All, and Clear are rejected for a multi-workspace task with `CROSS_WORKSPACE_HISTORY_ATOMICITY_REQUIRED`; the current history engine does not provide one transaction spanning every workspace journal.

## Shell and unmanaged changes

`run_command`, `run_commands`, background `process`, and mutating Git commands are not atomic or automatically undoable. The runtime records a privacy-preserving activity plus before/after change fingerprints. It does not store command text, stdout, stderr, environment variables, or secrets in the activity journal.

If a command changes tracked source outside `apply_patch`, the workspace is marked `unmanaged_changes`. `verify_changes` must not return `PASS` while that flag remains. Review the resulting diff, then explicitly adopt the changes through the verification flow only when they are understood. Missing/unsupported required gates also produce `INCOMPLETE`, not a false pass.

## Upgrade and rollback

```bash
lca update
lca rollback
```

`lca update` refuses a dirty LCA checkout unless explicitly forced. It stops a running supervisor, snapshots CLI config, `.env.local`, and runtime state, then fast-forwards the checkout, installs dependencies, checks storage, and records the pre-upgrade commit as a rollback point. It starts the runtime again only if it was running before. Each mutation is preceded by a durable coordinator stage; an interrupted operation is resumed or safely returned to its recorded source revision on the next `lca` invocation. Secrets are preserved and are not printed.

`lca rollback` stops a running supervisor, creates a pre-rollback safety snapshot, switches to the recorded pre-upgrade commit, restores the CLI config and `.env.local` snapshot, reinstalls dependencies, and restarts only when appropriate. A recovery bundle outside the Git checkout contains the CLI entrypoint and the complete `scripts/cli` module tree, so it remains callable while the transaction is pending. Rollback preserves the current runtime data for a later return. Refresh the connector if the rolled-back release exposes a different catalog.

Both commands avoid destructive Git cleanup by default. Recovery never passes Git's discard option for a dirty checkout unless the migration was explicitly authorized with `--force`; an ambiguous revision fails closed for manual review.

## Measured release status and known limits

The local release gates on 2026-07-18 cover catalog/session, storage, task isolation, cross-workspace transaction, task-close recovery, shell-mutation detection, journal, coding intelligence, agent, performance, hardening, Figma, security, CLI/supervisor, and VS Code extension checks. The eval suite passes 25/25 golden assertions. CLI passes 20/20. The measured catalog figures—35 tools, 24,652 bytes raw, 4,139 bytes with equivalent compression, and hash `96a7ec1d5fdf41d7`—belong to the 5.0.0 release before `task_reclassify` raised the current catalog to 36 tools/version 7. The 36-tool catalog must be measured again before publishing replacement size/hash claims. The focused performance gate measured stateful dispatch p95 0.006 ms, `lca_status` handler/server-total p95 0.3/1.3 ms, warm `workspace_snapshot` p95 40.02 ms, warm `code_query` p95 2.31 ms, widget autocomplete backend/end-to-end p95 36.3/37.82 ms, and compose 1.5/2.50 ms.

The release-scale cold-builder benchmark creates 10 registered workspaces, keeps two hot, runs 1,000 warm queries, mutates a watched file, and commits a two-workspace patch. The latest 10k run measured index 1.15 seconds, query p95 0.04 ms, freshness 43.5 ms, post-GC RSS 111.77 MB, cache 2.33 MB, forced-GC heap growth 1.26%, and event-loop p99 18.73 ms. The final 100k run measured index 9.89 seconds, warm snapshot 0.04 ms, query p95 0.04 ms, freshness 238.80 ms, post-GC RSS 120.17 MB, cache 23.46 MB, heap growth 3.00%, and event-loop p99 11.96 ms. Every measured 10k and 100k SLA is true. Runtime timing starts after isolated fixture generation so synthetic file creation is not misreported as LCA event-loop work.

The required 250k characterization also runs the same full workflow. It measured index 24.11 seconds, warm snapshot 0.04 ms, query p95 0.04 ms, freshness 547.79 ms, post-GC RSS 149.70 MB, cache 58.95 MB, heap growth 2.51%, and event-loop p99 11.96 ms; RSS after closing the hot graph returned to 120.57 MB. This is intentionally reported as characterization rather than relabeled as the 100k release target: index/query/cache/heap/event-loop behavior remains bounded, while live RSS and sub-500 ms freshness are the current 250k operating boundary.

The structural adapter is deliberately not presented as a compiler-grade type system for every language. When a query exceeds its coverage/budget, or a language lacks a deeper adapter, the result is partial with an explicit fallback reason. Project-local LSP/compiler integration can be added through `index_control`; packages are never installed globally or silently. “10/10” here means the measurable release gates, not a promise that an agent or parser can never be wrong.

Every patch-coordinator fault hook has isolated all-before/all-after recovery coverage, including partial commit. Tests also cover simulated `ENOSPC` during staging, `SQLITE_BUSY`, database corruption/clean-backup recovery, missing durable transaction manifests, expired leases/fencing, and every durable update/rollback migration stage. Unsafe ambiguity produces `in_doubt` or a blocked recovery rather than a false success.

Restart recovery has a real two-process integration test: the first runtime persists a task/plan, exits, and a new MCP session rejects missing/stale context before resuming the exact task with its token. A separate 1,000-cycle stateful reconnect benchmark completed 1,000/1,000 reconnects (100%, p95/p99 8.42/11.09 ms, above the 99.9% success gate). Hosted network reliability remains distinct from deterministic local loopback evidence.

`.github/workflows/nightly.yml` schedules 10,000 verified supervisor/server/fake-tunnel lifecycle cycles sharded across ten jobs, a real restart/resume test, 1,000 reconnect measurements, and canonical 10k scale artifacts. No scale SLA failure is allow-listed. CI is configured for Node.js 22.13 and 24 on macOS, Linux, and Windows. These workflows are executable release gates; an actual green hosted run must still be checked in GitHub before publishing a binary release.

The current local retrieval golden covers eight independent definitions and eight imported-reference expectations. The seeded impacted-test case spans eight monorepo packages, requires at least 95% recall, and caps the selected suite at 25% of all seeded tests. These are real regression gates, but they are still small deterministic fixtures rather than a claim of broad cross-language production recall.

Runtime responsibilities are organized by stable domains under `server/src` (`app`, `http`, `mcp`, `workspace`, `coding`, `mutation`, `verification`, `review`, `execution`, `storage`, `integrations`, and `shared`). `server/server.mjs` remains a five-line compatibility entrypoint and `server/src/server.mjs` is a bootstrap-only entrypoint. Source directories are never namespaced by product version.

## Runtime status

Use:

```bash
lca status
lca doctor
```

`lca status` reports the supervisor, server/tunnel readiness, active MCP sessions/tasks, and registered workspaces.

- `GET http://127.0.0.1:8789/healthz` is public liveness only. It returns status, version, `catalog_version`, and `catalog_hash`; it intentionally omits roots, tasks, PID, and configuration.
- `GET /healthz/details` is for trusted local companions. In production it requires loopback plus `X-LCA-Instance-Nonce`; an MCP tunnel bearer is insufficient. Normal `lca status` output redacts the nonce; the extension uses the explicit machine-readable local flow `lca status --json --include-instance-nonce`.
- Every `/changes` route, including `/changes/events`, uses the same companion authentication. Do not embed the nonce in documentation, settings committed to Git, or browser code.

ChatGPT Web must use the tunnel MCP URL rather than either loopback health URL.
