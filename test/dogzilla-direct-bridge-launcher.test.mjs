import assert from 'node:assert/strict'
import test from 'node:test'

import {
  forceDogzillaDirectBridgeOnStartup,
  shouldForceDogzillaDirectBridge,
  shouldStartDirectBridgeLive,
} from '../lib/dogzilla-direct-bridge-launcher.mjs'

test('shouldForceDogzillaDirectBridge follows active DOGZILLA Direct target', () => {
  assert.equal(shouldForceDogzillaDirectBridge({
    enabled: true,
    activeTarget: {
      kind: 'dogzilla-direct',
      managedByApp: false,
    },
  }, {}), true)

  assert.equal(shouldForceDogzillaDirectBridge({
    enabled: true,
    activeTarget: {
      kind: 'isaacsim',
    },
  }, {}), false)

  assert.equal(shouldForceDogzillaDirectBridge({
    enabled: true,
    activeTarget: {
      kind: 'dogzilla-direct',
    },
  }, {
    APP_DOGZILLA_DIRECT_BRIDGE_START: '0',
  }), false)
})

test('forceDogzillaDirectBridgeOnStartup reuses healthy direct bridge', async () => {
  const actionCalls = []
  const result = await forceDogzillaDirectBridgeOnStartup({
    runtimeConfig: directRuntimeConfig(),
    ros2Config: directRos2Config(),
    logger: quietLogger(),
    probeRobotSidecarHealthImpl: async () => ({
      status: 'ok',
      destination: 'http://10.0.4.32:8893/healthz',
    }),
    runDogzillaConnectionActionImpl: async (action) => {
      actionCalls.push(action)
      return { status: 'ok', action }
    },
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.reusedBridge, true)
  assert.deepEqual(actionCalls, ['stop-vendor-app'])
  assert.equal(result.vendorStopResult.action, 'stop-vendor-app')
})

test('forceDogzillaDirectBridgeOnStartup starts and waits for missing direct bridge', async () => {
  const healthSequence = [
    { status: 'error', error: 'fetch failed (ECONNREFUSED 10.0.4.32:8893)' },
    { status: 'ok', destination: 'http://10.0.4.32:8893/healthz' },
  ]
  const startActions = []

  const result = await forceDogzillaDirectBridgeOnStartup({
    runtimeConfig: directRuntimeConfig(),
    ros2Config: directRos2Config(),
    logger: quietLogger(),
    sleepImpl: async () => {},
    probeRobotSidecarHealthImpl: async () => healthSequence.shift() || healthSequence.at(-1),
    runDogzillaConnectionActionImpl: async (action, options) => {
      startActions.push({ action, options })
      return { status: 'ok', action }
    },
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.reusedBridge, false)
  assert.deepEqual(startActions, [
    {
      action: 'stop-vendor-app',
      options: undefined,
    },
    {
      action: 'start-direct',
      options: { live: false },
    },
  ])
})

test('forceDogzillaDirectBridgeOnStartup replaces healthy direct bridge when requested', async () => {
  const healthSequence = [
    { status: 'ok', destination: 'http://10.0.4.32:8893/healthz' },
    { status: 'ok', destination: 'http://10.0.4.32:8893/healthz' },
  ]
  const startActions = []

  const result = await forceDogzillaDirectBridgeOnStartup({
    runtimeConfig: directRuntimeConfig(),
    ros2Config: directRos2Config(),
    logger: quietLogger(),
    replaceExisting: true,
    sleepImpl: async () => {},
    probeRobotSidecarHealthImpl: async () => healthSequence.shift() || healthSequence.at(-1),
    runDogzillaConnectionActionImpl: async (action, options) => {
      startActions.push({ action, options })
      return { status: 'ok', action }
    },
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.reusedBridge, false)
  assert.deepEqual(startActions, [
    {
      action: 'stop-vendor-app',
      options: undefined,
    },
    {
      action: 'start-direct',
      options: { live: false },
    },
  ])
})

test('shouldStartDirectBridgeLive requires both runtime and transport live mode', () => {
  assert.equal(shouldStartDirectBridgeLive({ dryRun: false }, { transport: { dryRun: false } }), true)
  assert.equal(shouldStartDirectBridgeLive({ dryRun: false }, { transport: { dryRun: true } }), false)
  assert.equal(shouldStartDirectBridgeLive({ dryRun: true }, { transport: { dryRun: false } }), false)
})

function directRuntimeConfig() {
  return {
    enabled: true,
    dryRun: true,
    activeTarget: {
      id: 'dogzilla_direct',
      kind: 'dogzilla-direct',
      label: 'DOGZILLA Direct Bridge',
      managedByApp: false,
    },
  }
}

function directRos2Config() {
  return {
    transport: {
      dryRun: true,
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
