@echo off
REM ===========================================================================
REM Tusk's Tomes - open the browser once the app reports READY (Windows)
REM
REM Usage:  open-when-ready.cmd <port> [run-file]
REM
REM Start_Tusks_Tomes.bat runs this in the background while the server
REM starts in the foreground. It polls http://127.0.0.1:<port>/api/health
REM until the reply contains "ready":true, then opens the browser once.
REM
REM A fixed delay cannot do this job: the first start after setup or an
REM update takes far longer than a warm one, so any delay is either too
REM short for the slow case or too long for every other. Asking the app
REM is the only way to be right both times.
REM
REM If <run-file> is given, polling stops as soon as that file disappears.
REM The launcher deletes it when the server exits, so a start that fails
REM does not leave this loop running until the cap.
REM
REM Set TUSKS_NO_BROWSER=1 to print the address instead of opening it.
REM
REM Fetching uses curl.exe, which is part of Windows 10 1803 and later. If
REM it is not on PATH, PowerShell's Invoke-WebRequest is used instead.
REM ===========================================================================

setlocal EnableDelayedExpansion

set "PORT=%~1"
if "%PORT%"=="" set "PORT=5173"
set "RUN_FILE=%~2"
set "URL=http://localhost:%PORT%/"
set "HEALTH=http://127.0.0.1:%PORT%/api/health"
set "CAP=180"
set "WAITED=0"
set "LAST_PHASE="

set "FETCH=curl"
where curl.exe >nul 2>nul
if errorlevel 1 set "FETCH=powershell"

echo  Waiting for the app to finish starting...

:poll
if not "%RUN_FILE%"=="" if not exist "%RUN_FILE%" exit /b 0

set "BODY="
if "%FETCH%"=="powershell" goto :fetch_powershell
for /f "delims=" %%b in ('curl.exe -s -m 2 "%HEALTH%" 2^>nul') do set "BODY=%%b"
goto :fetched
:fetch_powershell
for /f "delims=" %%b in ('powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 '%HEALTH%').Content } catch { }" 2^>nul') do set "BODY=%%b"
:fetched
if "!BODY!"=="" goto :wait

REM The reply is one line of JSON. Strip the quotes so the rest of the
REM parsing only has to deal with plain text.
set FLAT=!BODY:"=!
set "CHECK=!FLAT:ready:true=!"
if not "!CHECK!"=="!FLAT!" goto :ready

set "REST=!FLAT:*phase:=!"
if "!REST!"=="!FLAT!" goto :wait
for /f "tokens=1 delims=,}" %%p in ("!REST!") do set "PHASE=%%p"
if "!PHASE!"=="!LAST_PHASE!" goto :wait
set "LAST_PHASE=!PHASE!"
set "LABEL=!PHASE!"
if "!PHASE!"=="binding" set "LABEL=binding the port"
if "!PHASE!"=="addons" set "LABEL=loading add-ons"
if "!PHASE!"=="lore" set "LABEL=reading the lore folder"
if "!PHASE!"=="vite" set "LABEL=preparing the interface - takes longer after an update"
echo  ... still starting: !LABEL!

:wait
if !WAITED! GEQ !CAP! goto :gave_up
REM waitfor is a one-second sleep that does not need a console for input,
REM which timeout.exe does; it exits non-zero when nothing signals it.
"%SystemRoot%\System32\waitfor.exe" /t 1 TusksTomesLaunchTick >nul 2>nul
set /a WAITED+=1
goto :poll

:ready
if defined TUSKS_NO_BROWSER (
  echo  The app is READY at !URL!
  exit /b 0
)
echo  The app is READY - opening !URL! in your browser.
rundll32 url.dll,FileProtocolHandler !URL!
exit /b 0

:gave_up
echo.
echo  The app has not reported READY after !CAP! seconds, so the browser was
echo  not opened. If the lines above show an error, that is the reason.
echo  Otherwise, open !URL! yourself once a line saying READY appears.
exit /b 1
