@echo off
setlocal

set REPO_ROOT=C:\Users\sandr\OneDrive\Documents\Robo-Doge
set ROBO_DOGE_ISAAC_STAGE=isaacsim\sim_environment_yahboom_xgo.usda

echo Launching Isaac Sim with Yahboom XGO visual proxy...
echo Stage: %ROBO_DOGE_ISAAC_STAGE%

call "%REPO_ROOT%\scripts\launch-isaac-robot-controller.bat" %*

endlocal
