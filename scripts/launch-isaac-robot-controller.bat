@echo off
setlocal

set ISAAC_SIM_BAT=C:\isaacsim\isaac-sim.bat
set REPO_ROOT=C:\Users\sandr\OneDrive\Documents\Robo-Doge
set EXT_FOLDER=%REPO_ROOT%\isaacsim\extensions
set OPEN_SCRIPT=%REPO_ROOT%\isaacsim\runtime\open_sim_environment.py

echo Launching Isaac Sim with robot controller extension...
echo Extension folder: %EXT_FOLDER%
echo Open script: %OPEN_SCRIPT%

call "%ISAAC_SIM_BAT%" --ext-folder "%EXT_FOLDER%" --enable omni.robot.controller --exec "%OPEN_SCRIPT%" %*

endlocal
