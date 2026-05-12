param(
  [Alias("Host")]
  [Parameter(Mandatory = $true)]
  [string]$PiIp,

  [string]$User = "pi",
  [int]$Port = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [switch]$NoHostKeyScan
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "dogzilla-ssh-common.ps1")

Require-LocalCommand ssh

$privateKey = Ensure-DogzillaSshKey -KeyPath $KeyPath
$publicKeyPath = "$privateKey.pub"
if (-not (Test-Path -LiteralPath $publicKeyPath)) {
  & ssh-keygen -y -f $privateKey | Set-Content -LiteralPath $publicKeyPath -Encoding ascii
}

$configPath = Ensure-DogzillaSshConfig `
  -Host $PiIp `
  -User $User `
  -Port $Port `
  -Alias $Alias `
  -KeyPath $privateKey `
  -NoHostKeyScan:$NoHostKeyScan

$publicKey = (Get-Content -Raw -LiteralPath $publicKeyPath).Trim()
$quotedPublicKey = ConvertTo-RemoteSingleQuote $publicKey
$remoteCommand = "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF $quotedPublicKey ~/.ssh/authorized_keys || printf '%s\n' $quotedPublicKey >> ~/.ssh/authorized_keys; chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys"

Write-Host "Installing local SSH key on $User@${PiIp}:$Port."
Write-Host "If prompted, use the vendor image password once."
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand

Write-Host "Testing key login."
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "echo ssh-key-ok"
