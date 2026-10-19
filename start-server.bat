@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 18 or newer first.
  pause
  exit /b 1
)
echo ============================================
echo  Flow Agent  local server
echo ============================================
echo.
echo   Open in browser:   http://localhost:8123/
echo   Bound to 127.0.0.1 only (LAN cannot reach it).
echo   Keep this window open. Close it to stop.
echo   Existing workbench instances are reused through the same address.
echo.
node "%~dp0tools\start-workbench.js" --port 8123
echo.
echo Server stopped. Press any key to close.
pause >nul
