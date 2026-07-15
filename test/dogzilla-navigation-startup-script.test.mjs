import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import test from 'node:test'

const SCRIPT_PATH = new URL('../sidecars/dogzilla_navigation/start-navigation-in-container.sh', import.meta.url)
const SCAN_SELF_FILTER_PATH = new URL('../sidecars/dogzilla_navigation/scan_self_filter.py', import.meta.url)
const LAUNCH_PATH = new URL('../sidecars/dogzilla_navigation/robodoge_nav2_navigation_launch.py', import.meta.url)
const GAIT_ADAPTER_PATH = new URL('../sidecars/dogzilla_navigation/cmd_vel_gait_adapter.py', import.meta.url)
const NAV2_GAIT_MAPPING_PATH = new URL('../sidecars/dogzilla_lib_bridge/nav2_gait_adapter.py', import.meta.url)
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

  assert.match(script, /qos_profile_sensor_data/)
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

test('DOGZILLA Nav2 startup generates doorway-tuned params from upstream defaults', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /DOGZILLA_NAV2_BASE_PARAMS=.*nav2_bringup\/params\/nav2_params\.yaml/)
  assert.match(script, /DOGZILLA_NAV2_ROBOT_RADIUS="\$\{DOGZILLA_NAV2_ROBOT_RADIUS:-0\.16\}"/)
  assert.match(script, /DOGZILLA_NAV2_INFLATION_RADIUS="\$\{DOGZILLA_NAV2_INFLATION_RADIUS:-0\.28\}"/)
  assert.match(script, /DOGZILLA_NAV2_COST_SCALING_FACTOR="\$\{DOGZILLA_NAV2_COST_SCALING_FACTOR:-8\.0\}"/)
  assert.match(script, /DOGZILLA_NAV2_OBSTACLE_MIN_RANGE="\$\{DOGZILLA_NAV2_OBSTACLE_MIN_RANGE:-0\.24\}"/)
  assert.match(script, /yaml\.safe_load/)
  assert.match(script, /robot_radius/)
  assert.match(script, /inflation_radius/)
  assert.match(script, /params_file:="\$DOGZILLA_NAV2_PARAMS"/)
})

test('DOGZILLA Nav2 startup lowers loop rates for Pi runtime load', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /DOGZILLA_NAV2_CONTROLLER_FREQUENCY="\$\{DOGZILLA_NAV2_CONTROLLER_FREQUENCY:-5\.0\}"/)
  assert.match(script, /DOGZILLA_NAV2_BT_LOOP_DURATION_MS="\$\{DOGZILLA_NAV2_BT_LOOP_DURATION_MS:-200\}"/)
  assert.match(script, /DOGZILLA_NAV2_BT_SERVER_TIMEOUT_MS="\$\{DOGZILLA_NAV2_BT_SERVER_TIMEOUT_MS:-10000\}"/)
  assert.match(script, /ctrl\["controller_frequency"\] = cf/)
  assert.match(script, /btn\["bt_loop_duration"\] = bld/)
  assert.match(script, /btn\["default_server_timeout"\] = bst/)
  assert.match(script, /btn\["wait_for_service_timeout"\] = bws/)
  assert.match(script, /pln\["expected_planner_frequency"\] = pf/)
  assert.match(script, /vs\["smoothing_frequency"\] = sf/)
})

test('DOGZILLA Nav2 startup loosens progress checker for slow quadruped gait', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /DOGZILLA_NAV2_REQUIRED_MOVEMENT_RADIUS="\$\{DOGZILLA_NAV2_REQUIRED_MOVEMENT_RADIUS:-0\.08\}"/)
  assert.match(script, /DOGZILLA_NAV2_MOVEMENT_TIME_ALLOWANCE="\$\{DOGZILLA_NAV2_MOVEMENT_TIME_ALLOWANCE:-45\.0\}"/)
  assert.match(script, /DOGZILLA_NAV2_FAILURE_TOLERANCE="\$\{DOGZILLA_NAV2_FAILURE_TOLERANCE:-5\.0\}"/)
  assert.match(script, /DOGZILLA_NAV2_MIN_SPEED_XY="\$\{DOGZILLA_NAV2_MIN_SPEED_XY:-0\.03\}"/)
  assert.match(script, /DOGZILLA_NAV2_TRANS_STOPPED_VELOCITY="\$\{DOGZILLA_NAV2_TRANS_STOPPED_VELOCITY:-0\.05\}"/)
  assert.match(script, /pc\["required_movement_radius"\] = rmr/)
  assert.match(script, /pc\["movement_time_allowance"\] = mta/)
  assert.match(script, /ctrl\["failure_tolerance"\] = max/)
  assert.match(script, /fp2\["min_speed_xy"\] = msx/)
  assert.match(script, /fp2\["trans_stopped_velocity"\] = tsv/)
})

