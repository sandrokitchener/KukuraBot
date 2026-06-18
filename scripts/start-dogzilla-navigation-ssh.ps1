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
  [switch]$NoSync,
  [switch]$NoHostKeyScan,
  [double]$Nav2RobotRadius = 0,
  [double]$Nav2FootprintPadding = 0,
  [double]$Nav2InflationRadius = 0,
  [double]$Nav2CostScalingFactor = 0,
  [double]$Nav2ObstacleMinRange = 0,
  [double]$Nav2ObstacleMaxRange = 0,
  [double]$Nav2RaytraceMaxRange = 0,
  [double]$Nav2ControllerFrequency = 0,
  [double]$Nav2BtLoopDurationMs = 0,
  [double]$Nav2BtServerTimeoutMs = 0,
  [double]$Nav2BtWaitForServiceTimeoutMs = 0,
  [double]$Nav2PlannerFrequency = 0,
  [double]$Nav2SmootherFrequency = 0,
  [double]$Nav2RequiredMovementRadius = 0,
  [double]$Nav2MovementTimeAllowance = 0,
  [double]$Nav2FailureTolerance = 0,
  [double]$Nav2MinSpeedXy = 0,
  [double]$Nav2TransStoppedVelocity = 0,
  [string]$Nav2ScanFilterEnabled = "",
  [double]$Nav2ScanFilterMaskStartDeg = -9999,
  [double]$Nav2ScanFilterMaskEndDeg = -9999,
  [double]$Nav2ScanFilterMaskRangeM = 0,
  [double]$YawGoalTolerance = 0,
  [double]$Nav2XyGoalTolerance = 0
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "dogzilla-ssh-common.ps1")

Require-LocalCommand ssh
Require-LocalCommand scp

$repoRoot = Resolve-RoboDogeRoot
$avoidanceConfigPath = Join-Path $repoRoot "config\robot-obstacle-avoidance.json"
$avoidanceConfig = $null
if (Test-Path -LiteralPath $avoidanceConfigPath) {
  $avoidanceConfig = Get-Content -LiteralPath $avoidanceConfigPath -Raw | ConvertFrom-Json
}

function Get-ConfigPropertyValue {
  param(
    [object]$Config,
    [string]$PropertyName
  )

  if ($null -eq $Config) {
    return $null
  }

  $property = $Config.PSObject.Properties[$PropertyName]
  if ($null -eq $property) {
    return $null
  }

  return $property.Value
}

function Use-PositiveConfigDouble {
  param(
    [double]$Current,
    [object]$Config,
    [string]$PropertyName
  )

  if ($Current -gt 0) {
    return $Current
  }

  $value = Get-ConfigPropertyValue -Config $Config -PropertyName $PropertyName
  if ($null -eq $value) {
    return $Current
  }

  $numeric = 0.0
  if ([double]::TryParse([string]$value, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$numeric) -and $numeric -gt 0) {
    return $numeric
  }

  return $Current
}

function Use-ConfigDoubleWhenUnset {
  param(
    [double]$Current,
    [double]$UnsetValue,
    [object]$Config,
    [string]$PropertyName
  )

  if ($Current -ne $UnsetValue) {
    return $Current
  }

  $value = Get-ConfigPropertyValue -Config $Config -PropertyName $PropertyName
  if ($null -eq $value) {
    return $Current
  }

  $numeric = 0.0
  if ([double]::TryParse([string]$value, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$numeric)) {
    return $numeric
  }

  return $Current
}

function Use-ConfigBoolFlag {
  param(
    [string]$Current,
    [object]$Config,
    [string]$PropertyName
  )

  if ($Current -ne "") {
    return $Current
  }

  $value = Get-ConfigPropertyValue -Config $Config -PropertyName $PropertyName
  if ($null -eq $value) {
    return $Current
  }

  if ($value -is [bool]) {
    return $(if ($value) { "1" } else { "0" })
  }

  $text = ([string]$value).Trim().ToLowerInvariant()
  if ($text -in @("1", "true", "yes", "on")) {
    return "1"
  }
  if ($text -in @("0", "false", "no", "off")) {
    return "0"
  }

  return $Current
}

