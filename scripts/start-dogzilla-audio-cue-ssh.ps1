param(
  [Alias("Host")]
  [string]$PiIp = "",

  [string]$User = "pi",
  [int]$SshPort = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge",
  [int]$Port = 8895,
  [string]$Player = "aplay",
  [switch]$Background,
  [switch]$NoHostKeyScan
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "dogzilla-ssh-common.ps1")

Require-LocalCommand ssh
Require-LocalCommand scp

$repoRoot = Resolve-RoboDogeRoot
$configPath = Ensure-DogzillaSshConfig `
  -Host $PiIp `
  -User $User `
  -Port $SshPort `
  -Alias $Alias `
  -KeyPath $KeyPath `
  -NoHostKeyScan:$NoHostKeyScan

$remoteRootQuoted = ConvertTo-RemoteSingleQuote $RemoteRoot
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "mkdir -p $remoteRootQuoted/sidecars $remoteRootQuoted/public/sounds $remoteRootQuoted/logs"

$sidecarSource = Join-Path $repoRoot "sidecars\dogzilla_audio_cue"
Write-Host "Copying sidecars\dogzilla_audio_cue -> ${Alias}:$RemoteRoot/sidecars/"
& scp -r -F $configPath $sidecarSource "${Alias}:$RemoteRoot/sidecars/"
if ($LASTEXITCODE -ne 0) {
  throw "scp failed for dogzilla_audio_cue sidecar"
}

$soundsSource = Join-Path $repoRoot "public\sounds\*.wav"
Write-Host "Copying public\sounds\*.wav -> ${Alias}:$RemoteRoot/public/sounds/"
& scp -F $configPath $soundsSource "${Alias}:$RemoteRoot/public/sounds/"
if ($LASTEXITCODE -ne 0) {
  throw "scp failed for sound cues"
}

$playerCheckCommand = "command -v $Player"
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $playerCheckCommand
if ($LASTEXITCODE -ne 0) {
  throw "Audio player '$Player' not found on Pi."
}

$serverCommand = "export PYTHONUNBUFFERED=1; cd $RemoteRoot && python3 sidecars/dogzilla_audio_cue/server.py --host 0.0.0.0 --port $Port --sounds-dir public/sounds --player $Player"

if ($Background) {
  $serverCommandQuoted = ConvertTo-RemoteSingleQuote $serverCommand
  $remoteCommand = "cd $remoteRootQuoted && mkdir -p logs && if [ -f logs/audio-cue.pid ]; then kill `$(cat logs/audio-cue.pid) 2>/dev/null || true; fi && pkill -f '[s]idecars/dogzilla_audio_cue/server.py' 2>/dev/null || true; sleep 1; (nohup bash -lc $serverCommandQuoted > logs/audio-cue.log 2>&1 < /dev/null & echo `$! > logs/audio-cue.pid) && sleep 1 && cat logs/audio-cue.pid && tail -n 20 logs/audio-cue.log"
  Write-Host "Starting DOGZILLA audio cue bridge on $Alias port $Port in remote background."
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
  exit $LASTEXITCODE
}

$remoteCommand = "cd $remoteRootQuoted && $serverCommand"
Write-Host "Starting DOGZILLA audio cue bridge on $Alias port $Port. This SSH session stays attached."
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
