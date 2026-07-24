# DOGZILLA Nav2 Navigation Sidecar

This starts a real Nav2 waypoint executor for DOGZILLA map waypoints.

It intentionally does not start AMCL. Cartographer map localization already owns the robot pose. This sidecar starts:

- `nav2_map_server`
- Nav2 planner/controller/behavior/BT navigator/waypoint follower
- Nav2 velocity smoother
- Robo-Doge DOGZILLA `/cmd_vel` gait adapter by default
- Cartographer map-pose localization repair when `odom -> base_link/base_footprint` TF is missing
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

The `/odom` publisher does not invent map coordinates. It republishes the live `odom -> base_link` or `odom -> base_footprint` TF as `nav_msgs/Odometry` so Nav2's controller and velocity smoother get the odometry topic they require. If that TF is missing, startup first runs the map-pose Cartographer localization script from `sidecars/dogzilla_map_pose`; only after TF exists does it start the TF-derived `/odom` helper.

## DOGZILLA gait adapter

Nav2 still owns path planning and local obstacle-aware control. The final `/cmd_vel` output is adapted before it reaches DOGZILLA hardware:

```text
Nav2 controller/recovery -> cmd_vel_nav
velocity_smoother -> /cmd_vel
cmd_vel_gait_adapter.py -> DOGZILLALib bridge /nav2/cmd_vel
DOGZILLALib -> pace/gait_type/move/turn
```

This keeps the planner intact while translating smooth wheeled-robot velocity commands into DOGZILLA-native gait commands. The default is stability-first: Nav2 stays in `walk`/`slow` with conservative forward motion and damped turning. Controller-requested in-place turns are limited to half the normal turn ceiling so the robot can face a new path; the recovery tree still contains no `Spin`. During frontier exploration, 20 seconds without meaningful approach cancels only that goal and moves on. Trot can be enabled only as an explicit tuning choice.

Disable the adapter and return to Yahboom's raw `/cmd_vel` base subscriber with:

```bash
DOGZILLA_NAV2_GAIT_ADAPTER_ENABLED=0
```

Useful adapter knobs:

- `DOGZILLA_NAV2_GAIT_ADAPTER_MAX_RATE_HZ` - max HTTP command rate from ROS to DOGZILLALib.
- `DOGZILLA_NAV2_GAIT_ADAPTER_STALE_STOP_SEC` - send a zero command after `/cmd_vel` goes quiet.
- Nav2 linear x full scale is fixed at the operator-approved `0.26`; stale `DOGZILLA_NAV2_GAIT_LINEAR_FULL_SCALE` values are ignored.
- `DOGZILLA_NAV2_GAIT_ANGULAR_FULL_SCALE` - Nav2 angular z velocity that maps to max DOGZILLA turn rate.
- `DOGZILLA_NAV2_GAIT_FORWARD_TURN_SCALE` - turn-rate reduction while also walking forward.
- `DOGZILLA_NAV2_GAIT_MAX_X_STEP` - max DOGZILLA forward step from Nav2. Default `8`.
- `DOGZILLA_NAV2_GAIT_MAX_Y_STEP` - max DOGZILLA lateral step from Nav2. Default `3`.
- `DOGZILLA_NAV2_GAIT_MAX_TURN_RATE` - max DOGZILLA turn rate from Nav2. Default `24`.
- Autonomous mapping uses Yahboom's standard `trot` gait at Nav2's existing
  `0.26 m/s` ceiling. Normal waypoint navigation remains walk-only.

## Final heading

Waypoint navigation defaults to position-first arrival. `DOGZILLA_NAV2_YAW_GOAL_TOLERANCE` defaults to `6.283185307179586`, so Nav2 does not spin just to match a saved waypoint yaw. Lower it only when final facing direction matters.

## Indoor doorway tuning

All obstacle avoidance parameters are now housed in `config/robot-obstacle-avoidance.json` on the host and are passed as environment variables at startup.

Startup generates `$REMOTE_ROOT/logs/robodoge_nav2_params.yaml` from the installed Nav2 defaults, then patches the DOGZILLA clearance values from the config file:

- `nav2RobotRadius` → `DOGZILLA_NAV2_ROBOT_RADIUS`
- `nav2FootprintPadding` → `DOGZILLA_NAV2_FOOTPRINT_PADDING`
- `nav2InflationRadius` → `DOGZILLA_NAV2_INFLATION_RADIUS`
- `nav2CostScalingFactor` → `DOGZILLA_NAV2_COST_SCALING_FACTOR`
- `nav2ObstacleMinRange` → `DOGZILLA_NAV2_OBSTACLE_MIN_RANGE`
- `nav2ObstacleMaxRange` → `DOGZILLA_NAV2_OBSTACLE_MAX_RANGE`
- `nav2RaytraceMaxRange` → `DOGZILLA_NAV2_RAYTRACE_MAX_RANGE`
- `nav2ScanFilterEnabled` → `DOGZILLA_NAV2_SCAN_FILTER_ENABLED`
- `nav2ScanFilterMaskStartDeg` → `DOGZILLA_NAV2_SCAN_FILTER_MASK_START_DEG`
- `nav2ScanFilterMaskEndDeg` → `DOGZILLA_NAV2_SCAN_FILTER_MASK_END_DEG`
- `nav2ScanFilterMaskRangeM` → `DOGZILLA_NAV2_SCAN_FILTER_MASK_RANGE_M`
- `yawGoalTolerance` → `DOGZILLA_NAV2_YAW_GOAL_TOLERANCE`

Bridge-side map navigation parameters are also sourced from the same config:

- `mapNavigationObstacleDistance` → `DOGZILLA_MAP_NAVIGATION_OBSTACLE_DISTANCE`
- `mapNavigationObstacleStopCount` → `DOGZILLA_MAP_NAVIGATION_OBSTACLE_STOP_COUNT`
- `mapNavigationMaxXStep` → `DOGZILLA_MAP_NAVIGATION_MAX_X_STEP`
- `mapNavigationMaxYStep` → `DOGZILLA_MAP_NAVIGATION_MAX_Y_STEP`
- `mapNavigationMaxTurnRate` → `DOGZILLA_MAP_NAVIGATION_MAX_TURN_RATE`
- `mapNavigationXGain` → `DOGZILLA_MAP_NAVIGATION_X_GAIN`
- `mapNavigationYGain` → `DOGZILLA_MAP_NAVIGATION_Y_GAIN`
- `mapNavigationTurnGain` → `DOGZILLA_MAP_NAVIGATION_TURN_GAIN`

This keeps LiDAR obstacle avoidance in Nav2's costmaps instead of starting Yahboom's separate `laser_Avoidance_xgo_RS200` controller during waypoint navigation. Keep `nav2InflationRadius` at least as large as the robot radius plus padding; lowering below the body radius can make Nav2 plan through collisions.

The DOGZILLA scan filter publishes `/scan_nav2` for Nav2 costmaps and masks the observed rear self-hit arc. The default mask is `120-260` degrees under `0.45 m`, which ignores close body/wire bounces behind the robot without hiding normal front obstacle data. Startup sets `inf_is_valid` on the filtered LaserScan source so masked rays can clear stale costmap cells instead of leaving old body hits behind.
