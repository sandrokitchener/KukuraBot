param(
  [Alias("Host")]
  [string]$PiIp = "",

  [string]$User = "pi",
  [int]$SshPort = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge",
  [string]$ContainerName = "robodoge-map-pose",
  [int]$RosDomainId = 16,
  [int]$PosePort = 9090,
  [ValidateSet("auto", "localization", "mapping", "continue_mapping")]
  [string]$Mode = "auto",
  [string]$MapPath = "",
  [switch]$AllowMapping,
  [switch]$ForceRestart,
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
if (-not $NoSync) {
  $remoteSetup = "sudo install -d -o $User -g $User $remoteRootQuoted/maps $remoteRootQuoted/logs"
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteSetup
  if ($LASTEXITCODE -ne 0) { throw "remote map-pose setup failed" }
  $mapPoseSource = Join-Path $repoRoot "sidecars\dogzilla_map_pose"
  Write-Output "Copying sidecars\dogzilla_map_pose -> ${Alias}:$RemoteRoot/sidecars/"
  & scp -r -F $configPath $mapPoseSource "${Alias}:$RemoteRoot/sidecars/"
  if ($LASTEXITCODE -ne 0) {
    throw "scp failed for dogzilla_map_pose sidecar"
  }
}

Repair-RemoteScriptLineEndings -ConfigPath $configPath -Alias $Alias -RemoteRoot $RemoteRoot

Write-Output "Starting DOGZILLA Cartographer map pose in $ContainerName."
$containerScript = "$RemoteRoot/sidecars/dogzilla_map_pose/start-map-pose-in-container.sh"
$mapEnv = if ($MapPath) { " -e DOGZILLA_MAP_PBSTREAM=$MapPath" } else { "" }
$allowMappingEnv = if ($AllowMapping) { " -e DOGZILLA_MAP_POSE_ALLOW_MAPPING=1" } else { "" }
$forceRestartEnv = if ($ForceRestart) { " -e DOGZILLA_FORCE_RESTART=1" } else { "" }

$originFile = Join-Path $repoRoot "output/app-cache/dogzilla-map-origin.json"
$initialX = "0"
$initialY = "0"
$initialYaw = "0"
if (Test-Path -LiteralPath $originFile) {
  try {
    $origin = Get-Content -LiteralPath $originFile -Raw | ConvertFrom-Json
    if ($null -ne $origin.x) { $initialX = [string]$origin.x }
    if ($null -ne $origin.y) { $initialY = [string]$origin.y }
    if ($null -ne $origin.yaw) { $initialYaw = [string]$origin.yaw }
  } catch {
    Write-Warning "Failed to read map origin file; using default initial pose (0,0,0): $_"
  }
}
$initialPoseEnv = " -e DOGZILLA_INITIAL_POSE_X=$initialX -e DOGZILLA_INITIAL_POSE_Y=$initialY -e DOGZILLA_INITIAL_POSE_YAW=$initialYaw"

function Wait-ContainerRunning {
  param(
    [string]$Name,
    [int]$TimeoutSec = 25
  )
  for ($i = 0; $i -lt $TimeoutSec; $i += 2) {
    $id = & ssh -F $configPath $Alias "docker ps --filter name=$Name --format='{{.ID}}' 2>/dev/null || true" 2>$null
    if ($id) {
      Start-Sleep -Seconds 3
      return $true
    }
    Start-Sleep -Seconds 2
  }
  return $false
}

$remoteCommand = "docker exec -e DOGZILLA_DOCKER_EXEC=1 -e REMOTE_ROOT=$RemoteRoot -e POSE_PORT=$PosePort -e ROS_DOMAIN_ID=$RosDomainId -e DOGZILLA_MAP_POSE_MODE=$Mode$mapEnv$allowMappingEnv$forceRestartEnv$initialPoseEnv $ContainerName bash $containerScript"
$startedInRequestedMode = $Mode -in @('mapping', 'continue_mapping')
if ($startedInRequestedMode) {
  Write-Output "Starting dedicated $Mode container..."
  $startCommand = "sudo systemctl stop robodoge-map-pose.service 2>/dev/null || true; docker rm -f $ContainerName 2>/dev/null || true; docker run -d --rm --name $ContainerName --privileged --network host -e REMOTE_ROOT=$RemoteRoot -e POSE_PORT=$PosePort -e ROS_DOMAIN_ID=$RosDomainId -e DOGZILLA_MAP_POSE_MODE=$Mode$mapEnv$allowMappingEnv$forceRestartEnv$initialPoseEnv -v /dev:/dev -v ${RemoteRoot}:${RemoteRoot} -w $RemoteRoot robodoge/ros-humble-cartographer:1.0 bash -lc 'source /opt/ros/humble/setup.bash; source /root/yahboomcar_ws/install/setup.bash 2>/dev/null || true; bash $containerScript'"
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $startCommand
  if ($LASTEXITCODE -ne 0 -or !(Wait-ContainerRunning -Name $ContainerName -TimeoutSec 25)) {
    throw "DOGZILLA Cartographer map pose container '$ContainerName' did not become ready in $Mode mode"
  }
} else {
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
  if ($LASTEXITCODE -ne 0) {
    Write-Output "Container $ContainerName not available; starting via systemd..."
    & ssh -F $configPath $Alias "sudo systemctl start robodoge-map-pose.service 2>/dev/null || docker start $ContainerName 2>/dev/null || true"
    if (Wait-ContainerRunning -Name $ContainerName -TimeoutSec 25) {
      Write-Output "Container $ContainerName started; retrying docker exec."
      Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
      if ($LASTEXITCODE -ne 0) {
        throw "DOGZILLA Cartographer map pose failed to start"
      }
    } else {
      throw "DOGZILLA Cartographer map pose container '$ContainerName' did not become ready within 25s"
    }
  }
}
