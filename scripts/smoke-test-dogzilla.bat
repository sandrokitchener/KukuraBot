@echo off
setlocal
set "DOGZILLA_IP=%~1"
if "%DOGZILLA_IP%"=="" (
  set /p DOGZILLA_IP=Enter DOGZILLA IP:
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0smoke-test-dogzilla.ps1" -Host "%DOGZILLA_IP%"
exit /b %ERRORLEVEL%
