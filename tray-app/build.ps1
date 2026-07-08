# Local Coding Agent
# Copyright (c) 2026 Long Nguyen
# SPDX-License-Identifier: AGPL-3.0-or-later

$ErrorActionPreference = "Stop"

# Build a self-contained, single-file Windows exe so end users do NOT need to
# install the .NET runtime. Output lands in .\publish .

$ProjDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Csproj = Join-Path $ProjDir "LocalCodingAgentTray.csproj"
$OutDir = Join-Path $ProjDir "publish"

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw "The .NET SDK is required to build. Install .NET 10 SDK: https://aka.ms/dotnet/download"
}

# A running instance locks the output exe and makes publish silently fail to
# overwrite. Stop any first.
Get-Process LocalCodingAgentTray -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

Write-Host "Restoring + publishing (win-x64, self-contained, single file)..."
dotnet publish $Csproj `
    -c Release `
    -r win-x64 `
    --self-contained true `
    /p:PublishSingleFile=true `
    /p:IncludeNativeLibrariesForSelfExtract=true `
    /p:EnableCompressionInSingleFile=true `
    -o $OutDir
if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed with exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "Done. Executable:"
Write-Host (Join-Path $OutDir "LocalCodingAgentTray.exe")
