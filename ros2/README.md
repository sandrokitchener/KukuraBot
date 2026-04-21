# ROS2 Scaffold

This folder is reserved for future ROS2 integration work for DOGZILLA.

Current state:

- no executable ROS2 package yet
- no launch files yet
- no bridge node implementation yet
- one dummy parameter file for shape only

The point of this scaffold is to give us a home for ROS2 work without forcing decisions too early.

Related config files live in `config/`:

- `config/robot-runtime.json`
- `config/robot-waypoints.json`
- `config/robot-actions.json`
- `config/robot-motion.json`
- `config/robot-ros2.json`

Reference doc:

- `docs/dogzilla-json-to-ros2-rules.md`

## Intended Direction

Later, this folder will likely hold a small `dogzilla_bridge` package that:

- accepts a narrow command contract from the app
- validates and clamps robot-safe values
- translates those commands into DOGZILLA control calls
- stays easy to test in dry-run mode

For now, this folder is only scaffolding.
