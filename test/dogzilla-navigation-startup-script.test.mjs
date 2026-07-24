import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import test from 'node:test'

const SCRIPT_PATH = new URL('../sidecars/dogzilla_navigation/start-navigation-in-container.sh', import.meta.url)
const AVOIDANCE_CONFIG_PATH = new URL('../config/robot-obstacle-avoidance.json', import.meta.url)
const SCAN_SELF_FILTER_PATH = new URL('../sidecars/dogzilla_navigation/scan_self_filter.py', import.meta.url)
const TF_ODOM_PUBLISHER_PATH = new URL('../sidecars/dogzilla_navigation/tf_odom_publisher.py', import.meta.url)
const LAUNCH_PATH = new URL('../sidecars/dogzilla_navigation/robodoge_nav2_navigation_launch.py', import.meta.url)
const GAIT_ADAPTER_PATH = new URL('../sidecars/dogzilla_navigation/cmd_vel_gait_adapter.py', import.meta.url)
const WAIT_NAV2_READY_PATH = new URL('../sidecars/dogzilla_navigation/wait-nav2-ready.sh', import.meta.url)
const NAV2_READINESS_LOGIC_PATH = new URL('../sidecars/dogzilla_navigation/nav2_readiness_logic.py', import.meta.url)
const STOP_NAV2_OWNER_PATH = new URL('../sidecars/dogzilla_navigation/stop-navigation-owner-in-container.sh', import.meta.url)
const NAV2_OWNER_STATUS_PATH = new URL('../sidecars/dogzilla_navigation/navigation-owner-status-in-container.sh', import.meta.url)
const NAV2_GAIT_MAPPING_PATH = new URL('../sidecars/dogzilla_lib_bridge/nav2_gait_adapter.py', import.meta.url)
const CORNER_RECOVERY_BT_PATH = new URL('../sidecars/dogzilla_navigation/robodoge_navigate_to_pose_corner_recovery.xml', import.meta.url)
const ROSBRIDGE_SCRIPT_PATH = new URL('../sidecars/dogzilla_rosbridge/start-rosbridge-in-container.sh', import.meta.url)
const MAP_POSE_SCRIPT_PATH = new URL('../sidecars/dogzilla_map_pose/start-map-pose-in-container.sh', import.meta.url)
const SAVE_MAP_POSE_SCRIPT_PATH = new URL('../sidecars/dogzilla_map_pose/save-map-pose-in-container.sh', import.meta.url)
const PROMOTE_CANDIDATE_SCRIPT_PATH = new URL('../sidecars/dogzilla_map_pose/promote-candidate-map-in-container.sh', import.meta.url)
const AUTONOMOUS_MAPPING_SSH_SCRIPT_PATH = new URL('../scripts/start-dogzilla-autonomous-mapping-ssh.ps1', import.meta.url)
const FINISH_AUTONOMOUS_MAPPING_SSH_SCRIPT_PATH = new URL('../scripts/finish-dogzilla-autonomous-mapping-ssh.ps1', import.meta.url)
const SSH_COMMON_SCRIPT_PATH = new URL('../scripts/dogzilla-ssh-common.ps1', import.meta.url)
const SSH_SCRIPT_PATH = new URL('../scripts/start-dogzilla-navigation-ssh.ps1', import.meta.url)
const BRIDGE_SSH_SCRIPT_PATH = new URL('../scripts/start-dogzilla-bridge-ssh.ps1', import.meta.url)
const YOLO_SSH_SCRIPT_PATH = new URL('../scripts/start-dogzilla-yolo-vision-ssh.ps1', import.meta.url)
const BOOT_SERVICES_SCRIPT_PATH = new URL('../scripts/install-dogzilla-boot-services-ssh.ps1', import.meta.url)
const AUDIO_SSH_SCRIPT_PATH = new URL('../scripts/start-dogzilla-audio-cue-ssh.ps1', import.meta.url)
const MAP_POSE_SSH_SCRIPT_PATH = new URL('../scripts/start-dogzilla-map-pose-ssh.ps1', import.meta.url)
const NOIMU_LOCALIZATION_LUA_PATH = new URL('../sidecars/dogzilla_map_pose/robodoge_dogzilla_laser_only_noimu_localization.lua', import.meta.url)
const IMU_LOCALIZATION_LUA_PATH = new URL('../sidecars/dogzilla_map_pose/robodoge_dogzilla_laser_only_localization.lua', import.meta.url)
const NOIMU_RECOVERY_LUA_PATH = new URL('../sidecars/dogzilla_map_pose/robodoge_dogzilla_laser_only_noimu_localization_recovery.lua', import.meta.url)
const IMU_RECOVERY_LUA_PATH = new URL('../sidecars/dogzilla_map_pose/robodoge_dogzilla_laser_only_localization_recovery.lua', import.meta.url)
const RELOCALIZE_SCRIPT_PATH = new URL('../sidecars/dogzilla_map_pose/relocalize_on_frozen_map.py', import.meta.url)
const YOLO_SERVER_PATH = new URL('../sidecars/dogzilla_yolo_vision/server.py', import.meta.url)

test('DOGZILLA scan self filter uses sensor data QoS for LiDAR compatibility', async () => {
  const script = await readFile(SCAN_SELF_FILTER_PATH, 'utf-8')
  const launch = await readFile(LAUNCH_PATH, 'utf-8')

  assert.match(script, /qos_profile_sensor_data/)
  assert.match(script, /--mask-start-deg", type=float, required=True/)
  assert.match(script, /--mask-end-deg", type=float, required=True/)
  assert.match(script, /--mask-range-m", type=float, required=True/)
  assert.match(script, /--self-radius-m", type=float, default=0\.0/)
  assert.match(launch, /"--self-radius-m", os\.environ\["DOGZILLA_NAV2_ROBOT_RADIUS"\]/)
  assert.match(script, /create_publisher\(LaserScan, args\.output_topic, qos_profile_sensor_data\)/)
  assert.match(script, /create_subscription\(\s*LaserScan,\s*args\.input_topic,\s*self\.filter_scan,\s*qos_profile_sensor_data,\s*\)/s)
})

test('DOGZILLA rosbridge startup requires live LiDAR scan samples', async () => {
  const script = await readFile(ROSBRIDGE_SCRIPT_PATH, 'utf-8')

  assert.match(script, /SCAN_STARTUP_TIMEOUT_SEC="\$\{DOGZILLA_SCAN_STARTUP_TIMEOUT_SEC:-20\}"/)
  assert.match(script, /def on_scan\(_msg\):/)
  assert.match(script, /create_subscription\(LaserScan, topic, on_scan, qos_profile_sensor_data\)/)
  assert.match(script, /No LiDAR scan sample on \$\{SCAN_TOPIC\}/)
  assert.match(script, /scan_watchdog \&/)
  assert.doesNotMatch(script, /\bapt-get\s+(update|install)\b/)
})

test('DOGZILLA Nav2 startup loads checked-in tuning as its canonical defaults', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /DOGZILLA_NAV2_BASE_PARAMS=.*nav2_bringup\/params\/nav2_params\.yaml/)
  assert.match(script, /DOGZILLA_NAV2_CONFIG="\$\{DOGZILLA_NAV2_CONFIG:-\$REMOTE_ROOT\/config\/robot-obstacle-avoidance\.json\}"/)
  assert.match(script, /json\.load\(/)
  assert.doesNotMatch(script, /if env_name in os\.environ:/)
  assert.match(script, /nav2RobotRadius.*DOGZILLA_NAV2_ROBOT_RADIUS/s)
  assert.match(script, /nav2InflationRadius.*DOGZILLA_NAV2_INFLATION_RADIUS/s)
  assert.doesNotMatch(script, /DOGZILLA_NAV2_ROBOT_RADIUS="\$\{DOGZILLA_NAV2_ROBOT_RADIUS:-0\.16\}"/)
  assert.doesNotMatch(script, /DOGZILLA_NAV2_INFLATION_RADIUS="\$\{DOGZILLA_NAV2_INFLATION_RADIUS:-0\.28\}"/)
  assert.match(script, /yaml\.safe_load/)
  assert.match(script, /robot_radius/)
  assert.match(script, /inflation_radius/)
  assert.match(script, /params_file:="\$DOGZILLA_NAV2_PARAMS"/)
})

test('DOGZILLA Nav2 startup lowers loop rates for Pi runtime load', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /nav2ControllerFrequency.*DOGZILLA_NAV2_CONTROLLER_FREQUENCY/s)
  assert.match(script, /nav2BtLoopDurationMs.*DOGZILLA_NAV2_BT_LOOP_DURATION_MS/s)
  assert.match(script, /nav2BtServerTimeoutMs.*DOGZILLA_NAV2_BT_SERVER_TIMEOUT_MS/s)
  assert.match(script, /ctrl\["controller_frequency"\] = cf/)
  assert.match(script, /btn\["bt_loop_duration"\] = bld/)
  assert.match(script, /btn\["default_server_timeout"\] = bst/)
  assert.match(script, /btn\["wait_for_service_timeout"\] = bws/)
  assert.match(script, /pln\["expected_planner_frequency"\] = pf/)
  assert.match(script, /vs\["smoothing_frequency"\] = sf/)
})

test('DOGZILLA Nav2 startup loosens progress checker for slow quadruped gait', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /nav2RequiredMovementRadius.*DOGZILLA_NAV2_REQUIRED_MOVEMENT_RADIUS/s)
  assert.match(script, /nav2MovementTimeAllowance.*DOGZILLA_NAV2_MOVEMENT_TIME_ALLOWANCE/s)
  assert.match(script, /nav2FailureTolerance.*DOGZILLA_NAV2_FAILURE_TOLERANCE/s)
  assert.match(script, /nav2MinSpeedXy.*DOGZILLA_NAV2_MIN_SPEED_XY/s)
  assert.match(script, /nav2TransStoppedVelocity.*DOGZILLA_NAV2_TRANS_STOPPED_VELOCITY/s)
  assert.match(script, /pc\["required_movement_radius"\] = rmr/)
  assert.match(script, /pc\["movement_time_allowance"\] = mta/)
  assert.match(script, /ctrl\["failure_tolerance"\] = max/)
  assert.match(script, /DOGZILLA_NAV2_MAPPING_MIN_SPEED_XY="\$\{DOGZILLA_NAV2_MAPPING_MIN_SPEED_XY:-0\.13\}"/)
  assert.match(script, /mapping_msx = max\(env_f_required\("DOGZILLA_NAV2_MAPPING_MIN_SPEED_XY"\), 0\.0\)/)
  assert.match(script, /fp2\["min_vel_x"\] = 0\.0/)
  assert.match(script, /fp2\["min_speed_xy"\] = max\(msx, mapping_msx\) if mapping_mode else msx/)
  assert.match(script, /fp2\["trans_stopped_velocity"\] = tsv/)
})

