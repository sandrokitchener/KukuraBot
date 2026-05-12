# dogzilla_bridge

Config-driven ROS2 bridge package for Robo-Doge.

## What It Does

- subscribes to `/dogzilla/command_plan`
- accepts canonical plan JSON as `std_msgs/msg/String`
- validates and clamps DOGZILLA command ranges before execution
- routes execution through a pluggable adapter:
  - `dry-run` records intended hardware calls when `dry_run: true`
  - `ros-publisher` preserves the current topic-publish behavior
  - `yahboom-python` dynamically loads the vendor Python control library once verified on the Pi
- publishes:
  - `geometry_msgs/msg/Twist` on `/dogzilla/cmd_vel` for relative motion
  - `std_msgs/msg/UInt16` on `/dogzilla/action` for verified action ids
  - `std_msgs/msg/Bool` on `/dogzilla/stabilize` for stabilize mode
  - `std_msgs/msg/String` on `/dogzilla/state` for operator feedback

## What It Does Not Yet Do

- talk directly to undocumented Yahboom internal nodes
- guess the vendor Python module name before hardware inspection
- guarantee that navigation action names already match the stock image
- guarantee the preset trick id map for your robot

## Files

- `dogzilla_bridge/bridge_node.py`
- `dogzilla_bridge/adapters.py`
- `dogzilla_bridge/commands.py`
- `launch/dogzilla_bridge.launch.py`
- `config/bridge.params.yaml`

## Adapter Modes

Use `dry_run: true` for first boot and bench prep. The node uses `dry-run` automatically and includes the recorded adapter call in `/dogzilla/state`.

Use `adapter_mode: "ros-publisher"` when another ROS2 node on the robot consumes `/dogzilla/cmd_vel`, `/dogzilla/action`, and `/dogzilla/stabilize`.

Use `adapter_mode: "yahboom-python"` only after the live image confirms the import path and constructor. Configure:

```yaml
dogzilla_python_module: "<module_name>"
dogzilla_python_factory: "<factory_or_class_name>"
```

The adapter maps canonical commands to documented DOGZILLA Python calls: `move`, `turn`, `stop`, `action`, `perform`, `imu`, `translation`, `attitude`, and read methods where present.

## Yahboom Study Page Defaults

The bridge state snapshot includes study-page bring-up hints:

- default `ROS_DOMAIN_ID=16` unless `ROS_DOMAIN_ID` or `DOGZILLA_ROS_DOMAIN_ID` is already set
- Pi 5 Docker entry: `./run_humble.sh`
- chassis/radar/IMU/joint-state bringup: `ros2 launch bringup Navigation_bringup.launch.py`
- keyboard smoke test: `ros2 run teleop_twist_keyboard teleop_twist_keyboard`
- APP camera topic shown by docs: `/usb_cam/imge_raw/compress`

## Launch

```bash
ros2 launch dogzilla_bridge dogzilla_bridge.launch.py
```

## Design Intent

This package is the ROS2-owned half of the control contract.

- app owns semantics
- bridge owns ROS fanout
- hardware adapter work stays below this package
