import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('robot controller config points at blockout scene and waypoint config', async () => {
  const raw = JSON.parse(await readFile('config/robot-controller.json', 'utf8'))

  assert.equal(raw.name, 'robot controller')
  assert.equal(raw.sceneFile, 'isaacsim/sim_environment.usd')
  assert.equal(raw.rigRootPrim, '/dogzilla_proxy_blockout/DOGZILLA_PROXY')
  assert.equal(raw.bodyPrim, '/dogzilla_proxy_blockout/DOGZILLA_PROXY/body_link')
  assert.equal(raw.waypointsFile, 'config/isaacsim-waypoints.json')
  assert.ok(raw.supportedActions.includes('robot_controller.goto_waypoint'))
  assert.ok(raw.supportedActions.includes('articulation.play_named_action'))
})