test('DOGZILLA Nav2 startup ignores final yaw by default', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /DOGZILLA_NAV2_YAW_GOAL_TOLERANCE="\$\{DOGZILLA_NAV2_YAW_GOAL_TOLERANCE:-6\.283185307179586\}"/)
  assert.match(script, /fp2\["yaw_goal_tolerance"\] = yaw/)
  assert.match(script, /scan_topic=\{st if sfe else/)
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
  assert.match(script, /cmd_vel_gait_adapter\.py/)
  assert.match(script, /DOGZILLA_NAV2_GAIT_ADAPTER_URL/)
  assert.match(script, /--input-topic "\$DOGZILLA_NAV2_GAIT_ADAPTER_INPUT_TOPIC"/)
  assert.match(script, /collision_monitor/)
  assert.match(script, /"cmd_vel_in_topic": "cmd_vel_raw"/)
  assert.match(script, /"cmd_vel_out_topic": "cmd_vel"/)
  assert.match(script, /DOGZILLA_NAV2_COLLISION_SOURCE_TIMEOUT="\$\{DOGZILLA_NAV2_COLLISION_SOURCE_TIMEOUT:-0\.75\}"/)
  assert.match(script, /"source_timeout": env_f\("DOGZILLA_NAV2_COLLISION_SOURCE_TIMEOUT", 0\.75\)/)
  assert.match(script, /"topic": "\/scan_nav2"/)
  assert.match(script, /"action_type": "stop"/)
  assert.match(launch, /"collision_monitor"/)
  assert.match(launch, /\("cmd_vel_smoothed", "cmd_vel_raw"\)/)
  assert.match(launch, /package="nav2_collision_monitor"/)
})

