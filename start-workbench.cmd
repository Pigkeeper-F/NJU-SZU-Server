@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 18 or newer first.
  pause
  exit /b 1
)
echo Checking the local workbench at http://localhost:18125/
echo Existing workbench instances are reused; your browser address stays unchanged.
node "%~dp0tools\start-workbench.js" --port 18125
pause
