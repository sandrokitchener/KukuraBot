# Robot Test App

Tiny local test UI for a rename-friendly robot-control wrapper with switchable local or network-served model profiles.

## What it does

- Sends your typed message to whichever configured model profile is active.
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
- Receives real-robot `robot.state` WebSocket messages and renders a mini map when the ROS2 real target is active.
- Supports `ollama` profiles and `openai-compatible` profiles, which is useful for llama.cpp or other GGUF-serving endpoints.
- Runs modular speech-to-text with swappable providers, including browser Whisper, browser Moonshine, and Parakeet through a local sidecar.

## Why this structure

- `server.mjs` owns model calls and prompt composition.
- `public/` is just a tiny UI layer.
- Isaac-side translation is kept in separate config and sidecar scaffolding so robot/sim transport stays out of prompt logic.
- Later voice input/output can call the same `/api/chat` backend without changing the prompt plumbing.
- API and architecture details live in `docs/api-architecture.md`.

## Run on desktop

```bash
cd <project-folder>
npm start
```

That one command starts server and opens browser to local app automatically.
It also starts local Isaac Python sidecar, waits for sidecar health, and launches Isaac Sim through `scripts/launch-isaac-robot-controller.bat`.
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

## Run on Raspberry Pi 5

This app now uses only Node built-ins in runtime code, so it can run on a Pi with a normal Node install.

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

## Android side quest

The Android build is a Tauri shell around the existing `public/` console. It does not run Node, Isaac Sim, or local sidecars on the phone; point it at a Robo-Doge backend on your PC or LAN.

```bash
bun install
bun run dev:lan
bun run tauri:android:init
bun run tauri:android:build
```

Install the APK from `src-tauri/gen/android/app/build/outputs/apk/`, then open Settings and set Backend URL to `http://<pc-lan-ip>:3037`.
The Windows build script produces the current side-load APK at `src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk`.

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
- `config/isaacsim-command-map.json`
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

## Real Robot State Stream

The app accepts robot telemetry only when the active target is `ros2_real`.
Run real mode:

```powershell
$env:ROBOT_RUNTIME_TARGET="ros2_real"; npm run dev
```

Then stream fake robot state from another terminal:

```powershell
npm run fake:robot-state
```

The robot-side WebSocket URL is:

```text
ws://127.0.0.1:3037/api/robot/state/stream
```

The browser polls the latest state snapshot from `/api/robot/state` and draws the red dot from `pose.x`, `pose.y`, and `pose.theta`.

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
