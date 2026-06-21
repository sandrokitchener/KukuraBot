import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import test from 'node:test'

const SCRIPT_PATH = new URL('../sidecars/dogzilla_navigation/start-navigation-in-container.sh', import.meta.url)
const LAUNCH_PATH = new URL('../sidecars/dogzilla_navigation/robodoge_nav2_navigation_launch.py', import.meta.url)
const GAIT_ADAPTER_PATH = new URL('../sidecars/dogzilla_navigation/cmd_vel_gait_adapter.py', import.meta.url)
const NAV2_GAIT_MAPPING_PATH = new URL('../sidecars/dogzilla_lib_bridge/nav2_gait_adapter.py', import.meta.url)
const MAP_POSE_SCRIPT_PATH = new URL('../sidecars/dogzilla_map_pose/start-map-pose-in-container.sh', import.meta.url)
const SAVE_MAP_POSE_SCRIPT_PATH = new URL('../sidecars/dogzilla_map_pose/save-map-pose-in-container.sh', import.meta.url)
const SSH_SCRIPT_PATH = new URL('../scripts/start-dogzilla-navigation-ssh.ps1', import.meta.url)
const BRIDGE_SSH_SCRIPT_PATH = new URL('../scripts/start-dogzilla-bridge-ssh.ps1', import.meta.url)
const YOLO_SSH_SCRIPT_PATH = new URL('../scripts/start-dogzilla-yolo-vision-ssh.ps1', import.meta.url)
const AUDIO_SSH_SCRIPT_PATH = new URL('../scripts/start-dogzilla-audio-cue-ssh.ps1', import.meta.url)
const YOLO_SERVER_PATH = new URL('../sidecars/dogzilla_yolo_vision/server.py', import.meta.url)

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
  assert.match(script, /controller\["controller_frequency"\] = controller_frequency/)
  assert.match(script, /bt_navigator\["bt_loop_duration"\] = bt_loop_duration_ms/)
  assert.match(script, /bt_navigator\["default_server_timeout"\] = bt_server_timeout_ms/)
  assert.match(script, /bt_navigator\["wait_for_service_timeout"\] = bt_wait_for_service_timeout_ms/)
  assert.match(script, /planner\["expected_planner_frequency"\] = planner_frequency/)
  assert.match(script, /velocity_smoother\["smoothing_frequency"\] = smoother_frequency/)
})

test('DOGZILLA Nav2 startup loosens progress checker for slow quadruped gait', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /DOGZILLA_NAV2_REQUIRED_MOVEMENT_RADIUS="\$\{DOGZILLA_NAV2_REQUIRED_MOVEMENT_RADIUS:-0\.08\}"/)
  assert.match(script, /DOGZILLA_NAV2_MOVEMENT_TIME_ALLOWANCE="\$\{DOGZILLA_NAV2_MOVEMENT_TIME_ALLOWANCE:-45\.0\}"/)
  assert.match(script, /DOGZILLA_NAV2_FAILURE_TOLERANCE="\$\{DOGZILLA_NAV2_FAILURE_TOLERANCE:-5\.0\}"/)
  assert.match(script, /DOGZILLA_NAV2_MIN_SPEED_XY="\$\{DOGZILLA_NAV2_MIN_SPEED_XY:-0\.03\}"/)
  assert.match(script, /DOGZILLA_NAV2_TRANS_STOPPED_VELOCITY="\$\{DOGZILLA_NAV2_TRANS_STOPPED_VELOCITY:-0\.05\}"/)
  assert.match(script, /progress_checker\["required_movement_radius"\] = required_movement_radius/)
  assert.match(script, /progress_checker\["movement_time_allowance"\] = movement_time_allowance/)
  assert.match(script, /controller\["failure_tolerance"\] = max/)
  assert.match(script, /follow_path\["min_speed_xy"\] = min_speed_xy/)
  assert.match(script, /follow_path\["trans_stopped_velocity"\] = trans_stopped_velocity/)
})

test('DOGZILLA Nav2 startup ignores final yaw by default', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /DOGZILLA_NAV2_YAW_GOAL_TOLERANCE="\$\{DOGZILLA_NAV2_YAW_GOAL_TOLERANCE:-6\.283185307179586\}"/)
  assert.match(script, /goal_checker\["yaw_goal_tolerance"\] = yaw_goal_tolerance/)
  assert.match(script, /yaw_goal_tolerance=\{yaw_goal_tolerance\}/)
})

test('DOGZILLA Nav2 launch routes controller and recovery cmd_vel through velocity smoother', async () => {
  const launch = await readFile(LAUNCH_PATH, 'utf-8')
  const controllerBlock = nodeBlock(launch, 'nav2_controller')
  const behaviorBlock = nodeBlock(launch, 'nav2_behaviors')
  const smootherBlock = nodeBlock(launch, 'nav2_velocity_smoother')

  assert.match(controllerBlock, /remappings=remappings \+ \[\("cmd_vel", "cmd_vel_nav"\)\]/)
  assert.match(behaviorBlock, /remappings=remappings \+ \[\("cmd_vel", "cmd_vel_nav"\)\]/)
  assert.match(smootherBlock, /\("cmd_vel", "cmd_vel_nav"\), \("cmd_vel_smoothed", "cmd_vel"\)/)
})

