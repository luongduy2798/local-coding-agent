# v4.6.0-pro Model Router

Goal: make the standalone client model-agnostic.

## Implemented Prototype

- Model provider interface:
  - OpenAI Responses API
  - Anthropic Messages API
  - local/Ollama-compatible HTTP models
- Tool schema adapters per provider.
- Configurable model presets:
  - fast
  - balanced
  - deep-review
  - local-only
- Retry and rate-limit handling.
- Retry handling for network errors, HTTP 429, and HTTP 5xx responses.
- Tool-call latency is shown in the timeline; raw provider usage remains
  available in the returned response payload.

## Run

```powershell
npm install
npm start
```

Open `http://127.0.0.1:5178`.

Or double-click `dist\LocalAgentStudio.exe` after running `..\build-all.ps1`.

The provider adapters are included in this folder's `standalone-app.mjs`.
`../shared/standalone-app.mjs` is the canonical copy used by `build-all.ps1`.
