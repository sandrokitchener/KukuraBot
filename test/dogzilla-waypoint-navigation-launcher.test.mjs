import assert from 'node:assert/strict'
import test from 'node:test'

import {
  forceDogzillaWaypointNavigationOnStartup,
  isDogzillaWaypointNavigationReady,
  shouldForceDogzillaWaypointNavigation,
} from '../lib/dogzilla-waypoint-navigation-launcher.mjs'

test('shouldForceDogzillaWaypointNavigation follows DOGZILLA Direct target and lidar config', () => {
  assert.equal(shouldForceDogzillaWaypointNavigation(directRuntimeConfig(), { lidar: { enabled: true } }, {}), true)
  assert.equal(shouldForceDogzillaWaypointNavigation(directRuntimeConfig(), { lidar: { enabled: false } }, {}), false)
  assert.equal(shouldForceDogzillaWaypointNavigation({ enabled: true, activeTarget: { kind: 'isaacsim' } }, { lidar: { enabled: true } }, {}), false)
  assert.equal(shouldForceDogzillaWaypointNavigation(directRuntimeConfig(), { lidar: { enabled: true } }, {
    APP_DOGZILLA_WAYPOINT_NAVIGATION_START: '0',
  }), false)
  assert.equal(shouldForceDogzillaWaypointNavigation(directRuntimeConfig(), { lidar: { enabled: false } }, {
    APP_DOGZILLA_WAYPOINT_NAVIGATION_START: '1',
  }), true)
})

test('isDogzillaWaypointNavigationReady accepts Nav2 health only', () => {
  assert.equal(isDogzillaWaypointNavigationReady(nav2Health()), true)
  assert.equal(isDogzillaWaypointNavigationReady(nav2Health({ nav2Available: false })), false)
  assert.equal(isDogzillaWaypointNavigationReady(nav2Health({ odomAvailable: false })), false)
  assert.equal(isDogzillaWaypointNavigationReady(nav2Health({ odomAvailable: false, odomPublisherCount: 1 })), false)
  assert.equal(isDogzillaWaypointNavigationReady(nav2Health({ lifecycleActive: false })), false)
  assert.equal(isDogzillaWaypointNavigationReady(nav2Health({ scanAvailable: false })), false)
  assert.equal(isDogzillaWaypointNavigationReady({ status: 'error' }), false)
})

