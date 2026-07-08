# Local Coding Agent
# Copyright (c) 2026 Long Nguyen
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# One-shot setup (Windows). Run from the repo root:  .\install.ps1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "== Local Coding Agent - setup ==" -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js not found. Install Node 18+ from https://nodejs.org then re-run." -ForegroundColor Yellow
    exit 1
}
Write-Host ("node {0}" -f (node -v))

Write-Host "Installing server dependencies..."
Push-Location (Join-Path $Root "server")
npm install --no-fund --no-audit
Pop-Location

$tools = Join-Path $Root "tools"
if (-not (Test-Path $tools)) { New-Item -ItemType Directory -Path $tools | Out-Null }

Write-Host ""
Write-Host "Done. Next steps:" -ForegroundColor Green
Write-Host "  1. Put your OpenAI tunnel client at: tools\tunnel-client.exe"
Write-Host "  2. Easiest: run the tray app   ->  cd tray-app; dotnet run   (or build.ps1)"
Write-Host "     Or the script              ->  `$env:AGENT_WORKSPACE='C:\path\to\repo'; .\scripts\start-tunnel.ps1"
Write-Host "  3. In ChatGPT: Settings -> Connectors -> Developer mode -> add the MCP connector."
Write-Host "  4. Verify in chat: 'call workspace_info'."
Write-Host ""
Write-Host "Dashboard (when running): http://127.0.0.1:8790/ui"
