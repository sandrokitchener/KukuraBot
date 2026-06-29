param(
  [Alias("Host")]
  [string]$PiIp = "",

  [string]$User = "pi",
  [int]$SshPort = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge",
  [int]$Port = 9090,
  [string]$SerialPort = "auto",
  [int]$Baudrate = 230400,
  [string]$Topic = "/scan",
  [int]$RosDomainId = 16,
  [string]$DockerImage = "robodoge/ros-humble-cartographer:1.0",
  [switch]$Background,
  [switch]$NoSync,
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

if (-not $NoSync) {
  $sidecarSource = Join-Path $repoRoot "sidecars\dogzilla_rosbridge"
  Write-Host "Copying sidecars\dogzilla_rosbridge -> ${Alias}:$RemoteRoot/sidecars/"
  & scp -r -F $configPath $sidecarSource "${Alias}:$RemoteRoot/sidecars/"
  if ($LASTEXITCODE -ne 0) {
    throw "scp failed for dogzilla_rosbridge sidecar"
  }
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

$serverCommand = "source /opt/ros/humble/setup.bash; source /root/yahboomcar_ws/install/setup.bash 2>/dev/null || true; export DOGZILLA_SERIAL_PORT=$effectiveSerialPort; export DOGZILLA_LIDAR_BAUDRATE=$Baudrate; export DOGZILLA_LIDAR_TOPIC=$Topic; export DOGZILLA_ROSBRIDGE_PORT=$Port; export DOGZILLA_MAP_TOPIC=/map_cartographer; cd $RemoteRoot && bash sidecars/dogzilla_rosbridge/start-rosbridge-in-container.sh"
$serverCommandQuoted = ConvertTo-RemoteSingleQuote $serverCommand
$containerName = "robodoge-rosbridge"

if ($Background) {
  $dockerCommand = "docker run -d --name $containerName --privileged --network host -e ROS_DOMAIN_ID=$RosDomainId -v /dev:/dev -v ${RemoteRoot}:$RemoteRoot -w $RemoteRoot $DockerImage bash -lc $serverCommandQuoted"
  $remoteCommand = "cd $remoteRootQuoted && docker rm -f $containerName 2>/dev/null || true; $dockerCommand && sleep 3 && docker ps --filter name=$containerName --format '{{.ID}} {{.Status}}' && docker logs --tail 40 $containerName"
  Write-Host "Starting DOGZILLA rosbridge on $Alias port $Port in Docker background."
  Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
  exit $LASTEXITCODE
}

$dockerCommand = "docker run --rm --name $containerName --privileged --network host -e ROS_DOMAIN_ID=$RosDomainId -v /dev:/dev -v ${RemoteRoot}:$RemoteRoot -w $RemoteRoot $DockerImage bash -lc $serverCommandQuoted"
$remoteCommand = "cd $remoteRootQuoted && docker rm -f $containerName 2>/dev/null || true; $dockerCommand"
Write-Host "Starting DOGZILLA rosbridge on $Alias port $Port. This SSH session stays attached."
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand
