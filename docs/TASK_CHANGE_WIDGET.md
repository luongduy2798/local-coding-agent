# Task-scoped diff, Undo and Reapply

LCA stores each coding job as an independent Git-backed change set. A task records either the known mutation paths or, when the scope is unknown, the full workspace tree before and after the job. Its diff does not include unrelated dirty changes that existed before the task.

## User flow

1. ChatGPT completes reads, searches and planning first.
2. Immediately before the first workspace mutation, ChatGPT calls `task_begin`, passing every known mutation path. It omits `paths` for commands or unknown scope to use the full-repository fallback.
3. ChatGPT edits the requested change with normal LCA tools.
4. ChatGPT calls `task_finish` after the work is complete to save the task and forward patch.
5. ChatGPT immediately calls `task_get` with the returned task ID to render the ChatGPT task widget.
6. **View diff** lazily reads the stored forward patch through read-only `task_diff` and the MCP Apps `tools/call` bridge.
7. **Undo** and **Reapply** send a `ui/message` user turn into the current conversation.
8. ChatGPT calls `task_undo` or `task_reapply`, keeping the model's conversation context consistent with the real workspace.

The widget never calls mutation tools directly.

## Tools

- `task_begin({ title, description?, paths?, cwd? })`
- `task_finish({ task_id, summary?, cwd? })`
- `task_get({ task_id, cwd? })`
- `task_list({ cwd?, status?, limit? })`
- `task_diff({ task_id, path?, mode?, max_chars?, offset?, cwd? })`
- `task_undo({ task_id, cwd? })`
- `task_reapply({ task_id, cwd? })`

Only one task may be active in a repository at a time in the first implementation.

## Storage

Task metadata and patches live inside the repository Git directory:

```text
.git/lca/tasks/<task-id>/
├── metadata.json
├── forward.patch
└── history.jsonl
```

Snapshots are Git tree objects kept alive by hidden refs:

```text
refs/lca/tasks/<task-id>/before
refs/lca/tasks/<task-id>/after
```

The snapshot process uses a temporary Git index (`GIT_INDEX_FILE`). It does not alter the user's real staging area. When `paths` is present, only those files/directories are refreshed from the working tree; every other path remains at `HEAD` in both snapshots. The caller must therefore include every path the mutation may touch. When `paths` is omitted, LCA falls back to `git add -A -- .`. Ignored files are excluded unless they are already tracked.

## Undo safety

`task_undo` runs `git apply -R forward.patch`; `task_reapply` runs `git apply forward.patch`.

Before changing files, LCA runs `git apply --check`. If later edits overlap with the task patch, the operation returns `task_patch_conflict` and leaves the filesystem unchanged. Version 1 does not cascade through later tasks automatically.

## ChatGPT widget bridge

The widget uses the portable MCP Apps bridge first:

- `tools/call` for `task_diff`
- `ui/message` for Undo and Reapply
- `ui/notifications/tool-result` to receive task state

`window.openai.callTool` and `window.openai.sendFollowUpMessage` are compatibility fallbacks where needed.

## Model workflow rule

For a coding request that may modify files:

```text
read/search/plan
→ task_begin({ paths: [...] }) immediately before mutation
→ edit tools
→ task_finish
→ task_get({ task_id })
```

For an Undo/Reapply message from the widget, call the task mutation tool named in the message. Do not use the whole working-tree diff when a task ID is available.

## Tests

Run:

```bash
cd server
npm run test:tasks
```

The regression test covers:

- dirty changes that existed before a task;
- path-scoped snapshots with full-repository fallback;
- task-only diff loaded from the stored forward patch;
- created and modified files;
- undo and reapply;
- idempotent repeated operations;
- conflict detection without overwriting later changes;
- task widget metadata and bridge behavior.
