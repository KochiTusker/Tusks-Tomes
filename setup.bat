@echo off
REM ===========================================================================
REM Tusk's Tomes — first-time setup (Windows)
REM
REM Safe to double-click. This script does ONLY the following:
REM
REM   1. Checks whether Node.js >= 20 is installed. If not, prints the
REM      single winget command to install it and exits.
REM   2. If Node is present, hands control over to
REM      `node scripts\setup\check-deps.mjs`, which is plain readable
REM      JavaScript you can audit before running.
REM
REM Nothing here is silent: every action is echoed to the terminal. We
REM never install system packages on your behalf, never elevate to admin,
REM and never touch anything outside this folder.
REM ===========================================================================

setlocal
cd /d "%~dp0"

title Tusk's Tomes - first-time setup

echo.
echo  ============================================
echo    Tusk's Tomes - first-time setup
echo  ============================================
echo.
echo  WHAT THIS WINDOW IS DOING
echo.
echo   This is the normal installer for Tusk's Tomes. You will see a lot of
echo   text scroll past - that is just the installer listing the files it is
echo   downloading. It is not an error, and nothing is wrong.
echo.
echo   What it does:
echo     - Checks you have Node.js installed.
echo     - Downloads the code libraries the app needs, into a folder called
echo       "node_modules" inside THIS folder.
echo.
echo   What it does NOT do:
echo     - It never asks for Administrator rights.
echo     - It never installs anything into Windows itself.
echo     - It never touches any folder outside this one.
echo     - It never sends your files anywhere.
echo.
echo   Everything it creates can be removed by deleting this folder.
echo   This usually takes 1-3 minutes depending on your internet speed.
echo.
echo  --------------------------------------------
echo.

REM ---- Pre-flight: confirm we can actually write to this folder ----
REM Catches Program Files / read-only / OneDrive-locked / antivirus
REM situations before npm install spends 60+ seconds dying on EACCES.
set "WRITE_PROBE=%~dp0.write-probe.tmp"
echo. > "%WRITE_PROBE%" 2>nul
if errorlevel 1 (
  echo  [error] This folder isn't writable: %~dp0
  echo.
  echo  Common causes on Windows:
  echo    - Repo cloned into Program Files, a system folder, or a network drive.
  echo    - Folder locked by OneDrive sync, Dropbox, or antivirus.
  echo    - VS Code or another editor is holding a file open in node_modules.
  echo.
  echo  Move the folder somewhere writable ^(Documents, Desktop^) and re-run
  echo  setup.bat. Don't run this as Administrator - that creates files your
  echo  normal user can't update later.
  echo.
  pause
  exit /b 1
)
del "%WRITE_PROBE%" >nul 2>nul

REM ---- Check Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo  [missing] Node.js was not found on PATH.
  echo.
  echo  Install Node.js 20 LTS or newer, then re-run this script:
  echo.
  echo      winget install OpenJS.NodeJS.LTS
  echo.
  echo  Or download from https://nodejs.org/
  echo.
  echo  After installing, close this window and open a new one so PATH
  echo  picks up the new node.exe.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set NODE_VERSION=%%v
echo  [ok] Node.js %NODE_VERSION%
echo.

REM ---- Hand off to the cross-platform Node script ----
echo  Running dependency check (scripts\setup\check-deps.mjs)...
echo.
node scripts\setup\check-deps.mjs
set EXIT_CODE=%errorlevel%

echo.
if %EXIT_CODE% NEQ 0 (
  echo  Setup did not complete cleanly. Scroll up for details.
) else (
  echo  Setup complete. You can close this window.
)
pause
exit /b %EXIT_CODE%
