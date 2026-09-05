@echo off
REM Launches the Leaderboard as a fullscreen Electron kiosk window (see
REM electron/main.js). Runs npm's dev server + Electron together via
REM `electron:dev`. Logs go to %TEMP%\leaderboard_electron.log.
REM
REM IMPORTANT: ELECTRON_RUN_AS_NODE must be cleared here -- VS Code (and
REM some other tools) set it in the environment to make their bundled
REM Electron behave as plain Node, which breaks `require('electron').app`
REM (throws "Cannot read properties of undefined (reading 'whenReady')").
set PATH=C:\Program Files\nodejs;C:\Windows\system32;C:\Windows
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
npm run electron:dev > "%TEMP%\leaderboard_electron.log" 2>&1
