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
  [int]$LidarPort = 8896,
  [string]$SerialPort = "/dev/ttyAMA1",
  [int]$RosDomainId = 16,
  [string]$DockerImage = "yahboomtechnology/ros-humble:3.6",
  [string]$AplayDevice = "plughw:CARD=Device,DEV=0",
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
  "dogzilla_lidar_bridge",
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

sudo tee /etc/robodoge/dogzilla.env >/dev/null <<ENV
REMOTE_ROOT=$REMOTE_ROOT
PYTHONUNBUFFERED=1
ROS_DOMAIN_ID=$ROS_DOMAIN_ID_VALUE
DOGZILLA_EXPECTED_ROS_DOMAIN_ID=$ROS_DOMAIN_ID_VALUE
DOGZILLA_SERIAL_PORT=/dev/ttyAMA0
DOGZILLA_DIRECT_DRY_RUN=0
DOGZILLA_MAP_POSE_URL=http://127.0.0.1:$LIDAR_PORT/pose
DOGZILLA_MAP_SCAN_URL=http://127.0.0.1:$LIDAR_PORT/scan
ENV

sudo tee /etc/systemd/system/robodoge-direct-bridge.service >/dev/null <<SERVICE
[Unit]
Description=Robo-Doge DOGZILLA Direct Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$REMOTE_ROOT
EnvironmentFile=/etc/robodoge/dogzilla.env
ExecStartPre=/bin/bash -lc 'pkill -f "[/]home/pi/DOGZILLA/app_dogzilla/app_dogzilla.py" 2>/dev/null || true; pkill -f "[s]idecars/dogzilla_lib_bridge/server.py" 2>/dev/null || true'
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

sudo tee /etc/systemd/system/robodoge-lidar-bridge.service >/dev/null <<SERVICE
[Unit]
Description=Robo-Doge DOGZILLA LiDAR Bridge
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
WorkingDirectory=$REMOTE_ROOT
EnvironmentFile=/etc/robodoge/dogzilla.env
ExecStartPre=-/usr/bin/docker rm -f robodoge-lidar-bridge
ExecStart=/usr/bin/docker run --rm --name robodoge-lidar-bridge --privileged --network host -e ROS_DOMAIN_ID=$ROS_DOMAIN_ID_VALUE -v /dev:/dev -v $REMOTE_ROOT:$REMOTE_ROOT -w $REMOTE_ROOT $DOCKER_IMAGE bash -lc 'source /opt/ros/humble/setup.bash; source /root/yahboomcar_ws/install/setup.bash 2>/dev/null || true; cd "$REMOTE_ROOT" && python3 sidecars/dogzilla_lidar_bridge/server.py --host 0.0.0.0 --port '"$LIDAR_PORT"' --driver oradar --serial-port '"$SERIAL_PORT"' --baudrate 230400 --topic /scan --no-scan-odom'
ExecStop=-/usr/bin/docker rm -f robodoge-lidar-bridge
Restart=always
RestartSec=5
StandardOutput=append:$REMOTE_ROOT/logs/lidar-bridge-systemd.log
StandardError=append:$REMOTE_ROOT/logs/lidar-bridge-systemd.log

[Install]
WantedBy=multi-user.target
SERVICE

sudo tee /etc/systemd/system/robodoge-map-pose.service >/dev/null <<SERVICE
[Unit]
Description=Robo-Doge DOGZILLA Cartographer Map Pose
After=robodoge-lidar-bridge.service
Requires=robodoge-lidar-bridge.service
PartOf=robodoge-lidar-bridge.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$REMOTE_ROOT
EnvironmentFile=/etc/robodoge/dogzilla.env
ExecStart=/usr/bin/docker exec -e REMOTE_ROOT=$REMOTE_ROOT -e POSE_PORT=$LIDAR_PORT -e ROS_DOMAIN_ID=$ROS_DOMAIN_ID_VALUE -e DOGZILLA_MAP_POSE_MODE=auto robodoge-lidar-bridge bash $REMOTE_ROOT/sidecars/dogzilla_map_pose/start-map-pose-in-container.sh
ExecStop=/usr/bin/docker exec robodoge-lidar-bridge bash -lc 'pkill -f "[c]artographer_node.*robodoge_dogzilla_laser_only" 2>/dev/null || true; pkill -f "[s]tatic_transform_publisher.*base_link laser_frame" 2>/dev/null || true'
TimeoutStartSec=90
StandardOutput=append:$REMOTE_ROOT/logs/map-pose-systemd.log
StandardError=append:$REMOTE_ROOT/logs/map-pose-systemd.log

[Install]
WantedBy=multi-user.target
SERVICE

sudo systemctl daemon-reload
sudo systemctl enable robodoge-direct-bridge.service robodoge-audio-cue.service robodoge-yolo-vision.service robodoge-lidar-bridge.service robodoge-map-pose.service
sudo systemctl restart robodoge-audio-cue.service || true
sudo systemctl restart robodoge-yolo-vision.service || true
sudo systemctl restart robodoge-lidar-bridge.service || true
sudo systemctl restart robodoge-direct-bridge.service || true
sleep 4
sudo systemctl restart robodoge-map-pose.service || true

systemctl --no-pager --full status robodoge-direct-bridge.service robodoge-audio-cue.service robodoge-yolo-vision.service robodoge-lidar-bridge.service robodoge-map-pose.service || true
'@

$remoteScript = $remoteScript.
  Replace('__REMOTE_ROOT__', $RemoteRoot).
  Replace('__USER_NAME__', $User).
  Replace('__DIRECT_PORT__', [string]$DirectPort).
  Replace('__VISION_PORT__', [string]$VisionPort).
  Replace('__AUDIO_PORT__', [string]$AudioPort).
  Replace('__LIDAR_PORT__', [string]$LidarPort).
  Replace('__SERIAL_PORT__', $SerialPort).
  Replace('__ROS_DOMAIN_ID__', [string]$RosDomainId).
  Replace('__DOCKER_IMAGE__', $DockerImage).
  Replace('__APLAY_DEVICE__', $AplayDevice)

Write-Host "Installing and enabling Robo-Doge boot services on $Alias."
$remoteScript | & ssh -F $configPath $Alias "bash -s"
if ($LASTEXITCODE -ne 0) {
  throw "DOGZILLA boot service installation failed"
}
