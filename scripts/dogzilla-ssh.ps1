param(
  [Alias("Host")]
  [string]$PiIp = "",

  [string]$User = "pi",
  [int]$Port = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$Command = "",
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

Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $Command