test('autonomous mapping prefers forward DWB trajectories without banning pivots', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /DOGZILLA_NAV2_MAPPING_PREFER_FORWARD_SCALE="\$\{DOGZILLA_NAV2_MAPPING_PREFER_FORWARD_SCALE:-20\.0\}"/)
  assert.match(script, /mapping_prefer_forward_scale = max\(/)
  assert.match(script, /if mapping_mode and mapping_prefer_forward_scale > 0\.0:/)
  assert.match(script, /critics\.index\("BaseObstacle"\) \+ 1/)
  assert.match(script, /critics\.insert\(insert_at, "PreferForward"\)/)
  assert.match(script, /fp2\["PreferForward\.scale"\] = mapping_prefer_forward_scale/)
  assert.doesNotMatch(script, /fp2\["min_vel_x"\] = max\(/)
})

test('DOGZILLA Nav2 startup ignores final yaw by default', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /yawGoalTolerance.*DOGZILLA_NAV2_YAW_GOAL_TOLERANCE/s)
  assert.match(script, /fp2\["yaw_goal_tolerance"\] = yaw/)
  assert.match(script, /goal_checker\["yaw_goal_tolerance"\] = yaw/)
  assert.match(script, /scan_source_topic = st if sfe else/)
})

test('DOGZILLA Nav2 launch routes controller and recovery cmd_vel through velocity smoother', async () => {
  const launch = await readFile(LAUNCH_PATH, 'utf-8')
  const controllerBlock = nodeBlock(launch, 'nav2_controller')
  const behaviorBlock = nodeBlock(launch, 'nav2_behaviors')
  const smootherBlock = nodeBlock(launch, 'nav2_velocity_smoother')
  const amclBlock = nodeBlock(launch, 'nav2_amcl')

  assert.match(controllerBlock, /remappings=remappings \+ \[\("cmd_vel", "cmd_vel_nav"\)\]/)
  assert.match(behaviorBlock, /remappings=remappings \+ \[\("cmd_vel", "cmd_vel_nav"\)\]/)
  assert.match(smootherBlock, /\("cmd_vel", "cmd_vel_nav"\), \("cmd_vel_smoothed", "cmd_vel_raw"\)/)
  assert.match(amclBlock, /package="nav2_amcl"/)
  assert.match(launch, /DeclareLaunchArgument\("localization_backend", default_value="amcl"\)/)
})

test('DOGZILLA Nav2 startup uses cmd_vel gait adapter as the default base consumer', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')
  const launch = await readFile(LAUNCH_PATH, 'utf-8')

  assert.match(script, /DOGZILLA_NAV2_GAIT_ADAPTER_ENABLED="\$\{DOGZILLA_NAV2_GAIT_ADAPTER_ENABLED:-1\}"/)
  assert.match(launch, /cmd_vel_gait_adapter\.py/)
  assert.match(launch, /DOGZILLA_NAV2_GAIT_ADAPTER_URL/)
  assert.match(launch, /"--input-topic", gait_input_topic/)
  assert.match(script, /DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC="\$\{DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC:-\/cmd_vel\}"/)
  assert.doesNotMatch(script, /DOGZILLA_NAV2_GAIT_SMOOTHER_BYPASS/)
  assert.match(script, /collision_monitor/)
  assert.match(script, /"cmd_vel_in_topic": "cmd_vel_raw"/)
  assert.match(script, /"cmd_vel_out_topic": "cmd_vel"/)
  assert.match(script, /nav2CollisionSourceTimeout.*DOGZILLA_NAV2_COLLISION_SOURCE_TIMEOUT/s)
  assert.match(script, /"source_timeout": env_f_required\("DOGZILLA_NAV2_COLLISION_SOURCE_TIMEOUT"\)/)
  assert.match(script, /"topic": scan_source_topic/)
  assert.match(script, /"action_type": "stop"/)
  assert.match(launch, /"collision_monitor"/)
  assert.match(launch, /\("cmd_vel_smoothed", "cmd_vel_raw"\)/)
  assert.match(launch, /package="nav2_collision_monitor"/)
  assert.match(script, /"base_shift_correction": False/)
})

test('DOGZILLA Nav2 recovery never commands an in-place spin', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')
  const tree = await readFile(CORNER_RECOVERY_BT_PATH, 'utf-8')

  assert.match(script, /DOGZILLA_NAV2_BT_XML=.*robodoge_navigate_to_pose_corner_recovery\.xml/)
  assert.match(script, /NavigateToPose behavior tree missing/)
  assert.match(script, /export DOGZILLA_NAV2_BT_XML/)
  assert.match(script, /bt_xml = os\.environ\.get\("DOGZILLA_NAV2_BT_XML"\)/)
  assert.match(script, /btn\["default_nav_to_pose_bt_xml"\] = bt_xml/)
  assert.match(tree, /BackUp backup_dist="0\.20" backup_speed="0\.13"/)
  assert.ok(tree.indexOf('<BackUp ') < tree.indexOf('<Sequence name="ClearingActions">'))
  assert.doesNotMatch(tree, /<Spin\b/)
  assert.match(tree, /<RoundRobin name="RecoveryActions">/)
})

test('DOGZILLA Nav2 launch supervises scan, odom, and gait helpers', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')
  const launch = await readFile(LAUNCH_PATH, 'utf-8')

  assert.match(launch, /from launch\.actions import .*ExecuteProcess/)
  assert.match(launch, /scan_self_filter\.py/)
  assert.match(launch, /tf_odom_publisher\.py/)
  assert.match(launch, /cmd_vel_odom_publisher\.py/)
  assert.match(launch, /cmd_vel_gait_adapter\.py/)
  assert.match(launch, /ExecuteProcess\([\s\S]*?respawn=True,[\s\S]*?respawn_delay=2\.0/s)
  assert.match(script, /DOGZILLA_LOCALIZATION_BACKEND="\$\{DOGZILLA_LOCALIZATION_BACKEND:-amcl\}"/)
  assert.doesNotMatch(script, /nohup python3 .*scan_self_filter\.py/)
  assert.doesNotMatch(script, /nohup python3 .*tf_odom_publisher\.py/)
  assert.doesNotMatch(script, /nohup python3 .*cmd_vel_odom_publisher\.py/)
  assert.doesNotMatch(script, /nohup python3 .*cmd_vel_gait_adapter\.py/)
})

test('DOGZILLA odom helper uses laser-localized map fallback when real odom TF is absent', async () => {
  const helper = await readFile(TF_ODOM_PUBLISHER_PATH, 'utf-8')
  const launch = await readFile(LAUNCH_PATH, 'utf-8')

  assert.match(helper, /TransformBroadcaster/)
  assert.match(helper, /--synthetic-fallback-after-sec", type=float, default=0\.0/)
  assert.match(helper, /class FallbackAuthority/)
  assert.match(helper, /if synthetic_fallback_active and fallback_source_frame:\s+return \(fallback_source_frame,\)/)
  assert.match(helper, /get_publishers_info_by_topic\("\/tf"\)/)
  assert.match(helper, /real_authority_present=real_authority_present/)
  assert.match(helper, /self\.synthetic_broadcaster\.sendTransform\(synthetic_transform\)/)
  assert.match(launch, /"--fallback-source-frame", "map"/)
  assert.match(launch, /"--synthetic-fallback-after-sec", "1\.0"/)
  assert.match(launch, /"--real-authority-node", "cartographer_node"/)
})

test('DOGZILLA Nav2 startup generates params with expected values', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /src_cfg\["topic"\] = st/)
  assert.match(script, /inf_is_valid/)
  assert.doesNotMatch(script, /source\.get\("topic"\) == "\/scan"/)
})

