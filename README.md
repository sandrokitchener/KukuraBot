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
- Supports `ollama` profiles and `openai-compatible` profiles, which is useful for llama.cpp or other GGUF-serving endpoints.
- Runs modular speech-to-text with swappable providers, including browser Whisper, browser Moonshine, and Parakeet through a local sidecar.

## Why this structure

- `server.mjs` owns model calls and prompt composition.
- `public/` is just a tiny UI layer.
- Isaac-side translation is kept in separate config and sidecar scaffolding so robot/sim transport stays out of prompt logic.
- Later voice input/output can call the same `/api/chat` backend without changing the prompt plumbing.

## Run on desktop

```bash
cd <project-folder>
npm start
```

That one command starts server and opens browser to local app automatically.
It also starts local Isaac Python sidecar, waits for sidecar health, and launches Isaac Sim through `scripts/launch-isaac-robot-controller.bat`.
Default app-managed Isaac launch opens `isaacsim/sim_environment.usd`, enables the PhysX sensor extension, and passes `--/app/window/width=640` plus `--/app/window/height=640`.
The Isaac startup script hides editor panels after the stage opens, leaving a compact viewport-focused window.

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
- `config/isaacsim-command-map.json`
- `config/isaacsim-sidecar.json`
- `config/isaacsim-cad-split-plan.json`

If you rename assistant/app branding, edit `config/app.json`.
If you add or tune model backends, edit `config/model-profiles.json`.
If you want a different default selected profile, edit `config/runtime.json`.
If you want to swap speech input engines later, start with `config/speech-profiles.json`.
Runtime speech profile selection now saves to `config/speech-runtime.json` from app UI, so you can flip between `Whisper Original (Browser)` and `Parakeet Test (Sidecar)` inside app.
Parakeet sidecar transport and launch options live in `config/speech-sidecar.json`.
When the active speech profile is Parakeet, `npm start` can launch `sidecars/parakeet_bridge/server.py` through WSL using the `launch.runtime: "wsl"` settings in `config/speech-sidecar.json`.
Install NeMo ASR/PyTorch inside WSL first, then set `launch.wslDistribution` or `launch.pythonPath` if your distro or virtualenv needs a specific command.
Whisper browser mode buffers local mic audio and transcribes it when you click `Send`.
Parakeet mode uses same buffered recorder flow, but sends captured audio to `sidecars/parakeet_bridge/server.py`.
Activation phrases for auto-send voice commands live in `config/activation_phrases.txt`.
Isaac Sim translation rules live in `config/isaacsim-command-map.json`.
Isaac sidecar transport settings live in `config/isaacsim-sidecar.json`.

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
