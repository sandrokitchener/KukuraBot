@echo off
setlocal
set "LABEL=%~1"
if not defined LABEL set "LABEL=fan-test"

where pwsh.exe >nul 2>nul
if errorlevel 1 (
  set "POWERSHELL=powershell.exe"
) else (
  set "POWERSHELL=pwsh.exe"
)

"%POWERSHELL%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0stress-test-dogzilla-fan.ps1" -Label "%LABEL%"
set "RESULT=%ERRORLEVEL%"
if not defined ROBO_DOGE_NO_PAUSE pause
exit /b %RESULT%
