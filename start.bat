@echo off
chcp 65001 >nul 2>&1
title Agent Hub
cd /d "%~dp0"

REM --- locate node (PATH first, then known install dirs) ---
set "NODE_EXE="
for %%P in (node.exe) do if not defined NODE_EXE set "NODE_EXE=%%~$PATH:P"
if not defined NODE_EXE if exist "D:\nodejs\node.exe" set "NODE_EXE=D:\nodejs\node.exe"
if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
  echo.
  echo   [X] node.exe not found.
  echo       Install Node.js 22+ or add it to PATH.
  echo.
  pause
  exit /b 1
)

set "AGENT_HUB_OPEN=1"
"%NODE_EXE%" server.mjs
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo   [X] Agent Hub exited with code %RC%
  echo       See the messages above.
)
echo.
pause
