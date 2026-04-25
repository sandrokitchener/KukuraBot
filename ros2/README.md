# ROS2 Bridge Scaffold

This repo now has a real ROS2 scaffold for the DOGZILLA path, plus an HTTP sidecar that the Node app can talk to.

## What Exists Now

- `ros2/dogzilla_bridge/` ROS2 Python package
- `ros2/dogzilla_bridge/dogzilla_bridge/bridge_node.py` bridge node
- `ros2/dogzilla_bridge/launch/dogzilla_bridge.launch.py` launch entry
- `ros2/dogzilla_bridge/config/bridge.params.yaml` package params
- `sidecars/ros2_bridge/server.py` HTTP-to-ROS2 bridge sidecar
- `scripts/setup-ros2-humble-windows.ps1` Windows Humble helper
- `scripts/ros2-humble-env.cmd` Windows env helper
- `scripts/launch-ros2-dogzilla-bridge.bat` bridge launch helper

## End-To-End Flow

```text
app input
-> model JSON
-> lib/robot-command-compiler.mjs
-> robotRuntime preview envelope
-> /api/robot/dispatch or auto-dispatch on chat
-> sidecars/ros2_bridge/server.py
-> /dogzilla/command_plan (std_msgs/String JSON)
-> ros2/dogzilla_bridge bridge_node
-> ROS topics + JSON state feedback
```

The app and ROS layers are intentionally separated:

- app owns prompt semantics and config selection
- sidecar owns HTTP transport and publish/feedback relay
- ROS2 package owns topic fanout and state publication

Important runtime detail:

- when `ros2_real` is active, the app-managed launch starts the HTTP sidecar
- it does not auto-launch the `dogzilla_bridge` ROS node
- start the ROS node yourself with `ros2 launch ...` or `scripts\launch-ros2-dogzilla-bridge.bat`

## Current ROS Topics

Default names come from `config/robot-ros2.json` and `config/bridge.params.yaml`.

- `/dogzilla/command_plan`
- `/dogzilla/cmd_vel`
- `/dogzilla/action`
- `/dogzilla/stabilize`
- `/dogzilla/state`

The app also reserves names for future services and actions:

- `/dogzilla/set_pose`
- `/dogzilla/set_gait`
- `/dogzilla/get_state`
- `/dogzilla/navigate_named_target`

## What The Bridge Node Handles Today

Implemented in `bridge_node.py`:

- `locomotion.relative` -> publishes `geometry_msgs/msg/Twist`
- `action.once` -> publishes `std_msgs/msg/UInt16`
- `stabilize.set` -> publishes `std_msgs/msg/Bool`
- `noop` -> state update only
- `locomotion.goto` -> logs `goto-request` state only

Not fully executed yet:

- named waypoint navigation goal execution
- follow behaviors
- detect behaviors
- direct integration with undocumented Yahboom internal nodes

## Dry-Run Model

Dry-run is first-class in both app config and bridge params.

- `config/robot-runtime.json` gates operator-facing runtime dry-run
- `config/robot-ros2.json` gates transport dry-run
- `ros2/dogzilla_bridge/config/bridge.params.yaml` gates ROS bridge dry-run

That makes it possible to validate plan compilation, transport, and bridge state before letting hardware move.

## Feedback And Logs

Current feedback surfaces:

- app endpoint: `GET /api/robot/health`
- app endpoint: `GET /api/robot/feedback`
- sidecar endpoint: `GET /healthz`
- sidecar endpoint: `GET /feedback`
- ROS topic: `/dogzilla/state`
- command log: `sidecars/ros2_bridge/command_log.ndjson`

The bridge publishes JSON state snapshots with:

- `status`
- `handledCount`
- `lastCommand`
- `lastError`
- `dryRun`
- `enabled`

## Config Files To Edit First

- `config/robot-runtime.json`
- `config/robot-ros2.json`
- `config/robot-waypoints.json`
- `config/robot-actions.json`
- `config/robot-motion.json`

These are the main knobs for target selection, waypoint mapping, motion scaling, and transport setup.

One honest caveat: `ros2/dogzilla_bridge/config/bridge.params.yaml` already contains file-path params such as `waypoint_file`, `action_file`, `motion_file`, and `bridge_contract_file`, but the current `bridge_node.py` does not consume them yet. Treat those as forward-looking scaffold for now.

## Launch Options

### From The App

Default:

```powershell
npm start
```

Force real-robot target:

```powershell
npm start -- --robot-target ros2_real
```

### Sidecar Only

```powershell
python sidecars/ros2_bridge/server.py --host 127.0.0.1 --port 8892
```

### ROS2 Package

If your ROS environment is already sourced:

```powershell
ros2 launch dogzilla_bridge dogzilla_bridge.launch.py
```

### Windows Humble Helper Path

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-ros2-humble-windows.ps1
cmd /k scripts\ros2-humble-env.cmd
scripts\launch-ros2-dogzilla-bridge.bat
```

## Recommended Runtime Split

- Isaac Sim target for fast visual parity and waypoint tuning
- ROS2 real target for bridge and hardware validation
- Raspberry Pi / DOGZILLA side kept on Humble-aligned stack

That matches both the current repo config and the upstream DOGZILLA platform docs better than trying to force every layer into one Windows runtime.

## Related Docs

- `docs/dogzilla-json-to-ros2-rules.md`
- `docs/waypoint-mapping-guide.md`
- `docs/sim-vs-real-runtime.md`
