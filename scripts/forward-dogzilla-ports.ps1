param(
  [Alias("Host")]
  [string]$PiIp = "",

  [string]$User = "pi",
  [int]$Port = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [int]$LocalRos2Port = 8892,
  [int]$RemoteRos2Port = 8892,
  [int]$LocalDirectPort = 8893,
  [int]$RemoteDirectPort = 8893,
  [switch]$NoHostKeyScan
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "dogzilla-ssh-common.ps1")

Require-LocalCommand ssh

$configPath = Ensure-DogzillaSshConfig `
  -Host $PiIp `
  -User $User `
  -Port $Port `
  -Alias $Alias `
  -KeyPath $KeyPath `
  -NoHostKeyScan:$NoHostKeyScan

$forwardArgs = @(
  "-F", $configPath,
  "-N",
  "-L", "${LocalRos2Port}:127.0.0.1:${RemoteRos2Port}",
  "-L", "${LocalDirectPort}:127.0.0.1:${RemoteDirectPort}",
  $Alias
)

Write-Host "Forwarding localhost:$LocalRos2Port -> ${Alias}:127.0.0.1:$RemoteRos2Port"
Write-Host "Forwarding localhost:$LocalDirectPort -> ${Alias}:127.0.0.1:$RemoteDirectPort"
Write-Host "Leave this window open while using forwarded ports."
& ssh @forwardArgs
