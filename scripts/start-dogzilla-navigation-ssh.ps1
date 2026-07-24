param(
  [Alias("Host")]
  [string]$PiIp = "",

  [string]$User = "pi",
  [int]$SshPort = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge",
  [string]$ContainerName = "robodoge-rosbridge",
  [int]$RosDomainId = 16,
  [int]$PosePort = 9090,
  [string]$MapYaml = "",
  [switch]$MappingMode,
  [switch]$SkipReadinessWait,
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
if (!(Test-Path -LiteralPath $avoidanceConfigPath)) {
  throw "Canonical Nav2 tuning config not found at $avoidanceConfigPath"
}
$mapMetadataSource = Join-Path $repoRoot "sidecars\dogzilla_lib_bridge\map_metadata.py"
if (!(Test-Path -LiteralPath $mapMetadataSource)) {
  throw "Shared map metadata validator not found at $mapMetadataSource"
}
$configPath = Ensure-DogzillaSshConfig `
  -Host $PiIp `
  -User $User `
  -Port $SshPort `
  -Alias $Alias `
  -KeyPath $KeyPath `
  -NoHostKeyScan:$NoHostKeyScan

$remoteRootQuoted = ConvertTo-RemoteSingleQuote $RemoteRoot
if (-not $NoSync) {
  $remoteSetup = "sudo install -d -o $User -g $User $remoteRootQuoted/sidecars/dogzilla_navigation $remoteRootQuoted/sidecars/dogzilla_map_pose $remoteRootQuoted/sidecars/dogzilla_imu_publisher $remoteRootQuoted/sidecars/dogzilla_lib_bridge $remoteRootQuoted/logs $remoteRootQuoted/config && sudo chown -R ${User}:$User $remoteRootQuoted/sidecars/dogzilla_navigation $remoteRootQuoted/sidecars/dogzilla_map_pose $remoteRootQuoted/sidecars/dogzilla_imu_publisher $remoteRootQuoted/sidecars/dogzilla_lib_bridge $remoteRootQuoted/config"
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteSetup
  if ($LASTEXITCODE -ne 0) { throw "remote navigation setup failed" }
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

  Write-Output "Copying config\robot-obstacle-avoidance.json -> ${Alias}:$RemoteRoot/config/"
  & scp -F $configPath $avoidanceConfigPath "${Alias}:$RemoteRoot/config/robot-obstacle-avoidance.json"
  if ($LASTEXITCODE -ne 0) {
    throw "scp failed for canonical Nav2 tuning config"
  }

  $mapMetadataStagePath = "/tmp/robodoge-map-metadata-$([guid]::NewGuid().ToString('N')).py"
  $mapMetadataRemotePath = "$RemoteRoot/sidecars/dogzilla_lib_bridge/map_metadata.py"
  Write-Output "Copying sidecars\dogzilla_lib_bridge\map_metadata.py -> ${Alias}:$mapMetadataRemotePath"
  & scp -q -F $configPath $mapMetadataSource "${Alias}:$mapMetadataStagePath"
  if ($LASTEXITCODE -ne 0) {
    throw "scp failed for shared map metadata validator"
  }
  $mapMetadataInstall = "sudo install -o $User -g $User -m 0644 $(ConvertTo-RemoteSingleQuote $mapMetadataStagePath) $(ConvertTo-RemoteSingleQuote $mapMetadataRemotePath) && rm -f $(ConvertTo-RemoteSingleQuote $mapMetadataStagePath)"
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $mapMetadataInstall
  if ($LASTEXITCODE -ne 0) {
    throw "sudo install failed for shared map metadata validator"
  }
}

Repair-RemoteScriptLineEndings -ConfigPath $configPath -Alias $Alias -RemoteRoot $RemoteRoot

Write-Output "Starting DOGZILLA Nav2 waypoint navigation in $ContainerName."
$containerScript = "$RemoteRoot/sidecars/dogzilla_navigation/start-navigation-in-container.sh"
$mapEnv = if ($MapYaml) { " -e DOGZILLA_NAV2_MAP=$MapYaml" } else { "" }
$localizationBackend = "cartographer"
$mappingModeEnv = " -e DOGZILLA_LOCALIZATION_BACKEND=$localizationBackend"
if ($MappingMode) { $mappingModeEnv += " -e DOGZILLA_NAV2_MAPPING_MODE=1" }
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
if (-not $MappingMode -and ($MapYaml -or $nav2Env)) {
  throw "Normal navigation is systemd-owned and reads canonical tuning from config/robot-obstacle-avoidance.json; per-launch CLI overrides are supported only with -MappingMode."
}
function Wait-ContainerRunning {
  param([string]$Name, [int]$TimeoutSec = 20)
  for ($i = 0; $i -lt $TimeoutSec; $i += 2) {
    $id = & ssh -n -F $configPath $Alias "docker ps --filter name=$Name --format='{{.ID}}' 2>/dev/null || true" 2>$null
    if ($id) {
      Start-Sleep -Seconds 2
      return $true
    }
    Start-Sleep -Seconds 2
  }
  return $false
}

$ownerFile = "$RemoteRoot/logs/navigation-runtime.owner"
$ownerFileQuoted = ConvertTo-RemoteSingleQuote $ownerFile
function Get-NavigationOwnerRecord {
  $ownerCommand = "if sudo -n test -f $ownerFileQuoted; then sudo -n sed -n -e 's/^mode=/mode=/p' -e 's/^token=/token=/p' $ownerFileQuoted; fi"
  $ownerLines = @(& ssh -n -F $configPath $Alias $ownerCommand 2>$null)
  if ($LASTEXITCODE -ne 0) {
    throw "Could not read the Nav2 owner record at $ownerFile."
  }
  $mode = ""
  $token = ""
  foreach ($line in $ownerLines) {
    $parts = @("$line" -split "=", 2)
    if ($parts.Count -ne 2) { continue }
    if ($parts[0] -eq "mode") { $mode = $parts[1].Trim() }
    if ($parts[0] -eq "token") { $token = $parts[1].Trim() }
  }
  return [pscustomobject]@{ Mode = $mode; Token = $token }
}

$expectedOwnerMode = if ($MappingMode) { "mapping" } else { "normal" }
$expectedOwnerToken = ""

if ($MappingMode) {
  # Mapping launch owns the explicit detached exception; the runtime flock still
  # refuses to compete with a systemd-owned localization launch.
  $ownerBefore = Get-NavigationOwnerRecord
  $remoteCommand = "docker exec -d -e REMOTE_ROOT=$RemoteRoot -e POSE_PORT=$PosePort -e ROS_DOMAIN_ID=$RosDomainId$mapEnv$mappingModeEnv$nav2Env $ContainerName bash $containerScript"
  $sshOutput = Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
  if ($LASTEXITCODE -ne 0) {
    Write-Output "Container $ContainerName not available; attempting to start..."
    & ssh -n -F $configPath $Alias "docker start $ContainerName 2>/dev/null || docker run -d --name $ContainerName --privileged --network host robodoge/ros-humble-cartographer:1.0 bash -lc 'echo started' 2>/dev/null || true"
    if (Wait-ContainerRunning -Name $ContainerName -TimeoutSec 20) {
      Write-Output "Container $ContainerName started; retrying mapping Nav2 launch."
      $ownerBefore = Get-NavigationOwnerRecord
      $sshOutput = Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
      if ($LASTEXITCODE -ne 0) {
        $detail = ($sshOutput | Out-String).Trim()
        $detailLines = $detail -split "`n" | Select-Object -First 30 | ForEach-Object { "    $_" }
        $suffix = if ($detailLines.Count -gt 0) { "`n`nSSH output:`n$($detailLines -join "`n")" } else { "" }
        throw "DOGZILLA mapping Nav2 failed to launch (exit=$LASTEXITCODE).$suffix"
      }
    } else {
      throw "DOGZILLA mapping Nav2 failed: container '$ContainerName' could not be started."
    }
  }
  $ownerDeadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    $ownerAfter = Get-NavigationOwnerRecord
    if (
      $ownerAfter.Mode -eq "mapping" -and
      $ownerAfter.Token -match '^[0-9a-fA-F]{32}$' -and
      $ownerAfter.Token -ne $ownerBefore.Token
    ) {
      $expectedOwnerToken = $ownerAfter.Token
      break
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $ownerDeadline)
  if (-not $expectedOwnerToken) {
    throw "DOGZILLA mapping Nav2 did not acquire a fresh mapping owner generation; the detached launch may have refused the runtime lock."
  }
  Write-Output "Launched mapping Nav2 under the detached exception; polling readiness."
} else {
  $ownerStatusScript = "$RemoteRoot/sidecars/dogzilla_navigation/navigation-owner-status-in-container.sh"
  $ownerStatusCommand = "if sudo systemctl is-active --quiet robodoge-autonomous-mapping-starting || sudo systemctl is-active --quiet robodoge-autonomous-mapping; then echo mapping; exit 42; fi; docker exec -e REMOTE_ROOT=$RemoteRoot $ContainerName bash $ownerStatusScript"
  $ownerStatusOutput = Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $ownerStatusCommand
  $ownerStatusExit = $LASTEXITCODE
  if ($ownerStatusExit -eq 42) {
    throw "DOGZILLA mapping owns the Nav2 runtime; refusing a normal systemd restart until mapping restores localization."
  }
  if ($ownerStatusExit -ne 0) {
    $ownerStatusDetail = ($ownerStatusOutput | Out-String).Trim()
    throw "DOGZILLA Nav2 runtime owner is unknown; refusing destructive restart: $ownerStatusDetail"
  }
  $remoteCommand = "sudo systemctl reset-failed robodoge-navigation.service; sudo systemctl restart robodoge-navigation.service"
  $sshOutput = Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
  if ($LASTEXITCODE -ne 0) {
    $detail = ($sshOutput | Out-String).Trim()
    throw "DOGZILLA Nav2 systemd service failed to restart: $detail"
  }
  Write-Output "Restarted systemd-owned Nav2; polling readiness."
}

if ($SkipReadinessWait) {
  Write-Output "Skipped blocking readiness wait; caller owns readiness supervision."
  return
}
$scanTopic = if ($Nav2ScanFilterEnabled -eq "0") { "/scan" } elseif ($Nav2ScanFilterEnabled -eq "1") { "/scan_nav2" } else { "auto" }
$waitScriptLocal = Join-Path $repoRoot "sidecars/dogzilla_navigation/wait-nav2-ready.sh"
if (!(Test-Path -LiteralPath $waitScriptLocal)) {
  throw "wait-nav2-ready.sh not found at $waitScriptLocal"
}
$readinessLogicLocal = Join-Path $repoRoot "sidecars/dogzilla_navigation/nav2_readiness_logic.py"
if (!(Test-Path -LiteralPath $readinessLogicLocal)) {
  throw "nav2_readiness_logic.py not found at $readinessLogicLocal"
}
$waitScriptRemote = "/tmp/wait-nav2-ready.sh"
$waitScriptContainer = "/tmp/wait-nav2-ready.sh"
$readinessLogicRemote = "/tmp/nav2_readiness_logic.py"
$readinessLogicContainer = "/tmp/nav2_readiness_logic.py"
$mappingProbeArg = if ($MappingMode) { "1" } else { "0" }
& scp -F $configPath $waitScriptLocal "${Alias}:$waitScriptRemote"
if ($LASTEXITCODE -ne 0) { throw "scp failed for wait-nav2-ready.sh" }
& scp -F $configPath $readinessLogicLocal "${Alias}:$readinessLogicRemote"
if ($LASTEXITCODE -ne 0) { throw "scp failed for nav2_readiness_logic.py" }
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "docker cp $waitScriptRemote $ContainerName`:$waitScriptContainer"
if ($LASTEXITCODE -ne 0) { throw "docker cp failed for wait-nav2-ready.sh" }
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "docker cp $readinessLogicRemote $ContainerName`:$readinessLogicContainer"
if ($LASTEXITCODE -ne 0) { throw "docker cp failed for nav2_readiness_logic.py" }
$probeCommand = "docker exec -e ROS_DOMAIN_ID=$RosDomainId $ContainerName bash $waitScriptContainer $RosDomainId $RemoteRoot $scanTopic 120 $mappingProbeArg $localizationBackend once http://127.0.0.1:8893/nav2/cmd_vel/health 20 $expectedOwnerMode"
$probeOutput = Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $probeCommand
$navExit = $LASTEXITCODE
if ($navExit -ne 0) {
  $logDetail = @()
  foreach ($logFile in @("$RemoteRoot/logs/scan-filter-supervisor.log", "$RemoteRoot/logs/tf-odom-publisher.log", "$RemoteRoot/logs/cmd-vel-gait-adapter.log")) {
    $logDetail += Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "docker exec $ContainerName tail -40 $logFile 2>/dev/null || true"
  }
  $detail = ($probeOutput + $logDetail | Out-String).Trim()
  $detailLines = $detail -split "`n" | Select-Object -First 60 | ForEach-Object { "    $_" }
  throw "DOGZILLA Nav2 waypoint navigation did not become ready within 120s.`n`nDetails:`n$($detailLines -join "`n")"
}
Write-Output "DOGZILLA Nav2 waypoint navigation is ready (action server, odom, and $scanTopic are live)."
