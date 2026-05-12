param(
  [Alias("Host")]
  [Parameter(Mandatory = $true)]
  [string]$PiIp,

  [string]$User = "robodoge",
  [int]$Port = 22,
  [string]$Alias = "robodoge-pi",
  [string]$RepoUrl = "",
  [string]$InstallRoot = "/opt/robodoge",
  [switch]$SkipRos,
  [switch]$NoRepoClone
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
Require-Command scp
Require-Command git

$repoRoot = Resolve-RepoRoot

if (-not $RepoUrl -and -not $NoRepoClone) {
  $gitRemote = (& git -C $repoRoot config --get remote.origin.url 2>$null)
  if ($LASTEXITCODE -eq 0) {
    $RepoUrl = ($gitRemote | Select-Object -First 1).Trim()
  }
}

& (Join-Path $PSScriptRoot "connect-robodoge-pi.ps1") `
  -Host $PiIp `
  -User $User `
  -Port $Port `
  -Alias $Alias `
  -RemoteCommand "true"

$configPath = Join-Path $repoRoot "output\pi-ssh\config"
$bootstrapPath = Join-Path $PSScriptRoot "bootstrap-robodoge-pi.sh"

& scp -F $configPath $bootstrapPath "${Alias}:/tmp/bootstrap-robodoge-pi.sh"

$remoteArgs = @("bash", "/tmp/bootstrap-robodoge-pi.sh", "--install-root", $InstallRoot)
if ($SkipRos) {
  $remoteArgs += "--skip-ros"
}
if (-not $NoRepoClone -and $RepoUrl) {
  $remoteArgs += @("--repo-url", $RepoUrl)
}

$remoteCommand = ($remoteArgs | ForEach-Object { "'" + ($_ -replace "'", "'\''") + "'" }) -join " "
& ssh -F $configPath $Alias $remoteCommand
