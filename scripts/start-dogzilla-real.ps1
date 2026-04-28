param(
  [string]$BridgeBaseUrl = "http://192.168.8.88:8892",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$env:ROBOT_RUNTIME_TARGET = "ros2_real"
$env:ROBOT_RUNTIME_DRY_RUN = if ($DryRun) { "1" } else { "0" }
$env:ROBOT_ROS2_TRANSPORT_DRY_RUN = if ($DryRun) { "1" } else { "0" }
$env:ROBOT_ROS2_BASE_URL = $BridgeBaseUrl
$env:ROBOT_ROS2_MANAGED_BY_APP = "0"

Write-Host "Robo-Doge real robot target"
Write-Host "Bridge: $BridgeBaseUrl"
Write-Host "Dry-run: $($DryRun.IsPresent)"
Write-Host

npm start
