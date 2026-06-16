<!-- Archive detail doc. Do not read by default. Current summary lives in docs/COMMANDS.md. -->

# Windows ROS 2 Setup for Robo-Doge

Last validated: April 24, 2026.

## Decision

For this repo, use this split:

- Primary repo lane: native Windows + ROS 2 Humble + Isaac Sim.
- Heavy ROS experimentation lane: WSL2 Ubuntu for Linux-style ROS work.
- Physical DOGZILLA S2 lane: Raspberry Pi 5 on the robot stays on a Humble-era stack until your custom bridge is proven.

Why this is the best fit for this repo:

- `config/robot-ros2.json` already defaults to `preferredDistro: "humble"` and `installRoot: "C:\\ros2_humble"`.
- `config/robot-runtime.json` already supports switching between `isaacsim` and `ros2_real`.
- Yahboom documents DOGZILLA S1/S2 as a Raspberry Pi 5 + ROS 2 Humble platform.
- NVIDIA Isaac Sim docs list Windows 10 and Windows 11 with Humble support. Their Ubuntu guidance prefers Jazzy, but Windows guidance is still Humble-first.
- Official ROS Windows docs still phrase native Windows support narrowly. Treat native Windows as a practical test lane, not your only long-term robotics environment.

## Recommended Topology

Use one command app, two runtime targets:

- `isaacsim`: local Isaac sidecar + Isaac Sim.
- `ros2_real`: ROS 2 bridge sidecar for a live robot path.

Keep the transport boundary simple:

- Windows host runs Node app, UI, Isaac Sim, and optional local ROS sidecar.
- DOGZILLA Pi runs low-level hardware-facing ROS nodes and sensor drivers.
- App switches targets without changing prompt behavior.

Repo pieces already aligned to this:

- `config/robot-runtime.json`
- `config/robot-ros2.json`
- `config/robot-waypoints.json`
- `config/robot-motion.json`
- `config/robot-actions.json`
- `scripts/setup-ros2-humble-windows.ps1`
- `scripts/ros2-humble-env.cmd`
- `scripts/launch-ros2-dogzilla-bridge.bat`
- `ros2/dogzilla_bridge/config/bridge.params.yaml`
- `sidecars/ros2_bridge/server.py`

## Config First, Code Second

Prefer these knobs before editing code:

- `config/robot-runtime.json`
  - `defaultTarget`
  - `dryRun`
  - `feedback.pollMs`
- `config/robot-ros2.json`
  - `transport.baseUrl`
  - `transport.dryRun`
  - `transport.dispatchOnChat`
  - `topics.*`
  - `feedback.pollMs`
  - `windows.*`
- Environment variables already supported by repo/runtime:
  - `ROBOT_RUNTIME_TARGET`
  - `ROBOT_RUNTIME_DRY_RUN`
  - `DOGZILLA_PLAN_TOPIC`
  - `DOGZILLA_STATE_TOPIC`
  - `RMW_IMPLEMENTATION`

Recommended practice:

- Keep sim-vs-real selection in `config/robot-runtime.json`.
- Use env vars only for temporary overrides and launch experiments.
- Keep topic names and sidecar URLs in `config/robot-ros2.json`.
- Keep home waypoint data in `config/robot-waypoints.json`.

## Windows Setup

### 1. Install official ROS 2 Humble prerequisites first

Do this from the official Humble Windows binary instructions before using repo scripts.

Important repo note:

- `scripts/setup-ros2-humble-windows.ps1` downloads the Humble zip, installs `pixi` if needed, creates `C:\pixi_ws`, installs `colcon-common-extensions`, and writes `scripts/ros2-humble-env.cmd`.
- It still does **not** replace every official Windows prerequisite from the ROS docs. You still need the upstream prerequisite stack first.

### 2. Bootstrap the repo's expected Humble location

From PowerShell in repo root:

```powershell
.\scripts\setup-ros2-humble-windows.ps1 -InstallRoot C:\ros2_humble
```

This matches the repo defaults in `config/robot-ros2.json`.

### 3. Open a ROS 2 terminal using the repo helper

From `cmd.exe`:

```bat
call scripts\ros2-humble-env.cmd
```

Recommended extra vars for this repo:

```bat
set ROS_DOMAIN_ID=30
set ROBOT_RUNTIME_DRY_RUN=1
```

Use one fixed `ROS_DOMAIN_ID` for this project and keep sim, sidecars, and robot on the same domain when you want them to talk.

### 4. Smoke-test ROS 2 itself

