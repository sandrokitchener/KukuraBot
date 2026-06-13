import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'

test('Yahboom XGO Isaac scene keeps robot controller prim contract', async () => {
  const rig = await readFile('isaacsim/yahboom_xgo_proxy_visual.usda', 'utf8')
  const scene = await readFile('isaacsim/sim_environment_yahboom_xgo.usda', 'utf8')

  assert.ok(scene.includes('references = @./yahboom_xgo_proxy_visual.usda@</World/DOGZILLA_PROXY>'))
  assert.match(rig, /def Xform "body_link"/)
  assert.match(rig, /def Xform "front_left_hip"/)
  assert.match(rig, /def Xform "front_right_hip"/)
  assert.match(rig, /def Xform "rear_left_hip"/)
  assert.match(rig, /def Xform "rear_right_hip"/)
  assert.match(rig, /def Lidar "Lidar"/)
  assert.ok(rig.includes('runtime_contract = "Keeps /dogzilla_proxy_blockout/DOGZILLA_PROXY prim paths'))
})

test('Yahboom XGO mesh library was generated from Pi STL meshes', async () => {
  const meshLibrary = await readFile('isaacsim/assets/yahboom_xgo_from_pi_meshes.usda', 'utf8')
  const generated = await stat('isaacsim/assets/yahboom_xgo_from_pi_meshes.usda')

  assert.ok(generated.size > 1_000_000)
  assert.ok(meshLibrary.includes('source_stl = "yahboom_description_from_pi/meshes/XGO/base_link.STL"'))
  assert.match(meshLibrary, /source_triangle_count = 54720/)
  assert.match(meshLibrary, /def Mesh "laser_link"/)
})

test('Yahboom XGO launch script selects alternate Isaac stage through env var', async () => {
  const raw = await readFile('scripts/launch-isaac-yahboom-xgo.bat', 'utf8')
  const opener = await readFile('isaacsim/runtime/open_sim_environment.py', 'utf8')

  assert.match(raw, /ROBO_DOGE_ISAAC_STAGE=isaacsim\\sim_environment_yahboom_xgo\.usda/i)
  assert.match(raw, /launch-isaac-robot-controller\.bat" %\*/i)
  assert.match(opener, /os\.environ\.get\("ROBO_DOGE_ISAAC_STAGE"/)
})
