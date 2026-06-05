# Robot Test App

Tiny local test UI for a rename-friendly robot-control wrapper with switchable local or network-served model profiles.

## What it does

- Sends your typed message to whichever configured model profile is active.
- Presents a warm, mobile-friendly robot console UI with off-white surfaces, charcoal framing, coral action states, compact segmented tabs, and simplified rail marks.
- Loads the assistant system prompt from `config/system-prompt.txt`.
- Loads the command JSON format spec from `config/command-response-format.json`.
- Loads extra command-category guidance from `config/command-types.txt`.
- Loads valid waypoint guidance from `config/valid-waypoints.txt`.
- Loads model profiles from `config/model-profiles.json`.
- Loads active profile selection from `config/runtime.json`.
- Loads speech-input profiles from `config/speech-profiles.json`.
- Loads active speech-input selection from `config/speech-runtime.json`.
- Loads Parakeet sidecar transport config from `config/speech-sidecar.json`.
- Loads activation phrases from `config/activation_phrases.txt`.
- Shows both the raw model reply and parsed JSON when the reply is valid JSON.
- Compiles parsed JSON into an Isaac Sim sidecar preview envelope using editable mapping config.
- Receives real-robot state from DOGZILLA Direct Bridge or ROS2 bridge and renders a grid-only mini map.
- Shows verified SLAM `map`-frame waypoints from `config/robot-waypoints.json` on the visual map.
- Plays robot cue sounds on the DOGZILLA Pi speaker when Pi audio is enabled, with app-side volume control.
- Supports Android as a Tauri shell that talks to the desktop backend over LAN or tailnet.
- Supports `ollama` profiles and `openai-compatible` profiles, which is useful for llama.cpp or other GGUF-serving endpoints.
- Runs modular speech-to-text with swappable providers, including browser Whisper, browser Moonshine, and Parakeet through a local sidecar.

## Why this structure

- `server.mjs` owns model calls and prompt composition.
- `public/` is just a tiny UI layer.
- Isaac-side translation is kept in separate config and sidecar scaffolding so robot/sim transport stays out of prompt logic.
- Later voice input/output can call the same `/api/chat` backend without changing the prompt plumbing.
- API and architecture details live in `docs/api-architecture.md`.

## Streamlined Setup

Use this path when the repo is already cloned and you mainly want the app running.

1. Install desktop prerequisites:

   ```text
   Node.js 20+
   npm
   PowerShell 7+
   adb, only if installing Android builds
   ```

2. Install JavaScript packages:

   ```bash
   npm install
   ```

3. Start the desktop backend:

   ```bash
   npm start
   ```

4. Open the app:

   ```text
   http://127.0.0.1:3037
   ```

5. For Android, set Backend URL to one of:

   ```text
   http://<pc-lan-ip>:3037
   http://100.89.71.113:3037
   ```

6. When the dog is online, install or refresh robot-side boot services:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\install-dogzilla-boot-services-ssh.ps1 -Host 10.0.4.32
   ```

Skip step 6 while DOGZILLA is offline or low battery. Local app, tests, Android builds, and UI work do not need Pi SSH.

## Full Setup Guide

### 1. Desktop Backend

Install Node.js, then install packages:

```bash
npm install
```

Start the backend:

```bash
npm start
```

`npm start` does a clean local runtime reset, starts the backend on port `3037`, and opens the browser.
The backend binds to `0.0.0.0`, so LAN and tailnet clients can reach it.

Useful checks:

```powershell
Invoke-RestMethod http://127.0.0.1:3037/healthz
Test-NetConnection -ComputerName 100.89.71.113 -Port 3037
```

### 2. DOGZILLA Robot-Side Services

Only do this when the dog is powered, charged enough, and reachable on the network.

Current default DOGZILLA LAN address:

```text
10.0.4.32
```

Install SSH access and boot services from Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-dogzilla-boot-services-ssh.ps1 -Host 10.0.4.32
```

This syncs sidecars to `/home/pi/robodoge` and enables:

```text
robodoge-direct-bridge.service
robodoge-audio-cue.service
robodoge-yolo-vision.service
robodoge-lidar-bridge.service
robodoge-map-pose.service
```

