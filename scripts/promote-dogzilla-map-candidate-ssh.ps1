param(
  [Alias("Host")][string]$PiIp = "",
  [string]$User = "pi",
  [int]$SshPort = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge",
  [string]$CandidateId = "",
  [switch]$NoHostKeyScan
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dogzilla-ssh-common.ps1')
$configPath = Ensure-DogzillaSshConfig -Host $PiIp -User $User -Port $SshPort -Alias $Alias -KeyPath $KeyPath -NoHostKeyScan:$NoHostKeyScan
$candidateEnv = if ($CandidateId) { " -e DOGZILLA_MAP_CANDIDATE_ID=$CandidateId" } else { '' }
$command = "docker exec -e REMOTE_ROOT=$RemoteRoot$candidateEnv robodoge-rosbridge bash $RemoteRoot/sidecars/dogzilla_map_pose/promote-candidate-map-in-container.sh"
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $command
if ($LASTEXITCODE -ne 0) { throw 'Candidate map promotion failed.' }
