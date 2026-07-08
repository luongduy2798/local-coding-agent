# Local Coding Agent - Windows Tray App

A small C#/.NET WinForms tray app that runs and supervises the Local Coding
Agent on one machine:

- Starts/stops the Node MCP server (`server/server.mjs`) and the OpenAI Secure
  Tunnel.
- A form to set the workspace root(s), mode, policy, ports, Runtime API key,
  Tunnel ID, and Organization ID.
- Stores the Runtime API key encrypted with Windows DPAPI (per user), never as
  plain text.
- Writes the tunnel profile YAML from the form so changing Tunnel ID or MCP URL
  does not require hand-editing config files.
- Live status, one-click **Copy MCP URL** and **Open Dashboard**.
- **Stop is authoritative**: it stops the server/tunnel even if they were
  started outside the app, for example by the launcher script.

Full documentation and security model: see the [repository README](../README.md).

## Requirements

- **Build:** .NET SDK (project targets `net10.0-windows`):
  https://aka.ms/dotnet/download
- **Run after self-contained publish:** nothing extra.
- Node.js for the MCP server.
- `tunnel-client.exe`, obtained separately from OpenAI.

## Build / run

```powershell
cd tray-app
dotnet run

# Or publish a single self-contained exe in .\publish:
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

## First-time setup in the app

1. Launch the app. Path fields auto-fill relative to the repo; set
   **Workspace** to the folder you want the agent to work in.
2. Choose **Mode** (`safe` recommended) and **Policy** (`balanced`
   recommended; `strict` = read-only, `full` = no local approval gate).
3. Point **tunnel-client.exe** at your copy.
4. Enter **Tunnel ID** (`tunnel_...`) from ChatGPT/OpenAI and the
   **Organization ID** (`org_...` or the organization value shown in Platform).
   Click **Save tunnel**. This rewrites the profile YAML.
5. Paste the **Runtime API key** into **Runtime API key** and click
   **Save key**. This is the Platform runtime key, not the Admin key used to
   create/manage tunnels.
6. Click **Start**. The tray starts the MCP server, then starts
   `tunnel-client` with the generated profile:

```text
CONTROL_PLANE_API_KEY=<saved runtime key>
control_plane.tunnel_id=<Tunnel ID>
control_plane.extra_headers=["OpenAI-Organization: <Organization ID>"]
```

The Organization ID fixes tunnel-client errors like:

```text
tunnel_active_organization_required
Configure the organization ID or send the OpenAI-Organization header.
```

Closing the window keeps it in the tray. Tray -> **Exit** fully stops it.

## Where settings live

`%APPDATA%\LocalCodingAgent\config.json`

The API key is the DPAPI-encrypted `EncryptedKey` field, decryptable only by the
same Windows user on the same machine. Tunnel ID and Organization ID are not
encrypted because they are routing/configuration values, not model/API secrets.

Hidden helper: `LocalCodingAgentTray.exe --kill-strays` stops any running
server/tunnel headlessly.