After this, restarting the dog should restart Pi-side robot services automatically.
You should not need to rerun full `npm start` just because the dog rebooted, as long as the desktop backend was already running.

### 3. Android Phone

Build the Android shell:

```bash
npm run tauri:android:build
```

Install on the connected phone:

```bash
adb install -r src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk
```

In the Android app, set Backend URL to the PC backend:

```text
LAN:     http://<pc-lan-ip>:3037
Tailnet: http://100.89.71.113:3037
```

Android does not run Node, ROS, SSH, or DOGZILLA sidecars.
It is a control surface for the desktop backend.

### 4. Model and Speech Profiles

The app can use local Ollama/OpenAI-compatible model profiles from `config/model-profiles.json`.
The active model profile is saved in `config/runtime.json`.

Speech profiles live in:

```text
config/speech-profiles.json
config/speech-runtime.json
config/speech-sidecar.json
```

Browser Whisper/Moonshine run in the browser.
Parakeet uses the local speech sidecar.

### 5. Map, Waypoints, and SLAM

SLAM means Simultaneous Localization and Mapping.
DOGZILLA map pose comes from the LiDAR bridge `/pose` endpoint when it reports `frame: "map"` and `waypointSafe: true`.

Real home waypoints live in:

```text
config/robot-waypoints.json
```

Only verified `frame: "map"` waypoints are drawn on the mini map.
Do not treat dummy `0,0` placeholders as real navigation targets.

### 6. Gamepad

Manual Control uses the browser Gamepad API.
Connect the Xbox controller, press a button, then enable gamepad control in the app.

Current mapping:

```text
left stick Y -> forward/back
left stick X -> strafe
right stick X -> turn
```

Test live movement only when DOGZILLA is charged, online, and in a safe open area.

### 7. Verification Commands

Use these before trusting a change:

```bash
node --check public/app.js
node --check server.mjs
node --test test/android-web-parity.test.mjs test/app-service.test.mjs test/robot-command-compiler.test.mjs test/robot-sidecar-client.test.mjs
python -m unittest test.test_dogzilla_lib_bridge test.test_dogzilla_audio_cue
```

Build Android when mobile UI changed:

```bash
npm run tauri:android:build
```

## Run on desktop

```bash
cd <project-folder>
npm start
```

That one command starts server and opens browser to local app automatically.
It also performs a clean local runtime reset before startup so stale desktop-side processes do not mask current code.
When Isaac is the selected target, it starts local Isaac Python sidecar, waits for sidecar health, and launches Isaac Sim through `scripts/launch-isaac-robot-controller.bat`.
Default app-managed Isaac launch opens `isaacsim/sim_environment.usd`, enables the PhysX sensor extension, and passes `--/app/window/width=640` plus `--/app/window/height=640`.
The Isaac startup script hides editor panels after the stage opens, leaving a compact viewport-focused window.

Windows launch shortcuts:

```text
scripts\start-robo-doge-isaacsim.bat
scripts\start-robo-doge-real.bat
```

The Isaac script forces the `isaacsim` runtime target.
The real script forces the `ros2_real` runtime target and opens a second terminal running the fake `robot.state` WebSocket sender so the mini map moves immediately.
It defaults real commands to dry-run. Speech profile stays controlled by the app settings/runtime config unless you explicitly set `APP_SPEECH_PROFILE`.

To force a profile just for this run:

```bash
npm start -- --profile home_llama_gguf
```

If you want direct raw server process instead:

```bash
node server.mjs
```

Then open:

```text
http://127.0.0.1:3037
```

## DOGZILLA Direct Bridge

The current real-robot target is DOGZILLA Direct Bridge on the robot Pi, plus support sidecars for audio, YOLO vision, LiDAR, and map pose.

Default Pi addresses live in `config/dogzilla-connection.json`.
The current LAN host is `10.0.4.32`.
The desktop backend binds to `0.0.0.0` so Android can reach it over LAN or Tailscale.

Important ports:

```text
3037 desktop Robo-Doge backend
8893 DOGZILLA Direct Bridge
8894 DOGZILLA YOLO vision
8895 DOGZILLA Pi audio cues
8896 DOGZILLA LiDAR + map pose
```

