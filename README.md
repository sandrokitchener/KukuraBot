# Robo-Doge Command App + Isaac Layer

This branch documents and ships the command app, speech input, and Isaac Sim path.

It does **not** include the ROS2 implementation layer. That work stays separate.

## What This Branch Does

- Runs a local browser app for natural-language robot commands.
- Sends prompts to the active model profile.
- Parses command JSON from model output.
- Compiles parsed commands into Isaac Sim preview envelopes.
- Optionally auto-dispatches those envelopes to the Isaac sidecar.
- Supports browser speech input plus local Parakeet sidecar speech input.

## Repo Layout

- `server.mjs`
  HTTP server and API routes.
- `run.mjs`
  Desktop launcher. Starts speech and Isaac sidecars, then opens the app.
- `public/`
  Small browser UI.
- `lib/app-service.mjs`
  Prompt composition and command-processing path.
- `lib/isaacsim-*.mjs`
  Isaac config, compile, client, and launch helpers.
- `lib/speech-*.mjs`
  Speech profile, sidecar, and launch helpers.
- `sidecars/isaac_bridge/`
  Isaac HTTP relay.
- `sidecars/parakeet_bridge/`
  Speech-to-text HTTP relay.
- `isaacsim/runtime/`
  Isaac controller and startup scripts.

## Prerequisites

## Node

- Node.js 20+ recommended
- `npm install`

## Model backend

Configure at least one model profile in:

- `config/model-profiles.json`

Examples already supported:

- `ollama`
- `openai-compatible`

Active profile selection lives in:

- `config/runtime.json`

## Isaac Sim

You need a working Isaac Sim install reachable by:

- `scripts/launch-isaac-robot-controller.bat`

This branch assumes Isaac launch is controlled through:

- `config/isaacsim-sidecar.json`
- `scripts/launch-isaac-robot-controller.bat`

If your Isaac path or launch args differ, change those files instead of patching app code.

## Speech

Speech profiles live in:

- `config/speech-profiles.json`

Speech runtime selection lives in:

- `config/speech-runtime.json`

Parakeet sidecar transport lives in:

- `config/speech-sidecar.json`

Activation phrases live in:

- `config/activation_phrases.txt`

## First-Time Setup

1. Install dependencies:

```bash
npm install
```

2. Check model profiles:

- `config/model-profiles.json`
- `config/runtime.json`

3. Check speech profiles:

- `config/speech-profiles.json`
- `config/speech-runtime.json`
- `config/speech-sidecar.json`

4. Check Isaac config:

- `config/isaacsim-command-map.json`
- `config/isaacsim-sidecar.json`
- `config/isaacsim-waypoints.json`
- `config/robot-controller.json`

5. If needed, edit the launcher:

- `scripts/launch-isaac-robot-controller.bat`

## Run

## Desktop app

```bash
npm start
```

This does:

1. starts speech sidecar when configured
2. starts Isaac sidecar when configured
3. waits for sidecar health
4. launches Isaac Sim through the checked-in batch script
5. starts browser app

Default app URL:

```text
http://127.0.0.1:3037
```

## Force one model profile for a run

```bash
npm start -- --profile home_llama_gguf
```

## Raw server only

```bash
node server.mjs
```

## Pi or LAN-hosted app

```bash
npm run start:pi
```

Then open:

```text
http://<raspberry-pi-ip>:3037
```

## CLI smoke test

```bash
node cli.mjs "go to the living room"
```

## App Behavior

Current flow:

1. user enters text or speech
2. backend composes system prompt from config
3. active model returns text
4. app tries to parse JSON
5. Isaac compiler builds preview envelope
6. if Isaac dispatch is enabled, app posts preview to Isaac sidecar

Useful API routes:

- `GET /api/config`
- `POST /api/chat`
- `POST /api/settings/profile`
- `POST /api/settings/speech-profile`
- `GET /api/isaac/health`
- `GET /api/speech/health`
- `POST /api/isaac/dispatch`
- `POST /api/speech/transcribe`

## Important Config Files

## Prompt and command contract

- `config/system-prompt.txt`
- `config/command-response-format.json`
- `config/command-types.txt`
- `config/valid-waypoints.txt`

## Model selection

- `config/model-profiles.json`
- `config/runtime.json`

## Speech

- `config/speech-profiles.json`
- `config/speech-runtime.json`
- `config/speech-sidecar.json`
- `config/activation_phrases.txt`

## Isaac

- `config/isaacsim-command-map.json`
- `config/isaacsim-sidecar.json`
- `config/isaacsim-cad-split-plan.json`
- `config/isaacsim-waypoints.json`
- `config/robot-controller.json`
- `config/isaacsim-proxy-rig.json`
- `config/dogzilla-proxy-walk-cycle.json`

## How To Tweak Behavior

## Change assistant/app naming

Edit:

- `config/app.json`

## Change command schema or guidance

Edit:

- `config/command-response-format.json`
- `config/command-types.txt`
- `config/valid-waypoints.txt`
- `config/system-prompt.txt`

## Change speech engine

Edit:

- `config/speech-profiles.json`
- `config/speech-runtime.json`

Or switch inside app UI.

## Change Isaac dispatch behavior

Edit:

- `config/isaacsim-sidecar.json`

Main toggles:

- `transport.enabled`
- `transport.dryRun`
- `transport.dispatchOnChat`
- `launch.managedByApp`
- `launch.isaacSimLaunchEnabled`

## Change waypoint mapping

Edit:

- `config/isaacsim-waypoints.json`

Keep waypoint names aligned with:

- `config/valid-waypoints.txt`

## Testing

Run Node tests:

```bash
node --test
```

Run Python syntax smoke checks for Isaac runtime files:

```bash
python -m py_compile isaacsim/runtime/open_sim_environment.py isaacsim/runtime/proxy_rig_motion.py isaacsim/runtime/robot_controller.py isaacsim/runtime/robot_controller_startup.py
```

## Branch Boundary

This branch intentionally includes:

- command app changes
- speech sidecar path
- Isaac controller/runtime path

This branch intentionally excludes:

- ROS2 bridge/runtime implementation
- ROS2 setup docs
- ROS2 launch helpers

That split keeps GitHub review focused on the command and Isaac layers only.
