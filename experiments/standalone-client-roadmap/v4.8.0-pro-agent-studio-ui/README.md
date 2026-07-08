# v4.8.0-pro Agent Studio UI

Goal: turn the MVP into a real Agent Studio interface.

## Implemented Prototype

- Chat timeline with:
  - model messages
  - tool calls
  - tool outputs
  - errors
  - approvals
- Skill controls:
  - list skills
  - read skill
  - validate skills
- Support controls:
  - status
  - doctor
  - network doctor
  - export support bundle
- Dashboard controls:
  - health score
  - latency
  - recent calls
  - top tools
- File/diff viewer for changed files.

## Run

```powershell
npm install
npm start
```

Open `http://127.0.0.1:5180`.

Or double-click `dist\LocalAgentStudio.exe` after running `..\build-all.ps1`.

Manual tool calls accept JSON arguments, and the UI exposes approvals,
metrics, files, diffs, skills, support bundles, profiles, and MCP supervision.
