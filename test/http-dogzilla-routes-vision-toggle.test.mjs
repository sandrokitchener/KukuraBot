import assert from 'node:assert/strict'
import test from 'node:test'

import { tryHandleDogzillaRoute } from '../lib/http-dogzilla-routes.mjs'

test('vision toggle restarts camera stream with detection flag instead of stopping sidecar', async () => {
  const actions = []
  const saved = []
  const sent = []

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
  })

  assert.equal(handled, true)
  assert.deepEqual(actions, [{ action: 'start-yolo', options: { live: true, detectionEnabled: false } }])
  assert.deepEqual(saved, [{ vision: { enabled: true, detectionEnabled: false } }])
  assert.equal(sent[0].statusCode, 200)
  assert.equal(sent[0].payload.enabled, false)
  assert.equal(sent[0].payload.vision.detectionEnabled, false)
})
