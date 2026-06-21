import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDogzillaWaypointNavigationReadinessSteps,
  getDogzillaWaypointNavigationReadiness,
} from '../lib/dogzilla-navigation-readiness.mjs'

test('DOGZILLA waypoint readiness requires action, odom, lifecycle, and filtered scan', () => {
  const ready = getDogzillaWaypointNavigationReadiness({
    nav2: readyNav2(),
  })

  assert.equal(ready.ready, true)
  assert.equal(ready.actionAvailable, true)
  assert.equal(ready.odomReady, true)
  assert.equal(ready.lifecycleActive, true)
  assert.equal(ready.scanReady, true)
})

test('DOGZILLA waypoint readiness blocks action plus odom without lifecycle and scan proof', () => {
  const readiness = getDogzillaWaypointNavigationReadiness({
    nav2: {
      ...readyNav2(),
      waypointReady: true,
      lifecycle: undefined,
      scan: undefined,
    },
  })

  assert.equal(readiness.ready, false)
  assert.equal(readiness.actionAvailable, true)
  assert.equal(readiness.odomReady, true)
  assert.match(readiness.reason, /Nav2 lifecycle state was not reported/)
  assert.match(readiness.reason, /No LaserScan publishers visible on \/scan_nav2/)
})

test('DOGZILLA waypoint readiness steps expose missing odom TF as its own startup gate', () => {
  const readiness = getDogzillaWaypointNavigationReadiness({
    nav2: {
      ...readyNav2(),
      waypointReady: false,
      odom: {
        topic: '/odom',
        publisherCount: 1,
        available: true,
        messageAvailable: true,
        tfAvailable: false,
      },
    },
  })
  const steps = buildDogzillaWaypointNavigationReadinessSteps(readiness)
  const odomSamples = steps.find((step) => step.id === 'odom-message')
  const odomTf = steps.find((step) => step.id === 'odom-tf')

  assert.equal(odomSamples.ok, true)
  assert.equal(odomTf.ok, false)
  assert.match(odomTf.detail, /odom->base_link\/base_footprint TF is unavailable/)
})

function readyNav2() {
  return {
    available: true,
    waypointReady: true,
    odom: {
      topic: '/odom',
      publisherCount: 1,
      available: true,
      messageAvailable: true,
      tfAvailable: true,
    },
    lifecycle: {
      active: true,
      nodes: [{ name: 'controller_server', active: true, state: 'active' }],
    },
    scan: {
      topic: '/scan_nav2',
      publisherCount: 1,
      subscriptionCount: 2,
      available: true,
    },
  }
}
