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

test('legacy performance profile route is not exposed', async () => {
  let bodyRead = false
  const handled = await tryHandleRuntimeRoute({
    request: { method: 'POST' },
    requestUrl: new URL('http://localhost/api/settings/performance-profile'),
    response: {},
    readJsonBody: async () => { bodyRead = true },
    sendJson: async () => true,
  })

  assert.equal(handled, false)
  assert.equal(bodyRead, false)
})
