import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const SCRIPT_PATH = new URL('../sidecars/dogzilla_navigation/start-navigation-in-container.sh', import.meta.url)
const LAUNCH_PATH = new URL('../sidecars/dogzilla_navigation/robodoge_nav2_navigation_launch.py', import.meta.url)
const GAIT_ADAPTER_PATH = new URL('../sidecars/dogzilla_navigation/cmd_vel_gait_adapter.py', import.meta.url)

test('DOGZILLA Nav2 startup generates doorway-tuned params from upstream defaults', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /DOGZILLA_NAV2_BASE_PARAMS=.*nav2_bringup\/params\/nav2_params\.yaml/)
  assert.match(script, /DOGZILLA_NAV2_ROBOT_RADIUS="\$\{DOGZILLA_NAV2_ROBOT_RADIUS:-0\.16\}"/)
  assert.match(script, /DOGZILLA_NAV2_INFLATION_RADIUS="\$\{DOGZILLA_NAV2_INFLATION_RADIUS:-0\.28\}"/)
  assert.match(script, /DOGZILLA_NAV2_COST_SCALING_FACTOR="\$\{DOGZILLA_NAV2_COST_SCALING_FACTOR:-8\.0\}"/)
  assert.match(script, /yaml\.safe_load/)
  assert.match(script, /robot_radius/)
  assert.match(script, /inflation_radius/)
  assert.match(script, /params_file:="\$DOGZILLA_NAV2_PARAMS"/)
})

test('DOGZILLA Nav2 startup lowers loop rates for Pi runtime load', async () => {
  const script = await readFile(SCRIPT_PATH, 'utf-8')

  assert.match(script, /controller\["controller_frequency"\] = 10\.0/)
  assert.match(script, /bt_navigator\["bt_loop_duration"\] = 50/)
  assert.match(script, /planner\["expected_planner_frequency"\] = 2\.0/)
  assert.match(script, /velocity_smoother\["smoothing_frequency"\] = 10\.0/)
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

test('DOGZILLA cmd_vel gait adapter forwards Nav2 Twist to the non-preempting bridge endpoint', async () => {
  const adapter = await readFile(GAIT_ADAPTER_PATH, 'utf-8')

  assert.match(adapter, /geometry_msgs\.msg import Twist/)
  assert.match(adapter, /http:\/\/127\.0\.0\.1:8893\/nav2\/cmd_vel/)
  assert.match(adapter, /stale-stop/)
  assert.match(adapter, /DOGZILLA_NAV2_GAIT_ADAPTER_MAX_RATE_HZ/)
})

function nodeBlock(source, packageName) {
  const start = source.indexOf(`package="${packageName}"`)
  assert.notEqual(start, -1, `missing ${packageName} node`)
  const next = source.indexOf('Node(', start + 1)
  return next === -1 ? source.slice(start) : source.slice(start, next)
}