$Nav2RobotRadius = Use-PositiveConfigDouble -Current $Nav2RobotRadius -Config $avoidanceConfig -PropertyName "nav2RobotRadius"
$Nav2FootprintPadding = Use-PositiveConfigDouble -Current $Nav2FootprintPadding -Config $avoidanceConfig -PropertyName "nav2FootprintPadding"
$Nav2InflationRadius = Use-PositiveConfigDouble -Current $Nav2InflationRadius -Config $avoidanceConfig -PropertyName "nav2InflationRadius"
$Nav2CostScalingFactor = Use-PositiveConfigDouble -Current $Nav2CostScalingFactor -Config $avoidanceConfig -PropertyName "nav2CostScalingFactor"
$Nav2ObstacleMinRange = Use-PositiveConfigDouble -Current $Nav2ObstacleMinRange -Config $avoidanceConfig -PropertyName "nav2ObstacleMinRange"
$Nav2ObstacleMaxRange = Use-PositiveConfigDouble -Current $Nav2ObstacleMaxRange -Config $avoidanceConfig -PropertyName "nav2ObstacleMaxRange"
$Nav2RaytraceMaxRange = Use-PositiveConfigDouble -Current $Nav2RaytraceMaxRange -Config $avoidanceConfig -PropertyName "nav2RaytraceMaxRange"
$Nav2ControllerFrequency = Use-PositiveConfigDouble -Current $Nav2ControllerFrequency -Config $avoidanceConfig -PropertyName "nav2ControllerFrequency"
$Nav2BtLoopDurationMs = Use-PositiveConfigDouble -Current $Nav2BtLoopDurationMs -Config $avoidanceConfig -PropertyName "nav2BtLoopDurationMs"
$Nav2BtServerTimeoutMs = Use-PositiveConfigDouble -Current $Nav2BtServerTimeoutMs -Config $avoidanceConfig -PropertyName "nav2BtServerTimeoutMs"
$Nav2BtWaitForServiceTimeoutMs = Use-PositiveConfigDouble -Current $Nav2BtWaitForServiceTimeoutMs -Config $avoidanceConfig -PropertyName "nav2BtWaitForServiceTimeoutMs"
$Nav2PlannerFrequency = Use-PositiveConfigDouble -Current $Nav2PlannerFrequency -Config $avoidanceConfig -PropertyName "nav2PlannerFrequency"
$Nav2SmootherFrequency = Use-PositiveConfigDouble -Current $Nav2SmootherFrequency -Config $avoidanceConfig -PropertyName "nav2SmootherFrequency"
$Nav2RequiredMovementRadius = Use-PositiveConfigDouble -Current $Nav2RequiredMovementRadius -Config $avoidanceConfig -PropertyName "nav2RequiredMovementRadius"
$Nav2MovementTimeAllowance = Use-PositiveConfigDouble -Current $Nav2MovementTimeAllowance -Config $avoidanceConfig -PropertyName "nav2MovementTimeAllowance"
$Nav2FailureTolerance = Use-PositiveConfigDouble -Current $Nav2FailureTolerance -Config $avoidanceConfig -PropertyName "nav2FailureTolerance"
$Nav2MinSpeedXy = Use-PositiveConfigDouble -Current $Nav2MinSpeedXy -Config $avoidanceConfig -PropertyName "nav2MinSpeedXy"
$Nav2TransStoppedVelocity = Use-PositiveConfigDouble -Current $Nav2TransStoppedVelocity -Config $avoidanceConfig -PropertyName "nav2TransStoppedVelocity"
$Nav2ScanFilterEnabled = Use-ConfigBoolFlag -Current $Nav2ScanFilterEnabled -Config $avoidanceConfig -PropertyName "nav2ScanFilterEnabled"
$Nav2ScanFilterMaskStartDeg = Use-ConfigDoubleWhenUnset -Current $Nav2ScanFilterMaskStartDeg -UnsetValue -9999 -Config $avoidanceConfig -PropertyName "nav2ScanFilterMaskStartDeg"
$Nav2ScanFilterMaskEndDeg = Use-ConfigDoubleWhenUnset -Current $Nav2ScanFilterMaskEndDeg -UnsetValue -9999 -Config $avoidanceConfig -PropertyName "nav2ScanFilterMaskEndDeg"
$Nav2ScanFilterMaskRangeM = Use-PositiveConfigDouble -Current $Nav2ScanFilterMaskRangeM -Config $avoidanceConfig -PropertyName "nav2ScanFilterMaskRangeM"
$YawGoalTolerance = Use-PositiveConfigDouble -Current $YawGoalTolerance -Config $avoidanceConfig -PropertyName "yawGoalTolerance"
$Nav2XyGoalTolerance = Use-PositiveConfigDouble -Current $Nav2XyGoalTolerance -Config $avoidanceConfig -PropertyName "nav2XyGoalTolerance"
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

if (-not $NoSync) {
  $navigationSource = Join-Path $repoRoot "sidecars\dogzilla_navigation"
  Write-Output "Copying sidecars\dogzilla_navigation -> ${Alias}:$RemoteRoot/sidecars/"
  & scp -r -F $configPath $navigationSource "${Alias}:$RemoteRoot/sidecars/"
  if ($LASTEXITCODE -ne 0) {
    throw "scp failed for dogzilla_navigation sidecar"
  }

  $mapPoseSource = Join-Path $repoRoot "sidecars\dogzilla_map_pose"
  Write-Output "Copying sidecars\dogzilla_map_pose -> ${Alias}:$RemoteRoot/sidecars/"
  & scp -r -F $configPath $mapPoseSource "${Alias}:$RemoteRoot/sidecars/"
  if ($LASTEXITCODE -ne 0) {
    throw "scp failed for dogzilla_map_pose sidecar"
  }

  $imuPublisherSource = Join-Path $repoRoot "sidecars\dogzilla_imu_publisher"
  Write-Output "Copying sidecars\dogzilla_imu_publisher -> ${Alias}:$RemoteRoot/sidecars/"
  & scp -r -F $configPath $imuPublisherSource "${Alias}:$RemoteRoot/sidecars/"
  if ($LASTEXITCODE -ne 0) {
    throw "scp failed for dogzilla_imu_publisher sidecar"
  }
}

