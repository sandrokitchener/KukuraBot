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

function healthyPose() {
  return {
    ok: true,
    status: 'ok',
    waypointSafe: true,
    mapPose: { frame: 'map', x: 0, y: 0, theta: 0 },
    destination: ROSBRIDGE_URL,
  }
}

function disabledLidar() {
  return { ok: false, status: 'disconnected', destination: ROSBRIDGE_URL }
}

function noPose() {
  return { ok: false, status: 'no-pose', waypointSafe: false, destination: ROSBRIDGE_URL }
}

test('shouldForceDogzillaRequiredServices follows required YOLO, audio, and lidar config', () => {
  assert.equal(shouldForceDogzillaRequiredServices({}), false)
  assert.equal(shouldForceDogzillaRequiredServices({ vision: { enabled: true } }), true)
  assert.equal(shouldForceDogzillaRequiredServices({ audio: { enabled: true } }), true)
  assert.equal(shouldForceDogzillaRequiredServices({ lidar: { enabled: true } }), true)
  assert.equal(shouldForceDogzillaRequiredServices({ vision: { enabled: true } }, {
    APP_DOGZILLA_REQUIRED_SERVICES_START: '0',
  }), false)
})

test('buildRequiredServiceDescriptors maps YOLO, audio, lidar, and map pose to startup actions', () => {
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

  assert.equal(descriptors.length, 4)
  assert.equal(descriptors[0].id, 'audio')
  assert.equal(descriptors[0].action, 'start-audio')
  assert.equal(descriptors[0].healthUrl, 'http://dogzilla:8895/healthz')
  assert.equal(descriptors[1].id, 'vision')
  assert.equal(descriptors[1].action, 'start-yolo')
  assert.equal(descriptors[1].healthUrl, 'http://dogzilla:8894/healthz')
  assert.equal(descriptors[2].id, 'lidar')
  assert.equal(descriptors[2].label, 'DOGZILLA rosbridge')
  assert.equal(descriptors[2].action, 'start-lidar')
  assert.equal(typeof descriptors[2].probe, 'function')
  assert.equal(descriptors[2].destination, ROSBRIDGE_URL)
  assert.equal(descriptors[3].id, 'mapPose')
  assert.equal(descriptors[3].label, 'DOGZILLA map pose localization')
  assert.equal(descriptors[3].action, 'start-map-pose')
  assert.equal(typeof descriptors[3].probe, 'function')
  assert.equal(descriptors[3].expectMapPose, true)
  assert.equal(descriptors[3].requiresService, 'lidar')
  assert.equal(descriptors[3].destination, ROSBRIDGE_URL)
})

test('forceDogzillaRequiredServicesOnStartup starts configured services that are not healthy', async () => {
  const startedActions = []
  const probeState = { lidar: false, pose: false }
  const readyUrls = new Set()

  const result = await forceDogzillaRequiredServicesOnStartup({
    config: {
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
    },
    logger: silentLogger(),
    fetchImpl: async (url) => jsonResponse({ ok: readyUrls.has(String(url)) }),
    getDogzillaLidarHealthImpl: async () => (probeState.lidar ? healthyLidar() : disabledLidar()),
    getDogzillaRobotPoseImpl: async () => (probeState.pose ? healthyPose() : noPose()),
    runDogzillaConnectionActionImpl: async (action) => {
      startedActions.push(action)
      if (action === 'start-audio') readyUrls.add('http://dogzilla:8895/healthz')
      if (action === 'start-yolo') readyUrls.add('http://dogzilla:8894/healthz')
      if (action === 'start-lidar') probeState.lidar = true
      if (action === 'start-map-pose') probeState.pose = true
      return { status: 'ok', action }
    },
    sleepImpl: async () => {},
  })

  assert.equal(result.status, 'ok')
  assert.deepEqual(startedActions, ['start-audio', 'start-yolo', 'start-lidar', 'start-map-pose'])
  assert.equal(result.results.vision.reusedService, false)
  assert.equal(result.results.audio.reusedService, false)
  assert.equal(result.results.lidar.reusedService, false)
  assert.equal(result.results.mapPose.reusedService, false)
})

test('forceDogzillaRequiredServicesOnStartup reuses healthy services', async () => {
  const startedActions = []
  const result = await forceDogzillaRequiredServicesOnStartup({
    config: {
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
    },
    logger: silentLogger(),
    fetchImpl: async (url) => jsonResponse({ ok: true }),
    getDogzillaLidarHealthImpl: healthyLidar,
    getDogzillaRobotPoseImpl: healthyPose,
    runDogzillaConnectionActionImpl: async (action) => {
      startedActions.push(action)
      return { status: 'ok', action }
    },
  })

  assert.equal(result.status, 'ok')
  assert.deepEqual(startedActions, [])
  assert.equal(result.results.vision.reusedService, true)
  assert.equal(result.results.audio.reusedService, true)
  assert.equal(result.results.lidar.reusedService, true)
  assert.equal(result.results.mapPose.reusedService, true)
})

