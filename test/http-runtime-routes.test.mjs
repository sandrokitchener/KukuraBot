import assert from 'node:assert/strict'
import test from 'node:test'

import { recordWaypointDispatchFromResult, tryHandleRuntimeRoute } from '../lib/http-runtime-routes.mjs'

test('recordWaypointDispatchFromResult records sent chat waypoint dispatches', () => {
  let recorded = null

  recordWaypointDispatchFromResult({
    robotDispatch: { status: 'sent' },
    robotRuntime: {
      canonicalPlan: {
        params: {
          waypoint: 'kitchen',
          arrivalToleranceMeters: 0.25,
        },
      },
    },
  }, (dispatch) => {
    recorded = dispatch
  })

  assert.deepEqual(recorded, {
    waypointName: 'kitchen',
    arrivalTolerance: 0.25,
  })
})

test('recordWaypointDispatchFromResult ignores unsent robot dispatches', () => {
  let called = false

  recordWaypointDispatchFromResult({
    robotDispatch: { status: 'navigation-unavailable' },
    robotRuntime: {
      canonicalPlan: {
        params: {
          waypoint: 'kitchen',
        },
      },
    },
  }, () => {
    called = true
  })

  assert.equal(called, false)
})

test('performance profile route switches reversible profile and returns public config', async () => {
  const sent = []
  let selected = ''
  const handled = await tryHandleRuntimeRoute({
    request: { method: 'POST' },
    requestUrl: new URL('http://localhost/api/settings/performance-profile'),
    response: {},
    readJsonBody: async () => ({ profileId: 'endurance' }),
    sendJson: async (_response, statusCode, payload) => {
      sent.push({ statusCode, payload })
      return true
    },
    loadRobotRuntimeConfigImpl: async () => ({ performanceSelectionLocked: false }),
    setActiveRobotPerformanceProfileImpl: async (profileId) => { selected = profileId },
    loadPublicConfigImpl: async () => ({ robotRuntime: { performanceProfile: { id: selected } } }),
  })

  assert.equal(handled, true)
  assert.equal(selected, 'endurance')
  assert.equal(sent[0].statusCode, 200)
  assert.equal(sent[0].payload.robotRuntime.performanceProfile.id, 'endurance')
})

test('performance profile route refuses environment-locked selection', async () => {
  const sent = []
  await tryHandleRuntimeRoute({
    request: { method: 'POST' },
    requestUrl: new URL('http://localhost/api/settings/performance-profile'),
    response: {},
    readJsonBody: async () => ({ profileId: 'balanced' }),
    sendJson: async (_response, statusCode, payload) => {
      sent.push({ statusCode, payload })
      return true
    },
    loadRobotRuntimeConfigImpl: async () => ({ performanceSelectionLocked: true }),
    setActiveRobotPerformanceProfileImpl: async () => { throw new Error('must not write') },
  })

  assert.equal(sent[0].statusCode, 409)
  assert.match(sent[0].payload.error, /locked/)
})