Repair-RemoteScriptLineEndings -ConfigPath $configPath -Alias $Alias -RemoteRoot $RemoteRoot

Write-Output "Starting DOGZILLA Nav2 waypoint navigation in $ContainerName."
$containerScript = "$RemoteRoot/sidecars/dogzilla_navigation/start-navigation-in-container.sh"
$mapEnv = if ($MapYaml) { " -e DOGZILLA_NAV2_MAP=$MapYaml" } else { "" }
$nav2Env = ''
if ($Nav2RobotRadius -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_ROBOT_RADIUS=$Nav2RobotRadius" }
if ($Nav2FootprintPadding -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_FOOTPRINT_PADDING=$Nav2FootprintPadding" }
if ($Nav2InflationRadius -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_INFLATION_RADIUS=$Nav2InflationRadius" }
if ($Nav2CostScalingFactor -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_COST_SCALING_FACTOR=$Nav2CostScalingFactor" }
if ($Nav2ObstacleMinRange -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_OBSTACLE_MIN_RANGE=$Nav2ObstacleMinRange" }
if ($Nav2ObstacleMaxRange -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_OBSTACLE_MAX_RANGE=$Nav2ObstacleMaxRange" }
if ($Nav2RaytraceMaxRange -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_RAYTRACE_MAX_RANGE=$Nav2RaytraceMaxRange" }
if ($Nav2ControllerFrequency -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_CONTROLLER_FREQUENCY=$Nav2ControllerFrequency" }
if ($Nav2BtLoopDurationMs -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_BT_LOOP_DURATION_MS=$Nav2BtLoopDurationMs" }
if ($Nav2BtServerTimeoutMs -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_BT_SERVER_TIMEOUT_MS=$Nav2BtServerTimeoutMs" }
if ($Nav2BtWaitForServiceTimeoutMs -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_BT_WAIT_FOR_SERVICE_TIMEOUT_MS=$Nav2BtWaitForServiceTimeoutMs" }
if ($Nav2PlannerFrequency -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_PLANNER_FREQUENCY=$Nav2PlannerFrequency" }
if ($Nav2SmootherFrequency -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_SMOOTHER_FREQUENCY=$Nav2SmootherFrequency" }
if ($Nav2RequiredMovementRadius -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_REQUIRED_MOVEMENT_RADIUS=$Nav2RequiredMovementRadius" }
if ($Nav2MovementTimeAllowance -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_MOVEMENT_TIME_ALLOWANCE=$Nav2MovementTimeAllowance" }
if ($Nav2FailureTolerance -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_FAILURE_TOLERANCE=$Nav2FailureTolerance" }
if ($Nav2MinSpeedXy -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_MIN_SPEED_XY=$Nav2MinSpeedXy" }
if ($Nav2TransStoppedVelocity -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_TRANS_STOPPED_VELOCITY=$Nav2TransStoppedVelocity" }
if ($Nav2ScanFilterEnabled -ne "") { $nav2Env += " -e DOGZILLA_NAV2_SCAN_FILTER_ENABLED=$Nav2ScanFilterEnabled" }
if ($Nav2ScanFilterMaskStartDeg -gt -9999) { $nav2Env += " -e DOGZILLA_NAV2_SCAN_FILTER_MASK_START_DEG=$Nav2ScanFilterMaskStartDeg" }
if ($Nav2ScanFilterMaskEndDeg -gt -9999) { $nav2Env += " -e DOGZILLA_NAV2_SCAN_FILTER_MASK_END_DEG=$Nav2ScanFilterMaskEndDeg" }
if ($Nav2ScanFilterMaskRangeM -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_SCAN_FILTER_MASK_RANGE_M=$Nav2ScanFilterMaskRangeM" }
if ($YawGoalTolerance -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_YAW_GOAL_TOLERANCE=$YawGoalTolerance" }
if ($Nav2XyGoalTolerance -gt 0) { $nav2Env += " -e DOGZILLA_NAV2_XY_GOAL_TOLERANCE=$Nav2XyGoalTolerance" }
$remoteCommand = "docker exec -e REMOTE_ROOT=$RemoteRoot -e POSE_PORT=$PosePort -e ROS_DOMAIN_ID=$RosDomainId$mapEnv$nav2Env $ContainerName bash $containerScript"
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
if ($LASTEXITCODE -ne 0) {
  throw "DOGZILLA Nav2 waypoint navigation failed to start"
}
