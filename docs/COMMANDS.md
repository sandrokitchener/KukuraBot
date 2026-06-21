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
```

Map identity / stale waypoint check:

```powershell
Invoke-RestMethod -TimeoutSec 45 http://10.0.4.32:8893/healthz | Select-Object -ExpandProperty runtime | Select-Object -ExpandProperty map | ConvertTo-Json -Depth 8
Get-Content output/app-cache/dogzilla-map-origin.json
npm run dogzilla:validate-waypoints
```

Expected rule: active map fingerprint, saved origin fingerprint, and waypoint fingerprint must all exist and match before app-map waypoint dispatch is trusted.

Recurring lifecycle-dispatch failure check:

```powershell
npm run dogzilla:probe-nav
Invoke-RestMethod -TimeoutSec 45 http://10.0.4.32:8893/healthz | Select-Object -ExpandProperty runtime | Select-Object -ExpandProperty nav2 | ConvertTo-Json -Depth 8
ssh -F output/pi-ssh/config dogzilla "tail -n 20 /home/pi/robodoge/sidecars/dogzilla_lib_bridge/command_log.ndjson"
ssh -F output/pi-ssh/config dogzilla 'docker exec robodoge-lidar-bridge bash -lc "source /opt/ros/humble/setup.bash; export ROS_DOMAIN_ID=16; for n in controller_server planner_server bt_navigator behavior_server; do echo NODE:\$n; ros2 lifecycle get /\$n || true; done"'
```

Expected current direct-bridge Nav2 timing defaults:

```text
lifecycleWaitTimeoutSec: 12
dockerStatusTimeoutSec: 30
```

DOGZILLA support services:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-dogzilla-bridge-ssh.ps1 -Bridge direct -Live -Background
powershell -ExecutionPolicy Bypass -File scripts/start-dogzilla-yolo-vision-ssh.ps1 -Background
powershell -ExecutionPolicy Bypass -File scripts/start-dogzilla-audio-cue-ssh.ps1 -Background
npm run dogzilla:start-map-pose
npm run dogzilla:start-navigation
```

Health endpoints:

```powershell
Invoke-RestMethod -TimeoutSec 8 http://10.0.4.32:8893/healthz
Invoke-RestMethod -TimeoutSec 8 http://10.0.4.32:8894/healthz
Invoke-RestMethod -TimeoutSec 8 http://10.0.4.32:8896/healthz
```

SSH:

```powershell
ssh -F output/pi-ssh/config dogzilla <command>
scp -F output/pi-ssh/config <local> dogzilla:<remote>
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

Android-specific Tauri commands are in the Android section above.

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
