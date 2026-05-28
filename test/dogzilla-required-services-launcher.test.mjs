import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRequiredServiceDescriptors,
  forceDogzillaRequiredServicesOnStartup,
  shouldForceDogzillaRequiredServices,
} from '../lib/dogzilla-required-services-launcher.mjs'

test('shouldForceDogzillaRequiredServices follows required YOLO and audio config', () => {
  assert.equal(shouldForceDogzillaRequiredServices({}), false)
  assert.equal(shouldForceDogzillaRequiredServices({ vision: { enabled: true } }), true)
  assert.equal(shouldForceDogzillaRequiredServices({ audio: { enabled: true } }), true)
  assert.equal(shouldForceDogzillaRequiredServices({ vision: { enabled: true } }, {
    APP_DOGZILLA_REQUIRED_SERVICES_START: '0',
  }), false)
})

test('buildRequiredServiceDescriptors maps YOLO and audio to startup actions', () => {
  assert.deepEqual(buildRequiredServiceDescriptors({
    vision: {
      enabled: true,
      statusUrl: 'http://dogzilla:8894/healthz',
    },
    audio: {
      enabled: true,
      healthUrl: 'http://dogzilla:8895/healthz',
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
  ])
})

test('forceDogzillaRequiredServicesOnStartup starts configured services that are not healthy', async () => {
  const startedActions = []
  const readyUrls = new Set()
  const urlByAction = new Map([
    ['start-yolo', 'http://dogzilla:8894/healthz'],
    ['start-audio', 'http://dogzilla:8895/healthz'],
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
    },
    logger: silentLogger(),
    fetchImpl: async (url) => jsonResponse(true, { ok: readyUrls.has(String(url)) }),
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
  assert.deepEqual(startedActions, ['start-yolo', 'start-audio'])
  assert.equal(result.results.vision.reusedService, false)
  assert.equal(result.results.audio.reusedService, false)
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
    },
    logger: silentLogger(),
    fetchImpl: async () => jsonResponse(true, { ok: true }),
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
