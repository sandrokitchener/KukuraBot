@echo off
setlocal

set "REPO_ROOT=%~dp0.."
pushd "%REPO_ROOT%" >nul

if not defined APP_HOST set "APP_HOST=127.0.0.1"
if not defined APP_PORT set "APP_PORT=3037"
set "ROBOT_RUNTIME_TARGET=isaacsim"

echo Robo-Doge Isaac Sim launcher
echo App: http://%APP_HOST%:%APP_PORT%
echo Target: %ROBOT_RUNTIME_TARGET%
if defined APP_SPEECH_PROFILE (
  echo Speech override: %APP_SPEECH_PROFILE%
) else (
  echo Speech: runtime config
)
echo.

npm start -- --robot-target isaacsim
set "EXIT_CODE=%ERRORLEVEL%"

popd >nul
endlocal & exit /b %EXIT_CODE%
