@echo off
setlocal

set "REPO_ROOT=%~dp0.."
pushd "%REPO_ROOT%" >nul || exit /b 1

if /I "%~1"=="--help" goto help
if /I "%~1"=="/?" goto help

if not defined APP_HOST set "APP_HOST=0.0.0.0"
if not defined APP_PORT set "APP_PORT=3037"
if not defined APP_MODEL_PROFILE set "APP_MODEL_PROFILE=local_ollama"

echo Robo-Doge Android LAN backend
echo Command: npm run dev:lan
echo Bind: %APP_HOST%:%APP_PORT%
echo Model profile: %APP_MODEL_PROFILE%
echo Ollama URL: http://127.0.0.1:11434
echo.

call :print_urls
echo.
call :ensure_ollama
echo.
echo Starting Robo-Doge LAN backend. Keep this window open while using the Android app.
echo.

npm run dev:lan
set "EXIT_CODE=%ERRORLEVEL%"

popd >nul
endlocal & exit /b %EXIT_CODE%

:print_urls
echo Set Android Backend URL to one of these desktop LAN addresses:
powershell -NoProfile -ExecutionPolicy Bypass -Command "$port = '%APP_PORT%'; $ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' -and $_.AddressState -eq 'Preferred' } | Select-Object -ExpandProperty IPAddress; if (-not $ips) { '  http://<desktop-lan-ip>:' + $port } else { foreach ($ip in $ips) { '  http://' + $ip + ':' + $port } }"
exit /b 0

:ensure_ollama
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:11434/api/tags' | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo Ollama: already reachable.
  exit /b 0
)

where ollama >nul 2>nul
if errorlevel 1 (
  echo Ollama: not reachable, and the ollama command was not found on PATH.
  echo Start Ollama manually before sending model requests from Android.
  exit /b 0
)

echo Ollama: not reachable; starting ollama serve in a separate window.
start "Ollama" cmd /k ollama serve
timeout /t 4 /nobreak >nul
exit /b 0

:help
echo Starts the desktop LAN backend used by the Android Robo-Doge app.
echo.
echo Wrapped command:
echo   npm run dev:lan
echo.
echo Android Backend URL:
echo   http://^<desktop-lan-ip^>:3037
echo.
echo Optional overrides:
echo   set APP_PORT=3038
echo   set APP_MODEL_PROFILE=local_ollama
echo.
popd >nul
endlocal & exit /b 0
