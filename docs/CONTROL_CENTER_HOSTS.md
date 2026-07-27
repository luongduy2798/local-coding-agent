# Control Center hosts

Local Coding Agent uses one React Control Center bundle across three hosts:

```text
shared protocol + React UI + styles
        │
        ├── VS Code webview adapter
        ├── JetBrains JCEF adapter
        └── standalone local browser adapter
```

The shared code lives under `vscode-extension/src/webview/` for compatibility with the existing package build, but it no longer depends directly on `acquireVsCodeApi()`. `protocol.ts` defines serializable state, actions and capabilities; `host-bridge.ts` selects the available host transport.

## Standalone local web

```bash
lca integrations setup web
lca ui
```

`lca ui` starts LCA when necessary, reads the supervisor instance nonce from local process state, and uses it once to create a short-lived launch ticket. The browser follows that ticket and receives an `HttpOnly; SameSite=Strict` cookie. The nonce, MCP bearer and tunnel runtime key are never returned to browser JavaScript or stored in web storage.

The web host can inspect tasks, activity and Review Changes, close/delete eligible task history, and Undo/Reapply through existing journal routes. Runtime start/stop and workspace registration remain CLI or IDE-host actions. When native file opening is unavailable, the UI copies a relative path; textual review opens the local web diff route.

## VS Code

```bash
lca integrations setup vscode
lca integrations open vscode
```

The VS Code extension owns editor-specific operations only: workspace trust, SecretStorage, native file/diff opening, notifications and CLI process launch. It passes the shared serializable state to the same React bundle.

Legacy commands remain temporary aliases:

```bash
lca extension setup
lca extension
lca extension uninstall
```

## JetBrains IDEs

```bash
lca integrations setup jetbrains
```

The command builds `jetbrains-plugin/` and reports the distribution ZIP. Install it with **Settings → Plugins → Install Plugin from Disk**, restart the IDE, then open **View → Tool Windows → Local Coding Agent**.

The first JetBrains host is intentionally thin: it launches a host-scoped `lca ui` session and loads the shared bundle in JCEF. Web diff and copy-path behavior are available immediately. A future native bridge can implement JetBrains `FileEditorManager` and `DiffManager` actions without changing the React UI or server state model.

## Capability negotiation

Each host advertises capabilities rather than making the UI infer behavior from an IDE name or version:

```ts
interface ControlCenterHostCapabilities {
  runtimeControl: boolean;
  workspaceManagement: boolean;
  taskManagement: boolean;
  changeMutation: boolean;
  nativeOpenFile: boolean;
  nativeDiff: boolean;
  secretStorage: boolean;
}
```

Unsupported actions are hidden or use an explicit fallback. Server and host releases can therefore evolve independently while the shared protocol remains versioned and serializable.

## Integration CLI

```bash
lca integrations list
lca integrations setup <vscode|jetbrains|web>
lca integrations open <vscode|jetbrains|web>
lca integrations uninstall <vscode|jetbrains|web>
lca integrations doctor
```

Integration metadata is stored separately from runtime secrets. `lca setup` continues to install the core runtime without forcing a particular editor.
