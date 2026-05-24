import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDogzillaActionPlan,
  normalizeDogzillaConnectionConfig,
} from '../lib/dogzilla-connection-center.mjs'

test('normalizeDogzillaConnectionConfig fills stock DOGZILLA SSH defaults', () => {
  const config = normalizeDogzillaConnectionConfig({
    ssh: {
      host: '192.168.8.88',
    },
  })

  assert.equal(config.ssh.host, '192.168.8.88')
  assert.equal(config.ssh.user, 'pi')
  assert.equal(config.ssh.port, 22)
  assert.equal(config.ssh.alias, 'dogzilla')
  assert.equal(config.bridges.direct.baseUrl, 'http://192.168.8.88:8893')
  assert.equal(config.bridges.ros2.baseUrl, 'http://192.168.8.88:8892')
  assert.equal(config.camera.streamUrl, 'http://192.168.8.88:6500/video_feed')
  assert.equal(config.camera.proxyStreamPath, '/api/dogzilla/camera/stream')
  assert.equal(config.camera.proxyStatusPath, '/api/dogzilla/camera/status')
  assert.equal(config.camera.controlPort, 6000)
  assert.equal(config.camera.wakeCommand, '$010F040115#')
  assert.equal(config.vision.enabled, false)
  assert.equal(config.vision.streamUrl, 'http://192.168.8.88:8894/stream.mjpg')
  assert.equal(config.audio.enabled, false)
  assert.equal(config.audio.cueUrl, 'http://192.168.8.88:8895/cue')
  assert.equal(config.lidar.enabled, false)
  assert.equal(config.lidar.scanUrl, 'http://192.168.8.88:8896/scan')
  assert.equal(config.lidar.proxyScanPath, '/api/dogzilla/lidar/scan')
})

test('normalizeDogzillaConnectionConfig can route camera through YOLO vision sidecar', () => {
  const config = normalizeDogzillaConnectionConfig({
    ssh: {
      host: '192.168.8.88',
    },
    vision: {
      enabled: true,
    },
  })

  assert.equal(config.vision.enabled, true)
  assert.equal(config.vision.statusUrl, 'http://192.168.8.88:8894/healthz')
  assert.equal(config.camera.processed, true)
  assert.equal(config.camera.streamUrl, 'http://192.168.8.88:8894/stream.mjpg')
  assert.equal(config.camera.sourceStreamUrl, 'http://192.168.8.88:6500/video_feed')
  assert.equal(config.camera.controlPort, undefined)
  assert.equal(config.camera.wakeCommand, undefined)
})

test('buildDogzillaActionPlan allowlists start-direct background bridge script', () => {
  const config = normalizeDogzillaConnectionConfig({
    ssh: {
      host: '192.168.8.88',
      user: 'pi',
      alias: 'dogzilla',
    },
    remoteRoot: '/home/pi/robodoge',
  })
  const plan = buildDogzillaActionPlan('start-direct', config)

  assert.equal(plan.action, 'start-direct')
  assert.equal(plan.background, false)
  assert.ok(plan.args.includes('start-dogzilla-bridge-ssh.ps1') || plan.args.some((arg) => arg.endsWith('start-dogzilla-bridge-ssh.ps1')))
  assert.ok(plan.args.includes('-Background'))
  assert.ok(plan.args.includes('-Bridge'))
  assert.ok(plan.args.includes('direct'))
})
