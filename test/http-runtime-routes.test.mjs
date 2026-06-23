import assert from 'node:assert/strict'
import test from 'node:test'

import { recordWaypointDispatchFromResult } from '../lib/http-runtime-routes.mjs'

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