In one terminal:

```bat
call scripts\ros2-humble-env.cmd
ros2 run demo_nodes_cpp talker
```

In another:

```bat
call scripts\ros2-humble-env.cmd
ros2 run demo_nodes_py listener
```

Do this before blaming the repo.

### 5. Build the repo ROS workspace

From a ROS-enabled terminal:

```bat
call scripts\ros2-humble-env.cmd
cd ros2
colcon build --merge-install --packages-select dogzilla_bridge
call install\local_setup.bat
```

If `colcon` is missing, install it into the same Python environment you are using for ROS before continuing.
If you used the repo setup script after this update, `colcon` should already be present in `C:\pixi_ws`.

### 6. Launch the repo bridge

Fast path:

```bat
scripts\launch-ros2-dogzilla-bridge.bat
```

Equivalent ROS-native path after build:

```bat
call scripts\ros2-humble-env.cmd
cd ros2
call install\local_setup.bat
ros2 launch dogzilla_bridge dogzilla_bridge.launch.py
```

### 7. Run app in sim or real mode

Sim:

```bat
npm start -- --robot-target isaacsim
```

Real-robot bridge path:

```bat
npm start -- --robot-target ros2_real
```

The launch path in `run.mjs` already knows how to start Isaac pieces when `isaacsim` is active and ROS bridge pieces when `ros2_real` is active.

## Isaac Sim Notes

Practical guidance for this repo:

- Treat native Windows + Humble as your Isaac-compatible path.
- Treat Ubuntu + Jazzy as the more future-facing ROS path.
- Do not mix Humble, Jazzy, and Isaac internal ROS libraries in the same terminal session.

On Windows, Isaac Sim behavior to remember:

- If no other ROS libraries are sourced, Isaac Sim auto-loads its internal Humble ROS libraries.
- NVIDIA documents a manual override path for Jazzy internal libs on Windows, but that path is newer and less conservative than the stable Humble guidance.

For this repo, recommendation stays:

- Use Humble on native Windows for Isaac tests.
- Use WSL2 when you want a more Linux-like ROS workflow, extra CLI tooling, or future Nav2-heavy work.

## Sim vs Real Comparison Workflow

Use this progression:

1. `isaacsim` + `dryRun=true`
2. `ros2_real` + `dryRun=true`
3. `ros2_real` + live bridge on bench
4. physical floor tests

What stays constant:

- App prompt and command schema
- Canonical plan payload
- waypoint names
- high-level operator flow

What changes:

- target selection
- sidecar destination
- ROS topic consumers
- waypoint frame and coordinates

Recommended split of waypoint files:

- `config/isaacsim-waypoints.json`: simulation coordinates in Isaac world space
- `config/robot-waypoints.json`: real-home coordinates in ROS `map` frame

Keep semantic names identical across both files:

- `living_room`
- `garage`
- `bedroom`
- `home`
- `source`

That lets one command schema drive both targets.

## Mapping Home Waypoints

The repo already points in the right direction. `config/robot-waypoints.json` includes:

- `frame`
- `x`
- `y`
- `yaw`
- `arrivalToleranceMeters`
- `physicalSpot`
- `anchorHint`
- `verified`

Keep using that shape.

### Recommended rule

A waypoint should mark a safe parking bubble, not a piece of furniture.

Good waypoint types for a house:

- dock or charge spot
- room entry spot
- room standby spot
- hallway merge spot
- garage threshold spot
- operator-follow semantic source

### How to measure

Pick one anchor that does not move:

- charging dock
- hallway corner
- wall intersection
- tile seam you can always re-find

Then measure every waypoint from that anchor in meters.

### Recommended parameterization

For real-robot waypoints, use:

- `frame: "map"`
- `x`: meters forward from origin
- `y`: meters left from origin
- `yaw`: robot final heading, preferably radians
- `arrivalToleranceMeters`: parking tolerance, usually `0.20` to `0.35`
- `physicalSpot`: plain-English description
- `anchorHint`: how you re-measure it later
- `verified`: `false` until the robot actually reaches it safely

Example:

```json
{
  "living_room_entry": {
    "kind": "map_pose",
    "frame": "map",
    "x": 2.10,
    "y": -0.45,
    "yaw": 1.57,
    "arrivalToleranceMeters": 0.25,
    "physicalSpot": "Living room standby bubble just outside the rug edge",
    "anchorHint": "Measured from hallway-wall corner, biased away from couch leg",
    "verified": false
  }
}
```

