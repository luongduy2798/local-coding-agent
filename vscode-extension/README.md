# Local Coding Agent for VS Code

The extension adds a **Review Changes** view to the VS Code Activity Bar.

## Install and open

```bash
lca extension setup
lca extension
```

Uninstall:

```bash
lca extension uninstall
```

The normal `lca setup` command does not install editor integrations. Run `lca extension` from the integrated terminal of the workspace you want to review. If LCA is serving another workspace, click **Connect LCA to this workspace** in the view; the extension stops the old instance and starts LCA for the current folder.

The view shows only the newest recorded change, matching the focused review flow used by Codex. Select a changed file to open the native VS Code diff editor.

Available actions:

- Review a before/after diff.
- Show one aggregated card for the full user task, even when LCA applies several patches.
- Undo or Reapply the complete task in operation-safe order.
- Undo or Reapply one file from a multi-file task.
- Close stale Review Changes diff tabs automatically after Undo or Reapply.
- Undo All applicable changes.
- Clear saved change history without changing workspace files.

The extension verifies that the workspace returned by `GET /healthz` matches one of the current VS Code workspace folders. Mutation actions are disabled until the workspace is trusted.

When LCA uses bearer authentication, run **LCA: Set Authentication Token** from the Command Palette. The token is stored in VS Code SecretStorage.

## Development

```bash
cd vscode-extension
npm install
npm run check
npm run build
```

Open the `vscode-extension/` folder in VS Code, run `npm run build`, then press `F5` and choose **Run Review Changes Extension**. In the Extension Development Host, open the project that LCA is currently serving.