Install or refresh Pi boot services from the desktop when the dog is online:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-dogzilla-boot-services-ssh.ps1 -Host 10.0.4.32
```

That syncs sidecars and enables these systemd units on the Pi:

```text
robodoge-direct-bridge.service
robodoge-audio-cue.service
robodoge-yolo-vision.service
robodoge-lidar-bridge.service
robodoge-map-pose.service
```

After install, a dog/Pi reboot should bring those robot-side services back without re-running full `npm start` on the PC.
The PC backend still must be running for the browser/Android app to work.

Do not run Pi SSH actions while the dog is low battery or offline.
The app can still be developed, built, and installed locally while the dog charges.

## Run Backend on Raspberry Pi 5

This app uses only Node built-ins in runtime code, so the backend itself can run on a Pi with a normal Node install.
This is separate from the DOGZILLA robot-side boot services above.

```bash
cd <project-folder>
npm run start:pi
```

Then open it from another machine on your LAN:

```text
http://<raspberry-pi-ip>:3037
```

If you want a quick terminal-only test on the Pi:

```bash
node cli.mjs "check the kitchen"
```

## Why this is Pi-friendly now

- The Ollama/prompt/schema logic lives in `lib/app-service.mjs`.
- Model profile resolution lives in `lib/model-profile-config.mjs`.
- Provider-specific request code lives in `lib/model-client.mjs`.
- The browser UI is just one client of that service.
- A future voice process on the Pi can call the same service functions or the same `/api/chat` route.
- No Bun-specific runtime features are required anymore.

## Android App

The Android build is a Tauri shell around the existing `public/` console. It does not run Node, Isaac Sim, or local sidecars on the phone; point it at a Robo-Doge backend on your PC or LAN.

```bash
bun install
bun run dev:lan
bun run tauri:android:init
bun run tauri:android:build
```

The package script uses the same build path:

```bash
npm run tauri:android:build
```

Install the APK from `src-tauri/gen/android/app/build/outputs/apk/`, then open Settings and set Backend URL to `http://<pc-lan-ip>:3037`.
The Windows build script produces the current side-load APK at `src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk`.
To install the latest arm64 debug APK onto the currently attached Android device:

```bash
adb install -r src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk
```

If the phone and PC are on Tailscale, use the PC tailnet backend URL:

```text
http://100.89.71.113:3037
```

Android suppresses local bark/thinking audio. Robot cues are sent to the DOGZILLA Pi audio sidecar instead, matching desktop behavior.

Mobile architecture and ASR/LLM tradeoffs live in `docs/android-sidequest.md`.

## Editable files

- `config/system-prompt.txt`
- `config/command-response-format.json`
- `config/command-types.txt`
- `config/valid-waypoints.txt`
- `config/model-profiles.json`
- `config/runtime.json`
- `config/speech-profiles.json`
- `config/speech-runtime.json`
- `config/speech-sidecar.json`
- `config/activation_phrases.txt`
- `config/app.json`
- `config/robot-runtime.json`
- `config/robot-ros2.json`
- `config/dogzilla-connection.json`
- `config/robot-actions.json`
- `config/robot-waypoints.json`
- `config/robot-motion.json`
- `config/isaacsim-command-map.json`
- `config/isaacsim-waypoints.json`
- `config/isaacsim-sidecar.json`
- `config/isaacsim-cad-split-plan.json`

If you rename assistant/app branding, edit `config/app.json`.
If you add or tune model backends, edit `config/model-profiles.json`.
If you want a different default selected profile, edit `config/runtime.json`.
If you want to swap speech input engines later, start with `config/speech-profiles.json`.
Runtime speech profile selection now saves to `config/speech-runtime.json` from app UI, so you can flip between `Whisper Original (Browser)` and `Parakeet Test (Sidecar)` inside app.
Parakeet sidecar transport and launch options live in `config/speech-sidecar.json`.
When the active speech profile is Parakeet, `npm start` can launch `sidecars/parakeet_onnx_bridge/server.py` with normal Windows Python using the ONNX model from `https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx`.
Parakeet defaults to `http://127.0.0.1:8893` so it does not collide with the real-robot ROS2 bridge on `8892`.
Install ONNX ASR first with `pip install "onnx-asr[cpu,hub]"`, then set `launch.pythonPath` if the dependency lives in a virtualenv.
The legacy NeMo/WSL bridge remains at `sidecars/parakeet_bridge/server.py` if we need it later.
Whisper browser mode buffers local mic audio and transcribes it when you click `Send`.
Parakeet mode uses same buffered recorder flow, but sends captured audio to `sidecars/parakeet_onnx_bridge/server.py`.
Activation phrases for auto-send voice commands live in `config/activation_phrases.txt`.
Isaac Sim translation rules live in `config/isaacsim-command-map.json`.
Isaac sidecar transport settings live in `config/isaacsim-sidecar.json`.
DOGZILLA connection settings live in `config/dogzilla-connection.json`.
Real DOGZILLA action IDs live in `config/robot-actions.json`.
Real DOGZILLA waypoints live in `config/robot-waypoints.json`.
Only verified `frame: "map"` waypoints are drawn on the mini map.

