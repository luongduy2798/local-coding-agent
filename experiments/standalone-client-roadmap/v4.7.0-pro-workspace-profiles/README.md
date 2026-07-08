# v4.7.0-pro Workspace Profiles

Goal: support multiple customer workspaces cleanly.

## Implemented Prototype

- Profile CRUD:
  - create
  - use
  - rename
  - delete
  - export redacted
- Per-profile settings:
  - workspace
  - extra roots
  - mode
  - policy
  - MCP port
  - dashboard port
  - tunnel ID
  - organization ID
  - model preset
- Activate a profile, then start the MCP server from the Studio UI.
- Active profile, endpoint, model, and workspace are shown in the profile list
  and connection status.

## Run

```powershell
npm install
npm start
```

Open `http://127.0.0.1:5179`.

Or double-click `dist\LocalAgentStudio.exe` after running `..\build-all.ps1`.

Profile data is stored under the current user's local application-data folder,
not committed to the repository.
