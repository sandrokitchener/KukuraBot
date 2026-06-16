# Android App Notes

Read this for mobile UI, Android build/install, backend URL, and phone-control behavior.

## Current architecture

The Android app is a Tauri shell around the shared `public/` web console. The phone is normally a control surface for the PC backend.

```text
Android WebView / Tauri shell
-> public/ UI
-> Backend URL in localStorage
-> PC Robo-Doge backend on :3037
-> DOGZILLA / Isaac / sidecars from PC
```

Android does not run Node, PowerShell, SSH, ROS2, or DOGZILLA sidecars locally.

## Backend URLs

Set Backend URL in the app settings or Connection Center:

```text
LAN:     http://<pc-lan-ip>:3037
Tailnet: http://100.89.71.113:3037
```

PC runtime for phone:

```powershell
npm run dev:lan
```

The older doc mentions `bun run dev:lan`; current `package.json` script is `node --watch scripts/start-lan-server.mjs`.

## Build and install

Build:

```powershell
npm run tauri:android:build
```

APK path:

```text
src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk
```

Install example:

```powershell
adb install -r src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk
```

When install state matters, verify the connected device:

```powershell
adb devices -l
adb shell dumpsys package com.robodoge.console
```

## Key files

| File | Role |
| --- | --- |
| `src-tauri/tauri.conf.json` | Tauri product id, frontend dist, Android min SDK |
| `src-tauri/src/lib.rs` | Minimal Tauri builder |
| `scripts/build-android-apk.mjs` | Android build wrapper and Windows symlink fallback |
| `scripts/start-robo-doge-android-lan.bat` | Android/LAN helper launcher |
| `public/api-client.js` | Backend URL behavior shared by web and Android |
| `test/android-web-parity.test.mjs` | Web/Android UI parity checks |

## Phone-local model experiments

`docs/archive/android-sidequest.md` documents an experimental Android `llama.cpp` path. Current stable default remains PC backend model calls. Phone-local LLM status is Unknown / not confirmed unless tested on device in the active turn.

## Gotchas

- Build success does not prove phone install success.
- Windows without Developer Mode may block symlinks; `scripts/build-android-apk.mjs` handles the known fallback.
- WebView local requests to phone `127.0.0.1` may hit CORS/platform limits for experimental phone-local model servers.

## More detail

- `docs/COMMANDS.md`
- `docs/archive/android-sidequest.md`
- `docs/TAURI.md`
