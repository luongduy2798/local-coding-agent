param(
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Launcher = Join-Path $Root "windows-launcher"
$Publish = Join-Path $Launcher "publish\win-x64"
$Exe = Join-Path $Publish "LocalAgentStudio.exe"
$SharedRuntime = Join-Path $Root "shared\standalone-app.mjs"
$LegacyVersions = @(
  "v4.5.0-pro-local-client-mvp",
  "v4.6.0-pro-model-router",
  "v4.7.0-pro-workspace-profiles",
  "v4.8.0-pro-agent-studio-ui",
  "v4.9.0-pro-packaging"
)
$Versions = @(
  $LegacyVersions
  "v5.0.0-local-agent-studio"
)

foreach ($Version in $LegacyVersions) {
  $VersionDir = Join-Path $Root $Version
  Copy-Item -LiteralPath $SharedRuntime -Destination (Join-Path $VersionDir "standalone-app.mjs") -Force
  Write-Host "[runtime] $Version"
}

foreach ($Version in $Versions) {
  $VersionDir = Join-Path $Root $Version
  if (-not $SkipInstall) {
    Write-Host "[install] $Version"
    Push-Location $VersionDir
    try {
      npm install
      npm run check
      if ($Version -eq "v5.0.0-local-agent-studio") {
        npm test
        npm run security:audit
      }
    } finally {
      Pop-Location
    }
  }
}

Write-Host "[build] Windows launcher"
Push-Location $Launcher
try {
  dotnet publish .\LocalAgentStudioLauncher.csproj -c Release -r win-x64 --self-contained true -o $Publish
} finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $Exe)) {
  throw "Launcher exe was not produced: $Exe"
}

foreach ($Version in $Versions) {
  $Dist = Join-Path $Root "$Version\dist"
  New-Item -ItemType Directory -Force -Path $Dist | Out-Null
  $Target = Join-Path $Dist "LocalAgentStudio.exe"
  Copy-Item -LiteralPath $Exe -Destination $Target -Force
  Write-Host "[exe] $Target"
}

Write-Host "All standalone versions and Windows launchers are ready."
