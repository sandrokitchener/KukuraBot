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
  [int]$PosePort = 8896,
  [string]$MapYaml = "",
  [switch]$NoHostKeyScan,
  [double]$Nav2RobotRadius = 0,
  [double]$Nav2FootprintPadding = 0,
  [double]$Nav2InflationRadius = 0,
  [double]$Nav2CostScalingFactor = 0,
  [double]$Nav2ObstacleMaxRange = 0,
  [double]$Nav2RaytraceMaxRange = 0
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
$remoteSetup = "sudo mkdir -p $remoteRootQuoted/sidecars $remoteRootQuoted/logs && sudo chown -R ${User}:${User} $remoteRootQuoted/sidecars $remoteRootQuoted/logs"
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteSetup
if ($LASTEXITCODE -ne 0) {
  throw "remote navigation setup failed"
}

$navigationSource = Join-Path $repoRoot "sidecars\dogzilla_navigation"
Write-Output "Copying sidecars\dogzilla_navigation -> ${Alias}:$RemoteRoot/sidecars/"
& scp -r -F $configPath $navigationSource "${Alias}:$RemoteRoot/sidecars/"
if ($LASTEXITCODE -ne 0) {
  throw "scp failed for dogzilla_navigation sidecar"
}

Write-Output "Starting DOGZILLA Nav2 waypoint navigation in $ContainerName."
$containerScript = "$RemoteRoot/sidecars/dogzilla_navigation/start-navigation-in-container.sh"
$mapEnv = if ($MapYaml) { " -e DOGZILLA_NAV2_MAP=$MapYaml" } else { "" }
$nav2Env = ''
if ($Nav2RobotRadius -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_ROBOT_RADIUS=$Nav2RobotRadius" }
if ($Nav2FootprintPadding -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_FOOTPRINT_PADDING=$Nav2FootprintPadding" }
if ($Nav2InflationRadius -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_INFLATION_RADIUS=$Nav2InflationRadius" }
if ($Nav2CostScalingFactor -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_COST_SCALING_FACTOR=$Nav2CostScalingFactor" }
if ($Nav2ObstacleMaxRange -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_OBSTACLE_MAX_RANGE=$Nav2ObstacleMaxRange" }
if ($Nav2RaytraceMaxRange -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_RAYTRACE_MAX_RANGE=$Nav2RaytraceMaxRange" }
$remoteCommand = "docker exec -e REMOTE_ROOT=$RemoteRoot -e POSE_PORT=$PosePort -e ROS_DOMAIN_ID=$RosDomainId$mapEnv$nav2Env $ContainerName bash $containerScript"
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
if ($LASTEXITCODE -ne 0) {
  throw "DOGZILLA Nav2 waypoint navigation failed to start"
}
