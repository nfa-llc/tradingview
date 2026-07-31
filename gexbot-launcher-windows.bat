@echo off
setlocal
cd /d "%~dp0"
title gexbot v1.0 - TradingView

echo.
echo   ========================================
echo     gexbot v1.0 - TradingView overlay
echo   ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] Node.js was not found.
  echo.
  echo   Install Node.js 22 or newer from https://nodejs.org and try again.
  pause
  exit /b 1
)

set "NODEMAJ=0"
set "NODEVER="
for /f "tokens=*" %%v in ('node -p "process.versions.node" 2^>nul') do set "NODEVER=%%v"
for /f "tokens=1 delims=." %%v in ("%NODEVER%") do set "NODEMAJ=%%v"
if %NODEMAJ% LSS 22 (
  echo   [ERROR] Node.js 22 or newer is required ^(found %NODEVER%^).
  pause
  exit /b 1
)

for %%f in (app\companion.js app\expiry-protobuf.js app\content.js app\injected.js app\panel.css platform\windows\start.ps1 platform\windows\launch-tradingview-debug.ps1) do (
  if not exist "%~dp0%%f" (
    echo   [ERROR] Missing file: %%f
    echo   Keep the complete cross-platform gexbot folder together.
    pause
    exit /b 1
  )
)

if defined IOF_API_KEY_PATH (
  set "KEYFILE=%IOF_API_KEY_PATH%"
) else (
  set "KEYFILE=%~dp0api-key.txt"
)
if not exist "%KEYFILE%" type nul >"%KEYFILE%"
findstr /r "[A-Za-z0-9_-]" "%KEYFILE%" >nul 2>nul
if not errorlevel 1 goto key_ready
if exist "%~dp0config.json" goto key_ready
if exist "%~dp0gb-tradingview-windows\config.json" goto key_ready
if exist "%~dp0gb-tradingview-linux\config.json" goto key_ready
if exist "%~dp0gb-tradingview-windows\api-key.txt" goto key_ready
if exist "%~dp0gb-tradingview-linux\api-key.txt" goto key_ready
echo   [WARNING] API key is not configured.
echo   Put the API key on the first line of:
echo   %KEYFILE%
echo.
pause
exit /b 1

:key_ready
set "IOF_NODE=node"
echo   Node %NODEVER% OK. Starting TradingView and the companion...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0platform\windows\start.ps1" -RootDir "%~dp0."
if errorlevel 1 (
  echo.
  echo   [ERROR] Startup failed; see the message above.
  pause
  exit /b 1
)

echo.
echo   Done. The gexbot companion is running in the background.
echo   Close TradingView normally when finished; the companion will shut itself down.
echo.
timeout /t 4 >nul
endlocal
