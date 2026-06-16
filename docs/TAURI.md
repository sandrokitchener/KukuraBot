# Tauri Notes

Read this for Tauri shell configuration and cross-platform packaging. For Android-specific workflow, read `docs/ANDROID_APP.md`.

## Current shape

Tauri wraps the shared `public/` frontend. The Rust app is minimal and delegates real behavior to the web UI plus configured backend.

## Key files

| File | Role |
| --- | --- |
| `src-tauri/tauri.conf.json` | Product, identifier, dev URL, frontend dist, bundle config |
| `src-tauri/Cargo.toml` | Tauri 2 dependencies and Rust crate settings |
| `src-tauri/src/lib.rs` | Minimal Tauri builder and debug log plugin |
| `src-tauri/src/main.rs` | Desktop main entrypoint |
| `src-tauri/capabilities/default.json` | Tauri permissions/capabilities |
| `scripts/build-android-apk.mjs` | Android build wrapper |

## Config facts

From `src-tauri/tauri.conf.json`:

- `productName`: `Questing Beast`
- `identifier`: `com.robodoge.console`
- `frontendDist`: `../public`
- `devUrl`: `http://127.0.0.1:3037`
- `beforeDevCommand`: `bun run dev:lan`
- Android `minSdkVersion`: `24`
- Android `versionCode`: `1`

From `src-tauri/Cargo.toml`:

- Rust edition: `2021`
- Rust version: `1.77.2`
- Tauri dependency: `2.10.3`
- Log plugin: `tauri-plugin-log`

## Commands

See `docs/COMMANDS.md`.

Note: `package.json` currently uses npm scripts, while `tauri.conf.json` still references `bun run dev:lan` for dev. If Tauri dev startup fails, verify Bun availability or align this command intentionally.

## Design rule

Do not add Node, SSH, ROS2, or DOGZILLA sidecar responsibilities inside Tauri unless the task explicitly changes architecture. Keep the backend on the desktop/PC path unless a mobile-local feature is specifically requested.

## Unknown / not confirmed

- Desktop Tauri packaging status.
- Current Android generated project health beyond source inspection.
- Whether `beforeDevCommand` should remain Bun-based or be changed to npm in a future cleanup.
