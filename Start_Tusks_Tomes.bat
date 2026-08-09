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

set "PORT=5173"
set "URL=http://localhost:%PORT%/"

REM ---- If a dev server is already on this port, just open the browser ----
netstat -ano | findstr "LISTENING" | findstr ":%PORT% " >nul 2>nul
if not errorlevel 1 (
  echo  Server already running on %URL%
  echo  Opening browser...
  rundll32 url.dll,FileProtocolHandler %URL%
  exit /b 0
)

REM ---- Schedule the browser to open once the dev server is listening ----
start "" /B cmd /c "%SystemRoot%\System32\timeout.exe /t 5 /nobreak >nul && rundll32 url.dll,FileProtocolHandler %URL%"

echo  WHAT THIS WINDOW IS
echo.
echo   This window IS Tusk's Tomes. The app runs on your own computer and
echo   shows its display in your web browser - that is why a browser tab
echo   opens on its own in a few seconds.
echo.
echo   Text will keep scrolling past below. That is the app telling you what
echo   it is doing. It is normal and it does not mean anything is wrong.
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

echo.
echo  Server stopped.
pause