test('forceDogzillaWaypointNavigationOnStartup reuses existing Nav2 server', async () => {
  const actionCalls = []
  const result = await forceDogzillaWaypointNavigationOnStartup({
    runtimeConfig: directRuntimeConfig(),
    ros2Config: directRos2Config(),
    dogzillaConfig: { lidar: { enabled: true } },
    logger: quietLogger(),
    probeRobotSidecarHealthImpl: async () => nav2Health(),
    runDogzillaConnectionActionImpl: async (action) => {
      actionCalls.push(action)
      return { status: 'ok', action }
    },
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.reusedNavigation, true)
  assert.deepEqual(actionCalls, [])
})

test('forceDogzillaWaypointNavigationOnStartup starts Nav2 and waits for bridge health', async () => {
  const healthSequence = [
    nav2Health({ nav2Available: false }),
    nav2Health({ nav2Available: false }),
    nav2Health(),
  ]
  const actionCalls = []

  const result = await forceDogzillaWaypointNavigationOnStartup({
    runtimeConfig: directRuntimeConfig(),
    ros2Config: directRos2Config(),
    dogzillaConfig: { lidar: { enabled: true } },
    logger: quietLogger(),
    sleepImpl: async () => {},
    probeRobotSidecarHealthImpl: async () => healthSequence.shift() || nav2Health(),
    runDogzillaConnectionActionImpl: async (action) => {
      actionCalls.push(action)
      return { status: 'ok', action }
    },
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.reusedNavigation, false)
  assert.deepEqual(actionCalls, ['start-map-pose', 'start-navigation'])
})

test('forceDogzillaWaypointNavigationOnStartup does not start Nav2 when direct bridge is down', async () => {
  const actionCalls = []
  const result = await forceDogzillaWaypointNavigationOnStartup({
    runtimeConfig: directRuntimeConfig(),
    ros2Config: directRos2Config(),
    dogzillaConfig: { lidar: { enabled: true } },
    logger: quietLogger(),
    probeRobotSidecarHealthImpl: async () => ({
      status: 'error',
      error: 'fetch failed',
    }),
    runDogzillaConnectionActionImpl: async (action) => {
      actionCalls.push(action)
      return { status: 'ok', action }
    },
  })

  assert.equal(result.status, 'error')
  assert.equal(result.error, 'DOGZILLA direct bridge is not ready')
  assert.deepEqual(actionCalls, [])
})

test('forceDogzillaWaypointNavigationOnStartup reports map-pose startup failure', async () => {
  const result = await forceDogzillaWaypointNavigationOnStartup({
    runtimeConfig: directRuntimeConfig(),
    ros2Config: directRos2Config(),
    dogzillaConfig: { lidar: { enabled: true } },
    logger: quietLogger(),
    probeRobotSidecarHealthImpl: async () => nav2Health({ nav2Available: false }),
    runDogzillaConnectionActionImpl: async (action) => ({
      status: 'error',
      action,
      error: 'map pose unavailable',
    }),
  })

  assert.equal(result.status, 'error')
  assert.equal(result.error, 'DOGZILLA map pose is not ready')
  assert.equal(result.mapPoseStartResult.error, 'map pose unavailable')
})

test('forceDogzillaWaypointNavigationOnStartup reports start-navigation failure after map-pose succeeds', async () => {
  const result = await forceDogzillaWaypointNavigationOnStartup({
    runtimeConfig: directRuntimeConfig(),
    ros2Config: directRos2Config(),
    dogzillaConfig: { lidar: { enabled: true } },
    logger: quietLogger(),
    probeRobotSidecarHealthImpl: async () => nav2Health({ nav2Available: false }),
    runDogzillaConnectionActionImpl: async (action) => action === 'start-map-pose'
      ? {
        status: 'ok',
        action,
      }
      : {
        status: 'error',
        action,
        error: 'nav2 launch failed',
      },
  })

  assert.equal(result.status, 'error')
  assert.equal(result.mapPoseStartResult.status, 'ok')
  assert.equal(result.startResult.error, 'nav2 launch failed')
})

function directRuntimeConfig() {
  return {
    enabled: true,
    activeTarget: {
      id: 'dogzilla_direct',
      kind: 'dogzilla-direct',
      label: 'DOGZILLA Direct Bridge',
    },
  }
}

function directRos2Config() {
  return {
    transport: {
      baseUrl: 'http://10.0.4.32:8893',
    },
  }
}

function nav2Health({
  nav2Available = true,
  odomAvailable = true,
  odomPublisherCount = odomAvailable ? 1 : 0,
  lifecycleActive = nav2Available,
  scanAvailable = nav2Available,
} = {}) {
  const waypointReady = nav2Available && odomAvailable && lifecycleActive && scanAvailable
  return {
    status: 'ok',
    destination: 'http://10.0.4.32:8893/healthz',
    body: {
      runtime: {
        available: true,
        nav2: {
          available: nav2Available,
          waypointReady,
          serverAvailable: nav2Available,
          odom: {
            topic: '/odom',
            publisherCount: odomPublisherCount,
            available: odomAvailable,
            messageAvailable: odomAvailable,
            tfAvailable: odomAvailable,
          },
          lifecycle: {
            active: lifecycleActive,
            nodes: [
              { name: 'controller_server', active: lifecycleActive, state: lifecycleActive ? 'active' : 'inactive' },
            ],
            error: lifecycleActive ? null : 'Nav2 lifecycle nodes are not active: controller_server',
          },
          scan: {
            topic: '/scan_nav2',
            publisherCount: scanAvailable ? 1 : 0,
            subscriptionCount: scanAvailable ? 2 : 0,
            available: scanAvailable,
            error: scanAvailable ? null : 'No LaserScan publishers visible on /scan_nav2',
          },
        },
        navigation: {
          available: waypointReady,
          primary: waypointReady ? 'nav2' : 'unavailable',
          actionServerAvailable: nav2Available,
          waypointReady,
        },
      },
    },
  }
}

function quietLogger() {
  return {
    log() {},
    warn() {},
  }
}
