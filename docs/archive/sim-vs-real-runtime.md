<!-- Archive detail doc. Do not read by default. Current summary lives in docs/ARCHITECTURE.md. -->

# Sim Vs Real Runtime

## Goal

This repo already has one app-facing command path and two execution targets:

- `isaacsim` for fast visual comparison
- `ros2_real` for the real DOGZILLA path

The safest way to compare them is to keep command semantics identical and swap only target config, launch path, and transport.

## Current Runtime Switches

| File | What it controls |
| --- | --- |
| `config/robot-runtime.json` | active target, dry-run, feedback polling, selected waypoint set |
| `config/robot-ros2.json` | ROS2 HTTP sidecar base URL, topics, services, Windows distro notes, bridge launch scripts |
| `config/isaacsim-sidecar.json` | Isaac sidecar transport and Isaac Sim launch flow |
| `config/robot-waypoints.json` | real-target waypoint registry |
| `config/isaacsim-waypoints.json` | sim-target waypoint registry |

## Actual Flow In This Repo

```text
user input
-> model JSON
-> app builds two previews in parallel
   -> isaacSim preview
   -> robotRuntime preview
-> active target decides which preview can auto-dispatch
```

For the real path, the current bridge flow is:

```text
/api/chat or /api/robot/dispatch
-> robotRuntime preview envelope
-> sidecars/ros2_bridge/server.py
-> /dogzilla/command_plan (std_msgs/String JSON)
-> ros2/dogzilla_bridge/dogzilla_bridge/bridge_node.py
-> ROS topics + JSON state feedback
```

Current launch truth:

- `run.mjs` starts the ROS2 HTTP sidecar when `ros2_real` is active
- it does not automatically launch `ros2 launch dogzilla_bridge dogzilla_bridge.launch.py`
- you still need the ROS node running if you want `/dogzilla/command_plan` to fan out into ROS topics

## What Is Really Implemented Today

The ROS2 scaffold is honest but partial.

| Canonical plan kind | Current bridge behavior |
| --- | --- |
| `locomotion.relative` | Publishes `geometry_msgs/msg/Twist` on `/dogzilla/cmd_vel` |
| `action.once` | Publishes `std_msgs/msg/UInt16` on `/dogzilla/action` when `actionId` is numeric |
| `stabilize.set` | Publishes `std_msgs/msg/Bool` on `/dogzilla/stabilize` |
| `noop` | Updates state only |
| `locomotion.goto` | Logs `goto-request` state only, does not send a nav goal yet |
| `behavior.detect`, `behavior.follow_*` | Can compile in app preview, but bridge node does not execute them yet |

Important consequence: waypoint comparison is already useful for contract and preview validation, but true real-world named navigation still needs the robot-side nav layer below `locomotion.goto`.

## Launching Each Target

Default desktop launch:

```powershell
npm start
```

Force Isaac Sim:

```powershell
npm start -- --robot-target isaacsim
```

Force ROS2 real target:

```powershell
npm start -- --robot-target ros2_real
```

Or lock the target with environment variables for one shell:

```powershell
$env:ROBOT_RUNTIME_TARGET = 'ros2_real'
$env:ROBOT_RUNTIME_DRY_RUN = 'true'
npm start
```

The app can also switch targets through `POST /api/settings/robot-target`, but the env var wins when `ROBOT_RUNTIME_TARGET` is set.

If `ROBOT_RUNTIME_TARGET` is set, the UI target selector becomes a display-only indicator for that session.

## Default Safety Posture

Real-robot execution is preview-first by default:

- `config/robot-runtime.json` sets `dryRun: true`
- `config/robot-ros2.json` sets `transport.dryRun: true`
- `ros2/dogzilla_bridge/config/bridge.params.yaml` sets `dry_run: true`

Isaac is looser by default:

- `config/isaacsim-sidecar.json` sets `transport.dryRun: false`

That split is good. Keep it until the bridge, waypoint set, and robot-side Humble stack are bench-verified.

## Feedback Surfaces

The repo already exposes several places to see what ROS is doing.

| Surface | What you learn |
| --- | --- |
| `GET /api/robot/health` | Whether the app can reach the ROS2 HTTP sidecar |
| `GET /api/robot/feedback` | Recent commands, last state, last publish time, last publish error |
| `GET http://127.0.0.1:8892/healthz` | Sidecar health and whether `rclpy` is available |
| `GET http://127.0.0.1:8892/feedback` | Sidecar recent command list and mirrored bridge state |
| `/dogzilla/state` | JSON state snapshots from `dogzilla_bridge` |
| `sidecars/ros2_bridge/command_log.ndjson` | Persistent command receipt log |

The bridge node currently publishes these state fields:

- `status`
- `handledCount`
- `lastCommand`
- `lastError`
- `dryRun`
- `enabled`

That is enough to build an operator panel or at least confirm whether a command was accepted, ignored, or failed to publish.

## Best Compare Workflow

