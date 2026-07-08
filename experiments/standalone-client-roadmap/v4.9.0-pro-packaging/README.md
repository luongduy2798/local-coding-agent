# v4.9.0-pro Packaging

Goal: make customer distribution simple.

## Implemented Prototype

- Windows x64 self-contained .NET launcher.
- Independent `dist/LocalAgentStudio.exe` in every version folder.
- Update assistant:
  - check current version
  - fetch latest release
  - preserve local config and tools
  - validate after update
- Support bundle:
  - redacted config
  - doctor
  - network doctor
  - status
  - health summary
  - relevant logs

## Build

```powershell
powershell -ExecutionPolicy Bypass -File ..\build-all.ps1
```

Run `dist\LocalAgentStudio.exe`.

The launcher requires Node.js 18+ and installs npm dependencies when they are
missing. macOS/Linux portable packaging remains a later release task.
