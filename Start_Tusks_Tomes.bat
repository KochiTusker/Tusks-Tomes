@echo off
REM ===========================================================================
REM Tusk's Tomes — start the local app (Windows)
REM
REM Safe to double-click after first-time setup. If you haven't run setup
REM yet, this script will redirect you to setup.bat.
REM
REM When Windows Terminal (wt.exe) is installed, this script relaunches
REM itself inside a shared "tusks" Windows Terminal window so that Tusk's
REM Tomes and Tusk's Vault open as adjacent tabs instead of two separate
REM cmd windows. Set TUSKS_NO_WT=1 to opt out and use a plain cmd window.
REM
REM The browser is opened by scripts\launch\open-when-ready.cmd, which
REM asks the app whether it is ready rather than guessing with a timer.
REM Set TUSKS_NO_BROWSER=1 to have it print the address instead.
REM ===========================================================================

setlocal
cd /d "%~dp0"

if defined WT_SESSION goto :no_wt_relaunch
if defined TUSKS_NO_WT goto :no_wt_relaunch
where wt.exe >nul 2>nul
if errorlevel 1 goto :no_wt_relaunch

start "" wt.exe --window tusks new-tab --title "Tusk's Tomes" --startingDirectory "%CD%" cmd /k "%~f0"
exit /b 0

:no_wt_relaunch
title Tusk's Tomes

echo.
echo                     .`.
echo                     .`~.-:
echo                   .`- . -`
echo                 .`-  . -`
echo               .`-   . -`
echo             .`-    . -`
echo           .`-     . -`
echo          `-      . -`
echo        .`-      . -`
echo       ;-       . -`
echo      .-      .  -`
echo     ;.      . -`
echo    ;.     . -`
echo    ::._.-`
echo    ^(.-`
echo    .Y^(.
echo   ^(^(^(^)^)^)
echo   _^)==^(_
echo   ^| .--. ^|
echo   ^| '--' ^|
echo   '------'
echo.
echo    Tusk's Tomes — TTRPG session chronicler
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [error] Node.js is not installed.
  echo          Run setup.bat first.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo  [info] node_modules is missing. Running first-time setup...
  echo.
  call "%~dp0setup.bat"
  if errorlevel 1 exit /b 1
)

REM The same PORT reaches the server and the browser opener, so a PORT set
REM in the environment moves both together.
if not defined PORT set "PORT=5173"
set "URL=http://localhost:%PORT%/"

REM ---- If a dev server is already on this port, just open the browser ----
netstat -ano | findstr "LISTENING" | findstr ":%PORT% " >nul 2>nul
if not errorlevel 1 (
  echo  Server already running on %URL%
  echo  Opening browser...
  rundll32 url.dll,FileProtocolHandler %URL%
  exit /b 0
)

REM ---- Open the browser once the app reports READY ----
REM The helper polls the app in the background while the server runs in
REM the foreground below. It keeps polling only while RUN_FILE exists;
REM the file is removed when the server exits, so a start that fails does
REM not leave a poller behind.
set "RUN_FILE=%TEMP%\tusks-tomes-launch-%RANDOM%%RANDOM%.run"
echo.> "%RUN_FILE%"
start "" /B cmd /c scripts\launch\open-when-ready.cmd %PORT% "%RUN_FILE%"

echo  WHAT THIS WINDOW IS
echo.
echo   This window IS Tusk's Tomes. The app runs on your own computer and
echo   shows its display in your web browser. A browser tab opens by itself
echo   as soon as the app says READY below.
echo.
echo   The first start after setup or an update can take 15-30 seconds
echo   while the app prepares its files. Later starts take a few seconds.
echo.
echo   The first lines below are the app's own numbered start-up steps.
echo   After that, text keeps scrolling past: that is the app telling you
echo   what it is doing, and it does not mean anything is wrong.
echo.
echo   Nothing here connects to the internet except the AI provider you
echo   choose yourself. There is no tracking and no account.
echo.
echo  --------------------------------------------
echo.
echo  Starting on %URL%
echo  Press Ctrl+C in this window to stop the app.
echo  ^(Leave this window open while you are using Tusk's Tomes.^)
echo.

call npm run dev

del "%RUN_FILE%" >nul 2>nul
echo.
echo  Server stopped.
pause
