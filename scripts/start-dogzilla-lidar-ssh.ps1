param(
  [Alias("Host")]
  [string]$PiIp = "",

  [string]$User = "pi",
  [int]$SshPort = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge",
  [int]$Port = 8896,
  [ValidateSet("oradar")]
  [string]$Driver = "oradar",
  [string]$SerialPort = "auto",
  [int]$Baudrate = 230400,
  [string]$Topic = "/scan",
  [int]$RosDomainId = 16,
  [string]$DockerImage = "yahboomtechnology/ros-humble:3.6",
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
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "mkdir -p $remoteRootQuoted/sidecars $remoteRootQuoted/logs"

$sidecarSource = Join-Path $repoRoot "sidecars\dogzilla_lidar_bridge"
Write-Host "Copying sidecars\dogzilla_lidar_bridge -> ${Alias}:$RemoteRoot/sidecars/"
& scp -r -F $configPath $sidecarSource "${Alias}:$RemoteRoot/sidecars/"
if ($LASTEXITCODE -ne 0) {
  throw "scp failed for dogzilla_lidar_bridge sidecar"
}

$effectiveSerialPort = $SerialPort
if ($SerialPort -eq "auto") {
  $detectSerialCommand = @'
printf '/dev/ttyAMA1'
'@
  $effectiveSerialPort = Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $detectSerialCommand
  $effectiveSerialPort = ($effectiveSerialPort | Out-String).Trim()
  if (-not $effectiveSerialPort) {
    $effectiveSerialPort = "/dev/ttyAMA1"
  }
  Write-Host "Auto-selected DOGZILLA lidar serial port: $effectiveSerialPort"
}

$serverCommand = "source /opt/ros/humble/setup.bash; source /root/yahboomcar_ws/install/setup.bash 2>/dev/null || true; cd $RemoteRoot && python3 sidecars/dogzilla_lidar_bridge/server.py --host 0.0.0.0 --port $Port --driver $Driver --serial-port $effectiveSerialPort --baudrate $Baudrate --topic $Topic --no-scan-odom"
$serverCommandQuoted = ConvertTo-RemoteSingleQuote $serverCommand
$containerName = "robodoge-lidar-bridge"

if ($Background) {
  $dockerCommand = "docker run -d --name $containerName --privileged --network host -e ROS_DOMAIN_ID=$RosDomainId -v /dev:/dev -v ${RemoteRoot}:$RemoteRoot -w $RemoteRoot $DockerImage bash -lc $serverCommandQuoted"
  $remoteCommand = "cd $remoteRootQuoted && docker rm -f $containerName 2>/dev/null || true; $dockerCommand && sleep 3 && docker ps --filter name=$containerName --format '{{.ID}} {{.Status}}' && docker logs --tail 40 $containerName"
  Write-Host "Starting DOGZILLA lidar bridge on $Alias port $Port in Docker background."
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
  exit $LASTEXITCODE
}

$dockerCommand = "docker run --rm --name $containerName --privileged --network host -e ROS_DOMAIN_ID=$RosDomainId -v /dev:/dev -v ${RemoteRoot}:$RemoteRoot -w $RemoteRoot $DockerImage bash -lc $serverCommandQuoted"
$remoteCommand = "cd $remoteRootQuoted && docker rm -f $containerName 2>/dev/null || true; $dockerCommand"
Write-Host "Starting DOGZILLA lidar bridge on $Alias port $Port. This SSH session stays attached."
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
