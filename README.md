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
- Loads activation phrases from `config/activation_phrases.txt`.
- Shows both the raw model reply and parsed JSON when the reply is valid JSON.
- Supports `ollama` profiles and `openai-compatible` profiles, which is useful for llama.cpp or other GGUF-serving endpoints.
- Runs browser speech-to-text locally with swappable browser providers, including Whisper and Moonshine.

## Why this structure

- `server.mjs` owns model calls and prompt composition.
- `public/` is just a tiny UI layer.
- Later voice input/output can call the same `/api/chat` backend without changing the prompt plumbing.

## Run on desktop

```bash
cd <project-folder>
npm start
```

That one command starts server and opens browser to local app automatically.

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
- `config/activation_phrases.txt`
- `config/app.json`

If you rename assistant/app branding, edit `config/app.json`.
If you add or tune model backends, edit `config/model-profiles.json`.
If you want a different default selected profile, edit `config/runtime.json`.
If you want to swap speech input engines later, start with `config/speech-profiles.json`.
Whisper browser mode buffers local mic audio and transcribes it when you click `Send`.
Activation phrases for auto-send voice commands live in `config/activation_phrases.txt`.
