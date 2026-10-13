@echo off
cd /d "%~dp0"
echo ============================================
echo  Flow Agent  local server
echo ============================================
echo.
echo   Open in browser:   http://localhost:8123/
echo   Bound to 127.0.0.1 only (LAN cannot reach it).
echo   Keep this window open. Close it to stop.
echo.
node server.js
echo.
echo Server stopped. Press any key to close.
pause >nul
