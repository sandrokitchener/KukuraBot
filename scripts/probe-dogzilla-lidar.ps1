param(
  [string]$BridgeBaseUrl = "",
  [string]$Host = "",
  [string]$User = "pi",
  [int]$Port = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path $repoRoot "scripts\dogzilla-ssh-common.ps1")

function Get-JsonOrText {
  param([string]$Url)

  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri $Url
    try {
      return ($response.Content | ConvertFrom-Json | ConvertTo-Json -Depth 8)
    } catch {
      return $response.Content
    }
  } catch {
    return "ERROR: $($_.Exception.Message)"
  }
}

if (-not $BridgeBaseUrl) {
  if (-not $Host) {
    $config = Join-Path $repoRoot "config\dogzilla-connection.json"
    if (Test-Path $config) {
      $raw = Get-Content $config -Raw | ConvertFrom-Json
      $BridgeBaseUrl = $raw.lidar.baseUrl
      $Host = $raw.ssh.host
    }
  }

  if (-not $BridgeBaseUrl -and $Host) {
    $BridgeBaseUrl = "http://${Host}:8896"
  }
}

if (-not $BridgeBaseUrl) {
  throw "Pass -BridgeBaseUrl or -Host, or set config\dogzilla-connection.json lidar.baseUrl."
}

$base = $BridgeBaseUrl.TrimEnd("/")
Write-Host "DOGZILLA lidar bridge: $base"
Write-Host ""

Write-Host "== /healthz =="
Write-Host (Get-JsonOrText "$base/healthz")
Write-Host ""

Write-Host "== /diagnostics =="
Write-Host (Get-JsonOrText "$base/diagnostics")
Write-Host ""

Write-Host "== /scan =="
Write-Host (Get-JsonOrText "$base/scan")
Write-Host ""

if ($Host) {
  $configPath = Ensure-DogzillaSshConfig `
    -Host $Host `
    -User $User `
    -Port $Port `
    -Alias $Alias `
    -KeyPath $KeyPath

  $remoteRootQuoted = ConvertTo-RemoteSingleQuote $RemoteRoot
  $remoteCommand = @"
set -eu
echo '== devices =='
ls -l /dev/ttyAMA* /dev/ttyUSB* /dev/serial/by-id/* /dev/serial/by-path/* 2>/dev/null || true
echo
echo '== lidar processes =='
ps -ef | grep -Ei 'oradar|ydlidar|lidar|robodoge' | grep -v grep || true
echo
echo '== lidar log tail =='
cd $remoteRootQuoted 2>/dev/null && tail -n 80 logs/lidar-bridge.log 2>/dev/null || true
"@

  Write-Host "== remote read-only checks =="
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
}
