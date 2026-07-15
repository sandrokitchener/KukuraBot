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

## Operator-capability parity matrix

| Capability | Android surface | Runtime owner | Required proof |
| --- | --- | --- | --- |
| Connection, chat, settings, map, camera, audio, and robot status | Shared `public/` UI | Configured PC backend and Pi/Isaac target | `node --test test/android-web-parity.test.mjs`; device launch check |
| Manual control and emergency stop | Shared UI; Android touch controls | PC backend dispatches robot command | `test/frontend-modules.test.mjs`; physical neutral-stop check |
| Map workflow and waypoint navigation | Shared UI | PC backend, Pi bridge, Cartographer/Nav2 | parity test; live Pi readiness and motion evidence |
| Connection actions and diagnostics | Shared UI | PC backend and Pi services | parity test; manual backend/bridge probe |
| APK installation and shell launch | Tauri Android shell | Android device | `adb shell dumpsys package com.robodoge.console`; launch/crash check |
| Node, PowerShell, SSH, ROS2, DOGZILLA sidecars, phone-local model server | Unsupported phone-local runtime | PC/Pi only | Explicitly unsupported; no Android-local proof claimed |

## Backend URLs

On first Android launch, Connection setup opens until a backend is saved. Enter a LAN, Tailnet, or HTTPS hosted URL; the app checks `/api/config` before saving it in local storage.

```text
LAN:     http://<pc-lan-ip>:3037
Tailnet: http://<pc-tailnet-ip>:3037
Hosted:  https://<host>
```

PC runtime for phone:

```powershell
npm run dev:lan
```

Archived Android notes may mention `bun run dev:lan`; current `package.json` uses `npm run dev:lan` (`node --watch scripts/start-lan-server.mjs`).

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

Manual control safety is shared by Android and desktop: backgrounding or blurring the app, pointer cancellation, gamepad loss, command timeout, lease loss, request failure, and page unload disable control and issue one neutral command. Automated coverage lives in `test/frontend-modules.test.mjs`; physical stop behavior remains hardware verification.

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
