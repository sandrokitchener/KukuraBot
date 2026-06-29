param(
  [switch]$NoRestart
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "dogzilla-ssh-common.ps1")

$repoRoot = Resolve-RoboDogeRoot
$configPath = Get-DogzillaSshConfigPath
$remoteRoot = "/home/pi/robodoge"
$alias = "dogzilla"

Write-Host "=== Deploying IMU fix to $alias ===" -ForegroundColor Cyan

$files = @(
  @{ Source = "sidecars/dogzilla_map_pose/robodoge_dogzilla_laser_only.lua"; Dest = "$remoteRoot/sidecars/dogzilla_map_pose/" }
  @{ Source = "sidecars/dogzilla_map_pose/robodoge_dogzilla_laser_only_localization.lua"; Dest = "$remoteRoot/sidecars/dogzilla_map_pose/" }
  @{ Source = "sidecars/dogzilla_map_pose/start-map-pose-in-container.sh"; Dest = "$remoteRoot/sidecars/dogzilla_map_pose/" }
  @{ Source = "sidecars/dogzilla_lib_bridge/server.py"; Dest = "$remoteRoot/sidecars/dogzilla_lib_bridge/" }
  @{ Source = "sidecars/dogzilla_imu_publisher/imu_publisher.py"; Dest = "$remoteRoot/sidecars/dogzilla_imu_publisher/" }
  @{ Source = "sidecars/dogzilla_imu_publisher/start-imu-publisher.sh"; Dest = "$remoteRoot/sidecars/dogzilla_imu_publisher/" }
)

Write-Host "Creating remote directories..." -ForegroundColor Yellow
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $alias -RemoteCommand "mkdir -p $remoteRoot/sidecars/dogzilla_imu_publisher"

foreach ($item in $files) {
  $sourcePath = Join-Path $repoRoot $item.Source
  Write-Host "  scp $($item.Source) -> ${alias}:" -NoNewline
  & scp -F $configPath $sourcePath "${alias}:$($item.Dest)"
  if ($LASTEXITCODE -ne 0) { throw "scp failed for $($item.Source)" }
  Write-Host " OK" -ForegroundColor Green
}

Repair-RemoteScriptLineEndings -ConfigPath $configPath -Alias $alias -RemoteRoot $remoteRoot

Write-Host "Setting executable flags..." -ForegroundColor Yellow
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $alias -RemoteCommand "chmod +x $remoteRoot/sidecars/dogzilla_imu_publisher/start-imu-publisher.sh $remoteRoot/sidecars/dogzilla_map_pose/start-map-pose-in-container.sh"

if (-not $NoRestart) {
  Write-Host "Restarting bridge + map-pose services..." -ForegroundColor Yellow
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $alias -RemoteCommand "sudo systemctl restart robodoge-direct-bridge.service" | Out-Null
  Start-Sleep 2
  Write-Host "Bridge restarted. The map-pose service will pick up changes on next wake cycle." -ForegroundColor Green

  Write-Host "Verifying processes..." -ForegroundColor Yellow
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $alias -RemoteCommand "docker exec robodoge-map-pose pgrep -a python3 | grep -E 'imu_publisher|cartographer' || echo '(container may need a wake cycle)'"
} else {
  Write-Host "Services NOT restarted (use -NoRestart). Restart manually or trigger a wake cycle." -ForegroundColor Magenta
}

Write-Host "=== Deployment complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next: After next wake cycle, check logs via:" -ForegroundColor White
Write-Host "  ssh -F $configPath $alias 'docker exec robodoge-map-pose tail -f ~/robodoge/logs/imu-publisher.log'" -ForegroundColor Gray
