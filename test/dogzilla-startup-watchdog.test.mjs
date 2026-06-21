import assert from 'node:assert/strict'
import test from 'node:test'

import {
  runDogzillaStartupWatchdog,
  shouldBlockDogzillaAppLaunchForNavigation,
  shouldRunDogzillaStartupWatchdog,
} from '../lib/dogzilla-startup-watchdog.mjs'

test('shouldRunDogzillaStartupWatchdog follows direct DOGZILLA target and opt-out', () => {
  assert.equal(shouldRunDogzillaStartupWatchdog(directRuntimeConfig(), {}), true)
  assert.equal(shouldRunDogzillaStartupWatchdog({ enabled: true, activeTarget: { kind: 'isaacsim' } }, {}), false)
  assert.equal(shouldRunDogzillaStartupWatchdog(directRuntimeConfig(), {
    APP_DOGZILLA_STARTUP_WATCHDOG: '0',
  }), false)
})

test('runDogzillaStartupWatchdog repairs support services before direct bridge and Nav2', async () => {
  const calls = []
  const result = await runDogzillaStartupWatchdog({
    logger: quietLogger(),
    loadRobotRuntimeConfigImpl: async () => directRuntimeConfig(),
    loadRobotRos2ConfigImpl: async () => directRos2Config(),
    forceDogzillaRequiredServicesOnStartupImpl: async () => {
      calls.push('required-services')
      return { status: 'ok' }
    },
    forceDogzillaDirectBridgeOnStartupImpl: async () => {
      calls.push('direct-bridge')
      return { status: 'ok' }
    },
    forceDogzillaWaypointNavigationOnStartupImpl: async () => {
      calls.push('waypoint-navigation')
      return { status: 'ok' }
    },
  })

  assert.equal(result.status, 'ok')
  assert.deepEqual(calls, ['required-services', 'direct-bridge', 'waypoint-navigation'])
})

test('shouldBlockDogzillaAppLaunchForNavigation blocks failed Nav2 readiness by default', () => {
  assert.equal(shouldBlockDogzillaAppLaunchForNavigation({
    status: 'degraded',
    waypointNavigation: {
      enabled: true,
      status: 'error',
      error: '/odom publishes samples, but odom->base_link/base_footprint TF is unavailable.',
    },
  }, {}), true)

  assert.equal(shouldBlockDogzillaAppLaunchForNavigation({
    status: 'ok',
    waypointNavigation: {
      enabled: true,
      status: 'ok',
    },
  }, {}), false)

  assert.equal(shouldBlockDogzillaAppLaunchForNavigation({
    status: 'degraded',
    waypointNavigation: {
      enabled: true,
      status: 'error',
    },
  }, {
    APP_DOGZILLA_STARTUP_REQUIRE_NAV: '0',
  }), false)
})

function directRuntimeConfig() {
  return {
    enabled: true,
    activeTarget: {
      id: 'dogzilla_direct',
      kind: 'dogzilla-direct',
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

function quietLogger() {
  return {
    log() {},
    warn() {},
  }
}
