param(
  [Alias("Host")]
  [string]$PiIp = "",

  [string]$User = "pi",
  [int]$SshPort = 22,
  [string]$Alias = "dogzilla",
  [string]$KeyPath = "$HOME\.ssh\robodoge_pi_ed25519",
  [string]$RemoteRoot = "/home/pi/robodoge",
  [int]$DirectPort = 8893,
  [int]$VisionPort = 8894,
  [int]$AudioPort = 8895,
  [int]$LidarPort = 9090,
[string]$RobotSerialPort = "/dev/ttyAMA0",
  [string]$SerialPort = "/dev/ttyAMA1",
  [int]$RosDomainId = 16,
  [string]$DockerImage = "robodoge/ros-humble-cartographer:1.0",
  [string]$BaseDockerImage = "yahboomtechnology/ros-humble:3.6",
  [string]$AplayDevice = "plughw:CARD=Device,DEV=0",
  [switch]$BuildImage,
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
Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand "mkdir -p $remoteRootQuoted/sidecars $remoteRootQuoted/public/sounds $remoteRootQuoted/models/dogzilla_yolo $remoteRootQuoted/logs $remoteRootQuoted/maps"
if ($LASTEXITCODE -ne 0) {
  throw "remote boot-service directory setup failed"
}

$sidecars = @(
  "dogzilla_lib_bridge",
  "dogzilla_audio_cue",
  "dogzilla_yolo_vision",
  "dogzilla_rosbridge",
  "dogzilla_map_pose"
)

foreach ($sidecar in $sidecars) {
  $source = Join-Path $repoRoot "sidecars\$sidecar"
  Write-Host "Copying sidecars\$sidecar -> ${Alias}:$RemoteRoot/sidecars/"
  & scp -r -F $configPath $source "${Alias}:$RemoteRoot/sidecars/"
  if ($LASTEXITCODE -ne 0) {
    throw "scp failed for $sidecar"
  }
}

Repair-RemoteScriptLineEndings -ConfigPath $configPath -Alias $Alias -RemoteRoot $RemoteRoot

if ($BuildImage) {
  Write-Host "Building DOGZILLA Cartographer/Nav2 Docker image on ${Alias}."
  $buildScript = Join-Path $PSScriptRoot "build-dogzilla-docker-image-ssh.ps1"
  & $buildScript `
    -Alias $Alias `
    -User $User `
    -PiIp $PiIp `
    -SshPort $SshPort `
    -KeyPath $KeyPath `
    -RemoteRoot $RemoteRoot `
    -DockerImage $DockerImage `
    -BaseDockerImage $BaseDockerImage `
    -NoHostKeyScan:$NoHostKeyScan
  if ($LASTEXITCODE -ne 0) {
    throw "DOCKER_BUILD_FAILED: Failed to build $DockerImage on $Alias"
  }
}

Write-Host "Copying public\sounds\*.wav -> ${Alias}:$RemoteRoot/public/sounds/"
& scp -F $configPath (Join-Path $repoRoot "public\sounds\*.wav") "${Alias}:$RemoteRoot/public/sounds/"
if ($LASTEXITCODE -ne 0) {
  throw "scp failed for sound cues"
}

$remoteScript = @'
set -euo pipefail

REMOTE_ROOT='__REMOTE_ROOT__'
USER_NAME='__USER_NAME__'
DIRECT_PORT='__DIRECT_PORT__'
VISION_PORT='__VISION_PORT__'
AUDIO_PORT='__AUDIO_PORT__'
LIDAR_PORT='__LIDAR_PORT__'
SERIAL_PORT='__SERIAL_PORT__'
ROS_DOMAIN_ID_VALUE='__ROS_DOMAIN_ID__'
DOCKER_IMAGE='__DOCKER_IMAGE__'
APLAY_DEVICE='__APLAY_DEVICE__'

sudo mkdir -p /etc/robodoge /etc/systemd/system "$REMOTE_ROOT/logs"
sudo chown -R "$USER_NAME:$USER_NAME" "$REMOTE_ROOT/logs" "$REMOTE_ROOT/maps" "$REMOTE_ROOT/public" "$REMOTE_ROOT/sidecars" "$REMOTE_ROOT/models" 2>/dev/null || true

if ! docker images --format '{{.Repository}}:{{.Tag}}' | grep -q "^${DOCKER_IMAGE}$"; then
  echo "Building DOGZILLA Cartographer/Nav2 image ${DOCKER_IMAGE} ..."
  docker build -t "${DOCKER_IMAGE}" -f "$REMOTE_ROOT/sidecars/dogzilla_map_pose/Dockerfile" "$REMOTE_ROOT/sidecars/dogzilla_map_pose/"
fi

sudo tee /etc/robodoge/dogzilla.env >/dev/null <<ENV
REMOTE_ROOT=$REMOTE_ROOT
PYTHONUNBUFFERED=1
ROS_DOMAIN_ID=$ROS_DOMAIN_ID_VALUE
DOGZILLA_EXPECTED_ROS_DOMAIN_ID=$ROS_DOMAIN_ID_VALUE
DOGZILLA_ROBOT_SERIAL_PORT=__ROBOT_SERIAL_PORT__
DOGZILLA_SERIAL_PORT=__SERIAL_PORT__
DOGZILLA_DIRECT_DRY_RUN=0
DOGZILLA_ROSBRIDGE_PORT=9090
DOGZILLA_MAP_TOPIC=/map_cartographer
ENV

sudo tee /etc/systemd/system/robodoge-direct-bridge.service >/dev/null <<SERVICE
[Unit]
Description=Robo-Doge DOGZILLA Direct Bridge
After=network-online.target
Wants=network-online.target
Conflicts=yahboom_oled.service

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$REMOTE_ROOT
EnvironmentFile=/etc/robodoge/dogzilla.env
ExecStartPre=+/bin/bash -lc 'systemctl stop yahboom_oled.service 2>/dev/null || true; pkill -TERM -f "[a]pp_dogzilla.py" 2>/dev/null || true; pkill -TERM -f "[o]led_dogzilla.py" 2>/dev/null || true; sleep 0.8; pkill -KILL -f "[a]pp_dogzilla.py" 2>/dev/null || true; pkill -KILL -f "[o]led_dogzilla.py" 2>/dev/null || true; sleep 0.3; if fuser -s "/dev/ttyAMA0"; then echo "/dev/ttyAMA0 still owned after vendor stop" >&2; fuser -v "/dev/ttyAMA0" >&2 || true; exit 1; fi'
ExecStartPre=/bin/bash -lc 'pkill -f "[s]idecars/dogzilla_lib_bridge/server.py" 2>/dev/null || true'
ExecStart=/usr/bin/python3 $REMOTE_ROOT/sidecars/dogzilla_lib_bridge/server.py --host 0.0.0.0 --port $DIRECT_PORT --live
Restart=always
RestartSec=3
StandardOutput=append:$REMOTE_ROOT/logs/direct-bridge.log
StandardError=append:$REMOTE_ROOT/logs/direct-bridge.log

[Install]
WantedBy=multi-user.target
SERVICE

sudo tee /etc/systemd/system/robodoge-audio-cue.service >/dev/null <<SERVICE
[Unit]
Description=Robo-Doge DOGZILLA Pi Audio Cues
After=network-online.target sound.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$REMOTE_ROOT
EnvironmentFile=/etc/robodoge/dogzilla.env
ExecStartPre=/bin/bash -lc 'pkill -f "[s]idecars/dogzilla_audio_cue/server.py" 2>/dev/null || true; amixer -c 2 set Speaker 100%% unmute 2>/dev/null || true; pactl set-sink-mute @DEFAULT_SINK@ 0 2>/dev/null || true; pactl set-sink-volume @DEFAULT_SINK@ 100%% 2>/dev/null || true'
ExecStart=/usr/bin/python3 $REMOTE_ROOT/sidecars/dogzilla_audio_cue/server.py --host 0.0.0.0 --port $AUDIO_PORT --sounds-dir $REMOTE_ROOT/public/sounds --player aplay --aplay-device $APLAY_DEVICE
Restart=always
RestartSec=3
StandardOutput=append:$REMOTE_ROOT/logs/audio-cue.log
StandardError=append:$REMOTE_ROOT/logs/audio-cue.log

[Install]
WantedBy=multi-user.target
SERVICE

sudo tee /etc/systemd/system/robodoge-yolo-vision.service >/dev/null <<SERVICE
[Unit]
Description=Robo-Doge DOGZILLA YOLO Vision
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$REMOTE_ROOT
EnvironmentFile=/etc/robodoge/dogzilla.env
ExecStartPre=/bin/bash -lc 'pkill -f "[s]idecars/dogzilla_yolo_vision/server.py" 2>/dev/null || true; python3 "$REMOTE_ROOT/sidecars/dogzilla_yolo_vision/release_camera_consumers.py" --camera-source auto || true'
ExecStart=/usr/bin/python3 $REMOTE_ROOT/sidecars/dogzilla_yolo_vision/server.py --host 0.0.0.0 --port $VISION_PORT --model $REMOTE_ROOT/models/dogzilla_yolo/best.onnx --labels $REMOTE_ROOT/models/dogzilla_yolo/custom.yaml --camera-url auto --camera-control-host '' --camera-control-port 0
Restart=always
RestartSec=5
StandardOutput=append:$REMOTE_ROOT/logs/yolo-vision.log
StandardError=append:$REMOTE_ROOT/logs/yolo-vision.log

[Install]
WantedBy=multi-user.target
SERVICE

sudo tee /etc/systemd/system/robodoge-rosbridge.service >/dev/null <<SERVICE
[Unit]
Description=Robo-Doge DOGZILLA Rosbridge
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
WorkingDirectory=$REMOTE_ROOT
EnvironmentFile=/etc/robodoge/dogzilla.env
TimeoutStartSec=180
ExecStartPre=/bin/bash -lc '/usr/bin/docker inspect robodoge-rosbridge >/dev/null 2>&1 || /usr/bin/docker create --name robodoge-rosbridge --privileged --network host -e ROS_DOMAIN_ID=$ROS_DOMAIN_ID_VALUE -e DOGZILLA_SERIAL_PORT=$SERIAL_PORT -e DOGZILLA_LIDAR_BAUDRATE=230400 -e DOGZILLA_LIDAR_TOPIC=/scan -e DOGZILLA_ROSBRIDGE_PORT=9090 -e DOGZILLA_MAP_TOPIC=/map_cartographer -v /dev:/dev -v $REMOTE_ROOT:$REMOTE_ROOT -w $REMOTE_ROOT $DOCKER_IMAGE bash -lc '"'"'source /opt/ros/humble/setup.bash; source /root/yahboomcar_ws/install/setup.bash 2>/dev/null || true; cd "$REMOTE_ROOT" && bash sidecars/dogzilla_rosbridge/start-rosbridge-in-container.sh'"'"''
ExecStart=/usr/bin/docker start -a robodoge-rosbridge
ExecStop=-/usr/bin/docker stop -t 20 robodoge-rosbridge
Restart=always
RestartSec=5
StandardOutput=append:$REMOTE_ROOT/logs/rosbridge-systemd.log
StandardError=append:$REMOTE_ROOT/logs/rosbridge-systemd.log

[Install]
WantedBy=multi-user.target
SERVICE

sudo tee /etc/systemd/system/robodoge-map-pose.service >/dev/null <<SERVICE
[Unit]
Description=Robo-Doge DOGZILLA Cartographer Map Pose
After=robodoge-rosbridge.service
Wants=robodoge-rosbridge.service

[Service]
Type=simple
WorkingDirectory=$REMOTE_ROOT
EnvironmentFile=/etc/robodoge/dogzilla.env
ExecStartPre=-/usr/bin/docker rm -f robodoge-map-pose
ExecStart=/usr/bin/docker run --rm --name robodoge-map-pose --privileged --network host -e REMOTE_ROOT=$REMOTE_ROOT -e POSE_PORT=$LIDAR_PORT -e ROS_DOMAIN_ID=$ROS_DOMAIN_ID_VALUE -e DOGZILLA_MAP_POSE_MODE=auto -v /dev:/dev -v $REMOTE_ROOT:$REMOTE_ROOT -w $REMOTE_ROOT $DOCKER_IMAGE bash -lc 'source /opt/ros/humble/setup.bash; source /root/yahboomcar_ws/install/setup.bash 2>/dev/null || true; cd "$REMOTE_ROOT" && bash sidecars/dogzilla_map_pose/start-map-pose-in-container.sh'
ExecStop=-/usr/bin/docker rm -f robodoge-map-pose
TimeoutStartSec=180
StandardOutput=append:$REMOTE_ROOT/logs/map-pose-systemd.log
StandardError=append:$REMOTE_ROOT/logs/map-pose-systemd.log

[Install]
WantedBy=multi-user.target
SERVICE

sudo systemctl daemon-reload
# Retire the old HTTP lidar bridge service so it does not steal port 9090.
sudo systemctl stop robodoge-lidar-bridge.service 2>/dev/null || true
sudo systemctl disable robodoge-lidar-bridge.service 2>/dev/null || true
sudo docker rm -f robodoge-lidar-bridge 2>/dev/null || true
sudo systemctl enable robodoge-direct-bridge.service robodoge-audio-cue.service robodoge-yolo-vision.service robodoge-rosbridge.service robodoge-map-pose.service
# Prevent the Yahboom OLED vendor app from respawning and reclaiming /dev/ttyAMA0 on live navigation machines.
sudo systemctl disable --now yahboom_oled.service 2>/dev/null || true
sudo systemctl restart robodoge-audio-cue.service || true
sudo systemctl restart robodoge-yolo-vision.service || true
sudo systemctl restart robodoge-rosbridge.service || true
sudo systemctl restart robodoge-direct-bridge.service || true
sleep 4
sudo systemctl restart robodoge-map-pose.service || true

systemctl --no-pager --full status robodoge-direct-bridge.service robodoge-audio-cue.service robodoge-yolo-vision.service robodoge-rosbridge.service robodoge-map-pose.service || true
'@

$remoteScript = $remoteScript.
  Replace("`r`n", "`n").
  Replace('__REMOTE_ROOT__', $RemoteRoot).
  Replace('__USER_NAME__', $User).
  Replace('__DIRECT_PORT__', [string]$DirectPort).
  Replace('__VISION_PORT__', [string]$VisionPort).
  Replace('__AUDIO_PORT__', [string]$AudioPort).
  Replace('__LIDAR_PORT__', [string]$LidarPort).
 Replace('__ROBOT_SERIAL_PORT__', $RobotSerialPort).
  Replace('__SERIAL_PORT__', $SerialPort).
  Replace('__ROS_DOMAIN_ID__', [string]$RosDomainId).
  Replace('__DOCKER_IMAGE__', $DockerImage).
  Replace('__APLAY_DEVICE__', $AplayDevice)

Write-Host "Installing and enabling Robo-Doge boot services on $Alias."
$remoteScript | & ssh -F $configPath $Alias "bash -s"
if ($LASTEXITCODE -ne 0) {
  throw "DOGZILLA boot service installation failed"
}
