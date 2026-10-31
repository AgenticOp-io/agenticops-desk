@echo off
rem Starts ClaudeDesk in dev mode with output going to a log instead of a window.
rem The "ClaudeDesk" shortcut runs this through "conhost --headless", so no terminal appears.
rem Closing the ClaudeDesk window stops the dev server too.
cd /d "%~dp0.."
if not exist "%APPDATA%\ClaudeDesk" mkdir "%APPDATA%\ClaudeDesk"
npm run dev > "%APPDATA%\ClaudeDesk\dev.log" 2>&1
