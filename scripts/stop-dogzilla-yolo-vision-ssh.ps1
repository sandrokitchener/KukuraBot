#Requires -Version 5.1
param(
  [string]$SshHost = 'dogzilla',
  [string]$SshPort = '22',
  [string]$ConfigPath = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dogzilla-ssh-common.ps1')

$configPath = Resolve-DogzillaSshConfig -ConfigPath $ConfigPath
$alias = $SshHost

Write-Host "Stopping DOGZILLA YOLO vision sidecar on $alias."

$stopPattern = "[s]idecars/dogzilla_yolo_vision/server.py"
$stopPatternQuoted = ConvertTo-RemoteSingleQuote $stopPattern
$remoteCommand = "if [ -f /home/pi/robodoge/logs/yolo-vision.pid ]; then kill `$(cat /home/pi/robodoge/logs/yolo-vision.pid) 2>/dev/null || true; fi && for pid in `$(pgrep -f $stopPatternQuoted 2>/dev/null || true); do if [ `"$pid`" = `"$$`" ] || [ `"$pid`" = `"$PPID`" ]; then continue; fi; kill -TERM `"$pid`" 2>/dev/null || true; done && sleep 0.8 && for pid in `$(pgrep -f $stopPatternQuoted 2>/dev/null || true); do if [ `"$pid`" = `"$$`" ] || [ `"$pid`" = `"$PPID`" ]; then continue; fi; kill -KILL `"$pid`" 2>/dev/null || true; done && echo 'YOLO vision stopped.'"

Invoke-DogzillaSsh -ConfigPath $configPath -Alias $alias -RemoteCommand $remoteCommand
exit $LASTEXITCODE
