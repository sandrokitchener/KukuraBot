@echo off
setlocal

set "ROOT_DIR=%~dp0.."
set "ROS_ENV_CMD=%ROOT_DIR%\scripts\ros2-humble-env.cmd"
set "PYTHON_EXE=C:\pixi_ws\.pixi\envs\default\python.exe"

if exist "%ROS_ENV_CMD%" (
  call "%ROS_ENV_CMD%"
)

if exist "%ROOT_DIR%\ros2\.install\local_setup.bat" (
  call "%ROOT_DIR%\ros2\.install\local_setup.bat"
)

if not exist "%PYTHON_EXE%" (
  set "PYTHON_EXE=python"
)

"%PYTHON_EXE%" "%ROOT_DIR%\sidecars\ros2_bridge\server.py" %*

endlocal