test('DOGZILLA Nav2 startup uses cmd_vel gait adapter as the default base consumer', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /DOGZILLA_NAV2_GAIT_ADAPTER_ENABLED="\$\{DOGZILLA_NAV2_GAIT_ADAPTER_ENABLED:-1\}"/)
  assert.match(script, /cmd_vel_gait_adapter\.py/)
  assert.match(script, /DOGZILLA_NAV2_GAIT_ADAPTER_URL/)
  assert.match(script, /pkill -f "\[y\]ahboom_base\.\*base"/)
  assert.match(script, /else[\s\S]+ros2 run yahboom_base base/)
})

test('DOGZILLA Nav2 startup probes the gait adapter endpoint directly', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /"source": "startup-probe"/)
  assert.match(script, /urllib\.request\.Request\(\s*url,/)
  assert.match(script, /DOGZILLA gait adapter zero-command probe failed/)
  assert.doesNotMatch(script, /health_url = url\.rsplit/)
})

test('DOGZILLA Nav2 startup allows ROS discovery time for the gait adapter', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /for _ in \$\(seq 1 60\); do[\s\S]+ros2 topic info \/cmd_vel/)
  assert.match(script, /sleep 0\.5/)
})

test('DOGZILLA Nav2 startup rejects stale odom publishers before launching Nav2', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /odom_has_live_sample\(\)/)
  assert.match(script, /robodoge_odom_startup_probe/)
  assert.match(script, /create_subscription\(Odometry, "\/odom"/)
  assert.match(script, /no live Odometry sample arrived/)
  assert.match(script, /probe_odom_tf\(\)/)
  assert.match(script, /grep -q "Translation:" \/tmp\/robodoge-odom-tf-probe\.txt/)
  assert.doesNotMatch(script, /tf2_echo odom "\$base_frame" 2>&1 \| tee/)
  assert.match(script, /odom->base_link\/base_footprint/)
  assert.match(script, /Repo-owned TF odom helper is running; waiting for discovery before restart/)
  assert.match(script, /letting app readiness wait/)
})

test('DOGZILLA Nav2 startup masks self-hit scan arc before costmaps', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /DOGZILLA_NAV2_SCAN_FILTER_TOPIC="\$\{DOGZILLA_NAV2_SCAN_FILTER_TOPIC:-\/scan_nav2\}"/)
  assert.match(script, /DOGZILLA_NAV2_SCAN_FILTER_MASK_START_DEG="\$\{DOGZILLA_NAV2_SCAN_FILTER_MASK_START_DEG:-120\}"/)
  assert.match(script, /DOGZILLA_NAV2_SCAN_FILTER_MASK_END_DEG="\$\{DOGZILLA_NAV2_SCAN_FILTER_MASK_END_DEG:-260\}"/)
  assert.match(script, /DOGZILLA_NAV2_SCAN_FILTER_MASK_RANGE_M="\$\{DOGZILLA_NAV2_SCAN_FILTER_MASK_RANGE_M:-0\.45\}"/)
  assert.match(script, /source\["topic"\] = scan_topic/)
  assert.match(script, /source\["inf_is_valid"\] = True/)
  assert.match(script, /scan_self_filter\.py/)
  assert.match(script, /--mask-start-deg "\$DOGZILLA_NAV2_SCAN_FILTER_MASK_START_DEG"/)
  assert.match(script, /--mask-end-deg "\$DOGZILLA_NAV2_SCAN_FILTER_MASK_END_DEG"/)
  assert.match(script, /--mask-range-m "\$DOGZILLA_NAV2_SCAN_FILTER_MASK_RANGE_M"/)
})

test('DOGZILLA Nav2 startup waits for managed lifecycle activation', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /pkill -f "\[s\]moother_server"/)
  assert.match(script, /grep -q "Managed nodes are active"/)
  assert.match(script, /did not become fully active/)
})

test('DOGZILLA Nav2 startup repairs missing odom TF through map-pose localization', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /start_map_pose_localization\(\)/)
  assert.match(script, /sidecars\/dogzilla_map_pose\/start-map-pose-in-container\.sh/)
  assert.match(script, /Starting DOGZILLA Cartographer map-pose localization/)
  assert.match(script, /ensure_odom_tf\(\)/)
  assert.match(script, /wait_for_odom_tf 30 2/)
  assert.match(script, /bash "\$map_pose_script" >&2/)
  assert.match(script, /start_tf_odom_helper "\$tf_target"/)
})

