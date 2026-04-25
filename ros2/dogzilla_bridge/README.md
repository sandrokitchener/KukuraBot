# dogzilla_bridge

Config-driven ROS2 bridge package for Robo-Doge.

## What It Does

- subscribes to `/dogzilla/command_plan`
- accepts canonical plan JSON as `std_msgs/msg/String`
- publishes:
  - `geometry_msgs/msg/Twist` on `/dogzilla/cmd_vel` for relative motion
  - `std_msgs/msg/UInt16` on `/dogzilla/action` for verified action ids
  - `std_msgs/msg/Bool` on `/dogzilla/stabilize` for stabilize mode
  - `std_msgs/msg/String` on `/dogzilla/state` for operator feedback

## What It Does Not Yet Do

- talk directly to undocumented Yahboom internal nodes
- guarantee that navigation action names already match the stock image
- guarantee the preset trick id map for your robot

## Files

- `dogzilla_bridge/bridge_node.py`
- `launch/dogzilla_bridge.launch.py`
- `config/bridge.params.yaml`

## Launch

```bash
ros2 launch dogzilla_bridge dogzilla_bridge.launch.py
```

## Design Intent

This package is the ROS2-owned half of the control contract.

- app owns semantics
- bridge owns ROS fanout
- hardware adapter work stays below this package
