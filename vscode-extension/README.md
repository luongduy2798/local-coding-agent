# Local Coding Agent Workspace Activity for VS Code

The extension is a thin VS Code host for the shared Local Coding Agent React Control Center. It adds one workspace-focused **Workspace Activity** view to the VS Code Activity Bar.
It shows observable LCA runtime, activity, task and Review Changes state; it does not display
`task_plan`, prompts, model thinking, tool arguments/output, or fake progress.

## Install and open

```bash
lca integrations setup vscode
lca integrations open vscode
```

Uninstall:

```bash
lca integrations uninstall vscode
```

`lca extension` remains a deprecated compatibility alias. The normal `lca setup` command does not install editor integrations. Run the integration command from an
integrated terminal. **Connect current folder** registers that folder, makes it the global default
for new tasks, and starts LCA when needed. It never changes the primary workspace of a task that is
already open.

The normal view is one workspace-focused feed:

- The compact header shows connection, version, active/max sessions and sync state. Start/Stop and
  Refresh are direct icon actions; monitoring remains active whenever the view is visible, and the
  workspace registry opens from the workspace popover.
- Tasks form one chat-style chronological feed: older assignments stay above and the newest task is
  appended and highlighted at the bottom. Opening the view or switching workspace starts at the
  latest task.
- Each task owns the safe audit activity shown directly beneath its title. Activity is ordered from
  old to new, shows duration and relative time, and the webview uses one shared clock only while work
  runs.
- While the user remains near the bottom, new tasks and activity auto-follow. Scrolling upward pauses
  following and shows **Latest** instead of pulling the view away from history.
- A task with reviewable changes shows **Changes N**. Expanding it displays that task's existing
  change records inline with `operations · files · +/−`, native diff, Undo and Reapply actions.
- Archived workspace history remains available as a separate read-only route from the workspace
  manager.

The current editor folder is selected first. Every other active/available registry workspace remains
available from the header manager. Each selection uses its workspace-scoped SSE stream; if SSE fails,
the view temporarily polls and then reconnects to return to Live.

Available actions:

- Make an active workspace the global default for new tasks.
- Archive a workspace while preserving its ID, tasks, journals, blobs, index and read-only history.
- Restore an archived workspace after its trust and filesystem/Git identity are verified.
- Permanently remove LCA data after exact-label confirmation, while leaving source files untouched.
- Review a before/after diff.
- Show one aggregated card for the full user task, even when LCA applies several patches.
- Undo or Reapply the complete task in operation-safe order.
- Undo or Reapply one file from a multi-file task.
- Close stale Review Changes diff tabs automatically after Undo or Reapply.
- Undo All applicable changes.
- Clear saved change history without changing workspace files.
- Follow journal revisions through server-sent events when supported, with bounded polling as a compatibility fallback.

Undo, Reapply, Undo All, and Clear are intentionally unavailable for a task attached to more
than one workspace. The server returns `CROSS_WORKSPACE_HISTORY_ATOMICITY_REQUIRED` because
Review Changes does not yet have one history transaction spanning every workspace journal.

Permanent removal is also blocked for a default/configured workspace, any multi-workspace task
history, an incomplete transaction, or while the LCA supervisor/server/tunnel is running. Archive
is reversible; permanent removal is not. Registering the same source root after permanent removal
creates a new workspace ID.

The extension verifies workspace identity by canonical root; it never infers identity from folder labels. Requests and mutations carry the selected `workspace_id` and `task_id` when the V5 HTTP API provides them. Connect and mutation actions are disabled until the workspace is trusted, and security-sensitive connection settings are restricted in untrusted workspaces.

Public `/healthz` is used only for liveness. The extension authenticates `/healthz/details` and
all `/changes` requests with the supervisor instance nonce obtained through the explicit local
flow `lca status --json --include-instance-nonce`. The MCP tunnel bearer does not grant Control
Center authority. Never hard-code the instance nonce in workspace settings.

Tool activity is read from the existing rotating runtime audit log, not a second activity database.
The UI keeps at most 20,000 events from the last seven days and only projects safe metadata:
invocation/tool/task/workspace IDs, phase, timestamps, duration, safe error code, verification enum
and counts. Arguments, commands, output, prompts, tokens, thinking and error content never enter the
webview. If audit is disabled, only per-task activity becomes unavailable.

## Development

```bash
cd vscode-extension
npm install
npm run check
npm test
npm run build
```

Open the `vscode-extension/` folder in VS Code, run `npm run build`, then press `F5`. Workspace
Activity can inspect the complete registry from its header manager; file mutation and **Open current
file** remain restricted to repos open in the current trusted VS Code window.
