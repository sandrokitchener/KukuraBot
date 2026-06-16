# Isaac Sim Notes

Read this for Isaac Sim, Isaac Lab, simulation, USD/CAD, and robot model work.

## Current shape

Isaac support is separated into command compilation, sidecar transport, and Isaac-side runtime hooks.

```text
app command JSON
-> lib/isaacsim-command-compiler.mjs
-> lib/isaacsim-sidecar-client.mjs
-> sidecars/isaac_bridge/server.py
-> Isaac-side script/runtime
```

The app-facing sidecar URL is configured in `config/isaacsim-sidecar.json` as `http://127.0.0.1:8891`.

## Key files

| File | Role |
| --- | --- |
| `config/isaacsim-sidecar.json` | Sidecar transport and app-managed Isaac launch settings |
| `config/isaacsim-command-map.json` | Command mapping for Isaac previews |
| `config/isaacsim-waypoints.json` | Sim waypoint set and placeholder scene targets |
| `config/isaacsim-proxy-rig.json` | Proxy rig config |
| `lib/isaacsim-config.mjs` | Config loader |
| `lib/isaacsim-command-compiler.mjs` | App command to Isaac preview |
| `lib/isaacsim-launcher.mjs` | Managed Isaac environment launch |
| `sidecars/isaac_bridge/server.py` | HTTP sidecar scaffold |
| `isaacsim/` | USD/USDA scenes |
| `isaac_assets/` | Converted/imported Yahboom assets |

## Scenes and assets

Current scene files in `isaacsim/`:

- `dogzilla_proxy_blockout.usda`
- `dogzilla_sim_env.usd`
- `sim_environment.usd`
- `sim_environment_yahboom_xgo.usda`
- `yahboom_xgo_proxy_visual.usda`

Existing assessment in `docs/archive/isaacsim-existing-scene-assessment.md` says `dogzilla_sim_env.usd` mostly wraps a DOGZILLA payload. The payload appears CAD-converted, with geometry but weak semantic part naming. Treat articulation, servo pivots, and true link hierarchy as Unknown / not confirmed unless inspected in Isaac.

`isaac_assets/Yahboom/` contains DOGZILLA/Yahboom USD and URDF-derived assets, including `Dogzilla_full.usd`, `Dogzilla_free_base.usda`, and `yahboom_xgo_isaac.urdf`.

## Launch commands

```powershell
npm start -- --robot-target isaacsim
scripts\launch-isaac-robot-controller.bat
scripts\launch-isaac-yahboom-xgo.bat
```

`config/isaacsim-sidecar.json` currently has `launch.managedByApp: true`, `isaacSimLaunchEnabled: true`, and `isaacSimLaunchScriptPath: scripts/launch-isaac-robot-controller.bat`.

## Command map

`config/isaacsim-command-map.json` maps app commands to Isaac actions:

- `move` -> `robot_controller.goto_waypoint`
- `detect` -> `perception.detect_in_zone`
- `trick` -> `articulation.play_named_action`
- `follow` -> `robot_controller.move_base`
- `talk` -> `dialog.say`

Trick fallback policy is `reject_unverified`; do not invent unverified trick IDs.

## Waypoints

`config/isaacsim-waypoints.json` uses simulator fields:

- `position: [x, y, z]`
- `yawDegrees`
- `verified`
- optional `special`

Keep semantic waypoint names aligned with real robot names where practical. Coordinates can differ.

## Tests

Relevant tests include:

- `test/isaacsim-command-compiler.test.mjs`
- `test/isaacsim-config.test.mjs`
- `test/isaacsim-launcher.test.mjs`
- `test/isaac-launch-script.test.mjs`
- `test/isaac-yahboom-xgo-assets.test.mjs`
- `test/test_proxy_rig_motion.py`
- `test/test_robot_controller_runtime.py`

## Unknown / not confirmed

- Current Isaac Sim installed version and local executable path.
- Whether latest scenes open cleanly in the local Isaac install.
- Whether any DOGZILLA asset has production-ready articulation.
- Archived detail docs: `docs/archive/isaacsim-sidecar-scaffold.md`, `docs/archive/isaacsim-existing-scene-assessment.md`.
