param(
  [Alias("Host")]
  [Parameter(Mandatory = $true)]
  [string]$PiIp,

  [string]$User = "pi",
  [int]$Port = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge",
  [int]$DirectPort = 8893,
  [switch]$SkipSync,
  [switch]$NoHostKeyScan
)

$ErrorActionPreference = "Stop"

function Step($Name) {
  Write-Host ""
  Write-Host "== $Name =="
}

function Run-Step($Name, [scriptblock]$Block) {
  Step $Name
  try {
    & $Block
    Write-Host "OK: $Name"
  } catch {
    Write-Host "FAIL: $Name"
    Write-Host $_.Exception.Message
    throw
  }
}

$directBaseUrl = "http://${PiIp}:$DirectPort"

Run-Step "SSH key login" {
  & (Join-Path $PSScriptRoot "dogzilla-ssh.ps1") `
    -Host $PiIp `
    -User $User `
    -Port $Port `
    -Alias $Alias `
    -KeyPath $KeyPath `
    -NoHostKeyScan:$NoHostKeyScan `
    -Command "echo ssh-ok && hostname && python3 --version"
}

Run-Step "Inventory capture" {
  & (Join-Path $PSScriptRoot "inspect-dogzilla-ssh.ps1") `
    -Host $PiIp `
    -User $User `
    -Port $Port `
    -Alias $Alias `
    -KeyPath $KeyPath `
    -NoHostKeyScan:$NoHostKeyScan
}

if (-not $SkipSync) {
  Run-Step "Bridge sync" {
    & (Join-Path $PSScriptRoot "sync-dogzilla-bridges.ps1") `
      -Host $PiIp `
      -User $User `
      -Port $Port `
      -Alias $Alias `
      -KeyPath $KeyPath `
      -RemoteRoot $RemoteRoot `
      -NoHostKeyScan:$NoHostKeyScan
  }
}

Run-Step "Start direct bridge dry-run" {
  & (Join-Path $PSScriptRoot "start-dogzilla-bridge-ssh.ps1") `
    -Host $PiIp `
    -Bridge direct `
    -User $User `
    -SshPort $Port `
    -Alias $Alias `
    -KeyPath $KeyPath `
    -RemoteRoot $RemoteRoot `
    -BridgePort $DirectPort `
    -Background `
    -NoSync `
    -NoHostKeyScan:$NoHostKeyScan
}

Run-Step "Direct bridge health" {
  Start-Sleep -Seconds 2
  $health = Invoke-RestMethod -Uri "$directBaseUrl/healthz" -Method Get -TimeoutSec 8
  $health | ConvertTo-Json -Depth 20
}

Write-Host ""
Write-Host "Smoke test done. Direct bridge dry-run URL: $directBaseUrl"
Write-Host "Probe command:"
Write-Host "powershell -ExecutionPolicy Bypass -File scripts\probe-dogzilla-bridge.ps1 -BridgeBaseUrl $directBaseUrl -Command health"
