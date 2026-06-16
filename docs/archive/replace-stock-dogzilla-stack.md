<!-- Archive detail doc. Do not read by default. Current summary lives in docs/ARCHITECTURE.md. -->

# Replacing Stock DOGZILLA Control Stack with Robo-Doge

Last validated: April 24, 2026.

## Goal

Replace Yahboom's stock high-level control stack with the Robo-Doge command stack, while keeping the robot recoverable.

Strong recommendation:

- Do not start with a destructive overwrite.
- Start with dual-stack bring-up.
- Prove the custom path in dry-run and bench mode.
- Disable stock services only after you can recover quickly.

This is especially important because Yahboom's public materials mix Python control docs, ROS 2 tutorials, downloadable system images, and multiple remote-control modes. Treat the shipped image as a black box until you inventory it.

## What To Replace First

Replace these early:

- vendor app and web launch wrappers
- vendor voice-control autostarts
- vendor navigation orchestration launchers
- prompt-to-command logic
- any "one big launch script" that mixes UI, speech, nav, and motion

Keep these at first:

- motor-controller firmware
- low-level servo protocol path
- lidar driver path unless you fully understand its replacement
- camera driver path
- calibration files
- power and boot basics

Practical rule:

- replace userland orchestration first
- replace hardware-facing pieces last

## Recommended Final Architecture

Use this separation:

- Windows host: command app, UI, Isaac Sim, comparison tooling
- Robot Pi: hardware adapter, ROS graph, sensors, robot-local safety checks

Command flow:

- app produces canonical plan
- sidecar transports plan
- `dogzilla_bridge` consumes `/dogzilla/command_plan`
- robot-local adapter turns that into `Twist`, action IDs, stabilize flags, or documented Python calls
- bridge publishes `/dogzilla/state`

This matches the repo's direction:

- `config/robot-ros2.json`
- `config/robot-runtime.json`
- `ros2/dogzilla_bridge/config/bridge.params.yaml`
- `sidecars/ros2_bridge/server.py`
- `docs/dogzilla-json-to-ros2-rules.md`

## Before You Touch The Stock Image

Do these first.

### 1. Make recovery real

- Clone the microSD card to a full image.
- Save the Yahboom download bundle and manuals outside the robot.
- Export the current service list.
- Copy the current home directory, systemd files, and shell startup files.

Useful commands on the Pi:

```bash
systemctl list-unit-files --type=service > ~/dogzilla-stock-services.txt
systemctl --type=service --state=running > ~/dogzilla-running-services.txt
crontab -l > ~/dogzilla-crontab.txt
ps -ef | grep -Ei 'dogzilla|yahboom|ros|voice|lidar' > ~/dogzilla-processes.txt
```

### 2. Find the actual stock control path

Inventory these:

- systemd units
- `~/.bashrc`
- `/etc/rc.local`
- desktop autostarts
- startup shell scripts
- vendor ROS workspaces
- Python scripts that talk to the motor board

Useful search:

```bash
grep -R "run_humble.sh\|ros2 launch\|dogzilla\|yahboom\|lidar\|voice" /etc /home/$USER -n 2>/dev/null
```

### 3. Record hardware-facing interfaces

Write down:

- motor-controller serial or USB path
- lidar device path
- camera device path
- IMU access path
- any custom udev rules
- any calibration files

Do not replace what you have not identified.

## Cutover Strategy

### Phase 1: Mirror only

Run your custom stack in observation mode first.

Goal:

- accept app commands
- compile canonical plans
- log them
- publish bridge state
- do **not** move hardware yet

Use:

- `config/robot-runtime.json` with `dryRun: true`
- `config/robot-ros2.json` with `transport.dryRun: true`
- bridge params with `dry_run: true`

### Phase 2: Bench motion only

With the robot physically restrained or lifted:

- test `noop`
- test reset posture
- test tiny `cmd_vel` values
- test stop behavior
- test one safe action

Do not start with autonomous room navigation.

### Phase 3: Replace high-level launchers

Once the custom bridge works, disable stock launchers that compete for control.

Disable one class at a time:

- stock voice-control service
- stock app/web control service
- stock nav demo service
- stock launch script wrappers

Keep sensor-only services alive until you know your replacement is ready.

### Phase 4: Promote custom services to boot

Only after repeated bench success:

- enable custom bridge service
- enable custom app-side transport or robot-local launch service
- confirm the robot comes up idle and safe after reboot

## Recommended Config-Driven Deployment

Use one env file on the robot for deployment-time changes.

Suggested shape:

