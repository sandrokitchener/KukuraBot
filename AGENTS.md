<!-- AUTONOMY DIRECTIVE - DO NOT REMOVE -->
YOU ARE AN AUTONOMOUS CODING AGENT. EXECUTE TASKS TO COMPLETION WITHOUT ASKING FOR PERMISSION.
DO NOT STOP TO ASK "SHOULD I PROCEED?" - PROCEED. DO NOT WAIT FOR CONFIRMATION ON OBVIOUS NEXT STEPS.
IF BLOCKED, TRY AN ALTERNATIVE APPROACH. ONLY ASK WHEN TRULY AMBIGUOUS OR DESTRUCTIVE.
<!-- END AUTONOMY DIRECTIVE -->

# Agent Context Rule

This repo uses targeted context docs to reduce token usage.

Before reading broad project files, decide which subsystem the task belongs to and read only the relevant doc(s). Do not load every documentation file by default.

When the user asks to "update context docs", they mean this context-doc set:

- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/KNOWN_ISSUES.md`
- `docs/ISAAC_SIM.md`
- `docs/ANDROID_APP.md`
- `docs/ELECTRON_APP.md`
- `docs/TAURI.md`
- `docs/NAVIGATION.md`
- `docs/COMMANDS.md`

Do not treat `docs/archive/`, generated folders, or manufacturer PDFs as context docs unless the user names them directly.

For most tasks:
1. Read `AGENTS.md`.
2. Read only the one most relevant `docs/*.md` file.
3. Inspect specific source files named by that doc.
4. Update the relevant doc only if the change creates durable project knowledge.

# Robo-Doge Agent Routing Index

Robo-Doge is a local desktop/mobile control console for Questing Beast / Yahboom DOGZILLA. The Node backend serves the web UI, manages robot sidecars, proxies camera/LiDAR/audio state, dispatches commands to real DOGZILLA or Isaac Sim targets, and packages the same `public/` UI into Electron and Tauri/Android shells.

Use this file as the router. Do not load every doc by default.

## Which doc should I read?

| Task shape | Read first |
| --- | --- |
| Architecture, runtime flow, API boundaries, config ownership | `docs/ARCHITECTURE.md` |
| Known bugs, broken setup, repeated failures, gotchas | `docs/KNOWN_ISSUES.md` |
| Isaac Sim, Isaac Lab, simulation, USD/CAD/robot model | `docs/ISAAC_SIM.md` |
| Android app, mobile UI, APK build/install, phone robot control | `docs/ANDROID_APP.md` |
| Electron desktop launcher or Windows portable exe | `docs/ELECTRON_APP.md` |
| Tauri shell/runtime/build configuration | `docs/TAURI.md` |
| SLAM, Nav2, waypoints, saved map origin, pose, robot movement, routing | `docs/NAVIGATION.md` |
| Cross-cutting design question | `docs/ARCHITECTURE.md`, then the specific subsystem doc |

## Do Not Read By Default

Open these only when a compact doc explicitly routes you there or the task directly requires them:

- `docs/archive/` - long historical/detail docs.
- `docs/DOGZILLA-main/` - manufacturer PDFs; required for DOGZILLA navigation/LiDAR behavior, otherwise heavy.
- `dist-electron/`, `src-tauri/gen/`, `src-tauri/target/`, `node_modules/`, `output/` - generated or runtime artifacts.
- `.playwright-mcp/`, loose snapshots, screenshots, and temporary inspection artifacts.

## Context discipline

- Before editing, identify the likely subsystem.
- Read only the relevant docs first, not every doc.
- Open the smallest relevant set of source files after the doc points you there.
- Summarize findings before broad or cross-subsystem changes.
- Prefer compact summaries over long pasted command outputs.
- Do not add transient debugging noise to docs unless it becomes a repeated known issue.
- After meaningful changes, update the relevant `.md` file briefly and factually.
- If status is live-environment dependent and you did not verify it this turn, write `Unknown / not confirmed`.

## Standing project rules

- For DOGZILLA robot behavior, navigation, LiDAR, mapping, patrol, obstacle avoidance, and waypoint work, check `docs/DOGZILLA-main` and the relevant Yahboom PDFs before inventing a new approach.
- For LiDAR/navigation, stay on the DOGZILLA HAT UART path `/dev/ttyAMA1` unless the user explicitly changes hardware.
- Treat `config/robot-waypoints.json` as authoritative for waypoint coordinates and trust fields. Do not rewrite, downgrade, disable, or "correct" trusted entries without explicit user instruction.
- Diagnostics may warn about map identity, fingerprints, bounds, notes, or drift, but those diagnostics must stay separate from waypoint config authority.
- For app/operator UI work, prefer existing panels and services before adding new surfaces.
- Use repo-local evidence before generic ROS, GitHub, or web explanations.

## Fast commands

Read `docs/COMMANDS.md` for the command index.

Default app URL:

```text
http://127.0.0.1:3037
```

## OpenRTK plugin (token optimization)

- RTK binary v0.42.2 installed at `C:\Users\sandr\.cargo\bin\rtk.exe`
- `openrtk` npm package configured in `.opencode/config.json`
- Use RTK by default for shell/git/npm/read/search commands when an RTK subcommand exists: `rtk git ...`, `rtk npm ...`, `rtk read ...`, `rtk grep ...`, `rtk diff ...`, `rtk tree ...`.
- Fall back to raw shell only when RTK lacks the needed command, exact unfiltered output is required, or RTK itself is broken; mention the fallback briefly.
- System prompt for `rtk gain`/meta-commands at `.opencode/opencode.md`
- **Known issue**: npm-published `openrtk` v0.1.0 has ESM extensionless import bug — patch applied in `node_modules/openrtk/lib/index.js` (adds `.js` to `./rewrite` import). Re-patch after `npm install`/`npm ci`.
