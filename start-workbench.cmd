@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 18 or newer first.
  pause
  exit /b 1
)
set "PORT=18125"
echo Open http://localhost:18125/ after the server starts.
echo Keep this window open. Press Ctrl+C to stop.
node server.js
pause
