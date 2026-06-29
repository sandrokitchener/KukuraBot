import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deriveNav2StabilityFromHealth,
  getNav2Stability,
  recordNav2CommandFailure,
  recordNav2RepairResult,
  recordNav2RepairStart,
  resetNav2Stability,
} from '../lib/dogzilla-nav2-stability.mjs'
import { nav2HealthBody } from '../test-support/robot-http-fixtures.mjs'

test.beforeEach(() => {
  resetNav2Stability()
})

function recordConfirmedStateSnapshotFailure(body) {
  deriveNav2StabilityFromHealth(body, { source: 'state-snapshot' })
  deriveNav2StabilityFromHealth(body, { source: 'state-snapshot' })
}

test('ready state tolerates one missed bridge probe before disconnected', () => {
  const readyHealth = nav2HealthBody()
  deriveNav2StabilityFromHealth(readyHealth, { source: 'state-snapshot', bridgeDestination: 'http://10.0.4.32:8893' })
  assert.equal(getNav2Stability().state, 'ready')

  deriveNav2StabilityFromHealth(null, { source: 'state-snapshot', bridgeDestination: 'http://10.0.4.32:8893' })
  assert.equal(getNav2Stability().state, 'ready')

  deriveNav2StabilityFromHealth(null, { source: 'state-snapshot', bridgeDestination: 'http://10.0.4.32:8893' })

  const stability = getNav2Stability()
  assert.equal(stability.state, 'disconnected')
  assert.match(stability.currentBlocker, /No runtime data from bridge/)
  assert.ok(stability.recentEvents.some((event) => event.nextState === 'disconnected' && event.source === 'state-snapshot'))
})
test('ready -> blocked with action/lifecycle/odom/TF/scan blockers', () => {
  const readyHealth = nav2HealthBody()
  deriveNav2StabilityFromHealth(readyHealth, { source: 'state-snapshot' })
  assert.equal(getNav2Stability().state, 'ready')

  const actionMissing = nav2HealthBody({
    nav2: { available: false, serverAvailable: false, serverError: 'Nav2 NavigateToPose action server is not running' },
  })
  recordConfirmedStateSnapshotFailure(actionMissing)
  assert.equal(getNav2Stability().state, 'blocked')
  assert.match(getNav2Stability().currentBlocker, /NavigateToPose action server/)
  assert.equal(getNav2Stability().recentEvents.at(-1).readinessStep, 'action_server')

  resetNav2Stability()
  deriveNav2StabilityFromHealth(readyHealth, { source: 'state-snapshot' })
  const lifecycleMissing = nav2HealthBody({
    navigation: { blockers: ['Nav2 lifecycle nodes are not active: controller_server'] },
  })
  recordConfirmedStateSnapshotFailure(lifecycleMissing)
  assert.equal(getNav2Stability().state, 'blocked')
  assert.equal(getNav2Stability().recentEvents.at(-1).readinessStep, 'lifecycle')

  resetNav2Stability()
  deriveNav2StabilityFromHealth(readyHealth, { source: 'state-snapshot' })
  const odomMissing = nav2HealthBody({
    navigation: { blockers: ['/odom not available'] },
  })
  recordConfirmedStateSnapshotFailure(odomMissing)
  assert.equal(getNav2Stability().state, 'blocked')
  assert.equal(getNav2Stability().recentEvents.at(-1).readinessStep, 'odom')

  resetNav2Stability()
  deriveNav2StabilityFromHealth(readyHealth, { source: 'state-snapshot' })
  const tfMissing = nav2HealthBody({
    navigation: { blockers: ['map->base_link TF unavailable'] },
  })
  recordConfirmedStateSnapshotFailure(tfMissing)
  assert.equal(getNav2Stability().state, 'blocked')
  assert.equal(getNav2Stability().recentEvents.at(-1).readinessStep, 'tf')

  resetNav2Stability()
  deriveNav2StabilityFromHealth(readyHealth, { source: 'state-snapshot' })
  const scanMissing = nav2HealthBody({
    navigation: { blockers: ['Filtered scan not ready on /scan_nav2'] },
  })
  recordConfirmedStateSnapshotFailure(scanMissing)
  assert.equal(getNav2Stability().state, 'blocked')
  assert.equal(getNav2Stability().recentEvents.at(-1).readinessStep, 'scan')
})

test('duplicate transition dedupe does not record a new event', () => {
  deriveNav2StabilityFromHealth(nav2HealthBody(), { source: 'state-snapshot' })
  const eventsAfterFirst = getNav2Stability().recentEvents.length

  deriveNav2StabilityFromHealth(nav2HealthBody(), { source: 'state-snapshot' })
  deriveNav2StabilityFromHealth(nav2HealthBody(), { source: 'state-snapshot' })

  assert.equal(getNav2Stability().recentEvents.length, eventsAfterFirst)
})

test('repair start/result events record source, action, and bridge destination', () => {
  const startEvent = recordNav2RepairStart({
    source: 'command-dispatch',
    repairAction: 'command-time-nav2-repair',
    bridgeDestination: 'http://10.0.4.32:8893/commands',
  })
  assert.ok(startEvent)
  assert.equal(startEvent.nextState, 'repairing')
  assert.equal(startEvent.source, 'command-dispatch')
  assert.equal(startEvent.repairAction, 'command-time-nav2-repair')
  assert.equal(startEvent.bridgeDestination, 'http://10.0.4.32:8893/commands')

  const successEvent = recordNav2RepairResult(true, {
    source: 'command-dispatch',
    repairAction: 'command-time-nav2-repair',
    bridgeDestination: 'http://10.0.4.32:8893/commands',
  })
  assert.ok(successEvent)
  assert.equal(successEvent.nextState, 'ready')
  assert.equal(successEvent.source, 'command-dispatch')

  resetNav2Stability()
  recordNav2RepairStart({ source: 'startup-monitor', repairAction: 'watchdog' })
  const failureEvent = recordNav2RepairResult(false, {
    source: 'startup-monitor',
    repairAction: 'watchdog',
    blocker: 'Nav2 did not become ready after repair attempt',
  })
  assert.ok(failureEvent)
  assert.equal(failureEvent.nextState, 'blocked')
  assert.match(failureEvent.blocker, /did not become ready/)
})

test('recordNav2CommandFailure logs the original blocker text from command dispatch', () => {
  const event = recordNav2CommandFailure({
    source: 'command-dispatch',
    blocker: 'Nav2 NavigateToPose action server unavailable after 2.0s',
    bridgeDestination: 'http://10.0.4.32:8893/commands',
    repairAction: 'command-time-nav2-repair',
  })
  assert.ok(event)
  assert.equal(event.nextState, 'blocked')
  assert.equal(event.source, 'command-dispatch')
  assert.match(event.blocker, /NavigateToPose action server unavailable/)
  assert.equal(event.readinessStep, 'action_server')
  assert.equal(event.bridgeDestination, 'http://10.0.4.32:8893/commands')
  assert.equal(event.repairAction, 'command-time-nav2-repair')
})
