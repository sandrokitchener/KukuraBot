param(
  [Alias("Host")][string]$PiIp = "",
  [string]$User = "pi",
  [int]$SshPort = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge",
  [int]$RosDomainId = 16,
  [int]$PosePort = 9090,
  [switch]$ContinueCurrentMap,
  [switch]$NoSync,
  [switch]$NoHostKeyScan
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'dogzilla-ssh-common.ps1')
$configPath = Ensure-DogzillaSshConfig -Host $PiIp -User $User -Port $SshPort -Alias $Alias -KeyPath $KeyPath -NoHostKeyScan:$NoHostKeyScan
$readyFile = "$RemoteRoot/maps/autonomous-mapping.ready"
$launchCommand = "if sudo systemctl is-active --quiet robodoge-autonomous-mapping || docker exec robodoge-rosbridge bash -lc 'pgrep -f ""[f]rontier_explorer.py"" >/dev/null 2>&1'; then exit 42; fi; rm -f $readyFile; sudo systemd-run --quiet --collect --unit=robodoge-autonomous-mapping --property=RuntimeMaxSec=1h --property=KillMode=control-group /bin/bash $RemoteRoot/sidecars/dogzilla_navigation/autonomous_mapping_supervisor.sh"
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $launchCommand
if ($LASTEXITCODE -eq 42) { throw 'Autonomous mapping is already running; Finish Mapping before starting another map job.' }
if ($LASTEXITCODE -ne 0) { throw "Autonomous frontier supervisor failed to launch (ssh exit $LASTEXITCODE)." }

$common = @{
  PiIp = $PiIp
  User = $User
  SshPort = $SshPort
  Alias = $Alias
  KeyPath = $KeyPath
  RemoteRoot = $RemoteRoot
  RosDomainId = $RosDomainId
  NoHostKeyScan = $NoHostKeyScan
  NoSync = $NoSync
}
$mapMode = if ($ContinueCurrentMap) { 'continue_mapping' } else { 'mapping' }
& (Join-Path $PSScriptRoot 'start-dogzilla-map-pose-ssh.ps1') @common -PosePort $PosePort -Mode $mapMode -ForceRestart
& (Join-Path $PSScriptRoot 'start-dogzilla-navigation-ssh.ps1') @common -PosePort $PosePort -MappingMode
$navModeCommand = "curl --max-time 20 -fsS -X POST -H 'Content-Type: application/json' --data '{`"mode`":`"navigate`"}' http://127.0.0.1:8893/mode"
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $navModeCommand
if ($LASTEXITCODE -ne 0) { throw 'Frontier supervisor launched, but Nav2 could not wake.' }
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "touch $readyFile"
if ($LASTEXITCODE -ne 0) { throw 'Frontier supervisor launched, but ready signal failed.' }
Write-Output "Autonomous $mapMode started. Robot will stop when safe frontier coverage ends or Finish Mapping is selected."
