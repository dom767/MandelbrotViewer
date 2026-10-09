@echo off
setlocal
cd /d "%~dp0"
set PORT=10001
set URL=http://localhost:%PORT%/

echo Starting Mandelbrot Zoomer server on %URL%
echo Close the server window when you are done.
echo.

start "Mandelbrot Zoomer" cmd /k npx --yes serve -l tcp://localhost:%PORT% --no-port-switching .

echo Waiting for the server to come up...
ping -n 3 127.0.0.1 >nul

rem Prefer Chrome for reliable WebGPU support
set CHROME=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
) else if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
  set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
) else if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" (
  set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
)

if defined CHROME (
  echo Opening Chrome...
  start "" "%CHROME%" "%URL%"
) else (
  echo Chrome not found; opening the default browser...
  start "" "%URL%"
)

endlocal
