# Robo-Doge Command Index

Compact command reference for agents. Prefer this over copying command blocks into subsystem docs.

## App

```powershell
npm install
npm start
npm run dev:lan
Invoke-RestMethod http://127.0.0.1:3037/healthz
```

Default app URL:

```text
http://127.0.0.1:3037
```

## DOGZILLA / Navigation

```powershell
npm run dogzilla:probe-nav
npm run dogzilla:validate-waypoints
npm run dogzilla:start-navigation
npm run dogzilla:start-map-pose
npm run dogzilla:set-origin
npx zx scripts/probe-dogzilla-rosbridge.mjs
```

Direct Nav2 graph check on Pi:

```powershell
ssh -F output/pi-ssh/config dogzilla "docker exec robodoge-rosbridge bash -lc 'source /opt/ros/humble/setup.bash; export ROS_DOMAIN_ID=16; timeout 8 ros2 action list | grep navigate_to_pose; timeout 8 ros2 topic info /odom; timeout 8 ros2 topic info /scan_nav2'"
```

Direct bridge Nav2 truth:

```powershell
Invoke-RestMethod -TimeoutSec 15 http://10.0.4.32:8893/healthz |
  Select-Object -ExpandProperty runtime |
  Select-Object -ExpandProperty navigation |
  ConvertTo-Json -Depth 8
```

Waypoint / origin check:

```powershell
Get-Content output/app-cache/dogzilla-map-origin.json
npm run dogzilla:validate-waypoints
```

Navigation status from app state:

```powershell
Invoke-RestMethod -TimeoutSec 8 http://127.0.0.1:3037/api/robot/state |
  Select-Object -ExpandProperty navigationStatus |
  ConvertTo-Json -Depth 8
```

DOGZILLA support services:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/stop-dogzilla-vendor-app-ssh.ps1
powershell -ExecutionPolicy Bypass -File scripts/start-dogzilla-bridge-ssh.ps1 -Bridge direct -Live -Background
powershell -ExecutionPolicy Bypass -File scripts/start-dogzilla-rosbridge-ssh.ps1 -Background
powershell -ExecutionPolicy Bypass -File scripts/start-dogzilla-yolo-vision-ssh.ps1 -Background
powershell -ExecutionPolicy Bypass -File scripts/start-dogzilla-audio-cue-ssh.ps1 -Background
npm run dogzilla:start-map-pose
npm run dogzilla:start-navigation
```

`start-dogzilla-yolo-vision-ssh.ps1` serves the app camera stream in raw mode by default. Add `-DetectionEnabled` only when object detection is needed; it loads ONNX runtime and increases Pi CPU load.

Direct bridge logical navigation modes:

```powershell
# current mode
Invoke-RestMethod -Method GET -Uri http://10.0.4.32:8893/mode | ConvertTo-Json -Depth 4

# logical mode only; does not start/stop/reinstall Nav2 or Cartographer
Invoke-RestMethod -Method POST -Uri http://10.0.4.32:8893/mode -Body '{"mode":"navigate"}' -ContentType 'application/json'
```

Explicit SLAM mapping workflow:

```powershell
# New Map in the UI uses this action
powershell -ExecutionPolicy Bypass -File scripts/start-dogzilla-map-pose-ssh.ps1 -Mode mapping -AllowMapping

# Save Map in the UI uses this action, then restarts localization against the saved map
powershell -ExecutionPolicy Bypass -File scripts/save-dogzilla-map-pose-ssh.ps1
```

Build or rebuild pre-baked Cartographer/Nav2 Docker image on Pi:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-dogzilla-docker-image-ssh.ps1
```

Install or reinstall Pi systemd boot services:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-dogzilla-boot-services-ssh.ps1
```

Health endpoints:

```powershell
Invoke-RestMethod -TimeoutSec 8 http://10.0.4.32:8893/healthz
Invoke-RestMethod -TimeoutSec 8 http://10.0.4.32:8894/healthz
# rosbridge has no HTTP healthz; verify via scripts/probe-dogzilla-rosbridge.mjs
```

SSH:

```powershell
ssh -F output/pi-ssh/config dogzilla <command>
scp -F output/pi-ssh/config <local> dogzilla:<remote>
```

Manual Nav2 message fix:

```powershell
scp -F output/pi-ssh/config scripts/install-nav2-msgs-in-container.sh dogzilla:/home/pi/robodoge/
ssh -F output/pi-ssh/config dogzilla "docker exec robodoge-rosbridge sudo bash /home/pi/robodoge/install-nav2-msgs-in-container.sh"
ssh -F output/pi-ssh/config dogzilla "sudo systemctl restart robodoge-direct-bridge.service; sleep 5"
```

Deploy changed direct-bridge Nav2 client:

```powershell
scp -F output/pi-ssh/config sidecars/dogzilla_lib_bridge/nav2_client.py dogzilla:/home/pi/robodoge/sidecars/dogzilla_lib_bridge/nav2_client.py
ssh -F output/pi-ssh/config dogzilla "rm -f /home/pi/robodoge/sidecars/dogzilla_lib_bridge/__pycache__/nav2_client.cpython-311.pyc"
ssh -F output/pi-ssh/config dogzilla "sudo systemctl restart robodoge-direct-bridge.service; sleep 5"
node scripts/probe-dogzilla-nav-readiness.mjs
```

## Android

```powershell
npm run tauri:android:init
npm run tauri:android:build
npm run tauri:android:run
adb devices -l
adb install -r src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk
adb shell dumpsys package com.robodoge.console
```

## Electron

```powershell
npm run desktop
npm run desktop:build
```

Portable output lives under `dist-electron/`.

## Tauri

```powershell
npm run tauri
npm run tauri:dev
```

Android-specific Tauri commands are in the Android section.

## Verification

```powershell
rtk npm test
rtk git diff --check
```

Python sidecar tests exist under `test/test_*.py`; run them directly only when touching Python sidecar behavior.

## RTK Usage

Prefer RTK wrappers for command output compression:

```powershell
rtk git status --short
rtk git diff --check
rtk npm test
rtk read AGENTS.md
rtk grep "pattern" docs
```

Use raw shell only when RTK has no matching wrapper, exact output matters, or RTK is unavailable.
