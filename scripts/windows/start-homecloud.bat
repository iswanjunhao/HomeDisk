@echo off
REM ===========================================================================
REM  HomeCloud - Windows one-click launcher
REM  Double-click this file to start the LAN cloud drive.
REM
REM  HOW TO CONFIGURE (edit the two lines below BEFORE first run):
REM    1) HOMECLOUD_ROOT = the folder/drive you want to share on your LAN.
REM       Example: D:\  or  D:\Share  or  E:\Family
REM    2) HOMECLOUD_PORT = the port browsers connect to (default 8080).
REM
REM  PREREQUISITE: Node.js LTS for Windows installed (https://nodejs.org,
REM  choose "Add to PATH"). The script auto-detects node; if not found it
REM  also accepts app\runtime\node.exe.
REM ===========================================================================

setlocal
set "HOMECLOUD_ROOT=D:\"
set "HOMECLOUD_PORT=8080"

REM Locate the app directory (this script lives in scripts\windows\).
set "SCRIPT_DIR=%~dp0"
set "APP_DIR=%SCRIPT_DIR%..\..\app"
for %%I in ("%APP_DIR%") do set "APP_DIR=%%~fI"

REM 1) Find node: prefer PATH, then a bundled runtime\node.exe
set "NODE_BIN="
where node >nul 2>nul
if not errorlevel 1 (
  set "NODE_BIN=node"
) else (
  if exist "%APP_DIR%\runtime\node.exe" (
    set "NODE_BIN=%APP_DIR%\runtime\node.exe"
  )
)

if "%NODE_BIN%"=="" (
  echo [ERROR] Node.js was not found.
  echo.
  echo Install Node.js LTS for Windows first: https://nodejs.org/
  echo (during install tick "Add to PATH")
  echo.
  echo Alternatively, copy node.exe into: %APP_DIR%\runtime\node.exe
  echo.
  pause
  exit /b 1
)

REM 2) Install dependencies on first run if missing
if not exist "%APP_DIR%\node_modules" (
  where npm >nul 2>nul
  if not errorlevel 1 (
    echo [Setup] node_modules not found, running npm install (first run only, please wait)...
    pushd "%APP_DIR%"
    call npm install --omit=dev --no-audit --no-fund
    popd
  ) else (
    echo [WARN] node_modules missing and npm not found. Run "npm install" in the app folder, then retry.
  )
)

echo.
echo ======================================================
echo  HomeCloud LAN Drive starting...
echo    Shared root : %HOMECLOUD_ROOT%
echo    Port        : %HOMECLOUD_PORT%
echo    Node        : %NODE_BIN%
echo ======================================================
echo.
echo  Open in a browser on ANY device connected to your LAN:
echo    http://^<this-pc-ip^>:%HOMECLOUD_PORT%
echo  (On this PC you can also use: http://127.0.0.1:%HOMECLOUD_PORT%)
echo.
echo  Tip: Admin password can be set once with:
echo    node server.js --set-password YOUR_PASSWORD
echo.
echo  Press Ctrl+C to stop the server.
echo.

cd /d "%APP_DIR%"
"%NODE_BIN%" server.js
