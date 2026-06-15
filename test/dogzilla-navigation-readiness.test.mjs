import test from 'node:test'
import assert from 'node:assert/strict'

import { getDogzillaWaypointNavigationReadiness } from '../lib/dogzilla-navigation-readiness.mjs'

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
