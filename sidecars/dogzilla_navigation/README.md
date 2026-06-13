# DOGZILLA Nav2 Navigation Sidecar

This starts a real Nav2 waypoint executor for DOGZILLA map waypoints.

It intentionally does not start AMCL. Cartographer map localization already owns the robot pose. This sidecar starts:

- `nav2_map_server`
- Nav2 planner/controller/behavior/BT navigator/waypoint follower
- Nav2 velocity smoother
- Robo-Doge DOGZILLA `/cmd_vel` gait adapter by default
- A TF-derived `/odom` publisher when Cartographer exposes `odom -> base_link` TF but no `nav_msgs/Odometry` publisher

Start from Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-dogzilla-navigation-ssh.ps1 -Host 10.0.4.32
```

Readiness proof:

```bash
ros2 action list -t | grep navigate_to_pose
ros2 topic info /cmd_vel
ros2 topic info /odom
ros2 topic info /map
```

The `/odom` publisher does not invent map coordinates. It republishes the live `odom -> base_link` TF as `nav_msgs/Odometry` so Nav2's controller and velocity smoother get the odometry topic they require.

## DOGZILLA gait adapter

Nav2 still owns path planning and local obstacle-aware control. The final `/cmd_vel` output is adapted before it reaches DOGZILLA hardware:

```text
Nav2 controller/recovery -> cmd_vel_nav
velocity_smoother -> /cmd_vel
cmd_vel_gait_adapter.py -> DOGZILLALib bridge /nav2/cmd_vel
DOGZILLALib -> pace/gait_type/move/turn
```

This keeps the planner intact while translating smooth wheeled-robot velocity commands into DOGZILLA-native gait commands. The default is stability-first: Nav2 forward velocity stays in `walk`/`slow` with conservative `move("x", ...)` and damped turning. In-place turns still pass through when Nav2 commands rotation without forward motion. Trot can be enabled only as an explicit tuning choice.

Disable the adapter and return to Yahboom's raw `/cmd_vel` base subscriber with:

```bash
DOGZILLA_NAV2_GAIT_ADAPTER_ENABLED=0
```

Useful adapter knobs:

- `DOGZILLA_NAV2_GAIT_ADAPTER_MAX_RATE_HZ` - max HTTP command rate from ROS to DOGZILLALib.
- `DOGZILLA_NAV2_GAIT_ADAPTER_STALE_STOP_SEC` - send a zero command after `/cmd_vel` goes quiet.
- `DOGZILLA_NAV2_GAIT_LINEAR_FULL_SCALE` - Nav2 linear x velocity that maps to max DOGZILLA x step.
- `DOGZILLA_NAV2_GAIT_ANGULAR_FULL_SCALE` - Nav2 angular z velocity that maps to max DOGZILLA turn rate.
- `DOGZILLA_NAV2_GAIT_FORWARD_TURN_SCALE` - turn-rate reduction while also walking forward.
- `DOGZILLA_NAV2_GAIT_MAX_X_STEP` - max DOGZILLA forward step from Nav2. Default `8`.
- `DOGZILLA_NAV2_GAIT_MAX_Y_STEP` - max DOGZILLA lateral step from Nav2. Default `3`.
- `DOGZILLA_NAV2_GAIT_MAX_TURN_RATE` - max DOGZILLA turn rate from Nav2. Default `24`.
- `DOGZILLA_NAV2_GAIT_ALLOW_TROT=1` - allow Nav2 to request `trot`; default is walk-only for stability.

## Indoor doorway tuning

All obstacle avoidance parameters are now housed in `config/robot-obstacle-avoidance.json` on the host and are passed as environment variables at startup.

Startup generates `$REMOTE_ROOT/logs/robodoge_nav2_params.yaml` from the installed Nav2 defaults, then patches the DOGZILLA clearance values from the config file:

- `nav2RobotRadius` → `DOGZILLA_NAV2_ROBOT_RADIUS`
- `nav2FootprintPadding` → `DOGZILLA_NAV2_FOOTPRINT_PADDING`
- `nav2InflationRadius` → `DOGZILLA_NAV2_INFLATION_RADIUS`
- `nav2CostScalingFactor` → `DOGZILLA_NAV2_COST_SCALING_FACTOR`
- `nav2ObstacleMaxRange` → `DOGZILLA_NAV2_OBSTACLE_MAX_RANGE`
- `nav2RaytraceMaxRange` → `DOGZILLA_NAV2_RAYTRACE_MAX_RANGE`

Bridge-side map navigation parameters are also sourced from the same config:

- `mapNavigationObstacleDistance` → `DOGZILLA_MAP_NAVIGATION_OBSTACLE_DISTANCE`
- `mapNavigationObstacleStopCount` → `DOGZILLA_MAP_NAVIGATION_OBSTACLE_STOP_COUNT`
- `mapNavigationMaxXStep` → `DOGZILLA_MAP_NAVIGATION_MAX_X_STEP`
- `mapNavigationMaxYStep` → `DOGZILLA_MAP_NAVIGATION_MAX_Y_STEP`
- `mapNavigationMaxTurnRate` → `DOGZILLA_MAP_NAVIGATION_MAX_TURN_RATE`
- `mapNavigationXGain` → `DOGZILLA_MAP_NAVIGATION_X_GAIN`
- `mapNavigationYGain` → `DOGZILLA_MAP_NAVIGATION_Y_GAIN`
- `mapNavigationTurnGain` → `DOGZILLA_MAP_NAVIGATION_TURN_GAIN`

This keeps LiDAR obstacle avoidance in Nav2's costmaps instead of starting Yahboom's separate `laser_Avoidance_xgo_RS200` controller during waypoint navigation. If DOGZILLA still refuses wide doorways, lower `nav2InflationRadius` in `config/robot-obstacle-avoidance.json` in small steps. If he cuts corners too close, raise it back up.
