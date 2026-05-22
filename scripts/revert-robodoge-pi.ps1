param(
  [Alias("Host")]
  [string]$PiIp = "10.0.4.32",
  [string]$User = "pi",
  [int]$Port = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge",
  [switch]$Apply,
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

$remoteRootQuoted = ConvertTo-RemoteSingleQuote $RemoteRoot

if (-not $Apply) {
  $remoteCommand = "set +e; echo '[dry-run] would stop Robo-Doge bridge processes'; ps -ef | grep -E '[s]idecars/(dogzilla_lib_bridge|ros2_bridge)/server.py' || true; echo '[dry-run] would remove remote root:' $remoteRootQuoted; find $remoteRootQuoted -maxdepth 3 -type f 2>/dev/null | sort || true; echo '[dry-run] vendor path /home/pi/DOGZILLA is not touched'"
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
  exit $LASTEXITCODE
}

$remoteCommand = "set +e; pkill -f '[s]idecars/dogzilla_lib_bridge/server.py' 2>/dev/null || true; pkill -f '[s]idecars/ros2_bridge/server.py' 2>/dev/null || true; rm -rf $remoteRootQuoted; echo 'Robo-Doge remote artifacts removed. Vendor DOGZILLA files untouched.'"
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
