param(
  [Alias("Host")]
  [string]$PiIp = "",

  [string]$User = "pi",
  [int]$Port = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$OutputDir = "output\dogzilla-inventory",
  [switch]$NoHostKeyScan
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "dogzilla-ssh-common.ps1")

Require-LocalCommand ssh

$repoRoot = Resolve-RoboDogeRoot
$configPath = Ensure-DogzillaSshConfig `
  -Host $PiIp `
  -User $User `
  -Port $Port `
  -Alias $Alias `
  -KeyPath $KeyPath `
  -NoHostKeyScan:$NoHostKeyScan

$targetName = if ($PiIp) { $PiIp } else { $Alias }
$safeTargetName = $targetName -replace "[^A-Za-z0-9_.-]", "_"
$stamp = Get-Date -Format "yyyyMMddTHHmmss"
$resolvedOutputDir = Join-Path $repoRoot $OutputDir
$outputPath = Join-Path $resolvedOutputDir "$safeTargetName-$stamp.txt"
New-Item -ItemType Directory -Force -Path $resolvedOutputDir | Out-Null

$remoteScript = @'
set -u

section() {
  printf '\n== %s ==\n' "$1"
}

section identity
date -Is 2>/dev/null || date
whoami
hostname
uname -a

section os
cat /etc/os-release 2>/dev/null || true

section network
ip -br addr 2>/dev/null || ip addr 2>/dev/null || true

section python
command -v python3 || true
python3 --version 2>/dev/null || true

section ros2
command -v ros2 || true
ros2 --help >/dev/null 2>&1 && echo "ros2: ok" || echo "ros2: unavailable"
printf 'ROS_DOMAIN_ID=%s\n' "${ROS_DOMAIN_ID:-unset}"

section vendor-paths
for path in /home/pi/DOGZILLA /home/pi/DOGZILLA/DOGZILLALib /home/yahboom/DOGZILLA /home/yahboom/DOGZILLA/DOGZILLALib "$HOME/DOGZILLA" "$HOME/DOGZILLALib"; do
  if [ -e "$path" ]; then
    echo "found $path"
    find "$path" -maxdepth 2 \( -name 'run_humble.sh' -o -iname '*dogzilla*.py' -o -iname '*DOGZILLA*.py' \) 2>/dev/null | head -80
  fi
done

section docker
command -v docker || true
[ -x "$HOME/DOGZILLA/run_humble.sh" ] && echo "run_humble: $HOME/DOGZILLA/run_humble.sh" || true

section devices
ls -l /dev/ttyAMA* /dev/ttyS* /dev/ttyUSB* /dev/serial/by-id/* 2>/dev/null || true

section services
systemctl --type=service --state=running --no-pager 2>/dev/null | grep -Ei 'dogzilla|yahboom|ros|jupyter|vnc|camera|lidar|bringup|docker' || true

section processes
ps -ef | grep -Ei 'dogzilla|yahboom|ros|jupyter|vnc|camera|lidar|bringup|docker' | grep -v grep || true

section python-imports
python3 - <<'PY' 2>/dev/null || true
import importlib
mods = ["DOGZILLALib.DOGZILLALib", "DOGZILLALib", "dogzilla"]
for name in mods:
    try:
        module = importlib.import_module(name)
        print(f"{name}: ok ({getattr(module, '__file__', 'built-in')})")
    except Exception as exc:
        print(f"{name}: no ({type(exc).__name__}: {exc})")
PY

section workspace
if [ -e "$HOME/robodoge" ]; then
  find "$HOME/robodoge" -maxdepth 2 -type f | head -80
else
  echo "no ~/robodoge yet"
fi
'@

$remoteCommand = "bash -lc " + (ConvertTo-RemoteSingleQuote $remoteScript)
Write-Host "Writing inventory to $outputPath"
& ssh -F $configPath $Alias $remoteCommand | Tee-Object -FilePath $outputPath
