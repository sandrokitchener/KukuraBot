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
$navModeCommand = "curl --max-time 20 -fsS -X POST -H 'Content-Type: application/json' --data '{`"mode`":`"navigate`"}' http://127.0.0.1:8893/mode"
$startingUnit = 'robodoge-autonomous-mapping-starting'
$preflightPython = "import json,time,urllib.request; deadline=time.monotonic()+60; result={}; ok=False; ready_since=None;`nwhile time.monotonic()<deadline:`n try:`n  h=json.load(urllib.request.urlopen('http://127.0.0.1:8893/healthz',timeout=30)); r=h.get('runtime') or {}; b=r.get('batterySafety') or {}; errors=([] if b.get('motionAllowed') is True else [b.get('cause') or b.get('blockedReason') or 'battery safety blocks motion'])+([] if h.get('gaitBlocked') is not True else ['gait is blocked: '+str(h.get('gaitBlockedReason') or 'unknown')]); now=time.monotonic(); ready_since=(ready_since if ready_since is not None else now) if not errors else None; stable=0 if ready_since is None else now-ready_since; ok=not errors and stable>=6; result={'ok':ok,'errors':errors,'stableReadySec':round(stable,1),'batteryMotionAllowed':b.get('motionAllowed'),'gaitBlocked':h.get('gaitBlocked')}`n  if ok: break`n except Exception as e: ready_since=None; result={'ok':False,'errors':[str(e)]}`n time.sleep(2)`nprint(json.dumps(result)); raise SystemExit(0 if ok else 2)"
$reserveCommand = "if sudo systemctl is-active --quiet robodoge-autonomous-mapping || sudo systemctl is-active --quiet $startingUnit || docker exec robodoge-rosbridge bash -lc 'pgrep -f ""[f]rontier_explorer.py"" >/dev/null 2>&1'; then exit 42; fi; sudo systemd-run --quiet --collect --unit=$startingUnit --property=RuntimeMaxSec=15m /bin/sleep 15m"

if ($ContinueCurrentMap) {
  $preflightStatus = Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "python3 -c $(ConvertTo-RemoteSingleQuote $preflightPython)"
  if ($LASTEXITCODE -ne 0) {
    throw "Continue Current Map safety prerequisites did not become ready. No mapping job was reserved and no motion was attempted. Last status: $($preflightStatus | Select-Object -Last 1)"
  }
}

Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $reserveCommand
if ($LASTEXITCODE -eq 42) { throw 'Autonomous mapping is already running; Finish Mapping before starting another map job.' }
if ($LASTEXITCODE -ne 0) { throw "Autonomous mapping start could not be reserved (ssh exit $LASTEXITCODE)." }

$launchCommand = "if sudo systemctl is-active --quiet robodoge-autonomous-mapping || docker exec robodoge-rosbridge bash -lc 'pgrep -f ""[f]rontier_explorer.py"" >/dev/null 2>&1'; then sudo systemctl stop $startingUnit; exit 42; fi; rm -f $readyFile; if sudo systemd-run --quiet --collect --unit=robodoge-autonomous-mapping --property=RuntimeMaxSec=1h --property=KillMode=control-group /bin/bash $RemoteRoot/sidecars/dogzilla_navigation/autonomous_mapping_supervisor.sh; then sudo systemctl stop $startingUnit; else code=`$?; sudo systemctl stop $startingUnit; exit `$code; fi"
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $launchCommand
$launchExit = $LASTEXITCODE
if ($launchExit -ne 0) {
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "sudo systemctl stop $startingUnit"
  if ($launchExit -eq 42) { throw 'Autonomous mapping is already running; Finish Mapping before starting another map job.' }
  throw "Autonomous frontier supervisor failed to launch (ssh exit $launchExit)."
}

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
try {
  if ($ContinueCurrentMap) {
    Write-Output 'No motion is needed before mapping resumes.'
    Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand 'sudo systemctl stop robodoge-navigation.service; ! sudo systemctl is-active --quiet robodoge-navigation.service'
    if ($LASTEXITCODE -ne 0) { throw 'Continue Current Map could not stop Nav2 before the Cartographer handoff.' }
  }
  & (Join-Path $PSScriptRoot 'start-dogzilla-map-pose-ssh.ps1') @common -PosePort $PosePort -Mode $mapMode -ForceRestart
  if ($LASTEXITCODE -ne 0) { throw 'Cartographer mapping mode failed to start.' }
  & (Join-Path $PSScriptRoot 'start-dogzilla-navigation-ssh.ps1') @common -PosePort $PosePort -MappingMode
  if ($LASTEXITCODE -ne 0) { throw 'Mapping Nav2 failed to start.' }
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $navModeCommand
  if ($LASTEXITCODE -ne 0) { throw 'Frontier supervisor launched, but Nav2 could not wake.' }
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "sudo systemctl is-active --quiet robodoge-autonomous-mapping && touch $readyFile"
  if ($LASTEXITCODE -ne 0) { throw 'Frontier supervisor stopped before mapping became ready.' }
} catch {
  $mappingError = $_
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand 'sudo systemctl stop robodoge-autonomous-mapping'
  if ($ContinueCurrentMap) {
    try {
      & (Join-Path $PSScriptRoot 'start-dogzilla-map-pose-ssh.ps1') @common -PosePort $PosePort -Mode localization -ForceRestart -RestoreOnly
      if ($LASTEXITCODE -ne 0) { throw 'Normal localization failed to restart.' }
    } catch {
      throw "Continue Current Map failed and normal localization rollback also failed: $($_.Exception.Message) Original error: $($mappingError.Exception.Message)"
    }
  }
  throw $mappingError
}
Write-Output "Autonomous $mapMode started. Robot will stop when safe frontier coverage ends or Finish Mapping is selected."
