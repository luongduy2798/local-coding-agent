@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js ^>=22.13.0 is required but node was not found in PATH.
  echo Install Node.js 22 LTS from https://nodejs.org/ or run winget install OpenJS.NodeJS.LTS, then open a new terminal.
  exit /b 1
)
node "%~dp0local-coding-agent.mjs" %*
exit /b %ERRORLEVEL%
