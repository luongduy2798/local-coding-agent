# Local Coding Agent
# Copyright (c) 2026 Long Nguyen
# SPDX-License-Identifier: AGPL-3.0-or-later

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Local Coding Agent launcher: starts the Node MCP server, then the OpenAI
# Secure MCP Tunnel. Edit the variables below, then run this script.
#
# This file is intentionally pure-ASCII: Windows PowerShell 5.1 reads .ps1 as
# ANSI, so non-ASCII literals (e.g. accented folder names) get corrupted.
# Use $AgentWorkspace below or set it via the AGENT_WORKSPACE env var.
# ---------------------------------------------------------------------------

# Repo root = parent of this script's folder (repo/scripts/..).
$RepoRoot  = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ServerDir = Join-Path $RepoRoot "server"

# ---- Edit these ----------------------------------------------------------
# Folder the agent is allowed to work in (REQUIRED). Example:
#   $AgentWorkspace = "C:\Users\you\source\my-project"
$AgentWorkspace = $env:AGENT_WORKSPACE
# Path to YOUR copy of the OpenAI tunnel-client.exe (not shipped in this repo).
$TunnelExe      = Join-Path $RepoRoot "tools\tunnel-client.exe"
$ProfileName    = "local-coding-agent"
$ProfileDir     = Join-Path $RepoRoot "tools\profiles"
$AgentMode      = "safe"     # "safe" (recommended) or "full"
$AgentPolicy    = "balanced" # "strict", "balanced", or "full"
$ExtraRoots     = ""          # extra folders, semicolon-separated
$AuthToken      = ""          # optional bearer token (defense in depth)
$Port           = "8789"
# --------------------------------------------------------------------------

$McpHealthUrl = "http://127.0.0.1:$Port/healthz"

function Get-McpHealth {
    try {
        $r = Invoke-WebRequest -Uri $McpHealthUrl -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -ne 200) { return $null }
        return ($r.Content | ConvertFrom-Json)
    } catch { return $null }
}

function Stop-McpServer([object]$Health) {
    $pidToStop = 0
    if ($Health -and $Health.pid) { $pidToStop = [int]$Health.pid }

    if (-not $pidToStop) {
        $matches = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
            Where-Object { $_.CommandLine -like "*server.mjs*" })
        if ($matches.Count -eq 1) { $pidToStop = [int]$matches[0].ProcessId }
        elseif ($matches.Count -gt 1) {
            throw "Multiple node server.mjs processes are running; refusing to stop them broadly. Stop the intended PID and retry."
        }
    }

    if (-not $pidToStop) { throw "The MCP endpoint is active but its server PID could not be identified safely." }
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $pidToStop" -ErrorAction SilentlyContinue
    if (-not $processInfo -or $processInfo.Name -ine "node.exe" -or $processInfo.CommandLine -notlike "*server.mjs*") {
        throw "PID $pidToStop does not look like the Local Coding Agent server; refusing to stop it."
    }
    Stop-Process -Id $pidToStop -Force -ErrorAction Stop
    Start-Sleep -Seconds 1
}

if (-not $AgentWorkspace) {
    throw "Set `$AgentWorkspace at the top of this script (or the AGENT_WORKSPACE env var) to the folder you want the agent to work in."
}
if (-not (Test-Path -LiteralPath $AgentWorkspace)) {
    throw "Workspace folder does not exist: $AgentWorkspace"
}
if (-not (Test-Path -LiteralPath $TunnelExe)) {
    throw "tunnel-client.exe not found at: $TunnelExe  (obtain it yourself and update `$TunnelExe)"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required but 'node' was not found on PATH."
}

# A non-secret signature lets the launcher detect every startup-setting change,
# not only workspace/mode. The auth value itself is deliberately not hashed.
$configMaterial = [ordered]@{
    workspace = [IO.Path]::GetFullPath($AgentWorkspace)
    mode = $AgentMode
    policy = $AgentPolicy
    extraRoots = $ExtraRoots
    authEnabled = [bool]$AuthToken
    port = $Port
} | ConvertTo-Json -Compress
$AgentConfigId = $configMaterial | node -e "const c=require('crypto');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(c.createHash('sha256').update(s).digest('hex').slice(0,16)))"

# Install server deps on first run.
if (-not (Test-Path -LiteralPath (Join-Path $ServerDir "node_modules"))) {
    Write-Host "Installing server dependencies..."
    Push-Location $ServerDir; npm install; Pop-Location
}

# Restart only the server behind this health endpoint when startup config changed.
$health = Get-McpHealth
if ($health -and $health.config_id -ne $AgentConfigId) {
    Write-Host "Restarting MCP server with the requested config..."
    Stop-McpServer $health
    $health = $null
}

if (-not $health) {
    Write-Host "Starting MCP server (workspace=$AgentWorkspace mode=$AgentMode)..."
    $env:PORT = $Port
    $env:AGENT_WORKSPACE = $AgentWorkspace
    $env:AGENT_MODE = $AgentMode
    $env:AGENT_POLICY = $AgentPolicy
    $env:AGENT_CONFIG_ID = $AgentConfigId
    $env:AGENT_EXTRA_ROOTS = $ExtraRoots
    $env:MCP_AUTH_TOKEN = $AuthToken
    Start-Process -FilePath "node.exe" -ArgumentList "server.mjs" `
        -WorkingDirectory $ServerDir -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $ServerDir "mcp.log") `
        -RedirectStandardError (Join-Path $ServerDir "mcp.err.log")
    Start-Sleep -Seconds 2
}

if (-not (Get-McpHealth)) {
    throw "MCP server did not respond at $McpHealthUrl. Check server\mcp.err.log."
}

Write-Host "MCP server OK:  http://127.0.0.1:$Port/mcp"
Write-Host ""
Write-Host "Paste the Runtime API key for the OpenAI Secure MCP Tunnel."
Write-Host "It connects the tunnel; it is not used for model responses."
$secureKey = Read-Host "CONTROL_PLANE_API_KEY" -AsSecureString
$plainKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey))

try {
    $env:CONTROL_PLANE_API_KEY = $plainKey
    if ($AuthToken) {
        $env:MCP_AUTH_HEADER = "Bearer $AuthToken"
        $env:MCP_EXTRA_HEADERS = "Authorization: env:MCP_AUTH_HEADER"
    }
    Write-Host ""
    Write-Host "Running tunnel. Keep this window open while using the ChatGPT app."
    & $TunnelExe run --profile $ProfileName --profile-dir $ProfileDir --open-web-ui
} finally {
    Remove-Item Env:\CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:\MCP_AUTH_HEADER -ErrorAction SilentlyContinue
    Remove-Item Env:\MCP_EXTRA_HEADERS -ErrorAction SilentlyContinue
}
