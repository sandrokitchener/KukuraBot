param(
  [Alias("Host")]
  [string]$PiIp = "10.0.4.32",
  [string]$User = "pi",
  [int]$Port = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$OutputDir = "output\dogzilla-baseline",
  [switch]$NoHostKeyScan
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "dogzilla-ssh-common.ps1")

$configPath = Ensure-DogzillaSshConfig `
  -Host $PiIp `
  -User $User `
  -Port $Port `
  -Alias $Alias `
  -KeyPath $KeyPath `
  -NoHostKeyScan:$NoHostKeyScan

$repoRoot = Resolve-RoboDogeRoot
$resolvedOutputDir = Join-Path $repoRoot $OutputDir
New-Item -ItemType Directory -Force -Path $resolvedOutputDir | Out-Null

$stamp = Get-Date -Format "yyyyMMddTHHmmss"
$outputPath = Join-Path $resolvedOutputDir "$PiIp-$stamp.txt"

$remoteCommand = @'
set +e
echo "== identity =="
date --iso-8601=seconds
whoami
hostname
uname -a

echo
echo "== os =="
cat /etc/os-release 2>/dev/null

echo
echo "== network =="
hostname -I
nmcli con show 2>/dev/null
nmcli con show --active 2>/dev/null
ip addr

echo
echo "== services =="
systemctl list-unit-files --type=service --no-pager 2>/dev/null | grep -Ei 'dogzilla|yahboom|jupyter|vnc|docker|NetworkManager|hostapd|dnsmasq' || true
systemctl --type=service --state=running --no-pager 2>/dev/null | grep -Ei 'dogzilla|yahboom|jupyter|vnc|docker|NetworkManager|hostapd|dnsmasq' || true

echo
echo "== processes =="
ps -ef | grep -Ei 'dogzilla|yahboom|robodoge|jupyter|vnc|docker|ros|lidar|camera' | grep -v grep || true

echo
echo "== listening =="
ss -lntp 2>/dev/null || true

echo
echo "== devices =="
ls -l /dev/ttyUSB* /dev/ttyACM* /dev/ttyAMA* /dev/serial* /dev/video* /dev/i2c* /dev/spidev* 2>/dev/null || true
lsusb 2>/dev/null || true

echo
echo "== docker =="
docker ps -a 2>/dev/null || true
docker images 2>/dev/null || true

echo
echo "== vendor files =="
find /home/pi/DOGZILLA -maxdepth 3 -type f 2>/dev/null | sort | head -300 || true

echo
echo "== robodoge files =="
find /home/pi/robodoge -maxdepth 4 -type f 2>/dev/null | sort || true
'@

Write-Host "Writing DOGZILLA baseline snapshot to $outputPath"
& ssh -F $configPath $Alias $remoteCommand | Tee-Object -FilePath $outputPath
