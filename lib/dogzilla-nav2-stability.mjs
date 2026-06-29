import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EVENT_LOG_PATH = path.join(__dirname, '..', 'output', 'app-cache', 'nav2-events.ndjson')
const OFF_VALUES = new Set(['0', 'false', 'no', 'off'])
const MAX_RECENT_EVENTS = 20
const STATE_SNAPSHOT_FAILURE_CONFIRMATIONS = 2

const VALID_STATES = new Set([
  'ready',
  'degraded',
  'repairing',
  'disconnected',
  'blocked',
  'unknown',
])

const state = {
  current: 'unknown',
  currentBlocker: null,
  lastReadyAt: null,
  lastFailureAt: null,
  lastRepairAt: null,
  recentEvents: [],
  pendingFailure: null,
}

export function isNav2StabilityTrackerEnabled(env = process.env) {
  const override = String(env.APP_NAV2_STABILITY_TRACKER ?? '').trim().toLowerCase()
  return !OFF_VALUES.has(override)
}

export function getNav2Stability() {
  return {
    state: state.current,
    currentBlocker: state.currentBlocker,
    lastReadyAt: state.lastReadyAt,
    lastFailureAt: state.lastFailureAt,
    lastRepairAt: state.lastRepairAt,
    recentEvents: [...state.recentEvents],
  }
}

export function recordNav2Transition(nextState, options = {}) {
  if (!VALID_STATES.has(nextState)) {
    return null
  }

  const previousState = state.current
  const previousBlocker = state.currentBlocker
  const nextBlocker = typeof options.blocker === 'string' ? options.blocker.trim() : null

if (nextState === 'ready' || nextState === 'repairing') {
  state.pendingFailure = null
} else if (shouldDebounceStateSnapshotFailure({ nextState, nextBlocker, options })) {
  return null
}

  if (previousState === nextState && previousBlocker === nextBlocker) {
    return null
  }

  const now = new Date()
  const timestamp = now.toISOString()

  if (nextState === 'ready') {
    state.lastReadyAt = timestamp
  }
  if (nextState === 'blocked' || nextState === 'disconnected' || nextState === 'degraded') {
    state.lastFailureAt = timestamp
  }
  if (nextState === 'repairing') {
    state.lastRepairAt = timestamp
  }

  state.current = nextState
  state.currentBlocker = nextBlocker

  const event = {
    timestamp,
    previousState,
    nextState,
    source: options.source || 'unknown',
    blocker: nextBlocker,
    readinessStep: options.readinessStep || null,
    probeDurationMs: Number.isFinite(options.probeDurationMs) ? options.probeDurationMs : null,
    bridgeDestination: options.bridgeDestination || null,
    repairAction: options.repairAction || null,
  }

  state.recentEvents.push(event)
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS)
  }

  void persistEvent(event)

  return event
}

export function resetNav2Stability() {
  state.current = 'unknown'
  state.currentBlocker = null
  state.lastReadyAt = null
  state.lastFailureAt = null
  state.lastRepairAt = null
  state.recentEvents = []
  state.pendingFailure = null
}

