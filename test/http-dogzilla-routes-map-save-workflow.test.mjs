import assert from 'node:assert/strict'
import test from 'node:test'

import { tryHandleDogzillaRoute } from '../lib/http-dogzilla-routes.mjs'

test('autonomous mapping start cues preparation before work and readiness after success', async () => {
  const cues = []
  const events = []
  const sent = []

  await tryHandleDogzillaRoute({
    request: { method: 'POST' },
    requestUrl: new URL('http://localhost/api/dogzilla/connection/action'),
    response: {},
    readJsonBody: async () => ({ action: 'start-autonomous-mapping', live: true }),
    sendJson: async (_response, statusCode, payload) => { sent.push({ statusCode, payload }); return true },
    getDogzillaPoseTrack: () => [],
    runDogzillaConnectionActionImpl: async () => { events.push('run'); return { status: 'ok' } },
    sendDogzillaAudioCueImpl: async (cue) => {
      cues.push(cue)
      events.push(cue)
      return { status: 'ok', ok: true, cue }
    },
  })

  assert.deepEqual(cues, ['thinking-start', 'thinking-stop', 'mapping-start'])
  assert.deepEqual(events, ['thinking-start', 'run', 'thinking-stop', 'mapping-start'])
  assert.equal(sent[0].payload.preparingAudioCue.ok, true)
  assert.equal(sent[0].payload.preparingAudioCueStop.ok, true)
  assert.equal(sent[0].payload.audioCue.ok, true)
  assert.equal(sent[0].statusCode, 200)
})

test('resume draft mapping stops its preparation cue and omits ready cue on failure', async () => {
  const cues = []
  const sent = []

  await tryHandleDogzillaRoute({
    request: { method: 'POST' },
    requestUrl: new URL('http://localhost/api/dogzilla/connection/action'),
    response: {},
    readJsonBody: async () => ({ action: 'resume-draft-mapping', live: true }),
    sendJson: async (_response, statusCode, payload) => { sent.push({ statusCode, payload }); return true },
    getDogzillaPoseTrack: () => [],
    runDogzillaConnectionActionImpl: async () => ({ status: 'error', error: 'startup failed' }),
    sendDogzillaAudioCueImpl: async (cue) => { cues.push(cue); return { status: 'ok', ok: true, cue } },
  })

  assert.deepEqual(cues, ['thinking-start', 'thinking-stop'])
  assert.equal(sent[0].statusCode, 400)
})

test('save-map-pose route saves map, clears the legacy origin, and restarts localization', async () => {
  const actions = []
  const sent = []
  let originClearCount = 0

  const handled = await tryHandleDogzillaRoute({
    request: { method: 'POST' },
    requestUrl: new URL('http://localhost/api/dogzilla/connection/action'),
    response: {},
    readJsonBody: async () => ({ action: 'save-map-pose', live: true }),
    sendJson: async (_response, statusCode, payload) => {
      sent.push({ statusCode, payload })
      return true
    },
    getDogzillaPoseTrack: () => [],
    clearDogzillaMapOriginImpl: async () => { originClearCount += 1 },
    runDogzillaConnectionActionImpl: async (action, options) => {
      actions.push({ action, options })
      return action === 'save-map-pose'
        ? { status: 'ok', id: 'robodoge_home_latest', pbstream: '/maps/latest.pbstream' }
        : { status: 'ok', mode: 'localization' }
    },
    getDogzillaRobotPoseImpl: async () => { throw new Error('save-map-pose must not capture a charger origin') },
    getRobotSidecarHealthImpl: async () => { throw new Error('save-map-pose must not infer map identity from health') },
  })

  assert.equal(handled, true)
  assert.deepEqual(actions.map((item) => item.action), ['save-map-pose', 'start-map-pose'])
  assert.deepEqual(actions.map((item) => item.options.live), [true, true])
  assert.equal(originClearCount, 1)
  assert.equal(sent[0].statusCode, 200)
  assert.equal(sent[0].payload.status, 'ok')
  assert.equal(sent[0].payload.mapOriginCleared, true)
  assert.equal(sent[0].payload.localization.status, 'ok')
  assert.equal(sent[0].payload.origin, undefined)
  assert.match(sent[0].payload.message, /without a charger-origin seed/i)
})

test('candidate promotion clears the old origin before localization and Nav2 restart', async () => {
  const actions = []
  const sent = []
  let originCleared = false

  const handled = await tryHandleDogzillaRoute({
    request: { method: 'POST' },
    requestUrl: new URL('http://localhost/api/dogzilla/connection/action'),
    response: {},
    readJsonBody: async () => ({ action: 'promote-map-candidate', live: true }),
    sendJson: async (_response, statusCode, payload) => { sent.push({ statusCode, payload }); return true },
    getDogzillaPoseTrack: () => [],
    clearDogzillaMapOriginImpl: async () => { originCleared = true },
    runDogzillaConnectionActionImpl: async (action) => {
      actions.push(action)
      return { status: 'ok' }
    },
  })

  assert.equal(handled, true)
  assert.equal(originCleared, true)
  assert.deepEqual(actions, ['promote-map-candidate', 'start-map-pose', 'start-navigation'])
  assert.equal(sent[0].statusCode, 200)
  assert.equal(sent[0].payload.mapOriginCleared, true)
})