## DOGZILLA Audio Cues

When `config/dogzilla-connection.json -> audio.enabled` is true, bark/confirm/thinking cues play on the dog through `sidecars/dogzilla_audio_cue/server.py`.
The Connection Center has a `Dog sound volume` slider.
The app stores that volume locally and sends it with every `/api/dogzilla/audio/cue` request.

The Pi sidecar scales WAV samples before calling `aplay`, so the robot speaker volume changes without changing Android or desktop speaker volume.
Avoid 100% for routine use; Yahboom voice-module notes warn against max volume.

## DOGZILLA Map and Waypoints

SLAM means Simultaneous Localization and Mapping.
Robo-Doge uses the DOGZILLA LiDAR bridge map pose when `/pose` reports `frame: "map"` and `waypointSafe: true`.

The mini map is intentionally grid-only:

- no fake floorplan image
- robot pose dot from live map pose
- pose trail from recent `map` samples
- verified map waypoints from `config/robot-waypoints.json`

Dummy placeholder waypoints at `0,0` are not drawn.
Capture or edit real waypoints only after the SLAM map origin is stable.

## Gamepad Manual Control

The Manual Control panel uses the browser Gamepad API.
An Xbox controller should appear after a button press and can drive DOGZILLA Direct Bridge or ROS2 real targets through `/api/robot/manual-control`.

Current mapping:

```text
left stick Y -> forward/back
left stick X -> strafe
right stick X -> turn
```

The compiler maps gamepad axes to `locomotion.relative` using `config/robot-motion.json`.
Neutral and deadband behavior are covered by tests.
Live movement still needs a charged, online dog for final evaluation.

## Real Robot State Stream

The app accepts robot telemetry for DOGZILLA Direct Bridge and ROS2 real targets.
Run real mode:

```powershell
$env:ROBOT_RUNTIME_TARGET="ros2_real"; bun run dev:lan
```

Then stream fake robot state from another terminal:

```powershell
$env:ROBOT_STATE_WS_URL="ws://127.0.0.1:3037/api/robot/state/stream"
npm run fake:robot-state
```

The robot-side WebSocket URL is:

```text
ws://127.0.0.1:3037/api/robot/state/stream
```

The browser polls the latest state snapshot from `/api/robot/state` and draws the robot dot from `pose.x`, `pose.y`, and `pose.theta`.
For DOGZILLA, permanent map waypoints should use `frame: "map"` only.

## Isaac Sim Scaffold

This repo now includes a thin Isaac Sim scaffold:

- `/api/chat` returns an `isaacSim` preview object alongside parsed command JSON
- `/api/chat` also auto-dispatches ready Isaac commands when `config/isaacsim-sidecar.json` has `dispatchOnChat` enabled
- `GET /api/isaac/health` probes the local Python sidecar config
- `POST /api/isaac/dispatch` sends a compiled envelope to the sidecar when enabled
- `sidecars/isaac_bridge/server.py` is an HTTP-to-command-log relay for the Isaac runtime

Current desktop default:

- sidecar transport enabled
- dispatch on chat enabled
- app-managed launch enabled for sidecar + Isaac Sim

If you want preview-only mode again, edit `config/isaacsim-sidecar.json` and toggle:

- `transport.enabled`
- `transport.dryRun`
- `transport.dispatchOnChat`
- `launch.managedByApp`
- `launch.isaacSimLaunchEnabled`