export function deriveNav2StabilityFromHealth(bridgeHealth = {}, options = {}) {
  const runtime = bridgeHealth?.runtime && typeof bridgeHealth.runtime === 'object'
    ? bridgeHealth.runtime
    : null
  const nav2 = runtime?.nav2 && typeof runtime.nav2 === 'object' ? runtime.nav2 : null
  const navigation = runtime?.navigation && typeof runtime.navigation === 'object' ? runtime.navigation : null

  if (!runtime) {
    return recordNav2Transition('disconnected', {
      source: options.source || 'health',
      blocker: 'No runtime data from bridge',
      bridgeDestination: options.bridgeDestination || null,
    })
  }

  if (nav2?.serverAvailable === false) {
    return recordNav2Transition('blocked', {
      source: options.source || 'health',
      blocker: nav2?.serverError || nav2?.importError || 'Nav2 NavigateToPose action server not available',
      readinessStep: 'action_server',
      bridgeDestination: options.bridgeDestination || null,
    })
  }

  const blockers = [
    ...(Array.isArray(navigation?.blockers) ? navigation.blockers : []),
    ...(Array.isArray(nav2?.blockers) ? nav2.blockers : []),
  ]

  if (blockers.length > 0) {
    return recordNav2Transition('blocked', {
      source: options.source || 'health',
      blocker: blockers[0],
      readinessStep: identifyReadinessStep(blockers[0]),
      bridgeDestination: options.bridgeDestination || null,
    })
  }

  const ready = navigation?.ready === true
    || navigation?.waypointReady === true
    || nav2?.waypointReady === true
    || (nav2?.serverAvailable === true && nav2?.lifecycle?.active === true && nav2?.scan?.available === true)

  if (ready) {
    return recordNav2Transition('ready', {
      source: options.source || 'health',
      bridgeDestination: options.bridgeDestination || null,
    })
  }

  return recordNav2Transition('degraded', {
    source: options.source || 'health',
    blocker: 'Navigation readiness incomplete',
    bridgeDestination: options.bridgeDestination || null,
  })
}

export function recordNav2RepairStart(options = {}) {
  return recordNav2Transition('repairing', {
    source: options.source || 'repair',
    repairAction: options.repairAction || 'auto-repair',
    bridgeDestination: options.bridgeDestination || null,
  })
}

export function recordNav2CommandFailure(options = {}) {
  const blocker = typeof options.blocker === 'string' && options.blocker.trim()
    ? options.blocker.trim()
    : 'Nav2 command dispatch failed'
  return recordNav2Transition('blocked', {
    source: options.source || 'command-dispatch',
    blocker,
    readinessStep: options.readinessStep || identifyReadinessStep(blocker),
    bridgeDestination: options.bridgeDestination || null,
    repairAction: options.repairAction || null,
  })
}

export function recordNav2RepairResult(success, options = {}) {
  if (success) {
    return recordNav2Transition('ready', {
      source: options.source || 'repair',
      repairAction: options.repairAction || 'auto-repair',
      bridgeDestination: options.bridgeDestination || null,
    })
  }
  return recordNav2Transition('blocked', {
    source: options.source || 'repair',
    blocker: options.blocker || 'Repair did not restore readiness',
    repairAction: options.repairAction || 'auto-repair',
    bridgeDestination: options.bridgeDestination || null,
  })
}

function shouldDebounceStateSnapshotFailure({ nextState, nextBlocker, options }) {
  if (state.current !== 'ready') {
    return false
  }
  if (options.source !== 'state-snapshot') {
    return false
  }
  if (nextState !== 'blocked' && nextState !== 'disconnected' && nextState !== 'degraded') {
    return false
  }

  const count = state.pendingFailure ? state.pendingFailure.count + 1 : 1
  state.pendingFailure = { nextState, blocker: nextBlocker, count }
  return count < STATE_SNAPSHOT_FAILURE_CONFIRMATIONS
}
function identifyReadinessStep(blockerText = '') {
  const text = blockerText.toLowerCase()
  if (text.includes('navigatepose') || text.includes('action server')) return 'action_server'
  if (text.includes('/odom') || text.includes('odom')) return 'odom'
  if (text.includes('tf') || text.includes('base_link') || text.includes('base_footprint')) return 'tf'
  if (text.includes('lifecycle')) return 'lifecycle'
  if (text.includes('/scan_nav2') || text.includes('filtered scan') || text.includes('scan')) return 'scan'
  if (text.includes('map') && text.includes('identity')) return 'map_identity'
  if (text.includes('pose') && text.includes('untrust')) return 'pose_trust'
  if (text.includes('waypoint') && text.includes('stale')) return 'waypoint_stale'
  return null
}

async function persistEvent(event) {
  try {
    await mkdir(path.dirname(EVENT_LOG_PATH), { recursive: true })
    const line = JSON.stringify(event) + '\n'
    await appendFile(EVENT_LOG_PATH, line, 'utf-8')
  } catch {
    // Silent: event log persistence is best-effort
  }
}
