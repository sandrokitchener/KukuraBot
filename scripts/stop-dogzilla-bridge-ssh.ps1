param(
  [Alias("Host")]
  [string]$PiIp = "",

  [string]$User = "pi",
  [int]$Port = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge",
  [switch]$NoHostKeyScan
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "dogzilla-ssh-common.ps1")

$configPath = Ensure-DogzillaSshConfig `
  -Host $PiIp `
  -User $User `
  -Port $Port `
  -Alias $Alias `
  -KeyPath $KeyPath `
  -NoHostKeyScan:$NoHostKeyScan

$remoteRootQuoted = ConvertTo-RemoteSingleQuote $RemoteRoot
$remoteCommand = "cd $remoteRootQuoted 2>/dev/null || exit 0; if [ -f logs/direct-bridge.pid ]; then kill `$(cat logs/direct-bridge.pid) 2>/dev/null || true; fi; if [ -f logs/ros2-bridge.pid ]; then kill `$(cat logs/ros2-bridge.pid) 2>/dev/null || true; fi; pkill -f '[s]idecars/dogzilla_lib_bridge/server.py' 2>/dev/null || true; pkill -f '[s]idecars/ros2_bridge/server.py' 2>/dev/null || true; rm -f logs/direct-bridge.pid logs/ros2-bridge.pid; echo dogzilla-bridges-stopped"

Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
