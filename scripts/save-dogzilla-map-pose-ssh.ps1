param(
  [Alias("Host")]
  [string]$PiIp = "",

  [string]$User = "pi",
  [int]$SshPort = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge",
  [string]$ContainerName = "robodoge-lidar-bridge",
  [int]$RosDomainId = 16,
  [string]$MapPath = "",
  [switch]$NoSync,
  [switch]$NoHostKeyScan
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "dogzilla-ssh-common.ps1")

Require-LocalCommand ssh
Require-LocalCommand scp

$repoRoot = Resolve-RoboDogeRoot
$configPath = Ensure-DogzillaSshConfig `
  -Host $PiIp `
  -User $User `
  -Port $SshPort `
  -Alias $Alias `
  -KeyPath $KeyPath `
  -NoHostKeyScan:$NoHostKeyScan

$remoteRootQuoted = ConvertTo-RemoteSingleQuote $RemoteRoot
$remoteSetup = "sudo mkdir -p $remoteRootQuoted/maps $remoteRootQuoted/logs && sudo chown -R ${User}:${User} $remoteRootQuoted/maps $remoteRootQuoted/logs"
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteSetup
if ($LASTEXITCODE -ne 0) {
  throw "remote map-pose setup failed"
}

if (-not $NoSync) {
  $mapPoseSource = Join-Path $repoRoot "sidecars\dogzilla_map_pose"
  Write-Output "Copying sidecars\dogzilla_map_pose -> ${Alias}:$RemoteRoot/sidecars/"
  & scp -r -F $configPath $mapPoseSource "${Alias}:$RemoteRoot/sidecars/"
  if ($LASTEXITCODE -ne 0) {
    throw "scp failed for dogzilla_map_pose sidecar"
  }
}

Repair-RemoteScriptLineEndings -ConfigPath $configPath -Alias $Alias -RemoteRoot $RemoteRoot

Write-Output "Saving DOGZILLA Cartographer map in $ContainerName."
$containerScript = "$RemoteRoot/sidecars/dogzilla_map_pose/save-map-pose-in-container.sh"
$mapEnv = if ($MapPath) { " -e DOGZILLA_MAP_PBSTREAM=$MapPath" } else { "" }
$remoteCommand = "docker exec -e REMOTE_ROOT=$RemoteRoot -e ROS_DOMAIN_ID=$RosDomainId$mapEnv $ContainerName bash $containerScript"
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
if ($LASTEXITCODE -ne 0) {
  throw "DOGZILLA Cartographer map save failed"
}
