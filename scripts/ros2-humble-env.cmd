@echo off

set "ROS2_INSTALL_ROOT=C:\ros2_humble"
set "PIXI_ENV_ROOT=C:\pixi_ws\.pixi\envs\default"
if exist "%ROS2_INSTALL_ROOT%\ros2-windows\setup.bat" set "ROS2_INSTALL_ROOT=%ROS2_INSTALL_ROOT%\ros2-windows"
if exist "%PIXI_ENV_ROOT%\Scripts" set "PATH=%PIXI_ENV_ROOT%\Scripts;%PATH%"
if exist "%PIXI_ENV_ROOT%\Library\bin" set "PATH=%PIXI_ENV_ROOT%\Library\bin;%PATH%"
if exist "%ROS2_INSTALL_ROOT%\setup.bat" (
  call "%ROS2_INSTALL_ROOT%\setup.bat"
)

set "DOGZILLA_REPO_ROOT=C:\Users\sandr\OneDrive\Documents\Robo-Doge"
set "DOGZILLA_PLAN_TOPIC=/dogzilla/command_plan"
set "DOGZILLA_STATE_TOPIC=/dogzilla/state"
