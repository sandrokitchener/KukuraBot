param(
  [Alias("Host")]
  [string]$PiIp = "",

  [string]$User = "pi",
  [int]$SshPort = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge",
  [switch]$NoHostKeyScan
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "dogzilla-ssh-common.ps1")

$configPath = Ensure-DogzillaSshConfig `
  -Host $PiIp `
  -User $User `
  -Port $SshPort `
  -Alias $Alias `
  -KeyPath $KeyPath `
  -NoHostKeyScan:$NoHostKeyScan

$remoteRootQuoted = ConvertTo-RemoteSingleQuote $RemoteRoot
$remoteCommand = "set +e; pkill -TERM -f '[a]pp_dogzilla.py' 2>/dev/null; pkill -TERM -f '[o]led_dogzilla.py' 2>/dev/null; sleep 0.8; pkill -KILL -f '[a]pp_dogzilla.py' 2>/dev/null; pkill -KILL -f '[o]led_dogzilla.py' 2>/dev/null; rm -f $remoteRootQuoted/logs/vendor-app.pid 2>/dev/null || true; echo vendor-dogzilla-app-stopped"

Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
exit $LASTEXITCODE