### Keep sim and real aligned semantically

Do not try to make Isaac coordinates numerically equal to house coordinates.

Instead:

- keep names equal
- keep intent equal
- let coordinates differ by target

Example:

- `living_room` in Isaac means your sim living room marker
- `living_room` in ROS `map` means your measured living room parking bubble

## Feedback: How to Tell What ROS Is Doing

You asked for feedback. Repo already has useful hooks:

- App runtime panel polls `/api/robot/feedback`
- Sidecar exposes `/healthz`
- Sidecar exposes `/feedback`
- Sidecar logs to `sidecars/ros2_bridge/command_log.ndjson`
- Bridge publishes JSON state to `/dogzilla/state`

Use this feedback ladder:

1. App UI for operator-friendly status
2. HTTP `/api/robot/feedback` for recent command + transport status
3. `ros2 topic echo /dogzilla/command_plan` for canonical plans
4. `ros2 topic echo /dogzilla/state` for bridge state
5. `ros2 topic echo /dogzilla/cmd_vel` for low-level motion commands

Useful commands:

```bat
ros2 topic list
ros2 topic echo /dogzilla/command_plan
ros2 topic echo /dogzilla/state
ros2 topic echo /dogzilla/cmd_vel
ros2 node list
```

Best next improvement, if you want richer feedback later:

- add battery, pose, active target, last waypoint, last action, and safety-stop reason into `/dogzilla/state`

## Networking and DDS

For a single Windows machine:

- keep `RMW_IMPLEMENTATION=rmw_fastrtps_cpp`
- use one `ROS_DOMAIN_ID`
- keep discovery local if you want isolation

For multi-machine Windows-to-Pi or Isaac-to-WSL:

- keep same `ROS_DOMAIN_ID`
- allow Windows firewall access for ROS tools, Python, and Isaac Sim
- use Fast DDS UDP config when DDS must cross machines
- keep the HTTP sidecar path available when you want fewer DDS surprises

If you need cross-machine ROS discovery, read these knobs:

- `ROS_AUTOMATIC_DISCOVERY_RANGE`
- `ROS_STATIC_PEERS`
- `FASTRTPS_DEFAULT_PROFILES_FILE`

Practical advice:

- If you only need app-to-robot command transport, HTTP sidecar is simpler.
- If you want direct ROS graph visibility across machines, budget time for DDS/firewall tuning.

## Optional Windows Playground: Jazzy

If you want a separate ROS to learn on in Windows, use Jazzy in a completely separate install path and terminal setup.

Recommended rule:

- Humble for this repo on native Windows
- Jazzy only as a sandbox

Do not point this repo at Jazzy by default unless you are intentionally testing compatibility drift.

## Sources

- ROS 2 Humble Windows binary install: <https://docs.ros.org/en/humble/Installation/Windows-Install-Binary.html>
- ROS 2 Humble installation overview: <https://docs.ros.org/en/humble/Installation.html>
- ROS 2 Jazzy Windows binary install: <https://docs.ros.org/en/jazzy/Installation/Windows-Install-Binary.html>
- ROS official note that WSL improves Windows ROS experience: <https://docs.ros.org/en/humble/Tutorials/Advanced/Simulators/Webots/Installation-Windows.html>
- Isaac Sim 5.1.0 ROS 2 installation page: <https://docs.isaacsim.omniverse.nvidia.com/5.1.0/installation/install_ros.html>
- Isaac Sim ROS 2 installation matrix: <https://docs.isaacsim.omniverse.nvidia.com/latest/installation/install_ros.html>
- Isaac Sim other-platform and Windows internal ROS library guidance: <https://docs.isaacsim.omniverse.nvidia.com/latest/installation/install_ros_other_platforms.html>
- ROS discovery controls: <https://docs.ros.org/en/rolling/Tutorials/Advanced/Improved-Dynamic-Discovery.html>
- Fast DDS discovery server tutorial: <https://docs.ros.org/en/humble/Tutorials/Advanced/Discovery-Server/Discovery-Server.html>
- Yahboom DOGZILLA GitHub repo: <https://github.com/YahboomTechnology/DOGZILLA>
- Yahboom DOGZILLA product page: <https://category.yahboom.net/products/dogzilla-s1>
- Yahboom tutorial/download page: <https://www.yahboom.net/study/DOGZILLA-S1>
- Yahboom DOGZILLA download link bundle: <https://raw.githubusercontent.com/YahboomTechnology/DOGZILLA/main/Annex_DownloadLink.txt>
