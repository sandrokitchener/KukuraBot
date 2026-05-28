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
  [switch]$NoHostKeyScan
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

if ($Bridge -eq "direct") {
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
import os, signal, subprocess
target = '$processPath'
try:
    rows = subprocess.check_output(['pgrep', '-af', target], text=True).splitlines()
except subprocess.CalledProcessError:
    rows = []
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
        print(f'stopped {target} {pid}')
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
