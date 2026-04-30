@echo off
setlocal

if /I "%~1"=="_fake" goto fake

set "REPO_ROOT=%~dp0.."
pushd "%REPO_ROOT%" >nul

if not defined APP_HOST set "APP_HOST=127.0.0.1"
if not defined APP_PORT set "APP_PORT=3037"
if not defined ROBOT_STATE_HZ set "ROBOT_STATE_HZ=20"
if not defined ROBOT_RUNTIME_DRY_RUN set "ROBOT_RUNTIME_DRY_RUN=1"
if not defined ROBOT_ROS2_TRANSPORT_DRY_RUN set "ROBOT_ROS2_TRANSPORT_DRY_RUN=1"
if not defined ROBOT_ROS2_MANAGED_BY_APP set "ROBOT_ROS2_MANAGED_BY_APP=1"
set "ROBOT_RUNTIME_TARGET=ros2_real"
set "ROBOT_STATE_WS_URL=ws://%APP_HOST%:%APP_PORT%/api/robot/state/stream"

echo Robo-Doge real robot launcher
echo App: http://%APP_HOST%:%APP_PORT%
echo Target: %ROBOT_RUNTIME_TARGET%
echo Command dry-run: %ROBOT_RUNTIME_DRY_RUN%
echo Fake state stream: %ROBOT_STATE_WS_URL%
if defined APP_SPEECH_PROFILE (
  echo Speech override: %APP_SPEECH_PROFILE%
) else (
  echo Speech: runtime config
)
echo.

start "Robo-Doge Fake Robot State" cmd /k call "%~f0" _fake

npm start -- --robot-target ros2_real
set "EXIT_CODE=%ERRORLEVEL%"

popd >nul
endlocal & exit /b %EXIT_CODE%

:fake
set "REPO_ROOT=%~dp0.."
pushd "%REPO_ROOT%" >nul

if not defined APP_HOST set "APP_HOST=127.0.0.1"
if not defined APP_PORT set "APP_PORT=3037"
if not defined ROBOT_STATE_HZ set "ROBOT_STATE_HZ=20"
if not defined ROBOT_STATE_WS_URL set "ROBOT_STATE_WS_URL=ws://%APP_HOST%:%APP_PORT%/api/robot/state/stream"

echo Robo-Doge fake robot state stream
echo Stream: %ROBOT_STATE_WS_URL%
echo Hz: %ROBOT_STATE_HZ%
echo.

npm run fake:robot-state

popd >nul
endlocal
