@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 18 or newer first.
  pause
  exit /b 1
)
set "PORT=18125"
if not defined CODEX_BIN if exist "%APPDATA%\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe" set "CODEX_BIN=%APPDATA%\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe"
echo Open http://localhost:18125/ after the server starts.
echo Keep this window open. Press Ctrl+C to stop.
node server.js
pause