1. Keep waypoint names identical in `config/robot-waypoints.json` and `config/isaacsim-waypoints.json`.
2. Run Isaac first and confirm the command semantics look right.
3. Save the `robotRuntime` preview payload from the same prompt and note the canonical plan.
4. Switch to `ros2_real` with dry-run still enabled.
5. Verify `/api/robot/health` and `/api/robot/feedback` before turning live motion on.
6. Compare only behaviors that are implemented end to end today:
   - relative motion
   - numeric action ids
   - stabilize on/off
7. Treat named waypoint `goto` as a contract test until a real nav executor exists.
8. Record the same fields for sim and real:
   - waypoint name
   - target pose
   - arrival tolerance
   - final heading
   - elapsed time
   - warnings and publish errors

## Config Knobs Worth Tuning First

These are the highest-value knobs to keep comparison practical:

| Config path | Why it matters |
| --- | --- |
| `config/robot-runtime.json -> defaultTarget` | Quick default between sim and real |
| `config/robot-runtime.json -> dryRun` | Safety gate for real hardware |
| `config/robot-runtime.json -> feedback.pollMs` | Operator UI refresh cadence |
| `config/robot-ros2.json -> transport.baseUrl` | Local sidecar vs robot-hosted sidecar |
| `config/robot-ros2.json -> transport.dispatchOnChat` | Whether chat auto-dispatches |
| `config/robot-ros2.json -> bridge.commandPlanTopic` | Main contract topic |
| `config/robot-ros2.json -> windows.*` | Which Windows ROS distro path the repo expects |
| `config/robot-motion.json -> profiles.default.twistCalibration.*` | Maps command intent to DOGZILLA step ranges |
| `config/robot-waypoints.json -> arrivalToleranceMeters` | Real-world acceptance window |

## Recommended Windows ROS Setup

Use two lanes, not one blended lane.

### Lane 1: Repo-Compatible Humble

Use this for the current repo, DOGZILLA alignment, and bridge bring-up.

- repo helper script: `scripts/setup-ros2-humble-windows.ps1`
- env helper: `scripts/ros2-humble-env.cmd`
- bridge launcher: `scripts/launch-ros2-dogzilla-bridge.bat`
- default install root in repo config: `C:\ros2_humble`

Why this lane first:

- `config/robot-ros2.json` already prefers `humble`
- Yahboom's DOGZILLA S1/S2 docs and README are built around ROS2 Humble on Raspberry Pi 5
- Isaac Sim on Windows still documents Humble support

### Lane 2: Separate Jazzy Playground

Use this only as a separate experiment lane.

- official Jazzy Windows install uses `pixi` and a short path such as `C:\pixi_ws`
- keep it in a separate shell and separate workspace assumptions
- do not assume cross-distro communication between Humble and Jazzy nodes

## Windows Source-Backed Notes

These facts shaped the recommendation above:

- ROS 2 Humble Windows binary docs still describe the older native Windows install path and officially list Windows 10 support only.
- ROS 2 Jazzy Windows binary docs use `pixi` plus conda-forge and also officially list Windows 10 support only.
- ROS 2 distributions docs show Humble supported through May 2027 and Jazzy through May 2029.
- Isaac Sim's current ROS installation docs list Windows 10 and Windows 11 with Humble support and Jazzy beta support, but for Windows they steer users toward WSL and note that custom ROS interfaces are not supported in that path.

Practical inference: use Humble as the repo-truth lane, keep Jazzy as a playground lane, and keep the real DOGZILLA stack on the Raspberry Pi / Ubuntu Humble side whenever possible.

## DOGZILLA-Specific Recommendation

Keep the robot-side contract conservative:

- Windows machine: operator app, preview, docs, CLI testing, optional local sidecar
- Raspberry Pi / DOGZILLA side: ROS2 Humble, Yahboom bringup, chassis access, lidar/nav stack

That matches the platform docs better than trying to replace the full robot-side stack with a Windows-only runtime.

## Suggested Comparison Checklist

- same prompt text
- same semantic waypoint name
- same command preview status
- same canonical plan kind
- same target pose meaning
- sidecar health green before dispatch
- no `lastPublishError`
- bridge `handledCount` increments
- bridge `status` matches expected behavior
- only mark parity after three repeatable runs

## Primary Sources

- [ROS 2 Humble Windows binary install](https://docs.ros.org/en/humble/Installation/Windows-Install-Binary.html)
- [ROS 2 Jazzy Windows binary install](https://docs.ros.org/en/jazzy/Installation/Windows-Install-Binary.html)
- [ROS 2 distributions and support windows](https://docs.ros.org/en/humble/Releases.html)
- [Isaac Sim ROS 2 install notes for other platforms](https://docs.isaacsim.omniverse.nvidia.com/latest/installation/install_ros_other_platforms.html)
- [Yahboom DOGZILLA repository](https://github.com/YahboomTechnology/DOGZILLA)
- [Yahboom DOGZILLA product page](https://category.yahboom.net/products/dogzilla-s1)
