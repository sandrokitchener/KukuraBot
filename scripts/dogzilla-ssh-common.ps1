function Resolve-RoboDogeRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Require-LocalCommand {
  param([Parameter(Mandatory = $true)][string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

function ConvertTo-RemoteSingleQuote {
  param([AllowNull()][string]$Value)

  if ($null -eq $Value) {
    return "''"
  }

  return "'" + $Value.Replace("'", "'\''") + "'"
}

function Ensure-DogzillaSshKey {
  param(
    [Parameter(Mandatory = $true)]
    [string]$KeyPath
  )

  Require-LocalCommand ssh-keygen

  if (Test-Path -LiteralPath $KeyPath) {
    return (Resolve-Path -LiteralPath $KeyPath).Path
  }

  $keyDir = Split-Path -Parent $KeyPath
  if ($keyDir) {
    New-Item -ItemType Directory -Force -Path $keyDir | Out-Null
  }

  $sshKeygenArgs = @(
    "-t", "ed25519",
    "-f", $KeyPath,
    "-N", "",
    "-C", "robodoge-pi-codex"
  )

  & ssh-keygen @sshKeygenArgs
  if ($LASTEXITCODE -ne 0) {
    throw "ssh-keygen failed for $KeyPath"
  }

  return (Resolve-Path -LiteralPath $KeyPath).Path
}

function Get-DogzillaSshConfigPath {
  $repoRoot = Resolve-RoboDogeRoot
  return (Join-Path $repoRoot "output\pi-ssh\config")
}

function Ensure-DogzillaSshConfig {
  param(
    [Alias("Host")]
    [string]$PiIp = "",
    [string]$User = "pi",
    [int]$Port = 22,
    [string]$Alias = "dogzilla",
    [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
    [switch]$NoHostKeyScan
  )

  $repoRoot = Resolve-RoboDogeRoot
  $configPath = Get-DogzillaSshConfigPath

  if ($PiIp) {
    Ensure-DogzillaSshKey -KeyPath $KeyPath | Out-Null

    $connectScript = Join-Path $PSScriptRoot "connect-robodoge-pi.ps1"
    $connectArgs = @(
      "-Host", $PiIp,
      "-User", $User,
      "-Port", $Port,
      "-Alias", $Alias,
      "-KeyPath", $KeyPath,
      "-WriteConfigOnly"
    )
    if ($NoHostKeyScan) {
      $connectArgs += "-NoHostKeyScan"
    }

    & $connectScript @connectArgs
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to write SSH config for $User@${PiIp}:$Port"
    }
  } elseif (-not (Test-Path -LiteralPath $configPath)) {
    throw "No SSH config found. Run this once with -Host <DOGZILLA_IP>."
  }

  return (Resolve-Path -LiteralPath $configPath).Path
}

function Invoke-DogzillaSsh {
  param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$Alias,
    [string]$RemoteCommand = ""
  )

  Require-LocalCommand ssh

  $sshArgs = @("-F", $ConfigPath, $Alias)
  if ($RemoteCommand) {
    $sshArgs += $RemoteCommand
  }

  & ssh @sshArgs
}
