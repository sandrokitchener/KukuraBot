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
- Use focused verification by default; run extensive test suites only when skipping them would block a credible result, the change is cross-cutting, or the user asks.
- Summarize findings before broad or cross-subsystem changes.
- Prefer compact summaries over long pasted command outputs.
- Use compact agent communication when it improves clarity or the user requests it; normal prose is the default for user-facing explanations.
- Use Cavecrew only for bounded fact-gathering or diff review when delegation materially saves work; direct execution is the default.
- Do not add transient debugging noise to docs unless it becomes a repeated known issue.
- After meaningful changes, update the relevant `.md` file briefly and factually.
- If status is live-environment dependent and you did not verify it this turn, write `Unknown / not confirmed`.

## Context doc cleanup rules

- Keep `AGENTS.md` as the router, not a subsystem encyclopedia.
- Keep reusable command recipes in `docs/COMMANDS.md`; subsystem docs should point there instead of duplicating long command blocks.
- Keep `docs/KNOWN_ISSUES.md` limited to repeated failures, stable traps, and current blockers; move background detail to the subsystem doc or archive when it grows.
- Prefer deleting stale or duplicated text over adding new sections. Add durable facts only when verified from repo source or live runtime evidence in the current turn.
## Standing project rules

- For DOGZILLA robot behavior, navigation, LiDAR, mapping, patrol, obstacle avoidance, and waypoint work, check `docs/DOGZILLA-main` and the relevant Yahboom PDFs before inventing a new approach.
- For LiDAR/navigation, stay on the DOGZILLA HAT UART path `/dev/ttyAMA1` unless the user explicitly changes hardware.
- Treat `config/robot-waypoints.json` as authoritative for waypoint coordinates and trust fields. Do not rewrite, downgrade, disable, or "correct" trusted entries without explicit user instruction.
- Diagnostics may warn about map identity, fingerprints, bounds, notes, or drift, but those diagnostics must stay separate from waypoint config authority.
- Active DOGZILLA map identity is authoritative for dispatch readiness. If saved origin or waypoint fingerprints are missing or differ from the active map fingerprint, treat origin/waypoints as stale for navigation while preserving `config/robot-waypoints.json`.
- If a DOGZILLA waypoint command reports `Nav2 lifecycle nodes are not active: controller_server, planner_server, bt_navigator, behavior_server`, do not assume Nav2 is stopped. First read `docs/NAVIGATION.md` and `docs/KNOWN_ISSUES.md`, then compare live `/healthz`, command log, and lifecycle services. The direct bridge uses longer lifecycle/status timeouts intentionally because Pi lifecycle services can answer slowly under load.
- DOGZILLA SSH startup scripts are launched from Windows PowerShell. Do not send PowerShell here-string heredocs through SSH for Python/Bash snippets; CRLF can break remote delimiters. Prefer `python3 -c`, checked-in scripts, or one-line shell loops, and make background stop loops skip `$$`/`$PPID` so they do not kill their own SSH launcher.
- When a change affects Pi-side runtime code, sidecars, startup scripts, ROS/Nav2 behavior, or systemd services, local edits/tests are not enough. After the user approves the change as good, deploy the changed files to the Pi, restart only the affected service/container, and verify the live Pi state before calling the task complete.
- For app/operator UI work, prefer existing panels and services before adding new surfaces.
- Use repo-local evidence before generic ROS, GitHub, or web explanations.

## Fast commands

Read `docs/COMMANDS.md` for the command index.

Default app URL:

```text
http://127.0.0.1:3037
```

## OpenRTK plugin (token optimization)

- The OpenRTK plugin rewrites supported shell commands automatically; run commands normally.
- Use `rtk` explicitly for meta commands, `rtk proxy`, exact unfiltered output, or when automatic rewriting is unavailable.
- `openrtk` is configured in `.opencode/config.json`; its known ESM patch may need reapplying after dependency installation.
- **Known issue**: npm-published `openrtk` v0.1.0 has ESM extensionless import bug — patch applied in `node_modules/openrtk/lib/index.js` (adds `.js` to `./rewrite` import). Re-patch after `npm install`/`npm ci`.

## Headroom files

- Do not delete, move, reset, clean, prune, or otherwise modify Headroom files or folders unless the user explicitly requests it in the current turn.
- Treat `.headroom/`, `headroom_memory.db`, global Headroom state such as `C:\Users\sandr\.headroom\`, and any Headroom cache/log/database files as user-owned tool state, even when they are untracked by git.
- Dirty-worktree cleanup must leave Headroom files untouched; do not include them in commits or cleanup sweeps unless directly instructed.


<!-- headroom:rtk-instructions -->
RTK command routing is automatic through OpenRTK. Use `rtk proxy` for raw/debugging and `rtk` directly for meta commands.
<!-- /headroom:rtk-instructions -->
