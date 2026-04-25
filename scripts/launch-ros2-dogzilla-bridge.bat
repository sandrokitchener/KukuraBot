@echo off
setlocal

set "ROOT_DIR=%~dp0.."
set "ROS_ENV_CMD=%ROOT_DIR%\scripts\ros2-humble-env.cmd"

if exist "%ROS_ENV_CMD%" (
  call "%ROS_ENV_CMD%"
)

if exist "%ROOT_DIR%\ros2\.install\local_setup.bat" (
  call "%ROOT_DIR%\ros2\.install\local_setup.bat"
)

ros2 run dogzilla_bridge bridge_node --ros-args --params-file "%ROOT_DIR%\ros2\dogzilla_bridge\config\bridge.params.yaml"

endlocal
