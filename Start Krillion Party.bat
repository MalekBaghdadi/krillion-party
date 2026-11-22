@echo off
title Krillion Party
cd /d "%~dp0"
echo Starting Krillion Party...
echo.

where node >nul 2>nul
if errorlevel 1 goto neednode
for /f %%v in ('node -p "parseInt(process.versions.node)"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 20 goto neednode
goto hasnode

:neednode
echo Krillion Party needs Node.js ^(a free helper program^) version 20 or newer.
echo A web page is opening: download the LTS version, install it, then double-click this file again.
start "" https://nodejs.org/en/download
pause
exit /b 1

:hasnode
rem Set up on the first start, and repair a setup that was interrupted halfway.
if not exist node_modules\playwright-core goto install
if not exist node_modules\qrcode goto install
goto run

:install
echo First start: setting things up ^(about a minute^)...
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 (
  echo Setup failed. Are you connected to the internet?
  pause
  exit /b 1
)
echo.

:run
node src\index.js
echo.
echo Krillion Party has stopped.
pause
