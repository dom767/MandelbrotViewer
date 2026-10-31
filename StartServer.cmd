@echo off
rem Start Mandelbrot Zoomer's dev server (AgentController standards/guidelines/start-scripts.md).
rem Serves the working tree as it is (no build). Uses %PORT% if set (agents), otherwise 10001.
setlocal
cd /d "%~dp0"

if not defined PORT set PORT=10001

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is needed to run the dev server. Install the LTS version from https://nodejs.org and try again.
  if not defined AC_NO_PAUSE pause
  exit /b 1
)

echo Serving %CD% on http://127.0.0.1:%PORT%/
echo Open it in Chrome or Edge (WebGPU). Close this window or press Ctrl+C to stop.
call npx --yes serve -l %PORT% --no-port-switching .
