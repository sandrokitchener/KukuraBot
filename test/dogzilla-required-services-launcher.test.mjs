import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRequiredServiceDescriptors,
  forceDogzillaRequiredServicesOnStartup,
  shouldForceDogzillaRequiredServices,
} from '../lib/dogzilla-required-services-launcher.mjs'

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
  assert.deepEqual(buildRequiredServiceDescriptors({
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
      healthUrl: 'http://dogzilla:8896/healthz',
      poseUrl: 'http://dogzilla:8896/pose',
    },
  }), [
    {
      id: 'vision',
      label: 'DOGZILLA YOLO object recognition',
      action: 'start-yolo',
      healthUrl: 'http://dogzilla:8894/healthz',
    },
    {
      id: 'audio',
      label: 'DOGZILLA Pi speaker cues',
      action: 'start-audio',
      healthUrl: 'http://dogzilla:8895/healthz',
    },
    {
      id: 'lidar',
      label: 'DOGZILLA lidar bridge',
      action: 'start-lidar',
      healthUrl: 'http://dogzilla:8896/healthz',
    },
    {
      id: 'mapPose',
      label: 'DOGZILLA map pose localization',
      action: 'start-map-pose',
      healthUrl: 'http://dogzilla:8896/pose',
      expectMapPose: true,
      requiresService: 'lidar',
    },
  ])
})

test('forceDogzillaRequiredServicesOnStartup starts configured services that are not healthy', async () => {
  const startedActions = []
  const readyUrls = new Set()
  const urlByAction = new Map([
    ['start-yolo', 'http://dogzilla:8894/healthz'],
    ['start-audio', 'http://dogzilla:8895/healthz'],
    ['start-lidar', 'http://dogzilla:8896/healthz'],
    ['start-map-pose', 'http://dogzilla:8896/pose'],
  ])

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
        healthUrl: 'http://dogzilla:8896/healthz',
        poseUrl: 'http://dogzilla:8896/pose',
      },
    },
    logger: silentLogger(),
    fetchImpl: async (url) => jsonResponse(true, String(url).endsWith('/pose')
      ? {
        ok: readyUrls.has(String(url)),
        waypointSafe: readyUrls.has(String(url)),
        mapPose: readyUrls.has(String(url)) ? { frame: 'map' } : null,
      }
      : { ok: readyUrls.has(String(url)) }),
    runDogzillaConnectionActionImpl: async (action) => {
      startedActions.push(action)
      readyUrls.add(urlByAction.get(action))
      return {
        status: 'ok',
        action,
      }
    },
    sleepImpl: async () => {},
  })

  assert.equal(result.status, 'ok')
  assert.deepEqual(startedActions, ['start-yolo', 'start-audio', 'start-lidar', 'start-map-pose'])
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
        healthUrl: 'http://dogzilla:8896/healthz',
        poseUrl: 'http://dogzilla:8896/pose',
      },
    },
    logger: silentLogger(),
    fetchImpl: async (url) => jsonResponse(true, String(url).endsWith('/pose')
      ? {
        ok: true,
        waypointSafe: true,
        mapPose: { frame: 'map' },
      }
      : { ok: true }),
    runDogzillaConnectionActionImpl: async (action) => {
      startedActions.push(action)
      return {
        status: 'ok',
        action,
      }
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
        healthUrl: 'http://dogzilla:8896/healthz',
        poseUrl: 'http://dogzilla:8896/pose',
      },
    },
    logger: silentLogger(),
    fetchImpl: async (url) => jsonResponse(true, String(url).endsWith('/pose')
      ? {
        ok: true,
        waypointSafe: true,
        frame: 'map',
        x: 0.00211,
        y: -0.00497,
      }
      : { ok: true }),
    runDogzillaConnectionActionImpl: async (action) => {
      startedActions.push(action)
      return {
        status: 'ok',
        action,
      }
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
        healthUrl: 'http://dogzilla:8896/healthz',
        poseUrl: 'http://dogzilla:8896/pose',
      },
    },
    logger: silentLogger(),
    replaceExisting: true,
    fetchImpl: async (url) => jsonResponse(true, String(url).endsWith('/pose')
      ? {
        ok: true,
        waypointSafe: true,
        mapPose: { frame: 'map' },
      }
      : { ok: true }),
    runDogzillaConnectionActionImpl: async (action) => {
      startedActions.push(action)
      return {
        status: 'ok',
        action,
      }
    },
  })

  assert.equal(result.status, 'ok')
  assert.deepEqual(startedActions, ['start-yolo', 'start-audio', 'start-lidar', 'start-map-pose'])
  assert.equal(result.results.vision.reusedService, false)
  assert.equal(result.results.audio.reusedService, false)
  assert.equal(result.results.lidar.reusedService, false)
  assert.equal(result.results.mapPose.reusedService, false)
})

test('forceDogzillaRequiredServicesOnStartup starts map pose when lidar is healthy but pose is not map-safe', async () => {
  const startedActions = []
  const readyUrls = new Set(['http://dogzilla:8896/healthz'])

  const result = await forceDogzillaRequiredServicesOnStartup({
    config: {
      lidar: {
        enabled: true,
        healthUrl: 'http://dogzilla:8896/healthz',
        poseUrl: 'http://dogzilla:8896/pose',
      },
    },
    logger: silentLogger(),
    fetchImpl: async (url) => jsonResponse(true, String(url).endsWith('/pose')
      ? {
        ok: readyUrls.has(String(url)),
        status: readyUrls.has(String(url)) ? 'ok' : 'no-pose',
        waypointSafe: readyUrls.has(String(url)),
        mapPose: readyUrls.has(String(url)) ? { frame: 'map' } : null,
      }
      : { ok: readyUrls.has(String(url)) }),
    runDogzillaConnectionActionImpl: async (action) => {
      startedActions.push(action)
      if (action === 'start-map-pose') {
        readyUrls.add('http://dogzilla:8896/pose')
      }
      return {
        status: 'ok',
        action,
      }
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
    fetchImpl: async (url) => jsonResponse(true, { ok: readyUrls.has(String(url)) }),
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
        healthUrl: 'http://dogzilla:8896/healthz',
        poseUrl: 'http://dogzilla:8896/pose',
      },
    },
    logger: silentLogger(),
    readyTimeoutMs: 1,
    pollIntervalMs: 1,
    fetchImpl: async () => jsonResponse(false, { ok: false }),
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

function jsonResponse(ok, body) {
  return {
    ok,
    status: ok ? 200 : 503,
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
