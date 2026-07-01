import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRequiredServiceDescriptors,
  forceDogzillaRequiredServicesOnStartup,
  shouldForceDogzillaRequiredServices,
} from '../lib/dogzilla-required-services-launcher.mjs'

const ROSBRIDGE_URL = 'ws://dogzilla:9090'

function healthyLidar() {
  return { ok: true, status: 'ok', destination: ROSBRIDGE_URL }
}

function disabledLidar() {
  return { ok: false, status: 'disconnected', destination: ROSBRIDGE_URL }
}

test('shouldForceDogzillaRequiredServices follows required YOLO and audio config', () => {
  assert.equal(shouldForceDogzillaRequiredServices({}), false)
  assert.equal(shouldForceDogzillaRequiredServices({ vision: { enabled: true } }), true)
  assert.equal(shouldForceDogzillaRequiredServices({ audio: { enabled: true } }), true)
  assert.equal(shouldForceDogzillaRequiredServices({ lidar: { enabled: true } }), false)
  assert.equal(shouldForceDogzillaRequiredServices({ vision: { enabled: true } }, {
    APP_DOGZILLA_REQUIRED_SERVICES_START: '0',
  }), false)
})

test('buildRequiredServiceDescriptors maps YOLO and audio only', () => {
const descriptors = buildRequiredServiceDescriptors({
vision: {
enabled: true,
statusUrl: 'http://dogzilla:8894/healthz',
    },
    audio: {
      enabled: true,
      healthUrl: 'http://dogzilla:8895/healthz',
    },
lidar: {
enabled: true,
transport: 'rosbridge',
rosbridgeUrl: ROSBRIDGE_URL,
},
})

assert.deepEqual(descriptors.map((descriptor) => descriptor.id), ['audio', 'vision'])
assert.deepEqual(descriptors.map((descriptor) => descriptor.action), ['start-audio', 'start-yolo'])
})

test('forceDogzillaRequiredServicesOnStartup starts support services without map-pose or Nav2', async () => {
  const startedActions = []
  const readyUrls = new Set()
  const result = await forceDogzillaRequiredServicesOnStartup({
    config: {
      audio: { enabled: true, healthUrl: 'http://dogzilla:8895/healthz' },
      vision: { enabled: true, statusUrl: 'http://dogzilla:8894/healthz' },
      lidar: { enabled: true, transport: 'rosbridge', rosbridgeUrl: ROSBRIDGE_URL },
    },
    logger: silentLogger(),
    fetchImpl: async (url) => jsonResponse({ ok: readyUrls.has(String(url)) }),
    getDogzillaLidarHealthImpl: async () => startedActions.includes('start-lidar') ? healthyLidar() : disabledLidar(),
    runDogzillaConnectionActionImpl: async (action) => {
      startedActions.push(action)
      if (action === 'start-audio') readyUrls.add('http://dogzilla:8895/healthz')
      if (action === 'start-yolo') readyUrls.add('http://dogzilla:8894/healthz')
      return { status: 'ok', action }
    },
    sleepImpl: async () => {},
  })

assert.equal(result.status, 'ok')
assert.deepEqual(startedActions, ['start-audio', 'start-yolo'])
assert.equal(result.results.lidar, undefined)
assert.equal(result.results.mapPose, undefined)
})

test('forceDogzillaRequiredServicesOnStartup ignores Pi-owned lidar rosbridge', async () => {
  const startedActions = []
  const result = await forceDogzillaRequiredServicesOnStartup({
    config: {
      lidar: { enabled: true, transport: 'rosbridge', rosbridgeUrl: ROSBRIDGE_URL },
    },
    logger: silentLogger(),
    getDogzillaLidarHealthImpl: healthyLidar,
    runDogzillaConnectionActionImpl: async (action) => {
      startedActions.push(action)
      return { status: 'ok', action }
    },
  })

assert.equal(result.status, 'skipped')
  assert.deepEqual(startedActions, [])
  assert.equal(result.results.lidar, undefined)
})

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return body
    },
  }
}

function silentLogger() {
  return {
    log() {},
    warn() {},
  }
}
