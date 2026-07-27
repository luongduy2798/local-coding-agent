# Local Coding Agent for JetBrains IDEs

This plugin is a thin JCEF host for the shared React Control Center bundle. It does not duplicate task, activity, Review Changes, blocker, or workspace presentation logic.

The tool window launches:

```bash
lca ui --print-url --no-open --host jetbrains --workspace <project-root>
```

The CLI exchanges the supervisor instance nonce for a short-lived, one-time launch ticket. JCEF receives only a same-origin HttpOnly session cookie; the supervisor nonce, MCP bearer, tunnel key and command output are never injected into browser JavaScript.

Build the distribution through the universal CLI:

```bash
lca integrations setup jetbrains
```

Then install the generated ZIP using **Settings → Plugins → Install Plugin from Disk** and restart the IDE. Java 17 and Gradle 9+ are required for the plugin build.

The first scaffold deliberately uses web diff and copy-path fallbacks. Native JetBrains file opening and DiffManager integration can be added later through the shared host action protocol without changing the React UI.
