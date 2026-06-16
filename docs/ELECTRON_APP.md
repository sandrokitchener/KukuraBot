# Electron Desktop App Notes

Read this for the Windows desktop launcher and portable exe.

## Current architecture

Electron is a launcher shell, not a second app implementation. It can start the full Node service path or open an already-ready backend at:

```text
http://127.0.0.1:3037
```

`electron/main.cjs` starts `scripts/start-clean.mjs` with `ELECTRON_RUN_AS_NODE=1` and `ROBO_DOGE_ELECTRON_LAUNCHER=1`, then probes `/healthz` until ready.

## Key files

| File | Role |
| --- | --- |
| `electron/main.cjs` | Main process, service lifecycle, health probe, process-tree stop |
| `electron/preload.cjs` | IPC bridge |
| `electron/launcher.html` | Launcher UI |
| `electron/launcher.js` | Launcher UI behavior |
| `electron/launcher.css` | Launcher styling |
| `scripts/build-electron-desktop.mjs` | Packaging wrapper |
| `package.json` `build` | electron-builder config |
| `test/electron-launcher.test.mjs` | Launcher tests |

## Commands

See `docs/COMMANDS.md`.

Build output goes under `dist-electron/`. Portable artifact naming is configured as:

```text
Questing-Beast-Desktop-${version}-${arch}.exe
```

## Packaging details

Current `package.json` electron-builder settings:

- `appId`: `com.robodoge.questingbeast.desktop`
- `productName`: `Questing Beast Desktop`
- `asar`: `false`
- Windows target: portable x64
- Included files: `electron/`, `public/`, `config/`, `lib/`, `sidecars/`, `scripts/`, `run.mjs`, `server.mjs`, `cli.mjs`, `package.json`

`scripts/build-electron-desktop.mjs` copies top-level `@ricky0123/vad-web` into the nested Moonshine package path if needed before running `electron-builder`.

## Service root resolution

Launcher searches:

1. `ROBO_DOGE_ROOT`
2. current working directory
3. app path
4. packaged `resources/app`
5. executable directory

A valid root contains `package.json`, `scripts/start-clean.mjs`, `run.mjs`, and `server.mjs`.

## Unknown / not confirmed

- Current portable exe launch status was not verified while writing this doc.
- Whether packaged build contains fresh user-edited config depends on rebuild timing and runtime root selection.