test('DOGZILLA Nav2 starts scan filter and odom helper directly', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /scan_self_filter\.py/)
  assert.match(script, /tf_odom_publisher\.py/)
  assert.match(script, /cmd_vel_odom_publisher\.py/)
  assert.match(script, /DOGZILLA_LOCALIZATION_BACKEND="\$\{DOGZILLA_LOCALIZATION_BACKEND:-amcl\}"/)
  assert.match(script, /--input-topic \/scan/)
  assert.match(script, /--output-topic "\$DOGZILLA_NAV2_SCAN_FILTER_TOPIC"/)
  assert.match(script, /--mask-start-deg "\$DOGZILLA_NAV2_SCAN_FILTER_MASK_START_DEG"/)
  assert.match(script, /--mask-end-deg "\$DOGZILLA_NAV2_SCAN_FILTER_MASK_END_DEG"/)
  assert.match(script, /--mask-range-m "\$DOGZILLA_NAV2_SCAN_FILTER_MASK_RANGE_M"/)
  assert.doesNotMatch(script, /scan_filter_supervisor\.py/)
  assert.doesNotMatch(script, /odom_publisher_supervisor\.py/)
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
  assert.match(script, /exec ros2 launch "\$DOGZILLA_NAV2_LAUNCH"/)
  assert.match(script, /autostart:=true/)
  assert.match(script, /use_respawn:=true/)
  assert.doesNotMatch(script, /ros2 lifecycle set/)
  assert.doesNotMatch(script, /try_graceful_nav2_recovery/)
  assert.doesNotMatch(script, /Managed nodes are active/)
})
test('DOGZILLA map-pose startup waits for fresh pose after Cartographer restart', async () => {
  const script = await readFile(MAP_POSE_SCRIPT_PATH, 'utf-8')

  assert.match(script, /tf_buffer\.lookup_transform\("map", "base_link", rclpy\.time\.Time\(\)\)/)
  assert.match(script, /"frame": "map"/)
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
  assert.match(script, /metadata\.get\("pbstream"\)/)
  assert.match(script, /Active map manifest missing, invalid, or overridden/)
  assert.doesNotMatch(script, /robodoge_home_\*\.pbstream/)
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
  assert.match(script, /systemd-run .*robodoge-autonomous-mapping/)
  assert.match(script, /autonomous-mapping\.ready/)
  assert.ok(script.indexOf('systemd-run') < script.indexOf('start-dogzilla-map-pose-ssh.ps1'))
  assert.match(supervisor, /--lock-file.*autonomous-mapping\.lock/)
  assert.match(supervisor, /READY_FILE/)
  assert.match(supervisor, /restore_localization/)
  assert.match(supervisor, /active_map_has_verified_pbstream/)
  assert.match(supervisor, /candidate-ready/)
  assert.match(supervisor, /\[ "\$explorer_exit" -eq 0 \]/)
  assert.match(supervisor, /autonomous-mapping\.active/)
  assert.match(supervisor, /mapping_start_cancelled/)
  assert.match(script, /\$common = @\{/)
  assert.doesNotMatch(script, /\$common = @\('-PiIp'/)
  assert.match(supervisor, /source \/opt\/ros\/humble\/setup\.bash/)
  assert.match(explorer, /ReliabilityPolicy\.BEST_EFFORT/)
  assert.match(explorer, /DurabilityPolicy\.TRANSIENT_LOCAL/)
  assert.match(explorer, /now - self\.started_monotonic > self\.args\.map_timeout/)
  assert.ok(script.indexOf('pgrep -f') < script.indexOf('start-dogzilla-map-pose-ssh.ps1'))
  assert.match(script, /127\.0\.0\.1:8893\/mode/)
  assert.match(script, /navigate/)
  assert.doesNotMatch(script, /mapping_resume_pose|resumeGoalPython|resumeAccepted/)
  assert.match(script, /127\.0\.0\.1:8893\/healthz/)
  assert.match(script, /batterySafety/)
  assert.match(script, /Last status/)
  assert.doesNotMatch(script, /127\.0\.0\.1:8893\/commands|waitForResult|goalCompleted|command_preempt/)
  assert.match(script, /No motion is needed before mapping resumes/)
  assert.doesNotMatch(script, /ros2 action send_goal/)
  assert.ok(script.indexOf('ConvertTo-RemoteSingleQuote $preflightPython') < script.indexOf('RemoteCommand $reserveCommand'))
  assert.ok(script.indexOf('--unit=robodoge-autonomous-mapping --property') < script.indexOf('start-dogzilla-map-pose-ssh.ps1'))
  assert.match(script, /systemctl stop robodoge-navigation\.service/)
  assert.ok(script.indexOf('systemctl stop robodoge-navigation.service') < script.indexOf('start-dogzilla-map-pose-ssh.ps1'))
  assert.match(script, /systemctl stop \$startingUnit/)
  assert.match(script, /catch \{/)
  assert.match(script, /systemctl stop robodoge-autonomous-mapping/)
  assert.match(script, /-Mode localization -ForceRestart -RestoreOnly/)
  assert.match(script, /normal localization rollback also failed/)
  assert.doesNotMatch(script, /Normal Nav2 failed to restart/)
  assert.doesNotMatch(script, /clear.*emergency|emergency.*clear/i)
  assert.doesNotMatch(script, /-SkipReadinessWait/)
  assert.ok(script.indexOf('-RemoteCommand $launchCommand') < script.lastIndexOf('-RemoteCommand $navModeCommand'))
})

test('Finish Mapping fails fast for dead sessions and accepts only candidate proof', async () => {
  const finish = await readFile(FINISH_AUTONOMOUS_MAPPING_SSH_SCRIPT_PATH, 'utf-8')
  const sshCommon = await readFile(SSH_COMMON_SCRIPT_PATH, 'utf-8')

  assert.match(sshCommon, /\$sshArgs = @\("-n", "-F"/)
  assert.match(finish, /systemctl is-active --quiet robodoge-autonomous-mapping/)
  assert.match(finish, /no active session remains to finish/)
  assert.match(finish, /"candidate-ready"\|candidate=true/)
})

test('DOGZILLA map save refuses localization and writes unique map identity', async () => {
  const script = await readFile(SAVE_MAP_POSE_SCRIPT_PATH, 'utf-8')

  assert.match(script, /Refusing to save map while Cartographer is in localization mode/)
  assert.match(script, /DOGZILLA_MAP_SAVE_ALLOW_LOCALIZATION/)
  assert.match(script, /map_id="\$\{DOGZILLA_MAP_ID:-robodoge_home_\$\(date -u \+%Y%m%dT%H%M%SZ\)\}"/)
  assert.match(script, /conversion_status" != "ok"/)
  assert.match(script, /Refusing to update \$DOGZILLA_MAP_METADATA/)
  assert.match(script, /"id": "\$map_id"/)
  assert.match(script, /"activeAlias": "robodoge_home"/)
})

test('DOGZILLA Nav2 startup resolves map yaml from active map metadata', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /DOGZILLA_MAP_METADATA/)
  assert.match(script, /m\.get\("yaml"\)/)
  assert.match(script, /Active map manifest missing, invalid, or overridden/)
  assert.match(script, /hashlib\.sha256/)
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
  assert.match(script, /scp -r -F \$configPath \$mapPoseSource/)
  assert.match(script, /scp -r -F \$configPath \$imuPublisherSource/)
})

test('DOGZILLA Nav2 SSH startup loads obstacle config for direct npm starts', async () => {
  const script = await readFile(SSH_SCRIPT_PATH, 'utf-8')

  assert.match(script, /config\\robot-obstacle-avoidance\.json/)
  assert.match(script, /ConvertFrom-Json/)
  assert.match(script, /Use-PositiveConfigDouble/)
  assert.match(script, /nav2RobotRadius/)
  assert.match(script, /nav2ScanFilterMaskRangeM/)
  assert.match(script, /nav2BtServerTimeoutMs/)
  assert.match(script, /nav2RequiredMovementRadius/)
  assert.match(script, /DOGZILLA_NAV2_BT_SERVER_TIMEOUT_MS/)
  assert.match(script, /DOGZILLA_NAV2_TRANS_STOPPED_VELOCITY/)
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

test('DOGZILLA localization lua configs widen real-time scan matcher window', async () => {
  const noimu = await readFile(NOIMU_LOCALIZATION_LUA_PATH, 'utf-8')
  const imu = await readFile(IMU_LOCALIZATION_LUA_PATH, 'utf-8')

  for (const script of [noimu, imu]) {
    assert.doesNotMatch(script, /TRAJECTORY_BUILDER\.pure_localization/)
    assert.match(script, /submap_publish_period_sec = 1\.0/)
    assert.match(script, /trajectory_publish_period_sec = 0\.2/)
    assert.match(script, /rangefinder_sampling_ratio = 0\.5/)
    assert.match(script, /real_time_correlative_scan_matcher\.linear_search_window = 0\.6/)
    assert.match(script, /real_time_correlative_scan_matcher\.angular_search_window = math\.rad\(45\.\)/)
    assert.match(script, /POSE_GRAPH\.optimize_every_n_nodes = 20/)
    assert.match(script, /POSE_GRAPH\.global_sampling_ratio = 0\.001/)
    assert.match(script, /POSE_GRAPH\.constraint_builder\.sampling_ratio = 0\.05/)
  }
})

test('DOGZILLA map-pose startup never seeds localization from charger origin or /initialpose', async () => {
  const script = await readFile(MAP_POSE_SCRIPT_PATH, 'utf-8')

  assert.doesNotMatch(script, /dogzilla-map-origin\.json/)
  assert.doesNotMatch(script, /DOGZILLA_INITIAL_POSE/)
  assert.doesNotMatch(script, /PoseWithCovarianceStamped/)
  assert.doesNotMatch(script, /\/initialpose/)
})

test('DOGZILLA map-pose startup keeps Cartographer alive when initial TF probe misses', async () => {
  const script = await readFile(MAP_POSE_SCRIPT_PATH, 'utf-8')

  assert.match(script, /Map-pose TF not ready after startup probe; keeping Cartographer alive for recovery/)
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
  assert.match(startup, /DOGZILLA_MAP_POSE_RESTORE_ONLY/)
  assert.match(startup, /\[ "\$mode" = "localization" \] && \[ "\$DOGZILLA_MAP_POSE_RESTORE_ONLY" != "1" \]/)
  assert.match(startup, /navigation remains blocked/)
  for (const recovery of [noimuRecovery, imuRecovery]) {
    assert.match(recovery, /POSE_GRAPH\.global_sampling_ratio = 1\.0/)
    assert.match(recovery, /POSE_GRAPH\.optimize_every_n_nodes = 1/)
    assert.match(recovery, /options\.rangefinder_sampling_ratio = 1\.0/)
    assert.match(recovery, /motion_filter\.max_time_seconds = 1\.0/)
    assert.match(recovery, /global_localization_min_score = 0\.55/)
    assert.doesNotMatch(recovery, /constraint_builder\.sampling_ratio = 1\.0/)
  }
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
  assert.match(script, /DOGZILLA_DOCKER_EXEC=1/)
  assert.match(script, /DOGZILLA_NAV2_PROVEN_INACTIVE=1/)
  assert.match(script, /DOGZILLA_MAP_POSE_RESTORE_ONLY=1/)
  assert.match(script, /systemctl stop robodoge-navigation\.service/)
  assert.match(script, /docker exec .* \$ContainerName bash \$containerScript/)
  assert.match(script, /systemctl start robodoge-map-pose\.service/)
  assert.match(script, /Starting dedicated \$Mode container/)
  assert.match(script, /docker run -d --rm --name \$ContainerName/)
  assert.match(script, /\$startedInRequestedMode = \$Mode -eq 'mapping'/)
  assert.match(script, /docker inspect -f '\{\{\.State\.Running\}\}'/)
  assert.doesNotMatch(script, /retrying docker exec/)
  assert.ok(script.indexOf('$startedInRequestedMode = $Mode') < script.indexOf('Invoke-DogzillaSsh -ConfigPath $configPath -Alias $Alias -RemoteCommand $remoteCommand'))
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

test('DOGZILLA map-pose startup keeps container alive while Cartographer runs', async () => {
  const script = await readFile(MAP_POSE_SCRIPT_PATH, 'utf-8')

  assert.match(script, /DOGZILLA_DOCKER_EXEC/)
  assert.match(script, /Map-pose startup complete; monitoring Cartographer/)
  assert.match(script, /while pgrep -f "\[c\]artographer_node" >\/dev\/null 2>&1; do/)
  assert.match(script, /Cartographer process not found; exiting so systemd can restart/)
  assert.match(script, /exit 1/)
})

test('Nav2 readiness latches DDS prerequisites across probe attempts', async () => {
  const script = await readFile(new URL('../sidecars/dogzilla_navigation/wait-nav2-ready.sh', import.meta.url), 'utf-8')

  assert.match(script, /action_ready=false/)
  assert.match(script, /odom_ready=false/)
  assert.match(script, /scan_ready=false/)
  assert.match(script, /if \$action_ready && \$odom_ready && \$scan_ready/)
  assert.doesNotMatch(script, /grep -q/)
  assert.match(script, /timeout --kill-after=1 2 ros2 action list/)
  assert.match(script, /timeout --kill-after=1 2 ros2 topic info \/odom/)
  assert.match(script, /timeout --kill-after=1 2 ros2 topic info "\$SCAN_TOPIC"/)
  assert.match(script, /for i in \$\(seq 1 40\)/)
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
  assert.match(mapPoseUnit, /StartLimitIntervalSec=0/)
  assert.match(mapPoseUnit, /Restart=on-failure/)
  assert.match(mapPoseUnit, /RestartSec=10/)
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
assert.match(script, /After=robodoge-rosbridge\.service/)
assert.match(script, /Wants=robodoge-rosbridge\.service/)
  assert.match(script, /PartOf=robodoge-rosbridge\.service/)
  assert.match(script, /After=robodoge-rosbridge\.service robodoge-map-pose\.service/)
  assert.match(script, /Type=simple/)
  assert.match(script, /StartLimitIntervalSec=0/)
  assert.match(script, /Restart=on-failure/)
  assert.match(script, /RestartSec=10/)
  assert.match(script, /TimeoutStartSec=240/)
  assert.doesNotMatch(script, /Restart=no/)
  assert.doesNotMatch(script, /RemainAfterExit=yes/)
  assert.match(script, /docker exec -e DOGZILLA_LOCALIZATION_BACKEND=cartographer robodoge-rosbridge bash -lc/)
  assert.doesNotMatch(script, /docker exec -d robodoge-rosbridge/)
  assert.match(script, /sidecars\/dogzilla_navigation\/start-navigation-in-container\.sh/)
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
