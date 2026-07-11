param(
  [Alias("Host")][string]$PiIp = "",
  [string]$User = "pi",
  [int]$SshPort = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge",
  [int]$RosDomainId = 16,
  [int]$PosePort = 9090,
  [switch]$NoSync,
  [switch]$NoHostKeyScan
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dogzilla-ssh-common.ps1')
$configPath = Ensure-DogzillaSshConfig -Host $PiIp -User $User -Port $SshPort -Alias $Alias -KeyPath $KeyPath -NoHostKeyScan:$NoHostKeyScan
$resultFile = "$RemoteRoot/maps/autonomous-mapping-result.json"
$mappingActive = Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "if sudo systemctl is-active --quiet robodoge-autonomous-mapping || docker exec robodoge-rosbridge bash -lc 'pgrep -f ""[f]rontier_explorer.py"" >/dev/null 2>&1'; then printf active; else printf stopped; fi"
if ($LASTEXITCODE -ne 0) { throw 'Could not check autonomous mapping state.' }
if (($mappingActive | Out-String).Trim() -ne 'active') {
  throw 'Autonomous mapping already stopped; no active session remains to finish. Start or continue mapping before trying again.'
}
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "touch $RemoteRoot/maps/autonomous-mapping.finish; touch $RemoteRoot/maps/autonomous-mapping.stop"
if ($LASTEXITCODE -ne 0) { throw 'Could not request autonomous mapping stop.' }
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "docker exec robodoge-rosbridge bash -lc 'for i in `$(seq 1 20); do pgrep -f ""[f]rontier_explorer.py"" >/dev/null || exit 0; sleep 1; done; exit 1'"
if ($LASTEXITCODE -ne 0) { throw 'Frontier explorer did not stop within 20 seconds; candidate map was not saved.' }
$result = Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "for i in `$(seq 1 180); do test -s $resultFile && cat $resultFile && exit 0; sleep 1; done; exit 1"
if ($LASTEXITCODE -ne 0) { throw 'Autonomous mapping supervisor did not finish within 180 seconds.' }
if (($result | Out-String) -notmatch '"state"\s*:\s*"candidate-ready"|candidate=true') {
  throw "Mapping stopped without saving a candidate: $(($result | Out-String).Trim())"
}
Write-Output 'Mapping stopped and candidate processing finished. Promote the candidate to resume navigation when the previous map has no verified pbstream.'
