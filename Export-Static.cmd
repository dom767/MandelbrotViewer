@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Export-Static.ps1" %*
set EXITCODE=%ERRORLEVEL%
if %EXITCODE% neq 0 (
  echo.
  echo Export failed with exit code %EXITCODE%.
  pause
  exit /b %EXITCODE%
)
echo.
pause
endlocal
