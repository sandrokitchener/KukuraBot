import assert from 'node:assert/strict'
import test from 'node:test'

import { tryHandleDogzillaRoute } from '../lib/http-dogzilla-routes.mjs'

test('vision toggle restarts camera stream with detection flag instead of stopping sidecar', async () => {
  const actions = []
  const saved = []
  const sent = []
  const health = [
    { ok: true, detectionEnabled: true, modelLoaded: true },
    { ok: true, detectionEnabled: false, modelLoaded: false },
  ]

  const handled = await tryHandleDogzillaRoute({
    request: { method: 'POST' },
    requestUrl: new URL('http://localhost/api/dogzilla/vision/toggle'),
    response: {},
    readJsonBody: async () => ({ enabled: false }),
    sendJson: async (_response, statusCode, payload) => {
      sent.push({ statusCode, payload })
      return true
    },
    loadDogzillaConnectionConfigImpl: async () => ({
      camera: { streamUrl: 'http://dogzilla:8894/stream.mjpg' },
      vision: { enabled: true, detectionEnabled: true, statusUrl: 'http://dogzilla:8894/healthz' },
    }),
    runDogzillaConnectionActionImpl: async (action, options) => {
      actions.push({ action, options })
      return { status: 'ok' }
    },
    saveDogzillaConnectionConfigImpl: async (update) => {
      saved.push(update)
      return {
        camera: { streamUrl: 'http://dogzilla:8894/stream.mjpg' },
        vision: { enabled: true, detectionEnabled: update.vision.detectionEnabled },
      }
    },
    probeDogzillaVisionHealthImpl: async () => health.shift(),
  })

  assert.equal(handled, true)
  assert.deepEqual(actions, [{ action: 'start-yolo', options: { live: true, detectionEnabled: false } }])
  assert.deepEqual(saved, [{ vision: { enabled: true, detectionEnabled: false } }])
  assert.equal(sent[0].statusCode, 200)
  assert.equal(sent[0].payload.enabled, false)
  assert.equal(sent[0].payload.requestedEnabled, false)
  assert.equal(sent[0].payload.actualEnabled, false)
  assert.equal(sent[0].payload.vision.detectionEnabled, false)
})

test('vision toggle is idempotent and does not restart an already matching state', async () => {
  let actionCount = 0
  let saveCount = 0
  const sent = []
  await tryHandleDogzillaRoute({
    request: { method: 'POST' },
    requestUrl: new URL('http://localhost/api/dogzilla/vision/toggle'),
    response: {},
    readJsonBody: async () => ({ enabled: true }),
    sendJson: async (_response, statusCode, payload) => { sent.push({ statusCode, payload }); return true },
    loadDogzillaConnectionConfigImpl: async () => ({ camera: {}, vision: { enabled: true, detectionEnabled: true } }),
    runDogzillaConnectionActionImpl: async () => { actionCount += 1; return { status: 'ok' } },
    saveDogzillaConnectionConfigImpl: async () => { saveCount += 1; return { camera: {}, vision: { enabled: true, detectionEnabled: true } } },
    probeDogzillaVisionHealthImpl: async () => ({ ok: true, detectionEnabled: true, modelLoaded: true }),
  })

  assert.equal(actionCount, 0)
  assert.equal(saveCount, 0)
  assert.equal(sent[0].payload.requestedEnabled, true)
  assert.equal(sent[0].payload.actualEnabled, true)
  assert.match(sent[0].payload.message, /already enabled/i)
})

test('vision toggle preserves config when YOLO restart fails', async () => {
  let saveCount = 0
  const sent = []
  await tryHandleDogzillaRoute({
    request: { method: 'POST' },
    requestUrl: new URL('http://localhost/api/dogzilla/vision/toggle'),
    response: {},
    readJsonBody: async () => ({ enabled: true }),
    sendJson: async (_response, statusCode, payload) => { sent.push({ statusCode, payload }); return true },
    loadDogzillaConnectionConfigImpl: async () => ({ camera: {}, vision: { enabled: true, detectionEnabled: false } }),
    runDogzillaConnectionActionImpl: async () => ({ status: 'error', error: 'Pi unavailable' }),
    saveDogzillaConnectionConfigImpl: async () => { saveCount += 1; return { camera: {}, vision: { enabled: true, detectionEnabled: true } } },
    probeDogzillaVisionHealthImpl: async () => ({ ok: true, detectionEnabled: false, modelLoaded: false }),
  })

  assert.equal(saveCount, 0)
  assert.equal(sent[0].statusCode, 502)
  assert.equal(sent[0].payload.requestedEnabled, true)
  assert.equal(sent[0].payload.actualEnabled, false)
  assert.equal(sent[0].payload.error, 'Pi unavailable')
})

test('vision toggle rejects saved-config success when live Pi health disagrees', async () => {
  const sent = []
  let probeCount = 0
  await tryHandleDogzillaRoute({
    request: { method: 'POST' },
    requestUrl: new URL('http://localhost/api/dogzilla/vision/toggle'),
    response: {},
    readJsonBody: async () => ({ enabled: true }),
    sendJson: async (_response, statusCode, payload) => { sent.push({ statusCode, payload }); return true },
    loadDogzillaConnectionConfigImpl: async () => ({ camera: {}, vision: { enabled: true, detectionEnabled: false } }),
    runDogzillaConnectionActionImpl: async () => ({ status: 'ok' }),
    saveDogzillaConnectionConfigImpl: async (update) => ({ camera: {}, vision: update.vision }),
    probeDogzillaVisionHealthImpl: async () => {
      probeCount += 1
      return { ok: true, detectionEnabled: false, modelLoaded: false }
    },
  })

  assert.equal(probeCount, 2)
  assert.equal(sent[0].statusCode, 502)
  assert.equal(sent[0].payload.actualEnabled, false)
  assert.match(sent[0].payload.error, /did not reach requested state/i)
})

test('vision toggle accepts loaded detection before camera first-frame health', async () => {
  const sent = []
  const health = [
    { ok: true, detectionEnabled: false, modelLoaded: false },
    { ok: false, detectionEnabled: true, modelLoaded: true, staleFrame: true },
  ]
  await tryHandleDogzillaRoute({
    request: { method: 'POST' },
    requestUrl: new URL('http://localhost/api/dogzilla/vision/toggle'),
    response: {},
    readJsonBody: async () => ({ enabled: true }),
    sendJson: async (_response, statusCode, payload) => { sent.push({ statusCode, payload }); return true },
    loadDogzillaConnectionConfigImpl: async () => ({ camera: {}, vision: { enabled: true, detectionEnabled: false } }),
    runDogzillaConnectionActionImpl: async () => ({ status: 'ok' }),
    saveDogzillaConnectionConfigImpl: async (update) => ({ camera: {}, vision: update.vision }),
    probeDogzillaVisionHealthImpl: async () => health.shift(),
  })

  assert.equal(sent[0].statusCode, 200)
  assert.equal(sent[0].payload.actualEnabled, true)
})
