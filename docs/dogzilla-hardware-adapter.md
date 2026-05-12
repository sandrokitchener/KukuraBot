# DOGZILLA Hardware Adapter Prep

Last updated: May 10, 2026.

## Decision

Robo-Doge now treats DOGZILLA hardware access as a pluggable adapter behind the ROS2 bridge.

Adapters:

- `dry-run`: records intended hardware calls and publishes them in bridge state.
- `ros-publisher`: publishes our owned ROS2 bridge topics.
- `yahboom-python`: calls the documented Yahboom Python control API once the real module path is verified on the Pi.

## Why

The public Yahboom repo documents useful control surfaces, but not a stable application-level ROS2 API we should hardcode before hardware inspection.

Verified surfaces from Yahboom public material:

- Python chassis methods: `forward`, `back`, `left`, `right`, `turnleft`, `turnright`, `move`, `turn`, `stop`.
- Python body/action methods: `pace`, `translation`, `attitude`, `action`, `perform`, `imu`.
- Python read methods: `read_Motor`, `read_Battery`, `read_roll`, `read_pitch`, `read_yaw`.
- ROS2 examples use standard `Twist` flows through teleop/lidar behavior code.

So the bridge owns validation and command shape, while adapters own the final transport.

## Day-1 Verification

Before live motion:

```bash
python3 - <<'PY'
import pkgutil
for name in ["DOGZILLALib", "dogzilla", "xgolib", "xgo"]:
    print(name, bool(pkgutil.find_loader(name)))
PY
```

Then inspect candidate APIs:

```bash
python3 - <<'PY'
import importlib
module_name = "DOGZILLALib"
m = importlib.import_module(module_name)
print(module_name, dir(m))
PY
```

Only after the constructor is verified, set:

```yaml
adapter_mode: "yahboom-python"
dogzilla_python_module: "<verified_module>"
dogzilla_python_factory: "<verified_class_or_factory>"
```

Keep `dry_run: true` until the adapter imports and state reads work.

## Safety Rules In Code

The command router clamps:

- `x_step`: `-25..25`
- `y_step`: `-18..18`
- `turn_rate`: `-100..100`
- `height`: `75..115`
- `roll`: `-20..20`
- `pitch`: `-15..15`
- `yaw`: `-11..11`

It rejects:

- non-integer `actionId`
- action IDs outside `1..19` or `255`
- unknown gaits/pace values
- unsupported behavior/navigation execution instead of improvising raw motion

## Current Implementation

Files:

- `ros2/dogzilla_bridge/dogzilla_bridge/commands.py`
- `ros2/dogzilla_bridge/dogzilla_bridge/adapters.py`
- `ros2/dogzilla_bridge/dogzilla_bridge/bridge_node.py`
- `ros2/dogzilla_bridge/config/bridge.params.yaml`

The Node app still sends canonical plans to `/dogzilla/command_plan`. The ROS2 bridge now decides how those plans reach hardware.

## Sources

- Yahboom DOGZILLA repo: https://github.com/YahboomTechnology/DOGZILLA
- DOGZILLA download links: https://raw.githubusercontent.com/YahboomTechnology/DOGZILLA/main/Annex_DownloadLink.txt
