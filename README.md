# Robot Test App

Tiny local test UI for a rename-friendly robot-control wrapper on top of Ollama.

## What it does

- Sends your typed message to a local Ollama model.
- Loads the assistant system prompt from `config/system-prompt.txt`.
- Loads the command JSON format spec from `config/command-response-format.json`.
- Shows both the raw model reply and parsed JSON when the reply is valid JSON.
- Keeps Ollama reasoning traces disabled by default so short chat replies do not vanish into `thinking`.

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
- The browser UI is just one client of that service.
- A future voice process on the Pi can call the same service functions or the same `/api/chat` route.
- No Bun-specific runtime features are required anymore.

## Editable files

- `config/system-prompt.txt`
- `config/command-response-format.json`
- `config/model.json`
- `config/app.json`

If you rename assistant/app branding, edit `config/app.json`.
If your local Ollama model tag changes, edit `config/model.json`.
