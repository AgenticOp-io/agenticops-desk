@echo off
rem Starts AgenticOps Desk in dev mode with output going to a log instead of a window.
rem The "AgenticOps Desk" shortcut runs this through "conhost --headless", so no terminal appears.
rem Closing the AgenticOps Desk window stops the dev server too.
cd /d "%~dp0.."
if not exist "%APPDATA%\AgenticOps Desk" mkdir "%APPDATA%\AgenticOps Desk"
npm run dev > "%APPDATA%\AgenticOps Desk\dev.log" 2>&1
