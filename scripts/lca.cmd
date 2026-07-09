@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js 18+ is required but node was not found in PATH.
  echo Install Node.js LTS from https://nodejs.org/ then open a new terminal and rerun:
  echo   scripts\lca.cmd setup
  exit /b 1
)
node "%~dp0local-coding-agent.mjs" %*
exit /b %ERRORLEVEL%
