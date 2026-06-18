# Robo-Doge

Local control console for Questing Beast / DOGZILLA. The desktop backend owns model calls, robot-side sidecars, telemetry, audio cues, camera proxying, map pose, and Android connectivity. The Android app is a Tauri shell that talks to the desktop backend over LAN or Tailscale.

## What It Does

- Sends chat commands through configurable local or OpenAI-compatible model profiles.
- Dispatches real DOGZILLA actions through DOGZILLA Direct Bridge.
- Shows live robot state, LiDAR scan, grid-only map pose, and verified `app_map` waypoints.
- Plays bark/thinking/confirm sounds on the DOGZILLA Pi speaker, including app-side volume control.
- Supports Android as a mobile control surface for the same backend.
- Keeps Isaac Sim support available as a separate runtime target.

## Streamlined Setup

Use this when the repo is already cloned and you mainly want the app running.

```bash
npm install
npm start
```

Open:

```text
http://127.0.0.1:3037
```

Android backend URL:

```text
LAN:     http://<pc-lan-ip>:3037
Tailnet: http://100.89.71.113:3037
```

When DOGZILLA is online, install or refresh robot-side boot services:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-dogzilla-boot-services-ssh.ps1 -Host 10.0.4.32
```

Skip Pi SSH steps while the dog is offline or low battery. Local app, tests, Android builds, and UI work do not need the dog online.

## Full Setup

The compact command index is in [docs/COMMANDS.md](docs/COMMANDS.md). Archived detailed setup notes live in [docs/archive/setup-guide.md](docs/archive/setup-guide.md). They cover:

- desktop backend setup
- DOGZILLA robot-side boot services
- Android build/install
- model and speech profiles
- SLAM map pose and waypoints
- Xbox/gamepad manual control
- verification commands

## Common Commands

```bash
npm start
npm test
npm run tauri:android:build
npm run desktop
npm run desktop:build
```

`npm run desktop` opens the Electron desktop launcher. The launcher can attach to an already-running backend or start the full `npm start` style service path from `scripts/start-clean.mjs`. `npm run desktop:build` creates the portable Windows executable under `dist-electron/`.

```powershell
Invoke-RestMethod http://127.0.0.1:3037/healthz
Test-NetConnection -ComputerName 100.89.71.113 -Port 3037
```

## Key Files

- `server.mjs` - desktop backend entrypoint
- `public/` - browser and Android web UI
- `config/dogzilla-connection.json` - DOGZILLA connection settings
- `config/robot-runtime.json` - active runtime target
- `config/robot-waypoints.json` - verified real-world waypoints
- `sidecars/dogzilla_*` - robot support sidecars
- `docs/COMMANDS.md` - compact command index
- `docs/archive/setup-guide.md` - archived full setup and operation guide

## More Docs

Context docs are the compact agent-facing docs. When asked to update context docs, update the relevant file from this set:

- [AGENTS.md](AGENTS.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md)
- [docs/ISAAC_SIM.md](docs/ISAAC_SIM.md)
- [docs/ANDROID_APP.md](docs/ANDROID_APP.md)
- [docs/ELECTRON_APP.md](docs/ELECTRON_APP.md)
- [docs/TAURI.md](docs/TAURI.md)
- [docs/NAVIGATION.md](docs/NAVIGATION.md)
- [docs/COMMANDS.md](docs/COMMANDS.md)