test('DOGZILLA map-pose startup waits for fresh pose after Cartographer restart', async () => {
  const script = await readFile(MAP_POSE_SCRIPT_PATH, 'utf-8')

  assert.match(script, /started_at = time\.time\(\)/)
  assert.match(script, /received_at >= started_at - 1\.0/)
  assert.match(script, /age_sec <= 2\.0/)
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
  assert.match(script, /DOGZILLA_MAP_PBSTREAM="\$\{DOGZILLA_MAP_PBSTREAM:-\$REMOTE_ROOT\/maps\/robodoge_home\.pbstream\}"/)
})

test('DOGZILLA map-pose startup retries apt while another startup owns the lock', async () => {
  const script = await readFile(MAP_POSE_SCRIPT_PATH, 'utf-8')

  assert.match(script, /map-pose-startup\.lock/)
  assert.match(script, /Timed out waiting for another DOGZILLA map-pose startup/)
  assert.match(script, /run_apt_get_once\(\)/)
  assert.match(script, /\/tmp\/robodoge-apt\.lock/)
  assert.match(script, /dpkg --configure -a/)
  assert.match(script, /run_apt_get\(\)/)
  assert.match(script, /waiting for apt\/dpkg lock/)
  assert.match(script, /run_apt_get update/)
  assert.match(script, /run_apt_get install -y --no-install-recommends "\$\{missing_packages\[@\]\}"/)
  assert.match(script, /exec 8>&- 2>\/dev\/null \|\| true[\s\S]+nohup "\$\{cartographer_args\[@\]\}"/)
  assert.match(script, /exec 8>&- 2>\/dev\/null \|\| true[\s\S]+cartographer_occupancy_grid_node/)
})

test('DOGZILLA map save refuses localization and writes unique map identity', async () => {
  const script = await readFile(SAVE_MAP_POSE_SCRIPT_PATH, 'utf-8')

  assert.match(script, /Refusing to save map while Cartographer is in localization mode/)
  assert.match(script, /DOGZILLA_MAP_SAVE_ALLOW_LOCALIZATION/)
  assert.match(script, /map_id="\$\{DOGZILLA_MAP_ID:-robodoge_home_\$\(date -u \+%Y%m%dT%H%M%SZ\)\}"/)
  assert.match(script, /"id": "\$map_id"/)
  assert.match(script, /"activeAlias": "robodoge_home"/)
})

test('DOGZILLA Nav2 startup resolves map yaml from active map metadata', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /DOGZILLA_MAP_METADATA/)
  assert.match(script, /metadata\.get\("yaml"\)/)
  assert.match(script, /DOGZILLA_NAV2_MAP="\$\{DOGZILLA_NAV2_MAP:-\$REMOTE_ROOT\/maps\/robodoge_home\.yaml\}"/)
})

test('DOGZILLA Nav2 startup retries apt while map-pose startup owns the lock', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /nav2-startup\.lock/)
  assert.match(script, /Timed out waiting for another DOGZILLA Nav2 startup/)
  assert.match(script, /run_apt_get_once\(\)/)
  assert.match(script, /\/tmp\/robodoge-apt\.lock/)
  assert.match(script, /dpkg --configure -a/)
  assert.match(script, /run_apt_get\(\)/)
  assert.match(script, /waiting for apt\/dpkg lock/)
  assert.match(script, /run_apt_get update/)
  assert.match(script, /run_apt_get install -y --no-install-recommends "\$\{missing_packages\[@\]\}"/)
  assert.match(script, /exec 8>&- 2>\/dev\/null \|\| true[\s\S]+cmd_vel_gait_adapter\.py/)
  assert.match(script, /exec 8>&- 2>\/dev\/null \|\| true[\s\S]+ros2 launch "\$DOGZILLA_NAV2_LAUNCH"/)
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
  const audioScript = await readFile(AUDIO_SSH_SCRIPT_PATH, 'utf-8')

  assert.doesNotMatch(yoloScript, /python3 - <<'PY'/)
  assert.doesNotMatch(yoloScript, /\$detectCameraCommand = @'/)
  assert.match(yoloScript, /\$detectCameraCommand = 'for candidate in \/dev\/v4l\/by-id\/\*video-index0/)
  assert.match(yoloScript, /python3 -c \$installProbeQuoted/)
  assert.match(yoloScript, /fuser -k \$releaseCameraSource/)
  assert.match(yoloScript, /\$stopPattern = "\[s\]idecars\/dogzilla_yolo_vision\/server\.py"/)
  assert.match(yoloScript, /pgrep -f ' \+ \$stopPatternQuoted/)
  assert.match(yoloScript, /\[ "\$pid" = "\$\$" \] \|\| \[ "\$pid" = "\$PPID" \]/)
  assert.match(yoloScript, /kill -TERM "\$pid"/)
  assert.match(yoloScript, /kill -KILL "\$pid"/)

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
  assert.match(mapping, /DOGZILLA_NAV2_GAIT_MAX_X_STEP", "14"/)
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

function nodeBlock(source, packageName) {
  const start = source.indexOf(`package="${packageName}"`)
  assert.notEqual(start, -1, `missing ${packageName} node`)
  const next = source.indexOf('Node(', start + 1)
  return next === -1 ? source.slice(start) : source.slice(start, next)
}
