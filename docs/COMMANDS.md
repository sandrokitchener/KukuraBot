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
npm test
git diff --check
```

Python sidecar tests exist under `test/test_*.py`; run them directly only when touching Python sidecar behavior.
