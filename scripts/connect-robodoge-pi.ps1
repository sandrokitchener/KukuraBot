param(
  [Alias("Host")]
  [Parameter(Mandatory = $true)]
  [string]$PiIp,

  [string]$User = "robodoge",
  [int]$Port = 22,
  [string]$Alias = "robodoge-pi",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteCommand = "",
  [switch]$NoHostKeyScan,
  [switch]$WriteConfigOnly
)

$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Require-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

Require-Command ssh

if (-not (Test-Path -LiteralPath $KeyPath)) {
  throw "SSH key not found: $KeyPath. Create it with: ssh-keygen -t ed25519 -f `"$KeyPath`" -N `"`" -C robodoge-pi-codex"
}

$resolvedKeyPath = (Resolve-Path -LiteralPath $KeyPath).Path -replace "\\", "/"
$repoRoot = Resolve-RepoRoot
$sshStateDir = Join-Path $repoRoot "output\pi-ssh"
$knownHostsPath = Join-Path $sshStateDir "known_hosts"
$configPath = Join-Path $sshStateDir "config"

New-Item -ItemType Directory -Force -Path $sshStateDir | Out-Null

if (-not $NoHostKeyScan) {
  if (Get-Command ssh-keyscan -ErrorAction SilentlyContinue) {
    $scan = & ssh-keyscan -p $Port -H $PiIp 2>$null
    if ($LASTEXITCODE -eq 0 -and $scan) {
      $scan | Set-Content -LiteralPath $knownHostsPath -Encoding ascii
    } elseif (-not (Test-Path -LiteralPath $knownHostsPath)) {
      New-Item -ItemType File -Force -Path $knownHostsPath | Out-Null
    }
  } elseif (-not (Test-Path -LiteralPath $knownHostsPath)) {
    New-Item -ItemType File -Force -Path $knownHostsPath | Out-Null
  }
}

@"
Host $Alias
  HostName $PiIp
  User $User
  Port $Port
  IdentityFile $resolvedKeyPath
  IdentitiesOnly yes
  ServerAliveInterval 30
  ServerAliveCountMax 4
  StrictHostKeyChecking accept-new
  UserKnownHostsFile $($knownHostsPath -replace "\\", "/")
"@ | Set-Content -LiteralPath $configPath -Encoding ascii

Write-Host "Wrote SSH config: $configPath"
Write-Host "Alias: $Alias -> $User@${PiIp}:$Port"

if ($WriteConfigOnly) {
  exit 0
}

$sshArgs = @("-F", $configPath, $Alias)
if ($RemoteCommand) {
  $sshArgs += $RemoteCommand
}

& ssh @sshArgs
