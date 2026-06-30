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

test('runDogzillaStartupWatchdog checks support services and direct bridge only', async () => {
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
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.nav2Ownership, 'pi-owned')
  assert.deepEqual(calls, ['required-services', 'direct-bridge'])
})

test('shouldBlockDogzillaAppLaunchForNavigation never blocks Pi-owned Nav2 startup', () => {
  assert.equal(shouldBlockDogzillaAppLaunchForNavigation({
    status: 'degraded',
    waypointNavigation: {
      enabled: true,
      status: 'error',
    },
  }, {}), false)
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