test('forceDogzillaRequiredServicesOnStartup reuses top-level map pose response', async () => {
  const startedActions = []
  const result = await forceDogzillaRequiredServicesOnStartup({
    config: {
      lidar: {
        enabled: true,
        transport: 'rosbridge',
        rosbridgeUrl: ROSBRIDGE_URL,
      },
    },
    logger: silentLogger(),
    fetchImpl: async () => jsonResponse({ ok: false }),
    getDogzillaLidarHealthImpl: healthyLidar,
    getDogzillaRobotPoseImpl: async () => ({
      ok: true,
      status: 'ok',
      waypointSafe: true,
      frame: 'map',
      x: 0.00211,
      y: -0.00497,
      destination: ROSBRIDGE_URL,
    }),
    runDogzillaConnectionActionImpl: async (action) => {
      startedActions.push(action)
      return { status: 'ok', action }
    },
  })

  assert.equal(result.status, 'ok')
  assert.deepEqual(startedActions, [])
  assert.equal(result.results.lidar.reusedService, true)
  assert.equal(result.results.mapPose.reusedService, true)
})

test('forceDogzillaRequiredServicesOnStartup replaces healthy services when requested', async () => {
  const startedActions = []
  const result = await forceDogzillaRequiredServicesOnStartup({
    config: {
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
    },
    logger: silentLogger(),
    replaceExisting: true,
    fetchImpl: async (url) => jsonResponse({ ok: true }),
    getDogzillaLidarHealthImpl: healthyLidar,
    getDogzillaRobotPoseImpl: healthyPose,
    runDogzillaConnectionActionImpl: async (action) => {
      startedActions.push(action)
      return { status: 'ok', action }
    },
  })

  assert.equal(result.status, 'ok')
  assert.deepEqual(startedActions, ['start-audio', 'start-yolo', 'start-lidar', 'start-map-pose'])
  assert.equal(result.results.vision.reusedService, false)
  assert.equal(result.results.audio.reusedService, false)
  assert.equal(result.results.lidar.reusedService, false)
  assert.equal(result.results.mapPose.reusedService, false)
})

test('forceDogzillaRequiredServicesOnStartup starts map pose when lidar is healthy but pose is not map-safe', async () => {
  const startedActions = []
  let poseHealthy = false

  const result = await forceDogzillaRequiredServicesOnStartup({
    config: {
      lidar: {
        enabled: true,
        transport: 'rosbridge',
        rosbridgeUrl: ROSBRIDGE_URL,
      },
    },
    logger: silentLogger(),
    fetchImpl: async () => jsonResponse({ ok: false }),
    getDogzillaLidarHealthImpl: healthyLidar,
    getDogzillaRobotPoseImpl: async () => (poseHealthy ? healthyPose() : noPose()),
    runDogzillaConnectionActionImpl: async (action) => {
      startedActions.push(action)
      if (action === 'start-map-pose') poseHealthy = true
      return { status: 'ok', action }
    },
    sleepImpl: async () => {},
  })

  assert.equal(result.status, 'ok')
  assert.deepEqual(startedActions, ['start-map-pose'])
  assert.equal(result.results.lidar.reusedService, true)
  assert.equal(result.results.mapPose.reusedService, false)
})

test('forceDogzillaRequiredServicesOnStartup accepts health recovery after start command failure', async () => {
  const readyUrls = new Set()

  const result = await forceDogzillaRequiredServicesOnStartup({
    config: {
      vision: {
        enabled: true,
        statusUrl: 'http://dogzilla:8894/healthz',
      },
    },
    logger: silentLogger(),
    fetchImpl: async (url) => jsonResponse({ ok: readyUrls.has(String(url)) }),
    runDogzillaConnectionActionImpl: async () => {
      readyUrls.add('http://dogzilla:8894/healthz')
      return {
        status: 'error',
        action: 'start-yolo',
        error: 'launcher returned before health was ready',
      }
    },
    sleepImpl: async () => {},
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.results.vision.status, 'ok')
  assert.equal(result.results.vision.recoveredAfterStartError, true)
  assert.equal(result.results.vision.health.status, 'ok')
})

test('forceDogzillaRequiredServicesOnStartup skips map pose when lidar startup fails', async () => {
  const startedActions = []

  const result = await forceDogzillaRequiredServicesOnStartup({
    config: {
      lidar: {
        enabled: true,
        transport: 'rosbridge',
        rosbridgeUrl: ROSBRIDGE_URL,
      },
    },
    logger: silentLogger(),
    readyTimeoutMs: 1,
    pollIntervalMs: 1,
    fetchImpl: async () => jsonResponse({ ok: false }),
    getDogzillaLidarHealthImpl: disabledLidar,
    getDogzillaRobotPoseImpl: noPose,
    runDogzillaConnectionActionImpl: async (action) => {
      startedActions.push(action)
      return {
        status: 'error',
        action,
        error: 'docker failed',
      }
    },
    sleepImpl: async () => {},
  })

  assert.equal(result.status, 'error')
  assert.deepEqual(startedActions, ['start-lidar'])
  assert.equal(result.results.lidar.status, 'error')
  assert.equal(result.results.mapPose.status, 'skipped')
  assert.match(result.results.mapPose.reason, /lidar is not ready/)
})

function jsonResponse(body) {
  return {
    ok: Boolean(body?.ok),
    status: body?.ok ? 200 : 503,
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
