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

test('DOGZILLA waypoint readiness trusts the bridge instead of rebuilding its Nav2 topology', () => {
  const readiness = getDogzillaWaypointNavigationReadiness({
    nav2: {
      ...readyNav2(),
      waypointReady: true,
      lifecycle: undefined,
      scan: undefined,
    },
  })

  assert.equal(readiness.ready, true)
  assert.equal(readiness.actionAvailable, true)
  assert.equal(readiness.odomReady, true)
  assert.equal(readiness.lifecycleActive, false)
  assert.equal(readiness.scanReady, false)
  assert.equal(readiness.reason, '')
})

test('DOGZILLA waypoint readiness requires fresh odom samples and fresh odom TF', () => {
  for (const staleField of ['fresh', 'tfFresh']) {
    const nav2 = readyNav2()
    nav2.waypointReady = false
    nav2.odom.available = false
    nav2.odom[staleField] = false

    const readiness = getDogzillaWaypointNavigationReadiness({ nav2 })

    assert.equal(readiness.ready, false, `${staleField} must fail closed`)
    assert.equal(readiness.odomReady, false)
    assert.match(readiness.reason, /stale/i)
  }
})

test('DOGZILLA waypoint readiness fallback uses the bridge lifecycle result without hard-coded node names', () => {
  const nav2 = readyNav2()
  delete nav2.waypointReady
  nav2.lifecycle = {
    active: true,
    requiredNodes: ['controller_server'],
    nodes: [{ name: 'controller_server', active: true }],
  }

  const readiness = getDogzillaWaypointNavigationReadiness({ nav2 })

  assert.equal(readiness.ready, true)
  assert.equal(readiness.lifecycleActive, true)
  assert.deepEqual(readiness.lifecycleRequiredNodes, ['controller_server'])
})

test('DOGZILLA waypoint readiness fallback accepts bridge scan readiness without exact consumer names', () => {
  const nav2 = readyNav2()
  delete nav2.waypointReady
  nav2.scan.consumerNodes = ['/robot/nav2_costmap']

  const readiness = getDogzillaWaypointNavigationReadiness({ nav2 })

  assert.equal(readiness.ready, true)
  assert.equal(readiness.scanReady, true)
  assert.deepEqual(readiness.scanConsumerNodes, ['/robot/nav2_costmap'])
})

test('DOGZILLA bridge readiness never bypasses map-pose safety', () => {
  const readiness = getDogzillaWaypointNavigationReadiness(
    { nav2: readyNav2() },
    { waypointSafe: false },
  )

  assert.equal(readiness.ready, false)
  assert.equal(readiness.poseReady, false)
  assert.match(readiness.reason, /waypointSafe=false/)
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
        fresh: true,
        tfAvailable: false,
        tfFresh: false,
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
  const lifecycleNodes = [
    'map_server',
    'controller_server',
    'planner_server',
    'behavior_server',
    'bt_navigator',
    'velocity_smoother',
    'collision_monitor',
  ]
  return {
    available: true,
    waypointReady: true,
    odom: {
      topic: '/odom',
      publisherCount: 1,
      available: true,
      messageAvailable: true,
      fresh: true,
      tfAvailable: true,
      tfFresh: true,
    },
    lifecycle: {
      active: true,
      requiredNodes: lifecycleNodes,
      nodes: lifecycleNodes.map((name) => ({ name, active: true, state: 'active' })),
    },
    scan: {
      topic: '/scan_nav2',
      publisherCount: 1,
      subscriptionCount: 3,
      available: true,
      messageAvailable: true,
      fresh: true,
      consumerNodes: [
        '/local_costmap/local_costmap',
        '/global_costmap/global_costmap',
        '/collision_monitor',
      ],
    },
  }
}