```dotenv
DOGZILLA_CONTROL_MODE=custom
DOGZILLA_SAFE_START=1
DOGZILLA_DRY_RUN=1
DOGZILLA_PLAN_TOPIC=/dogzilla/command_plan
DOGZILLA_STATE_TOPIC=/dogzilla/state
DOGZILLA_ROS_DOMAIN_ID=30
DOGZILLA_BRIDGE_HOST=0.0.0.0
DOGZILLA_BRIDGE_PORT=8892
DOGZILLA_WAYPOINT_SET=home
DOGZILLA_HW_ADAPTER=documented_python
DOGZILLA_LIDAR_ENABLED=1
DOGZILLA_VOICE_ENABLED=0
```

Meaning:

- `DOGZILLA_CONTROL_MODE`: lets you keep a stock/custom switch for rollback
- `DOGZILLA_SAFE_START`: boot into non-moving state
- `DOGZILLA_DRY_RUN`: forces logging-only startup
- topic names stay out of code
- hardware adapter choice stays explicit

## Recommended Service Layout

Use two custom services, not one giant do-everything service.

Service 1:

- HTTP sidecar transport
- receives commands from Windows app
- exposes feedback endpoint

Service 2:

- ROS 2 bridge node
- converts canonical plans into motion topics or documented Python calls
- publishes `/dogzilla/state`

That keeps failure domains smaller.

## Example Service Skeletons

Example transport service:

```ini
[Unit]
Description=Robo-Doge HTTP to ROS2 sidecar
After=network-online.target

[Service]
EnvironmentFile=/etc/robodoge/robodoge.env
WorkingDirectory=/opt/robodoge
ExecStart=/usr/bin/python3 /opt/robodoge/sidecars/ros2_bridge/server.py --host 0.0.0.0 --port 8892
Restart=always

[Install]
WantedBy=multi-user.target
```

Example ROS bridge service:

```ini
[Unit]
Description=Robo-Doge ROS2 bridge
After=network-online.target

[Service]
EnvironmentFile=/etc/robodoge/robodoge.env
WorkingDirectory=/opt/robodoge/ros2
ExecStart=/bin/bash -lc 'source /opt/ros/humble/setup.bash && source /opt/robodoge/ros2/install/local_setup.bash && ros2 launch dogzilla_bridge dogzilla_bridge.launch.py'
Restart=always

[Install]
WantedBy=multi-user.target
```

Keep these custom units alongside, not mixed into, vendor units.

## How To Disable Stock Stack Safely

Preferred order:

1. stop vendor service
2. verify custom stack still works
3. disable vendor service from boot
4. wait through several clean reboots
5. only then archive or remove vendor launcher

Examples:

```bash
sudo systemctl stop <vendor-service>
sudo systemctl disable <vendor-service>
sudo systemctl enable --now robodoge-http-bridge.service
sudo systemctl enable --now robodoge-ros2-bridge.service
```

Avoid this early:

- deleting vendor workspaces
- reflashing controller firmware
- deleting calibration files
- replacing sensor drivers just because the high-level stack changed

## Hardware Adapter Recommendation

Because the DOGZILLA docs more clearly describe Python control functions than internal ROS topic contracts, the safest first custom adapter is:

- canonical plan
- robot-local adapter
- documented Python control functions or simple ROS topics you have personally verified

Good first hardware contract:

- `Twist` for base motion where available
- action topic for fixed action IDs
- stabilize flag
- periodic JSON state summary

Avoid depending on undocumented Yahboom internals until you have captured them from the live system.

## Validation Checklist

Do not call the stack replacement complete until all of these pass:

- robot boots without moving unexpectedly
- app can switch between `isaacsim` and `ros2_real`
- `/dogzilla/command_plan` receives commands
- `/dogzilla/state` updates continuously
- stop command always works
- reset posture works
- one forward motion test works
- one turn test works
- one waypoint request works in dry-run first, then live
- reboot returns to safe idle

## Recovery Plan

Keep rollback simple:

- separate stock SD image
- saved vendor download bundle
- stock service list export
- one env switch or one disabled custom service away from recovery

Best recovery shape:

- spare microSD with untouched stock image
- custom stack on a separate cloned card during bring-up

That is safer than modifying your only known-good vendor image in place.

## Practical Recommendation

If your goal is "replace stock install," the safest real interpretation is:

- preserve stock firmware and recovery image
- replace stock Linux userland control stack
- keep all high-level behavior in config, env files, and your own ROS bridge
- leave yourself one reboot away from rollback

That gets you a real custom command stack without turning the robot into a brick.

## Sources

- Yahboom DOGZILLA GitHub repo: <https://github.com/YahboomTechnology/DOGZILLA>
- Yahboom DOGZILLA product page: <https://category.yahboom.net/products/dogzilla-s1>
- Yahboom tutorial/download page: <https://www.yahboom.net/study/DOGZILLA-S1>
- Yahboom download bundle pointer: <https://raw.githubusercontent.com/YahboomTechnology/DOGZILLA/main/Annex_DownloadLink.txt>