test('DOGZILLA Nav2 startup is foreground systemd ownership, not repair loop', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /Starting Pi-owned Nav2\./)
  assert.match(script, /setsid ros2 launch "\$DOGZILLA_NAV2_LAUNCH"/)
  assert.match(script, /nav2_launch_pid=\$!/)
  assert.match(script, /autostart:=true/)
  assert.match(script, /use_respawn:=true/)
  assert.match(script, /exec 9>"\$DOGZILLA_NAV2_LOCK_FILE"/)
  assert.match(script, /flock -n 9/)
  assert.ok(script.indexOf('flock -n 9') < script.indexOf('pkill -9 -f "ros2.*daemon"'))
  assert.doesNotMatch(script, /ros2 lifecycle set/)
  assert.doesNotMatch(script, /try_graceful_nav2_recovery/)
  assert.doesNotMatch(script, /Managed nodes are active/)
  assert.match(script, /SIGKILL is asynchronous from the ROS graph's point of view/)
  assert.match(script, /pgrep -f "\[r\]os2 launch .*robodoge_nav2_navigation_launch\.py"/)
  assert.match(script, /pgrep -f "\[l\]ifecycle_manager_navigation"/)
})
test('DOGZILLA map-pose startup waits for fresh pose after Cartographer restart', async () => {
  const script = await readFile(MAP_POSE_SCRIPT_PATH, 'utf-8')

  assert.match(script, /tf_buffer\.lookup_transform\("map", "base_link", rclpy\.time\.Time\(\)\)/)
  assert.match(script, /"frame": "map"/)
  assert.doesNotMatch(script, /python3 - <<'PY' \|\| echo "Map-pose TF not ready/)
  assert.match(script, /if ! python3 - <<'PY'[\s\S]*then\s+echo "Map-pose TF not ready[\s\S]*exit 4\s+fi\s+touch "\$READY_MARKER"/)
})

test('DOGZILLA map-pose startup cleanly restarts stale Cartographer processes', async () => {
  const script = await readFile(MAP_POSE_SCRIPT_PATH, 'utf-8')

  assert.match(script, /stop_existing_cartographer\(\)/)
  assert.match(script, /pkill -TERM -f "\[c\]artographer_node\.\*robodoge_dogzilla_laser_only"/)
  assert.match(script, /pkill -KILL -f "\[c\]artographer_node\.\*robodoge_dogzilla_laser_only"/)
  assert.match(script, /Cartographer has \$CARTOGRAPHER_COUNT matching processes/)
})

test('DOGZILLA map-pose startup selects no-IMU config before Cartographer launch', async () => {
  const script = await readFile(MAP_POSE_SCRIPT_PATH, 'utf-8')
  const imuConfigIndex = script.indexOf('IMU_CONFIG="_noimu"')
  const cartographerArgsIndex = script.indexOf('cartographer_args=(')

  assert.ok(imuConfigIndex > 0, 'expected no-IMU config assignment')
  assert.ok(cartographerArgsIndex > 0, 'expected Cartographer arg construction')
  assert.ok(imuConfigIndex < cartographerArgsIndex, 'IMU_CONFIG must be resolved before Cartographer args are built')
  assert.match(script, /DOGZILLA_IMU_AVAILABLE="\$\{DOGZILLA_IMU_AVAILABLE:-false\}"/)
  assert.doesNotMatch(script, /robodoge_dogzilla_laser_only-noimu/)
})

test('DOGZILLA map-pose startup resolves active pbstream from map metadata', async () => {
  const script = await readFile(MAP_POSE_SCRIPT_PATH, 'utf-8')

  assert.match(script, /DOGZILLA_MAP_METADATA/)
  assert.match(script, /from map_metadata import read_active_map_metadata/)
  assert.match(script, /read_active_map_metadata\(Path\(sys\.argv\[1\]\)\)/)
  assert.match(script, /metadata\.get\("available"\) is not True/)
  assert.match(script, /metadata\.get\(['"]error['"]\)/)
  assert.match(script, /metadata\.get\("pbstream"\)/)
  assert.match(script, /Active map manifest missing, invalid, or overridden/)
  assert.doesNotMatch(script, /robodoge_home_\*\.pbstream/)
})

test('Continue Current Map resumes the newest verified candidate without promoting it', async () => {
  const [launcher, mapPoseLauncher, startup, relocalize] = await Promise.all([
    readFile(AUTONOMOUS_MAPPING_SSH_SCRIPT_PATH, 'utf-8'),
    readFile(MAP_POSE_SSH_SCRIPT_PATH, 'utf-8'),
    readFile(MAP_POSE_SCRIPT_PATH, 'utf-8'),
    readFile(RELOCALIZE_SCRIPT_PATH, 'utf-8'),
  ])

  assert.match(launcher, /select_resume_map\.py/)
  assert.match(launcher, /ValidateSet\("active", "candidate"\)/)
  assert.match(launcher, /--source \$ResumeSource/)
  assert.match(launcher, /resumeSelection\.source/)
  assert.match(launcher, /resumeSelection\.metadata/)
  assert.match(launcher, /resumeSelection\.pbstream/)
  assert.match(launcher, /-MapMetadataPath \$resumeMetadataPath -MapPath \$resumeMapPath/)
  assert.match(launcher, /AllowPoseHintJump = \$AllowPoseHintJump/)
  assert.doesNotMatch(launcher, /promote-candidate-map-in-container/)
  assert.match(mapPoseLauncher, /\[string\]\$MapMetadataPath = ""/)
  assert.match(mapPoseLauncher, /DOGZILLA_MAP_METADATA=\$MapMetadataPath/)
  assert.match(mapPoseLauncher, /DOGZILLA_ALLOW_POSE_HINT_JUMP=1/)
  assert.match(mapPoseLauncher, /--allow-pose-hint-jump/)
  assert.match(startup, /--map-metadata "\$DOGZILLA_MAP_METADATA"/)
  assert.match(startup, /DOGZILLA_ALLOW_POSE_HINT_JUMP/)
  assert.match(startup, /recovery_args\+=\(--allow-pose-hint-jump\)/)
  assert.match(relocalize, /--map-metadata/)
  assert.match(relocalize, /--allow-pose-hint-jump/)
  assert.match(relocalize, /Path\(self\.args\.map_metadata\)/)
})

test('DOGZILLA Nav2 startup disables lateral motion after sustained-walk falls', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /mvy = 0\.0/)
  assert.match(script, /lay = 0\.0/)
  assert.match(script, /vys = 1/)
  assert.doesNotMatch(script, /DOGZILLA_NAV2_MAX_LATERAL_VELOCITY/)
  assert.match(script, /fp2\["min_vel_y"\] = -mvy/)
  assert.match(script, /fp2\["max_vel_y"\] = mvy/)
  assert.match(script, /fp2\["acc_lim_y"\] = lay/)
  assert.match(script, /fp2\["decel_lim_y"\] = -lay/)
  assert.match(script, /fp2\["vy_samples"\] = vys/)
  assert.match(script, /vs\["max_velocity"\]\[1\] = mvy/)
  assert.match(script, /vs\["min_velocity"\]\[1\] = -mvy/)
  assert.match(script, /vs\["max_accel"\]\[1\] = lay/)
  assert.match(script, /vs\["max_decel"\]\[1\] = -lay/)
})

test('DOGZILLA map-pose startup refuses startup-time package installs', async () => {
  const script = await readFile(MAP_POSE_SCRIPT_PATH, 'utf-8')

  assert.match(script, /map-pose-startup\.lock/)
  assert.doesNotMatch(script, /\bapt-get\s+(update|install)\b/)
  assert.doesNotMatch(script, /run_apt_get/)
  assert.match(script, /Required map-pose\/SLAM ROS packages missing/)
  assert.match(script, /Refusing startup-time install/)
  assert.match(script, /exec 8>&- 2>\/dev\/null \|\| true[\s\S]+nohup "\$\{cartographer_args\[@\]\}"/)
  assert.match(script, /DOGZILLA_MAP_POSE_OCCUPANCY_GRID="\$\{DOGZILLA_MAP_POSE_OCCUPANCY_GRID:-auto\}"/)
  assert.match(script, /if \[ "\$mode" = "mapping" \] \|\| \[ "\$mode" = "continue_mapping" \]/)
  assert.match(script, /exec 8>&- 2>\/dev\/null \|\| true[\s\S]+cartographer_occupancy_grid_node/)
})

test('DOGZILLA Nav2 mapping mode uses Cartographer map without map server or AMCL', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')
  const launch = await readFile(LAUNCH_PATH, 'utf-8')

  assert.match(script, /DOGZILLA_NAV2_MAPPING_MODE="\$\{DOGZILLA_NAV2_MAPPING_MODE:-0\}"/)
  assert.match(script, /"map_topic": "\/map_cartographer"/)
  assert.match(script, /DOGZILLA_NAV2_MAP="\$\{DOGZILLA_NAV2_MAP:-\/dev\/null\}"/)
  assert.match(script, /"map_subscribe_transient_local": False/)
  assert.match(script, /if \[ "\$DOGZILLA_NAV2_MAPPING_MODE" != "1" \] && \[ ! -s "\$DOGZILLA_NAV2_MAP" \]/)
  assert.match(launch, /DeclareLaunchArgument\("mapping_mode", default_value="false"\)/)
  assert.match(launch, /if backend == "amcl" and not is_mapping_mode:/)
  assert.match(launch, /\*\(\[\] if is_mapping_mode else \[Node\(/)
})

test('candidate save and promotion never overwrite the active map until promotion', async () => {
  const save = await readFile(SAVE_MAP_POSE_SCRIPT_PATH, 'utf-8')
  const promote = await readFile(PROMOTE_CANDIDATE_SCRIPT_PATH, 'utf-8')

  assert.match(save, /DOGZILLA_MAP_SAVE_CANDIDATE/)
  assert.match(save, /maps\/candidates\/\$map_id/)
  assert.match(save, /"state": "candidate"/)
  assert.match(save, /robodoge_mapping_resume_pose_capture/)
  assert.match(save, /resumePose/)
  assert.ok(save.indexOf('lookup_transform("map", "base_link"') < save.indexOf('ros2 service call \/write_state'))
  assert.match(save, /sha256sum/)
  assert.doesNotMatch(save, /ros2 service list \| grep -qx "\/write_state"/)
  assert.match(save, /timeout 20s ros2 service call \/write_state/)
  assert.match(save, /exit 0/)
  assert.match(promote, /robodoge_home\.pbstream/)
  assert.match(promote, /robodoge_home\.pgm/)
  assert.match(promote, /robodoge_home\.yaml/)
  assert.match(promote, /SHA-256 mismatch/)
  assert.match(promote, /\.promotion-backups/)
  assert.match(promote, /restoring previous active map/)
  assert.match(promote, /"state": "active"/)
})

test('autonomous mapping refuses duplicate jobs before restarting mapping services', async () => {
  const script = await readFile(AUTONOMOUS_MAPPING_SSH_SCRIPT_PATH, 'utf-8')
  const explorer = await readFile(new URL('../sidecars/dogzilla_navigation/frontier_explorer.py', import.meta.url), 'utf-8')
  const supervisor = await readFile(new URL('../sidecars/dogzilla_navigation/autonomous_mapping_supervisor.sh', import.meta.url), 'utf-8')

  assert.match(script, /pgrep -f ""\[f\]rontier_explorer\.py""/)
  assert.match(script, /Autonomous mapping is already running/)
  assert.match(supervisor, /stop-navigation-owner-in-container\.sh" mapping/)
  assert.doesNotMatch(supervisor, /for pid in \$\(pgrep -f "\/opt\/ros\/humble\/lib\/nav2_/)
  assert.match(script, /systemd-run .*robodoge-autonomous-mapping/)
  assert.match(script, /autonomous-mapping\.ready/)
  assert.ok(script.indexOf('systemd-run') < script.indexOf('start-dogzilla-map-pose-ssh.ps1'))
  assert.match(supervisor, /--lock-file.*autonomous-mapping\.lock/)
  assert.match(supervisor, /READY_FILE/)
  assert.match(supervisor, /restore_localization/)
  assert.match(supervisor, /systemctl reset-failed robodoge-map-pose\.service robodoge-navigation\.service/)
  assert.match(supervisor, /active_map_has_verified_pbstream/)
  assert.match(supervisor, /candidate-ready/)
  assert.match(supervisor, /if \[ "\$motion_proven" = true \] && \{ \[ "\$finish_requested" = true \]/)
  assert.match(supervisor, /candidate=false no_verified_motion/)
  assert.match(supervisor, /healthz-lite/)
  assert.match(supervisor, /value <= warning/)
  assert.match(supervisor, /autonomous-mapping-save\.log/)
  assert.match(supervisor, /wait_for_mapping_nav2/)
  assert.match(supervisor, /wait-nav2-ready\.sh/)
  assert.match(supervisor, /mapping_nav2_not_ready; no_frontier_goal_sent/)
  assert.ok(supervisor.indexOf('wait_for_mapping_nav2') < supervisor.indexOf("exec python3 -u '$EXPLORER'"))
  assert.match(supervisor, /sessionTranslationCommandSec/)
  assert.match(supervisor, /displacement >= 0\.05 and translation_command_sec >=/)
  assert.match(explorer, /create_subscription\(Twist, args\.cmd_vel_topic, self\._on_cmd_vel, 10\)/)
  assert.match(explorer, /rotation_command_sec >= self\.args\.rotation_timeout/)
  assert.match(supervisor, /\[ "\$explorer_exit" -eq 0 \]/)
  assert.match(supervisor, /autonomous-mapping\.active/)
  assert.match(supervisor, /mapping_start_cancelled/)
  assert.match(supervisor, /mapping_start_not_ready_restore_failed/)
  assert.match(supervisor, /if restore_localization; then\s+write_result "\$RESULT_FILE" restored "mapping_start_not_ready"/)
  assert.match(script, /\$common = @\{/)
  assert.doesNotMatch(script, /\$common = @\('-PiIp'/)
  assert.match(supervisor, /source \/opt\/ros\/humble\/setup\.bash/)
  assert.match(explorer, /ReliabilityPolicy\.BEST_EFFORT/)
  assert.match(explorer, /DurabilityPolicy\.TRANSIENT_LOCAL/)
  assert.match(explorer, /self\.map_message is None[\s\S]*now - self\.started_monotonic > self\.args\.action_timeout/)
  assert.match(explorer, /now - self\.map_received_at > self\.args\.map_timeout/)
  assert.ok(script.indexOf('pgrep -f') < script.indexOf('start-dogzilla-map-pose-ssh.ps1'))
  assert.doesNotMatch(script, /127\.0\.0\.1:8893\/mode/)
  assert.doesNotMatch(script, /mapping_resume_pose|resumeGoalPython|resumeAccepted/)
  assert.match(script, /127\.0\.0\.1:8893\/healthz/)
  assert.match(script, /batterySafety/)
  assert.match(script, /Last status/)
  assert.match(script, /Write-AutonomousMappingFailure/)
  assert.match(script, /autonomous-mapping-result\.json/)
  assert.doesNotMatch(script, /if \(\$ContinueCurrentMap\) \{\s+\$preflightStatus/)
  assert.doesNotMatch(script, /127\.0\.0\.1:8893\/commands|waitForResult|goalCompleted/)
  assert.match(script, /gait_reason=='command_preempt'/)
  assert.doesNotMatch(script, /stableReadySec|stable>=6/)
  assert.doesNotMatch(supervisor, /--max-failures/)
  assert.doesNotMatch(supervisor, /MAPPING_GOAL_TIMEOUT_SEC|--goal-timeout|--goal-progress-distance/)
  assert.match(supervisor, /--goal-max-duration 90/)
  assert.match(supervisor, /--failed-goal-radius 0\.5/)
  assert.match(supervisor, /--cancel-timeout '\$MAPPING_CANCEL_TIMEOUT_SEC'/)
  assert.match(supervisor, /--scan-timeout '\$MAPPING_SCAN_TIMEOUT_SEC'/)
  assert.match(supervisor, /DOGZILLA_MAPPING_SCAN_PAUSE_SEC:-2/)
  assert.match(supervisor, /DOGZILLA_MAPPING_SCAN_TIMEOUT_SEC:-120/)
  assert.match(supervisor, /--scan-pause-after '\$MAPPING_SCAN_PAUSE_SEC'/)
  assert.match(script, /No motion is needed before mapping resumes/)
  assert.doesNotMatch(script, /ros2 action send_goal/)
  assert.ok(script.indexOf('ConvertTo-RemoteSingleQuote $preflightPython') < script.indexOf('RemoteCommand $reserveCommand'))
  assert.ok(script.indexOf('--unit=robodoge-autonomous-mapping --property') < script.indexOf('start-dogzilla-map-pose-ssh.ps1'))
  assert.doesNotMatch(script, /systemctl stop robodoge-navigation\.service/)
  assert.match(script, /systemctl stop \$startingUnit/)
  assert.match(script, /catch \{/)
  assert.match(script, /systemctl stop robodoge-autonomous-mapping/)
  assert.match(script, /-Mode localization -ForceRestart -RestoreOnly/)
  assert.match(script, /normal localization rollback also failed/)
  assert.doesNotMatch(script, /Normal Nav2 failed to restart/)
  assert.doesNotMatch(script, /clear.*emergency|emergency.*clear/i)
  assert.match(script, /-MappingMode -SkipReadinessWait/)
  assert.doesNotMatch(script, /-MappingMode -WakeBeforeReadiness/)
  assert.doesNotMatch(script, /navModeCommand|navModeDeadline|navModeReady|could not wake/)
  assert.ok(script.indexOf('start-dogzilla-map-pose-ssh.ps1') < script.indexOf('start-dogzilla-navigation-ssh.ps1'))
})

test('Stop Early fails fast for dead sessions and accepts only candidate proof', async () => {
  const finish = await readFile(FINISH_AUTONOMOUS_MAPPING_SSH_SCRIPT_PATH, 'utf-8')
  const sshCommon = await readFile(SSH_COMMON_SCRIPT_PATH, 'utf-8')

  assert.match(sshCommon, /\$sshArgs = @\("-n", "-F"/)
  assert.match(finish, /systemctl is-active --quiet robodoge-autonomous-mapping/)
  assert.match(finish, /no active session remains to finish/)
  assert.match(finish, /"candidate-ready"\|candidate=true/)
})

test('shared DOGZILLA SSH line-ending repair is singular and non-interactive', async () => {
  const sshCommon = await readFile(SSH_COMMON_SCRIPT_PATH, 'utf-8')
  const repairStart = sshCommon.indexOf('function Repair-RemoteScriptLineEndings')
  const repairEnd = sshCommon.indexOf('function Invoke-DogzillaSsh')
  const repair = sshCommon.slice(repairStart, repairEnd)

  assert.equal((sshCommon.match(/function Repair-RemoteScriptLineEndings/g) ?? []).length, 1)
  assert.match(repair, /\$sshArgs = @\("-n", "-F"/)
})

test('DOGZILLA map save refuses localization and writes unique map identity', async () => {
  const script = await readFile(SAVE_MAP_POSE_SCRIPT_PATH, 'utf-8')

  assert.match(script, /Refusing to save map while Cartographer is in localization mode/)
  assert.match(script, /DOGZILLA_MAP_SAVE_ALLOW_LOCALIZATION/)
  assert.match(script, /map_id="\$\{DOGZILLA_MAP_ID:-robodoge_home_\$\(date -u \+%Y%m%dT%H%M%SZ\)\}"/)
  assert.match(script, /conversion_status" != "ok"/)
  assert.match(script, /grep -F "cartographer_ros cartographer_pbstream_to_ros_map" >\/dev\/null/)
  assert.doesNotMatch(script, /ros2 pkg executables cartographer_ros[^\n]+grep -q/)
  assert.match(script, /Refusing to update \$DOGZILLA_MAP_METADATA/)
  assert.match(script, /"id": "\$map_id"/)
  assert.match(script, /"activeAlias": "robodoge_home"/)
})

test('DOGZILLA Nav2 startup resolves map yaml from active map metadata', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /DOGZILLA_MAP_METADATA/)
  assert.match(script, /from map_metadata import read_active_map_metadata/)
  assert.match(script, /read_active_map_metadata\(Path\(sys\.argv\[1\]\)\)/)
  assert.match(script, /metadata\.get\("available"\) is not True/)
  assert.match(script, /metadata\.get\(['"]error['"]\)/)
  assert.match(script, /metadata\.get\("yaml"\)/)
  assert.match(script, /Active map manifest missing, invalid, or overridden/)
})

test('DOGZILLA Nav2 startup refuses startup-time package installs', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.doesNotMatch(script, /nav2-startup\.lock/)
  assert.doesNotMatch(script, /\bapt-get\s+(update|install)\b/)
  assert.doesNotMatch(script, /run_apt_get/)
  assert.match(script, /Required Nav2 ROS packages missing/)
  assert.doesNotMatch(script, /Refusing startup-time install/)
  assert.doesNotMatch(script, /exec 8>&-/)
})

test('DOGZILLA direct bridge background startup avoids nested SSH heredocs', async () => {
  const script = await readFile(BRIDGE_SSH_SCRIPT_PATH, 'utf-8')

  assert.doesNotMatch(script, /python3 - <<'PY'/)
  assert.match(script, /\$stopPattern = if \(\$processPath\.Length -gt 0\)/)
  assert.match(script, /pgrep -f ' \+ \$stopPatternQuoted/)
  assert.match(script, /\[ "\$pid" = "\$\$" \] \|\| \[ "\$pid" = "\$PPID" \]/)
  assert.match(script, /kill -TERM "\$pid"/)
  assert.match(script, /kill -KILL "\$pid"/)
})

test('DOGZILLA support service background startups avoid nested SSH heredocs', async () => {
  const yoloScript = await readFile(YOLO_SSH_SCRIPT_PATH, 'utf-8')
  const bootServicesScript = await readFile(BOOT_SERVICES_SCRIPT_PATH, 'utf-8')
  const audioScript = await readFile(AUDIO_SSH_SCRIPT_PATH, 'utf-8')

  assert.doesNotMatch(yoloScript, /python3 - <<'PY'/)
  assert.doesNotMatch(yoloScript, /\$detectCameraCommand = @'/)
  assert.match(yoloScript, /\$detectCameraCommand = 'for candidate in \/dev\/v4l\/by-id\/\*video-index0/)
  assert.match(yoloScript, /python3 -c \$installProbeQuoted/)
  assert.match(yoloScript, /\[switch\]\$DetectionEnabled/)
  assert.match(yoloScript, /\$detectionFlag = if \(\$DetectionEnabled\)/)
  assert.match(yoloScript, /--raw-stream/)
  assert.match(yoloScript, /fuser -k \$releaseCameraSource/)
  assert.match(yoloScript, /\$stopPattern = "\[s\]idecars\/dogzilla_yolo_vision\/server\.py"/)
  assert.match(yoloScript, /pgrep -f ' \+ \$stopPatternQuoted/)
  assert.match(yoloScript, /\[ "\$pid" = "\$\$" \] \|\| \[ "\$pid" = "\$PPID" \]/)
  assert.match(yoloScript, /kill -TERM "\$pid"/)
  assert.match(yoloScript, /kill -KILL "\$pid"/)
  assert.match(yoloScript, /systemctl restart robodoge-yolo-vision\.service/)
  assert.match(yoloScript, /YOLO_DETECTION_FLAG=/)
  assert.match(bootServicesScript, /EnvironmentFile=-\/etc\/robodoge\/yolo-vision\.env/)
  assert.match(bootServicesScript, /\\\$YOLO_DETECTION_FLAG/)

  assert.doesNotMatch(audioScript, /python3 - <<'PY'/)
  assert.match(audioScript, /\$stopPattern = "\[s\]idecars\/dogzilla_audio_cue\/server\.py"/)
  assert.match(audioScript, /pgrep -f ' \+ \$stopPatternQuoted/)
  assert.match(audioScript, /\[ "\$pid" = "\$\$" \] \|\| \[ "\$pid" = "\$PPID" \]/)
  assert.match(audioScript, /kill -TERM "\$pid"/)
  assert.match(audioScript, /kill -KILL "\$pid"/)
})

test('DOGZILLA YOLO server allows immediate restart on the same port', async () => {
  const server = await readFile(YOLO_SERVER_PATH, 'utf-8')

  assert.match(server, /class ReusableThreadingHTTPServer\(ThreadingHTTPServer\):/)
  assert.match(server, /allow_reuse_address = True/)
  assert.match(server, /server = ReusableThreadingHTTPServer\(\(args\.host, args\.port\), VisionHandler\)/)
})

test('DOGZILLA Nav2 SSH startup ships map-pose and IMU sidecars for odom TF repair', async () => {
  const script = await readFile(SSH_SCRIPT_PATH, 'utf-8')

  assert.match(script, /sidecars\\dogzilla_navigation/)
  assert.match(script, /sidecars\\dogzilla_map_pose/)
  assert.match(script, /sidecars\\dogzilla_imu_publisher/)
  assert.match(script, /sudo chown -R \$\{User\}:\$User .*sidecars\/dogzilla_navigation .*sidecars\/dogzilla_map_pose .*sidecars\/dogzilla_imu_publisher .*sidecars\/dogzilla_lib_bridge .*config/)
  assert.match(script, /scp -r -F \$configPath \$mapPoseSource/)
  assert.match(script, /scp -r -F \$configPath \$imuPublisherSource/)
})

test('DOGZILLA Nav2 launchers sync canonical tuning without duplicating its defaults', async () => {
  const script = await readFile(SSH_SCRIPT_PATH, 'utf-8')
  const installer = await readFile(BOOT_SERVICES_SCRIPT_PATH, 'utf-8')

  assert.match(script, /config\\robot-obstacle-avoidance\.json/)
  assert.match(script, /scp -F \$configPath \$avoidanceConfigPath/)
  assert.doesNotMatch(script, /ConvertFrom-Json/)
  assert.doesNotMatch(script, /Use-PositiveConfigDouble/)
  assert.match(installer, /config\\robot-obstacle-avoidance\.json/)
  assert.match(installer, /scp -F \$configPath \$avoidanceConfigSource/)
})

test('manual Nav2 and map-pose deploys sync the shared active-map validator', async () => {
  for (const launcherPath of [SSH_SCRIPT_PATH, MAP_POSE_SSH_SCRIPT_PATH]) {
    const launcher = await readFile(launcherPath, 'utf-8')
    assert.match(launcher, /sidecars\\dogzilla_lib_bridge\\map_metadata\.py/)
    assert.match(launcher, /sidecars\/dogzilla_lib_bridge\/map_metadata\.py/)
    assert.match(launcher, /& scp -q -F \$configPath \$mapMetadataSource/)
    assert.match(launcher, /sudo install -o \$User -g \$User -m 0644/)
    assert.match(launcher, /throw "scp failed for shared map metadata validator"/)
    assert.match(launcher, /throw "sudo install failed for shared map metadata validator"/)
  }
})

test('DOGZILLA Nav2 SSH launcher leaves normal ownership to systemd', async () => {
  const script = await readFile(SSH_SCRIPT_PATH, 'utf-8')
  const installer = await readFile(BOOT_SERVICES_SCRIPT_PATH, 'utf-8')
  const readiness = await readFile(WAIT_NAV2_READY_PATH, 'utf-8')

  assert.match(script, /if \(\$MappingMode\) \{[\s\S]*docker exec -d/s)
  assert.match(script, /else \{[\s\S]*systemctl restart robodoge-navigation\.service/s)
  assert.match(script, /systemctl reset-failed robodoge-navigation\.service; sudo systemctl restart/)
  assert.match(script, /Mapping launch owns the explicit detached exception/)
  assert.match(script, /if \(-not \$MappingMode -and \(\$MapYaml -or \$nav2Env\)\)/)
  assert.match(script, /Normal navigation is systemd-owned and reads canonical tuning/)
  assert.doesNotMatch(readiness, /os\.replace\(temporary, readiness_file\)\\n/)
  assert.doesNotMatch(installer, /ExecStartPre=.*\[s\]tart-navigation-in-container\.sh/)
})

test('manual localization restarts clear the systemd rate limit', async () => {
  const script = await readFile(MAP_POSE_SSH_SCRIPT_PATH, 'utf-8')
  assert.match(script, /systemctl reset-failed robodoge-map-pose\.service; sudo systemctl start/)
})

test('DOGZILLA rear self-mask stops before the configured collision boundary', async () => {
  const config = JSON.parse(await readFile(AVOIDANCE_CONFIG_PATH, 'utf-8'))
  const points = config.nav2CollisionStopPolygonPoints

  assert.ok(Array.isArray(points) && points.length >= 6 && points.length % 2 === 0)
  const xs = points.filter((_, index) => index % 2 === 0)
  const rearStopDistance = Math.abs(Math.min(...xs))
  assert.ok(config.nav2ScanFilterMaskRangeM <= 0.20)
  assert.ok(config.nav2ScanFilterMaskRangeM <= config.nav2RobotRadius)
  assert.ok(config.nav2ScanFilterMaskRangeM < rearStopDistance)
})

test('DOGZILLA cmd_vel gait adapter forwards Nav2 Twist to the non-preempting bridge endpoint', async () => {
  const adapter = await readFile(GAIT_ADAPTER_PATH, 'utf-8')
  const mapping = await readFile(NAV2_GAIT_MAPPING_PATH, 'utf-8')

  assert.match(adapter, /geometry_msgs\.msg import Twist/)
  assert.match(adapter, /http:\/\/127\.0\.0\.1:8893\/nav2\/cmd_vel/)
  assert.match(adapter, /stale-stop/)
  assert.match(adapter, /DOGZILLA_NAV2_GAIT_ADAPTER_MAX_RATE_HZ/)
  assert.match(mapping, /DOGZILLA_NAV2_GAIT_MAX_X_STEP", "8"/)
  assert.match(mapping, /y_step = 0\.0/)
  assert.match(mapping, /gait = "walk"/)
  assert.match(mapping, /pace = "slow"/)
  assert.match(adapter, /DOGZILLA_NAV2_GAIT_ADAPTER_HTTP_TIMEOUT_SEC", "0\.8"/)
})

function parseEolLine(line) {
  const parts = line.trim().split(/\s+/)
  if (parts.length < 5) return null
  const [indexEol, workingEol, , , filePath] = parts
  const indexAttrs = indexEol.split('/')
  const workingAttrs = workingEol.split('/')
  if (indexAttrs.length < 2 || workingAttrs.length < 2) return null
  return { filePath, indexEol: indexAttrs[1], workingEol: workingAttrs[1] }
}

test('all tracked .sh launch assets have no CRLF bytes', async () => {
  const trackedSh = execSync('git ls-files --eol *.sh', { encoding: 'utf-8' }).trim().split('\n').filter(Boolean)

  assert.ok(trackedSh.length > 0, 'expected at least 1 tracked .sh file')
  for (const line of trackedSh) {
    const info = parseEolLine(line)
    assert.notEqual(info, null, `failed to parse: ${line}`)
    assert.equal(
      info.indexEol, 'lf',
      `${info.filePath} has index EOL ${info.indexEol} instead of lf. CRLF in .sh files breaks Bash \`set -eo pipefail\` on Linux.\nFull line: ${line}`
    )
  }
})

test('all tracked .lua files have no CRLF bytes', async () => {
  const trackedLua = execSync('git ls-files --eol *.lua', { encoding: 'utf-8' }).trim().split('\n').filter(Boolean)

  assert.ok(trackedLua.length > 0, 'expected at least 1 tracked .lua file')
  for (const line of trackedLua) {
    const info = parseEolLine(line)
    assert.notEqual(info, null, `failed to parse: ${line}`)
    assert.equal(
      info.indexEol, 'lf',
      `${info.filePath} has index EOL ${info.indexEol} instead of lf.`
    )
  }
})

test('.gitattributes enforces LF for .sh files', async () => {
  const attrCheck = execSync('git check-attr eol -- sidecars/dogzilla_navigation/start-navigation-in-container.sh', { encoding: 'utf-8' }).trim()
  assert.match(attrCheck, /eol: lf$/)
})

test('DOGZILLA localization lua configs preserve full scan matching accuracy', async () => {
  const noimu = await readFile(NOIMU_LOCALIZATION_LUA_PATH, 'utf-8')
  const imu = await readFile(IMU_LOCALIZATION_LUA_PATH, 'utf-8')

  for (const script of [noimu, imu]) {
    assert.doesNotMatch(script, /TRAJECTORY_BUILDER\.pure_localization/)
    assert.match(script, /submap_publish_period_sec = 1\.0/)
    assert.match(script, /trajectory_publish_period_sec = 0\.2/)
    assert.match(script, /rangefinder_sampling_ratio = 1\./)
    assert.match(script, /real_time_correlative_scan_matcher\.linear_search_window = 0\.6/)
    assert.match(script, /real_time_correlative_scan_matcher\.angular_search_window = math\.rad\(45\.\)/)
    assert.match(script, /POSE_GRAPH\.optimize_every_n_nodes = 5/)
    assert.doesNotMatch(script, /POSE_GRAPH\.global_sampling_ratio = 0\.001/)
    assert.doesNotMatch(script, /POSE_GRAPH\.constraint_builder\.sampling_ratio = 0\.05/)
  }
})

test('DOGZILLA map-pose startup never seeds localization from charger origin or /initialpose', async () => {
  const script = await readFile(MAP_POSE_SCRIPT_PATH, 'utf-8')

  assert.doesNotMatch(script, /dogzilla-map-origin\.json/)
  assert.doesNotMatch(script, /DOGZILLA_INITIAL_POSE/)
  assert.doesNotMatch(script, /PoseWithCovarianceStamped/)
  assert.doesNotMatch(script, /\/initialpose/)
})

test('DOGZILLA map-pose startup stays non-ready when the initial TF probe misses', async () => {
  const script = await readFile(MAP_POSE_SCRIPT_PATH, 'utf-8')

  assert.match(script, /Map-pose TF not ready after startup probe; refusing to publish the ready marker/)
  assert.ok(script.indexOf('exit 4') < script.indexOf('touch "$READY_MARKER"'))
  assert.match(script, /while pgrep -f "\[c\]artographer_node" >\/dev\/null 2>&1; do/)
})

test('DOGZILLA Nav2 startup seeds AMCL initial pose from saved origin, not map-pose mode', async () => {
 const script = await readFile(SCRIPT_PATH, 'utf-8')

 assert.match(script, /DOGZILLA_INITIAL_POSE_X/)
 assert.match(script, /DOGZILLA_INITIAL_POSE_Y/)
 assert.match(script, /DOGZILLA_INITIAL_POSE_YAW/)
 assert.doesNotMatch(script, /DOGZILLA_MAP_POSE_MODE/)
 assert.doesNotMatch(script, /start_map_pose_localization/)
 assert.doesNotMatch(script, /cartographer_occupancy_grid_node/)
 assert.doesNotMatch(script, /DOGZILLA_MAP_PBSTREAM/)
 assert.doesNotMatch(script, /Proceeding anyway/)
})

test('DOGZILLA map-pose SSH launcher never reads charger origin or passes initial pose env vars', async () => {
  const script = await readFile(MAP_POSE_SSH_SCRIPT_PATH, 'utf-8')

  assert.doesNotMatch(script, /dogzilla-map-origin\.json/)
  assert.doesNotMatch(script, /DOGZILLA_INITIAL_POSE/)
  assert.doesNotMatch(script, /initialPoseEnv/)
  assert.doesNotMatch(script, /InitialX|InitialY|InitialYaw|ExpectedMap/)
})

test('DOGZILLA map-pose startup runs bounded global matching before trusting localization', async () => {
  const [startup, noimuRecovery, imuRecovery, relocalize] = await Promise.all([
    readFile(MAP_POSE_SCRIPT_PATH, 'utf-8'),
    readFile(NOIMU_RECOVERY_LUA_PATH, 'utf-8'),
    readFile(IMU_RECOVERY_LUA_PATH, 'utf-8'),
    readFile(RELOCALIZE_SCRIPT_PATH, 'utf-8'),
  ])

  assert.match(startup, /relocalize_on_frozen_map\.py/)
  assert.match(startup, /DOGZILLA_MAP_POSE_SKIP_RELOCALIZATION/)
  assert.doesNotMatch(startup, /DOGZILLA_MAP_POSE_RESTORE_ONLY/)
  assert.match(startup, /navigation remains blocked/)
  for (const recovery of [noimuRecovery, imuRecovery]) {
    assert.match(recovery, /POSE_GRAPH\.global_sampling_ratio = 1\.0/)
    assert.match(recovery, /POSE_GRAPH\.optimize_every_n_nodes = 1/)
    assert.match(recovery, /options\.rangefinder_sampling_ratio = 1\.0/)
    assert.match(recovery, /motion_filter\.max_time_seconds = 1\.0/)
    assert.match(recovery, /global_localization_min_score = 0\.55/)
    assert.doesNotMatch(recovery, /constraint_builder\.sampling_ratio = 1\.0/)
  }
  assert.match(relocalize, /min-score-percent.*default=55\.0/)
  assert.match(relocalize, /min-cross-nodes.*default=3/)
  assert.match(relocalize, /service-timeout-sec.*default=30\.0/)
  assert.match(relocalize, /def resume_pose_hint\(metadata:/)
  assert.match(relocalize, /metadata\.get\("resumePose"\)/)
  assert.match(relocalize, /initial_pose=self\.resume_pose_hint/)
  assert.match(relocalize, /relative_to_trajectory_id=frozen_ids\[0\]/)
  assert.match(relocalize, /self\.recovery_services\.finish\([\s\S]*?"map",\s*"base_link",\s*recovery_started_ns/)
  assert.doesNotMatch(relocalize, /self\._require_state\([\s\S]*?FINISHED/)
  assert.match(relocalize, /self\.normal_process = self\._launch_cartographer\([\s\S]*?self\.active_pbstream/)
  assert.match(relocalize, /normalFrozenTrajectoryIds=normal_frozen_ids/)
  assert.match(relocalize, /matched_trajectory_id not in normal_frozen_ids/)
  assert.match(relocalize, /map_anchor_id not in normal_frozen_ids/)
  assert.match(relocalize, /initial_pose=recovered_pose/)
  assert.match(relocalize, /relative_to_trajectory_id=normal_anchor_id/)
  assert.match(relocalize, /normal_anchor_id = map_anchor_id/)
  assert.match(relocalize, /--handoff-config/)
  assert.match(relocalize, /self\.handoff_config/)
  assert.match(startup, /--handoff-config.*robodoge_dogzilla_laser_only\$\{IMU_CONFIG\}\.lua/)
  assert.match(startup, /DOGZILLA_NAV2_PROVEN_INACTIVE/)
  assert.match(startup, /recovery_args\+=\(--no-pause-nav2\)/)
  assert.match(startup, /Continue mapping anchored at the globally recovered current pose/)
  assert.match(startup, /static_transform_publisher.*base_link laser_frame/)
  assert.match(relocalize, /mapping_handoff = not self\.handoff_config\.endswith/)
  assert.match(relocalize, /\(False, None\) if mapping_handoff else self\._resume_nav2\(\)/)
  assert.doesNotMatch(relocalize, /robodoge_localization_runtime\.pbstream/)
  assert.match(relocalize, /acceptedCrossTrajectoryConstraintCount/)
  assert.match(relocalize, /trusted=True/)
  assert.match(relocalize, /trusted=False/)
  assert.match(relocalize, /_is_recovery_process/)
  assert.match(relocalize, /self\.recovery_services\.refresh\(\)/)
  assert.match(relocalize, /for attempt in range\(3\)/)
})

test('DOGZILLA map-pose SSH launcher targets own container and falls back to systemd', async () => {
  const script = await readFile(MAP_POSE_SSH_SCRIPT_PATH, 'utf-8')

  assert.match(script, /\[string\]\$ContainerName = "robodoge-map-pose"/)
  assert.doesNotMatch(script, /\[string\]\$ContainerName = "robodoge-lidar-bridge"/)
  assert.doesNotMatch(script, /DOGZILLA_DOCKER_EXEC/)
  assert.match(script, /DOGZILLA_NAV2_PROVEN_INACTIVE=1/)
  assert.doesNotMatch(script, /DOGZILLA_MAP_POSE_RESTORE_ONLY/)
  assert.match(script, /if \(\$Mode -in @\('mapping', 'continue_mapping'\)\)/)
  assert.match(script, /systemctl stop robodoge-navigation\.service/)
  assert.match(script, /relocalize_on_frozen_map\.py --remote-root \$RemoteRoot/)
  assert.match(script, /\$relocalizeNav2Arg = if \(\$Mode -eq 'localization'\) \{ " --no-pause-nav2" \}/)
  assert.match(script, /--remote-root \$RemoteRoot\$relocalizeMetadataArg\$relocalizeNav2Arg/)
  assert.equal((script.match(/--no-pause-nav2/g) ?? []).length, 1)
  assert.match(script, /systemctl start robodoge-map-pose\.service/)
  assert.match(script, /Starting dedicated \$Mode container/)
  assert.match(script, /docker run -d --rm --name \$ContainerName/)
  assert.match(script, /\$startedInRequestedMode = \$Mode -in @\('mapping', 'continue_mapping'\)/)
  assert.match(script, /docker inspect -f '\{\{\.State\.Running\}\}'/)
  assert.doesNotMatch(script, /retrying docker exec/)
  assert.match(script, /robodoge_map_pose_skip_relocalization/)
  assert.match(script, /if \(\$RestoreOnly\)/)
  assert.match(script, /Wait-ContinueMappingProof/)
  assert.match(script, /Wait-ContainerReady/)
  assert.match(script, /trusted.*-eq \$true/)
  assert.match(script, /ready.*-eq \$true/)
  assert.match(script, /running.*-ne \$true/)
  assert.match(script, /robodoge_map_pose_ready/)
  const dedicatedStartupReturn = script.indexOf(
    'the dedicated container owns this startup transaction.',
  )
  assert.ok(dedicatedStartupReturn > script.indexOf('Wait-ContinueMappingProof'))
  assert.ok(
    dedicatedStartupReturn <
      script.indexOf('RemoteCommand $relocalizeCommand', dedicatedStartupReturn),
  )
  assert.match(script, /sudo install .* && rm -f/)
  assert.match(script, /clearSkipMarkerCommand/)
  assert.match(script, /if \(\$Mode -eq 'localization'\)/)
  assert.ok(script.indexOf("if ($Mode -eq 'localization')") < script.indexOf('$containerState -notmatch'))
  assert.ok(script.indexOf('systemctl stop robodoge-map-pose.service; $readyReset; $skipMarkerCommand') > 0)
  assert.ok(script.indexOf('RemoteCommand $stopNavigationCommand') < script.indexOf("throw 'Localization recovery could not prove Nav2 inactive"))
  assert.ok(script.indexOf("throw 'Localization recovery could not prove Nav2 inactive") < script.indexOf('RemoteCommand $relocalizeCommand'))
  assert.ok(script.indexOf('$startedInRequestedMode = $Mode') < script.indexOf('Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $relocalizeCommand'))
})

const DOCKERFILE_PATH = new URL('../sidecars/dogzilla_map_pose/Dockerfile', import.meta.url)
const INSTALL_SCRIPT_PATH = new URL('../scripts/install-dogzilla-boot-services-ssh.ps1', import.meta.url)

test('DOGZILLA Cartographer/Nav2 Dockerfile pre-bakes required packages', async () => {
  const dockerfile = await readFile(DOCKERFILE_PATH, 'utf-8')

  assert.match(dockerfile, /FROM yahboomtechnology\/ros-humble/)
  assert.match(dockerfile, /ros-humble-cartographer-ros/)
  assert.match(dockerfile, /ros-humble-cartographer-ros-msgs/)
  assert.match(dockerfile, /ros-humble-nav2-msgs/)
  assert.match(dockerfile, /ros-humble-nav2-bringup/)
  assert.match(dockerfile, /ros-humble-navigation2/)
})

test('DOGZILLA map-pose startup waits for rosbridge container readiness', async () => {
  const script = await readFile(MAP_POSE_SCRIPT_PATH, 'utf-8')

  assert.match(script, /POSE_HOST="\$\{DOGZILLA_POSE_HOST:-127\.0\.0\.1\}"/)
  assert.match(script, /POSE_PORT="\$\{POSE_PORT:-9090\}"/)
  assert.doesNotMatch(script, /curl -sf "http:\/\/\$\{POSE_HOST\}:\$\{POSE_PORT\}\/healthz"/)
  assert.match(script, /s\.connect\(\(sys\.argv\[1\], int\(sys\.argv\[2\]\)\)\)/)
  assert.match(script, /for _ in \$\(seq 1 30\)/)
})

test('DOGZILLA map-pose startup keeps its container alive while Cartographer runs', async () => {
  const script = await readFile(MAP_POSE_SCRIPT_PATH, 'utf-8')

  assert.doesNotMatch(script, /DOGZILLA_DOCKER_EXEC/)
  assert.match(script, /Map-pose startup complete; monitoring Cartographer/)
  assert.match(script, /while pgrep -f "\[c\]artographer_node" >\/dev\/null 2>&1; do/)
  assert.match(script, /Cartographer process not found; exiting so systemd can restart/)
  assert.match(script, /exit 1/)
})

test('Nav2 readiness requires continuously fresh samples, TF, subscribers, and lifecycle state', async () => {
  const script = await readFile(WAIT_NAV2_READY_PATH, 'utf-8')

  assert.match(script, /ActionClient\(node, NavigateToPose, "navigate_to_pose"\)/)
  assert.match(script, /if \[ "\$SCAN_TOPIC" = "auto" \]/)
  assert.match(script, /robot-obstacle-avoidance\.json/)
  assert.match(script, /create_subscription\(Odometry, "\/odom", on_odom, qos_profile_sensor_data\)/)
  assert.match(script, /create_subscription\(LaserScan, scan_topic, on_scan, qos_profile_sensor_data\)/)
  assert.match(script, /sample_times\["odom"\] = time\.monotonic\(\)/)
  assert.match(script, /sample_times\["scan"\] = time\.monotonic\(\)/)
  assert.match(script, /tf_buffer\.lookup_transform\("odom", "base_link", Time\(\)\)/)
  assert.match(script, /tf_buffer\.lookup_transform\("map", "base_link", Time\(\)\)/)
  assert.match(script, /tf_buffer\.lookup_transform\("map", "odom", Time\(\)\)/)
  assert.match(script, /node_names_present\(/)
  assert.match(script, /REQUIRED_SAFETY_SCAN_CONSUMERS/)
  assert.doesNotMatch(script, /REQUIRED_SCAN_CONSUMERS/)
  assert.match(script, /REQUIRED_CMD_VEL_NAV_PUBLISHERS/)
  assert.match(script, /PERMITTED_CMD_VEL_RAW_PUBLISHERS/)
  assert.match(script, /PERMITTED_CMD_VEL_PUBLISHERS/)
  assert.match(script, /node_identities_exactly\(/)
  assert.match(script, /get_publishers_info_by_topic\("\/cmd_vel_nav"\)/)
  assert.match(script, /get_subscriptions_info_by_topic\("\/cmd_vel_nav"\)/)
  assert.match(script, /get_publishers_info_by_topic\("\/cmd_vel_raw"\)/)
  assert.match(script, /get_subscriptions_info_by_topic\("\/cmd_vel_raw"\)/)
  assert.match(script, /get_subscriptions_info_by_topic\("\/cmd_vel"\)/)
  assert.match(script, /single_anonymous_endpoint_matches_live_node\(/)
  assert.match(script, /node\.get_node_names_and_namespaces\(\)/)
  assert.doesNotMatch(script, /owner_generation_is_valid\(/)
  assert.match(script, /EXPECTED_OWNER_MODE="\$\{10:-/)
  assert.doesNotMatch(script, /OWNER_FILE=/)
  assert.doesNotMatch(script, /EXPECTED_OWNER_TOKEN=/)
  assert.doesNotMatch(script, /has_non_probe_subscription/)
  assert.match(script, /create_client\(GetState, f"\/\{name\}\/get_state"\)/)
  assert.match(script, /state_id == 3 or label == "active"/)
  assert.match(script, /"collision_monitor"/)
  assert.match(script, /if not mapping_mode:\s+lifecycle_nodes \+= \("map_server",\)/)
  assert.match(script, /if backend == "amcl" and not mapping_mode:\s+lifecycle_nodes \+= \("amcl",\)/)
  assert.match(script, /lifecycle_states\[name\] = active/)
  assert.match(script, /lifecycle_states\[name\] = False/)
  assert.match(script, /lifecycle_ready = all\(lifecycle_states\.values\(\)\)/)
  assert.match(script, /lifecycle_services_ready = all\(lifecycle_service_ready\.values\(\)\)/)
  assert.match(script, /action_ready = action_client\.wait_for_server/)
  assert.match(script, /odom_ready = sample_is_fresh\("odom", now\)/)
  assert.match(script, /scan_ready = sample_is_fresh\("scan", now\)/)
  assert.match(script, /ReadinessHysteresis/)
  assert.match(script, /stable_ready_sec=STABLE_READY_SEC/)
  assert.doesNotMatch(script, /get_publishers_info_by_topic\(scan_topic\)/)
  assert.doesNotMatch(script, /ros2 (action list|topic info)/)
  assert.match(script, /timeout_sec = max\(float\(sys\.argv\[2\]\), 1\.0\)/)
  assert.match(script, /state_line\("TIMEOUT"\)/)
  assert.match(script, /f"\{prefix\} action=\{action_ready\} odom=\{odom_ready\} scan=\{scan_ready\}/)
  assert.match(script, /lifecycle=\{missing_lifecycle\} lifecycle_services=\{missing_lifecycle_services\}/)
  assert.match(script, /tf=\{tf_ready\}[\s\S]*scan_subscribers=\{scan_subscribers_ready\}/)
  assert.match(script, /"schemaVersion": 2/)
  assert.match(script, /"readinessState": readiness_state/)
  assert.match(script, /"blockers": blockers/)
  assert.match(script, /"gaitAdapterReady": bool\(gait_adapter_ready\)/)
  assert.match(script, /"gaitConsumerReady": bool\(gait_consumer_ready\)/)

  const launcher = await readFile(SSH_SCRIPT_PATH, 'utf-8')
  assert.match(launcher, /\$mappingProbeArg = if \(\$MappingMode\) \{ "1" \} else \{ "0" \}/)
  assert.match(launcher, /\$localizationBackend = "cartographer"/)
  assert.match(launcher, /DOGZILLA_LOCALIZATION_BACKEND=\$localizationBackend/)
  assert.match(launcher, /\$scanTopic 120 \$mappingProbeArg \$localizationBackend/)
  assert.match(launcher, /else \{ "auto" \}/)
  assert.doesNotMatch(launcher, /WakeBeforeReadiness|wakeForReadiness|navigate mode could not be asserted/)
  assert.match(launcher, /function Get-NavigationOwnerRecord/)
  assert.match(launcher, /\$ownerBefore = Get-NavigationOwnerRecord/)
  assert.match(launcher, /\$ownerAfter\.Mode -eq "mapping"/)
  assert.match(launcher, /\$ownerAfter\.Token -ne \$ownerBefore\.Token/)
  assert.match(launcher, /did not acquire a fresh mapping owner generation/)
  assert.doesNotMatch(launcher, /\$probeCommand \+= " \$expectedOwnerToken"/)
})

test('Pi-owned Nav2 supervision fails the whole launch only after sustained end-to-end degradation', async () => {
  const readiness = await readFile(WAIT_NAV2_READY_PATH, 'utf-8')
  const readinessLogic = await readFile(NAV2_READINESS_LOGIC_PATH, 'utf-8')
  const startup = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(readiness, /WATCH_MODE="\$\{7:-once\}"/)
  assert.match(readiness, /BRIDGE_HEALTH_URL="\$\{8:-http:\/\/127\.0\.0\.1:8893\/nav2\/cmd_vel\/health\}"/)
  assert.match(readiness, /node\.count_subscribers\("\/cmd_vel"\) > 0/)
  assert.match(readiness, /get_publishers_info_by_topic\("\/cmd_vel"\)/)
  assert.match(readiness, /collision_monitor/)
  assert.match(readinessLogic, /dogzilla_cmd_vel_gait_adapter/)
  assert.match(readinessLogic, /PERMITTED_MAPPING_CMD_VEL_CONSUMERS/)
  assert.match(readinessLogic, /robodoge_frontier_explorer/)
  assert.match(readiness, /if mapping_mode:[\s\S]*PERMITTED_MAPPING_CMD_VEL_CONSUMERS/)
  assert.match(readiness, /urllib\.request\.urlopen/)
  assert.match(readiness, /payload\.get\("runtimeAvailable"\) is True/)
  assert.doesNotMatch(readiness, /bridge_transitioning|transition_timeout|TRANSITIONING/)
  assert.doesNotMatch(readiness, /payload\.get\("blocked"\).*bridge_ready/)
  assert.match(readiness, /expected_ready=full_ready/)
  assert.doesNotMatch(readiness, /standby_infrastructure_ready/)
  assert.doesNotMatch(readiness, /expected_readiness/)
  assert.doesNotMatch(readiness, /owner_generation_is_valid\(/)
  assert.match(readiness, /gait_adapter_ready = node\.count_subscribers\("\/cmd_vel"\) > 0 and has_gait_consumer\(\)/)
  assert.match(readiness, /node_identities_exactly\([\s\S]*PERMITTED_CMD_VEL_PUBLISHERS/)
  assert.match(readiness, /readiness_state == "recovered"/)
  assert.doesNotMatch(readinessLogic, /STANDBY_MODES/)
  assert.match(readinessLogic, /now - self\.unhealthy_since >= self\.unhealthy_grace_sec/)
  assert.match(readinessLogic, /now - self\.ready_since >= self\.stable_ready_sec/)
  assert.doesNotMatch(readiness, /nav_mode/)
  assert.match(readiness, /f"UNHEALTHY action=\{action_ready\}/)
  assert.match(readiness, /f"gait_adapter=\{gait_adapter_ready\} gait_consumer=\{gait_consumer_ready\} bridge=\{bridge_ready\}/)

  assert.match(startup, /DOGZILLA_NAV2_MAPPING_MODE" = "1"[\s\S]*DOGZILLA_NAV2_READINESS_GRACE_SEC="\$\{DOGZILLA_NAV2_MAPPING_READINESS_GRACE_SEC:-120\}"/)
  assert.doesNotMatch(startup, /DOGZILLA_NAV2_MAPPING_MODE" = "1"[\s\S]*DOGZILLA_NAV2_READINESS_GRACE_SEC="\$\{DOGZILLA_NAV2_READINESS_GRACE_SEC:-120\}"/)
  assert.match(startup, /DOGZILLA_NAV2_READINESS_GRACE_SEC="\$\{DOGZILLA_NAV2_READINESS_GRACE_SEC:-20\}"/)
  assert.match(startup, /setsid ros2 launch "\$DOGZILLA_NAV2_LAUNCH"[\s\S]*&\s+nav2_launch_pid=\$!/)
  assert.match(startup, /NAV2_OWNER_MODE="normal"/)
  assert.match(startup, /DOGZILLA_NAV2_MAPPING_MODE.*NAV2_OWNER_MODE="mapping"/s)
  assert.match(startup, /write_navigation_owner "\$NAV2_OWNER_MODE" "\$nav2_launch_pgid"/)
  assert.match(startup, /"\$probe_timeout" \\\r?\n\s+"\$DOGZILLA_NAV2_MAPPING_MODE" \\/)
  assert.match(startup, /wait-nav2-ready\.sh"[\s\S]*"\$probe_mode"[\s\S]*"\$DOGZILLA_NAV2_READINESS_GRACE_SEC"/)
  assert.match(startup, /"\$DOGZILLA_NAV2_READINESS_GRACE_SEC"[\s\S]*"\$NAV2_OWNER_MODE"/)
  assert.match(startup, /DOGZILLA_NAV2_READINESS_RECHECK_TIMEOUT_SEC="\$\{DOGZILLA_NAV2_READINESS_RECHECK_TIMEOUT_SEC:-10\}"/)
  assert.match(startup, /run_nav2_readiness watch "\$DOGZILLA_NAV2_READINESS_STARTUP_TIMEOUT_SEC"/)
  assert.match(startup, /run_nav2_readiness once "\$DOGZILLA_NAV2_READINESS_RECHECK_TIMEOUT_SEC"/)
  assert.match(startup, /requiring a fresh independent confirmation before stopping Nav2/)
  assert.match(startup, /replacing the stale watcher without interrupting Nav2/)
  assert.doesNotMatch(startup, /readiness_launch_pid/)
  assert.match(startup, /kill -TERM -- "-\$nav2_launch_pgid"/)
  assert.match(startup, /kill -0 -- "-\$nav2_launch_pgid"/)
  assert.doesNotMatch(startup, /if ! kill -0 "\$nav2_launch_pid"[\s\S]{0,120}return/)
  assert.match(startup, /exit "\$readiness_status"/)
})

test('normal Nav2 restart refuses mapping ownership and systemd stops only its validated owner', async () => {
  const launcher = await readFile(SSH_SCRIPT_PATH, 'utf-8')
  const startup = await readFile(SCRIPT_PATH, 'utf-8')
  const stopper = await readFile(STOP_NAV2_OWNER_PATH, 'utf-8')
  const ownerStatus = await readFile(NAV2_OWNER_STATUS_PATH, 'utf-8')
  const installer = await readFile(BOOT_SERVICES_SCRIPT_PATH, 'utf-8')

  assert.match(startup, /navigation-runtime\.owner/)
  assert.match(startup, /write_navigation_owner "\$NAV2_OWNER_MODE"/)
  assert.match(launcher, /navigation-owner-status-in-container\.sh/)
  assert.match(launcher, /mapping owns the Nav2 runtime/)
  assert.ok(launcher.indexOf('mapping owns the Nav2 runtime') < launcher.indexOf('systemctl restart robodoge-navigation.service'))

  assert.match(stopper, /EXPECTED_MODE="\$\{1:-normal\}"/)
  assert.match(stopper, /owner_mode.*EXPECTED_MODE/)
  assert.match(stopper, /owner_version.*"2"/)
  assert.match(stopper, /owner_boot_id.*current_boot_id/)
  assert.match(stopper, /DOGZILLA_NAV2_OWNER_TOKEN=\$owner_token/)
  assert.match(stopper, /validate_group_members/)
  assert.match(stopper, /PROC_SESSION="\$4"/)
  assert.match(stopper, /\[ "\$PROC_SESSION" != "\$owner_pgid" \]/)
  assert.match(stopper, /Recorded Nav2 group leader lacks its generation token/)
  assert.doesNotMatch(stopper, /Process \$member_pid in recorded Nav2 group lacks its generation token/)
  assert.match(stopper, /find_token_members\(\)/)
  assert.match(stopper, /DOGZILLA_NAV2_OWNER_TOKEN=\$owner_token/)
  assert.match(stopper, /signal_token_members TERM/)
  assert.match(stopper, /signal_token_members KILL/)
  assert.match(stopper, /flock -n "\$LOCK_FILE" -c true && exit 0/)
  assert.match(stopper, /owner cleanup left the runtime lock held/)
  assert.match(stopper, /owner_is_mapping_launch=1/)
  assert.match(stopper, /ros2 launch.*robodoge_nav2_navigation_launch\.py/)
  assert.match(stopper, /Recorded mapping owner lacks its generation token/)
  assert.match(stopper, /\[ "\$PROC_PGID" = "\$owner_pid" \].*\[ "\$PROC_SESSION" = "\$owner_pid" \]/)
  assert.match(stopper, /\/proc\/\[0-9\]\*/)
  assert.match(stopper, /\/proc\/\$owner_pid\/cmdline/)
  assert.match(stopper, /kill -TERM -- "-\$owner_pgid"/)
  assert.match(stopper, /kill -KILL -- "-\$owner_pgid"/)
  assert.ok(stopper.indexOf('kill -TERM "$owner_pid"') > stopper.indexOf('validate_group_members || exit 1'))
  assert.doesNotMatch(stopper, /pkill/)
  assert.match(ownerStatus, /navigation-runtime\.lock/)
  assert.match(ownerStatus, /navigation-runtime\.owner/)
  assert.match(ownerStatus, /flock -n "\$LOCK_FILE" -c true/)
  assert.match(ownerStatus, /owner_mode.*mapping/)
  assert.match(ownerStatus, /exit 42/)
  assert.match(ownerStatus, /owner_mode.*normal/)
  assert.match(installer, /ExecStop=.*stop-navigation-owner-in-container\.sh normal/)
  const navUnit = installer.slice(installer.indexOf('/etc/systemd/system/robodoge-navigation.service'), installer.indexOf('[Install]', installer.indexOf('/etc/systemd/system/robodoge-navigation.service')))
  assert.doesNotMatch(navUnit, /pkill/)

  assert.match(launcher, /systemctl is-active --quiet robodoge-autonomous-mapping-starting/)
  assert.match(launcher, /systemctl is-active --quiet robodoge-autonomous-mapping/)
  assert.match(launcher, /\$ownerStatusCommand = "if sudo systemctl is-active --quiet robodoge-autonomous-mapping-starting[\s\S]*docker exec[\s\S]*\$ownerStatusScript"/)
})

test('Windows mapping launchers make every direct SSH probe non-interactive', async () => {
  for (const path of [
    new URL('../scripts/start-dogzilla-map-pose-ssh.ps1', import.meta.url),
    SSH_SCRIPT_PATH,
  ]) {
    const script = await readFile(path, 'utf-8')
    const directSshCalls = script.split(/\r?\n/).filter((line) => /& ssh\b/.test(line))
    assert.ok(directSshCalls.length > 0)
    for (const line of directSshCalls) {
      assert.match(line, /& ssh -n\b/, `interactive SSH call can hang Node action stdin: ${line.trim()}`)
    }
  }
})

test('DOGZILLA launchers never gate startup on legacy navigation power modes', async () => {
  for (const path of [
    SSH_SCRIPT_PATH,
    AUTONOMOUS_MAPPING_SSH_SCRIPT_PATH,
    new URL('../scripts/start-dogzilla-map-pose-ssh.ps1', import.meta.url),
  ]) {
    const script = await readFile(path, 'utf-8')
    assert.doesNotMatch(script, /127\.0\.0\.1:8893\/(?:mode|sleep|wake)/)
    assert.doesNotMatch(script, /WakeBeforeReadiness|navModeCommand|navModeReady|could not wake/)
  }
})

test('DOGZILLA boot service install defaults to pre-baked Cartographer/Nav2 image', async () => {
  const script = await readFile(INSTALL_SCRIPT_PATH, 'utf-8')

  assert.match(script, /\[string\]\$DockerImage = "robodoge\/ros-humble-cartographer:1\.0"/)
  assert.match(script, /\[switch\]\$BuildImage/)
  assert.match(script, /docker build -t "\$\{DOCKER_IMAGE\}" -f "\$REMOTE_ROOT\/sidecars\/dogzilla_map_pose\/Dockerfile"/)
})

test('DOGZILLA boot service install runs map-pose in its own container', async () => {
const script = await readFile(INSTALL_SCRIPT_PATH, 'utf-8')
const mapPoseUnit = script.slice(
script.indexOf('/etc/systemd/system/robodoge-map-pose.service'),
script.indexOf('/etc/systemd/system/robodoge-navigation.service'),
)

assert.doesNotMatch(mapPoseUnit, /ExecStart=\/usr\/bin\/docker exec .* robodoge-lidar-bridge bash .*start-map-pose-in-container\.sh/)
assert.match(mapPoseUnit, /ExecStartPre=-\/usr\/bin\/docker rm -f robodoge-map-pose/)
assert.match(mapPoseUnit, /ExecStart=\/usr\/bin\/docker run --rm --name robodoge-map-pose/)
  assert.match(mapPoseUnit, /ExecStop=-\/usr\/bin\/docker rm -f robodoge-map-pose/)
  assert.match(mapPoseUnit, /Type=simple/)
  assert.match(mapPoseUnit, /StartLimitIntervalSec=900/)
  assert.match(mapPoseUnit, /StartLimitBurst=3/)
  assert.match(mapPoseUnit, /Restart=on-failure/)
  assert.match(mapPoseUnit, /RestartSec=30/)
  assert.match(script, /rm -f \/etc\/systemd\/system\/robodoge-map-pose\.service\.d\/restart\.conf/)
  assert.doesNotMatch(mapPoseUnit, /RemainAfterExit=yes/)
  assert.match(mapPoseUnit, /bash sidecars\/dogzilla_map_pose\/start-map-pose-in-container\.sh/)
})

test('DOGZILLA boot service install makes Pi systemd own Nav2 startup', async () => {
const script = await readFile(INSTALL_SCRIPT_PATH, 'utf-8')
const serviceIndex = script.indexOf('/etc/systemd/system/robodoge-navigation.service')
const enableIndex = script.indexOf('systemctl enable robodoge-direct-bridge.service')
const restartIndex = script.indexOf('systemctl restart robodoge-navigation.service')
const statusIndex = script.indexOf('status robodoge-direct-bridge.service')

assert.ok(serviceIndex > 0, 'expected robodoge-navigation.service unit')
assert.match(script, /Description=Robo-Doge DOGZILLA Nav2 Navigation/)
assert.match(script, /"dogzilla_navigation"/)
  assert.match(script, /PartOf=robodoge-rosbridge\.service/)
  assert.match(script, /Type=simple/)
  assert.match(script, /StartLimitIntervalSec=900/)
  assert.match(script, /StartLimitBurst=3/)
  assert.match(script, /Restart=on-failure/)
  assert.match(script, /RestartSec=30/)
  assert.match(script, /After=robodoge-direct-bridge\.service robodoge-rosbridge\.service robodoge-map-pose\.service/)
  assert.match(script, /Wants=robodoge-direct-bridge\.service robodoge-rosbridge\.service robodoge-map-pose\.service/)
  assert.match(script, /TimeoutStartSec=240/)
  assert.doesNotMatch(script, /Restart=no/)
  assert.doesNotMatch(script, /RemainAfterExit=yes/)
  assert.match(script, /docker exec -e REMOTE_ROOT=\$REMOTE_ROOT -e ROS_DOMAIN_ID=\$ROS_DOMAIN_ID_VALUE -e DOGZILLA_LOCALIZATION_BACKEND=cartographer robodoge-rosbridge bash -lc/)
  assert.doesNotMatch(script, /docker exec -d robodoge-rosbridge/)
  assert.match(script, /sidecars\/dogzilla_navigation\/start-navigation-in-container\.sh/)
  assert.match(script, /rm -f \/etc\/systemd\/system\/robodoge-navigation\.service\.d\/cartographer-backend\.conf/)
  assert.match(script, /rm -f \/etc\/systemd\/system\/robodoge-navigation\.service\.d\/restart\.conf/)
assert.match(script, /robodoge-navigation\.service/)
assert.ok(enableIndex > serviceIndex, 'expected service enable after unit write')
assert.ok(restartIndex > enableIndex, 'expected service restart after enable')
assert.ok(statusIndex > restartIndex, 'expected service status after restart')
assert.doesNotMatch(script, /docker rm -f robodoge-navigation/)
  assert.match(script, /DOGZILLA_MAP_TOPIC=\/map/)
})

test('DOGZILLA direct bridge SSH startup stops vendor app before launching bridge', async () => {
const script = await readFile(BRIDGE_SSH_SCRIPT_PATH, 'utf-8')

  assert.match(script, /stop-dogzilla-vendor-app-ssh\.ps1/)
  assert.match(script, /stopVendorArgs/)
  assert.match(script, /DOGZILLA vendor app stop failed/)
  assert.ok(script.indexOf('stop-dogzilla-vendor-app-ssh.ps1') < script.indexOf('server.py --host'))
})

test('DOGZILLA boot service install makes direct bridge conflict with yahboom_oled', async () => {
  const script = await readFile(INSTALL_SCRIPT_PATH, 'utf-8')

  assert.match(script, /Conflicts=yahboom_oled\.service/)
  assert.match(script, /ExecStartPre=\+\/bin\/bash -lc/)
  assert.match(script, /systemctl stop yahboom_oled\.service/)
  assert.match(script, /pkill -TERM -f "\[a\]pp_dogzilla\.py"/)
  assert.match(script, /pkill -TERM -f "\[o\]led_dogzilla\.py"/)
  assert.match(script, /pkill -KILL -f "\[a\]pp_dogzilla\.py"/)
  assert.match(script, /pkill -KILL -f "\[o\]led_dogzilla\.py"/)
  assert.match(script, /\/dev\/ttyAMA0/)
})

test('DOGZILLA boot service install disables yahboom_oled after enabling direct bridge', async () => {
  const script = await readFile(INSTALL_SCRIPT_PATH, 'utf-8')

  const enableIndex = script.indexOf('systemctl enable robodoge-direct-bridge.service')
  const disableIndex = script.indexOf('systemctl disable --now yahboom_oled.service')

  assert.ok(enableIndex > 0, 'expected direct-bridge enable')
  assert.ok(disableIndex > enableIndex, 'expected yahboom_oled disable after direct-bridge enable')
})

function nodeBlock(source, packageName) {
  const start = source.indexOf(`package="${packageName}"`)
  assert.notEqual(start, -1, `missing ${packageName} node`)
  const next = source.indexOf('Node(', start + 1)
  return next === -1 ? source.slice(start) : source.slice(start, next)
}
