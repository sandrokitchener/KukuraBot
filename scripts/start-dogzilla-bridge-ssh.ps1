param(
  [Alias("Host")]
  [string]$PiIp = "",

  [ValidateSet("direct", "ros2")]
  [string]$Bridge = "direct",
  [string]$User = "pi",
  [int]$SshPort = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge",
  [int]$BridgePort = 0,
  [switch]$Live,
  [switch]$Background,
  [switch]$NoSync,
  [switch]$NoHostKeyScan,
  [double]$ObstacleDistance = 0,
  [int]$ObstacleStopCount = 0,
  [double]$MaxXStep = 0,
  [double]$MaxYStep = 0,
  [double]$MaxTurnRate = 0,
  [double]$XGain = 0,
  [double]$YGain = 0,
  [double]$TurnGain = 0
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "dogzilla-ssh-common.ps1")

if (-not $NoSync) {
  $syncArgs = @{
    User = $User
    Port = $SshPort
    Alias = $Alias
    KeyPath = $KeyPath
    RemoteRoot = $RemoteRoot
  }
  if ($PiIp) {
    $syncArgs.PiIp = $PiIp
  }
  if ($NoHostKeyScan) {
    $syncArgs.NoHostKeyScan = $true
  }

  & (Join-Path $PSScriptRoot "sync-dogzilla-bridges.ps1") @syncArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Bridge sync failed."
  }
}

$configPath = Ensure-DogzillaSshConfig `
  -Host $PiIp `
  -User $User `
  -Port $SshPort `
  -Alias $Alias `
  -KeyPath $KeyPath `
  -NoHostKeyScan:$NoHostKeyScan

$remoteRootQuoted = ConvertTo-RemoteSingleQuote $RemoteRoot
$envPrefix = 'export ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-16}"; export DOGZILLA_EXPECTED_ROS_DOMAIN_ID="${DOGZILLA_EXPECTED_ROS_DOMAIN_ID:-16}";'
$avoidanceEnv = ''
if ($ObstacleDistance -gt 0) { $avoidanceEnv += "export DOGZILLA_MAP_NAVIGATION_OBSTACLE_DISTANCE=$ObstacleDistance; " }
if ($ObstacleStopCount -gt 0) { $avoidanceEnv += "export DOGZILLA_MAP_NAVIGATION_OBSTACLE_STOP_COUNT=$ObstacleStopCount; " }
if ($MaxXStep -gt 0) { $avoidanceEnv += "export DOGZILLA_MAP_NAVIGATION_MAX_X_STEP=$MaxXStep; " }
if ($MaxYStep -gt 0) { $avoidanceEnv += "export DOGZILLA_MAP_NAVIGATION_MAX_Y_STEP=$MaxYStep; " }
if ($MaxTurnRate -gt 0) { $avoidanceEnv += "export DOGZILLA_MAP_NAVIGATION_MAX_TURN_RATE=$MaxTurnRate; " }
if ($XGain -gt 0) { $avoidanceEnv += "export DOGZILLA_MAP_NAVIGATION_X_GAIN=$XGain; " }
if ($YGain -gt 0) { $avoidanceEnv += "export DOGZILLA_MAP_NAVIGATION_Y_GAIN=$YGain; " }
if ($TurnGain -gt 0) { $avoidanceEnv += "export DOGZILLA_MAP_NAVIGATION_TURN_GAIN=$TurnGain; " }
if ($avoidanceEnv) { $envPrefix = $avoidanceEnv + $envPrefix }

if ($Bridge -eq "direct") {
  $stopVendorArgs = @{
    User = $User
    SshPort = $SshPort
    Alias = $Alias
    KeyPath = $KeyPath
    RemoteRoot = $RemoteRoot
  }
  if ($PiIp) {
    $stopVendorArgs.PiIp = $PiIp
  }
  if ($NoHostKeyScan) {
    $stopVendorArgs.NoHostKeyScan = $true
  }

  & (Join-Path $PSScriptRoot "stop-dogzilla-vendor-app-ssh.ps1") @stopVendorArgs
  if ($LASTEXITCODE -ne 0) {
    throw "DOGZILLA vendor app stop failed."
  }

  $port = if ($BridgePort -gt 0) { $BridgePort } else { 8893 }
  $liveFlag = if ($Live) { " --live" } else { "" }
  $serverCommand = "$envPrefix python3 sidecars/dogzilla_lib_bridge/server.py --host 0.0.0.0 --port $port$liveFlag"
  $logName = "direct-bridge"
  $processPath = "sidecars/dogzilla_lib_bridge/server.py"
} else {
  $port = if ($BridgePort -gt 0) { $BridgePort } else { 8892 }
  $serverCommand = "$envPrefix python3 sidecars/ros2_bridge/server.py --host 0.0.0.0 --port $port"
  $logName = "ros2-bridge"
  $processPath = "sidecars/ros2_bridge/server.py"
}

if ($Background) {
  $serverCommandQuoted = ConvertTo-RemoteSingleQuote $serverCommand
  $stopCommand = @"
python3 - <<'PY'
import os, signal, subprocess, time
target = '$processPath'
try:
    rows = subprocess.check_output(['pgrep', '-af', target], text=True).splitlines()
except subprocess.CalledProcessError:
    rows = []
stopped = []
for row in rows:
    pid = int(row.split()[0])
    if pid in (os.getpid(), os.getppid()):
        continue
    try:
        comm = open(f'/proc/{pid}/comm', encoding='utf-8').read().strip()
    except OSError:
        continue
    if comm.startswith('python'):
        os.kill(pid, signal.SIGTERM)
        stopped.append(pid)
        print(f'stopped {target} {pid}')
time.sleep(0.8)
for pid in stopped:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        continue
    os.kill(pid, signal.SIGKILL)
    print(f'force-stopped {target} {pid}')
PY
"@
  $stopCommandQuoted = ConvertTo-RemoteSingleQuote $stopCommand.Trim()
  $remoteCommand = "cd $remoteRootQuoted && mkdir -p logs && if [ -f logs/$logName.pid ]; then kill `$(cat logs/$logName.pid) 2>/dev/null || true; fi && bash -lc $stopCommandQuoted && sleep 1 && (nohup bash -lc $serverCommandQuoted > logs/$logName.log 2>&1 < /dev/null & echo `$! > logs/$logName.pid) && sleep 1 && cat logs/$logName.pid"
  Write-Host "Starting $Bridge bridge on $Alias port $port in remote background."
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
  exit $LASTEXITCODE
}

$remoteCommand = "cd $remoteRootQuoted && $serverCommand"
Write-Host "Starting $Bridge bridge on $Alias port $port. This SSH session stays attached."
if ($Bridge -eq "direct" -and -not $Live) {
  Write-Host "Direct bridge is dry-run. Add -Live only after bench checks."
}

Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
