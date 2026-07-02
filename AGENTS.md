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
- Always invoke the `caveman` skill for compact agent communication unless the user explicitly asks for normal prose, expanded rationale, or a human-facing document.
- Always prefer the `cavecrew` skill for bounded read-only fact-gathering, small surgical edits, or diff review when a subagent would help; keep work inline when delegation would add overhead.
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

- RTK binary v0.42.2 installed at `C:\Users\sandr\.cargo\bin\rtk.exe`
- `openrtk` npm package configured in `.opencode/config.json`
- Use RTK by default for shell/git/npm/read/search commands when an RTK subcommand exists: `rtk git ...`, `rtk npm ...`, `rtk read ...`, `rtk grep ...`, `rtk diff ...`, `rtk tree ...`.
- Fall back to raw shell only when RTK lacks the needed command, exact unfiltered output is required, or RTK itself is broken; mention the fallback briefly.
- System prompt for `rtk gain`/meta-commands at `.opencode/opencode.md`
- **Known issue**: npm-published `openrtk` v0.1.0 has ESM extensionless import bug — patch applied in `node_modules/openrtk/lib/index.js` (adds `.js` to `./rewrite` import). Re-patch after `npm install`/`npm ci`.

## Headroom files

- Do not delete, move, reset, clean, prune, or otherwise modify Headroom files or folders unless the user explicitly requests it in the current turn.
- Treat `.headroom/`, `headroom_memory.db`, global Headroom state such as `C:\Users\sandr\.headroom\`, and any Headroom cache/log/database files as user-owned tool state, even when they are untracked by git.
- Dirty-worktree cleanup must leave Headroom files untouched; do not include them in commits or cleanup sweeps unless directly instructed.


<!-- headroom:rtk-instructions -->
# RTK (Rust Token Killer) - Token-Optimized Commands

When running shell commands, **always prefix with `rtk`**. This reduces context
usage by 60-90% with zero behavior change. If rtk has no filter for a command,
it passes through unchanged � so it is always safe to use.

## Key Commands
```bash
# Git (59-80% savings)
rtk git status          rtk git diff            rtk git log

# Files & Search (60-75% savings)
rtk ls <path>           rtk read <file>         rtk grep <pattern>
rtk find <pattern>      rtk diff <file>

# Test (90-99% savings) � shows failures only
rtk pytest tests/       rtk cargo test          rtk test <cmd>

# Build & Lint (80-90% savings) � shows errors only
rtk tsc                 rtk lint                rtk cargo build
rtk prettier --check    rtk mypy                rtk ruff check

# Analysis (70-90% savings)
rtk err <cmd>           rtk log <file>          rtk json <file>
rtk summary <cmd>       rtk deps                rtk env

# GitHub (26-87% savings)
rtk gh pr view <n>      rtk gh run list         rtk gh issue list

# Infrastructure (85% savings)
rtk docker ps           rtk kubectl get         rtk docker logs <c>

# Package managers (70-90% savings)
rtk pip list            rtk pnpm install        rtk npm run <script>
```

## Rules
- In command chains, prefix each segment: `rtk git add . && rtk git commit -m "msg"`
- For debugging, use raw command without rtk prefix
- `rtk proxy <cmd>` runs command without filtering but tracks usage
<!-- /headroom:rtk-instructions -->

## Perform a context-doc maintenance pass.

Review the code changes in this branch/session and update the smallest relevant files under `/docs`.

Rules:
- Do not rewrite docs wholesale.
- Do not add noisy changelog-style notes.
- Remove or correct stale context.
- Keep docs optimized for future coding agents.
- Prefer durable architecture, APIs, gotchas, setup steps, and test instructions.
- If no docs need updates, say exactly: "Docs checked; no updates needed."

Then summarize:
1. Docs changed
2. Why each doc changed
3. Any docs intentionally left unchanged
## `@dipshit` — offload read-only fact-gathering to local Ollama to save tokens. Good: summarize docs, find references, extract facts, list TODOs. Bad: edits, decisions, security, anything subtle. Verify output before acting. Only worth the round-trip when main-agent context is already tight or you need compressed output without dumping raw files into context.
