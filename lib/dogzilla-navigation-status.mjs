const ARRIVAL_DECAY_MS = 30_000
const FINDING_WAYPOINT_MS = 5_000

export function deriveNavigationStatus({
  poseTrack = [],
  dispatchState = null,
  mapOriginStatus = null,
  bridgeRuntime = null,
  robotFeedback = null,
  poseState = null,
  dogzillaWaypointReadiness = null,
} = {}) {
  const hasRobotData = dispatchState || poseTrack.length || bridgeRuntime || mapOriginStatus || dogzillaWaypointReadiness
  if (!hasRobotData) {
    return { status: 'unknown', text: 'No robot data', severity: 'gray' }
  }

  const waypointReadinessReady = isWaypointReadinessReady(dogzillaWaypointReadiness)
  const runtimeReadiness = deriveRuntimeReadiness(bridgeRuntime)
  if (runtimeReadiness && !runtimeReadiness.ready && !waypointReadinessReady) {
    return {
      status: 'blocked',
      text: `Blocked: ${runtimeReadiness.reason}`,
      severity: runtimeReadiness.code === 'nav2_action_missing' ? 'red' : 'orange',
      code: runtimeReadiness.code,
    }
  }

  if (dogzillaWaypointReadiness) {
    if (!waypointReadinessReady) {
      const blockers = Array.isArray(dogzillaWaypointReadiness.blockers)
        ? dogzillaWaypointReadiness.blockers.map((item) => String(item || '').trim()).filter(Boolean)
        : []
      const blocker = dogzillaWaypointReadiness.reason || blockers[0] || 'navigation not ready'
      return { status: 'blocked', text: `Blocked: ${blocker}`, severity: 'orange' }
    }
  }

  if (dispatchState && dispatchState.status === 'navigating') {
    return deriveActiveDispatchStatus(dispatchState, robotFeedback)
  }

  if (dispatchState && dispatchState.status === 'arrived') {
    const elapsedMs = Date.now() - dispatchState.arrivedAt
    if (elapsedMs < ARRIVAL_DECAY_MS) {
      return {
        status: 'arrived',
        text: `Arrived at ${dispatchState.waypointName || 'target'}`,
        severity: 'green',
        targetWaypoint: dispatchState.waypointName || null,
      }
    }
  }

  if (waypointReadinessReady) {
    return { status: 'ready', text: 'Nav2 ready', severity: 'green' }
  }

  if (runtimeReadiness?.ready) {
    return { status: 'ready', text: 'Nav2 ready', severity: 'green' }
  }

  return { status: 'idle', text: 'Robot idle', severity: 'green' }
}

function deriveActiveDispatchStatus(dispatchState, robotFeedback) {
  const elapsedMs = Date.now() - dispatchState.dispatchedAt
  const elapsedSec = Math.round(elapsedMs / 1000)
  const wpName = dispatchState.waypointName || 'target'
  const feedback = findDispatchFeedback(dispatchState, robotFeedback)
  const motionStatus = feedback?.motionStatus || feedback?.result?.motionStatus || ''

  if (motionStatus === 'moving') {
    return {
      status: 'navigating',
      text: `Walking to ${wpName}`,
      severity: 'blue',
      targetWaypoint: wpName,
    }
  }

  if (motionStatus === 'no-motion') {
    return {
      status: 'stuck',
      text: `No movement evidence for ${elapsedSec}s`,
      severity: 'red',
      targetWaypoint: wpName,
    }
  }

  if (motionStatus === 'cancelled') {
    return {
      status: 'cancelled',
      text: `Navigation cancelled for ${wpName}`,
      severity: 'orange',
      targetWaypoint: wpName,
    }
  }

  if (motionStatus === 'failed') {
    return {
      status: 'failed',
      text: feedback?.monitorError || feedback?.result?.monitorError || `Motion monitor failed for ${wpName}`,
      severity: 'red',
      targetWaypoint: wpName,
    }
  }

  if (elapsedMs < FINDING_WAYPOINT_MS) {
    return {
      status: 'finding_waypoint',
      text: `Finding ${wpName}...`,
      severity: 'yellow',
      targetWaypoint: wpName,
    }
  }

  return {
    status: 'finding_waypoint',
    text: `Waiting for motion evidence for ${wpName}...`,
    severity: 'yellow',
    targetWaypoint: wpName,
  }
}

function findDispatchFeedback(dispatchState, robotFeedback) {
  const commandId = String(dispatchState?.commandId || '').trim()
  if (!commandId) {
    return null
  }
  const records = Array.isArray(robotFeedback?.recentCommands) ? robotFeedback.recentCommands : []
  return records.find((record) => String(record?.commandId || '').trim() === commandId) || null
}

function deriveRuntimeReadiness(runtime) {
  if (!runtime || typeof runtime !== 'object') {
    return null
  }

  const navigation = runtime.navigation && typeof runtime.navigation === 'object' ? runtime.navigation : null
  const nav2 = navigation?.nav2 && typeof navigation.nav2 === 'object'
    ? navigation.nav2
    : runtime.nav2 && typeof runtime.nav2 === 'object'
      ? runtime.nav2
      : null
  const blockers = [
    ...stringList(navigation?.blockers),
    ...stringList(nav2?.blockers),
  ]

  const ready = navigation?.ready === true
    || navigation?.waypointReady === true
    || nav2?.waypointReady === true
    || (nav2?.serverAvailable === true && nav2?.lifecycle?.active === true && nav2?.scan?.available === true)

  if (ready) {
    return { ready: true }
  }

  const actionMissing = nav2?.serverAvailable === false
    || blockers.some((item) => /NavigateToPose action server is not running/i.test(item))
  const specificBlocker = blockers.find((item) => !/NavigateToPose action server is not running/i.test(item))

  if (specificBlocker) {
    return {
      ready: false,
      code: 'nav2_blocked',
      reason: specificBlocker,
    }
  }

  if (actionMissing) {
    return {
      ready: false,
      code: 'nav2_action_missing',
      reason: 'Nav2 NavigateToPose action server is not running',
    }
  }

  if (blockers.length > 0) {
    return {
      ready: false,
      code: 'nav2_blocked',
      reason: blockers[0],
    }
  }

  return null
}

function isWaypointReadinessReady(readiness) {
  return readiness?.ready === true || readiness?.readyForMapWaypoints === true
}

function stringList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : []
}

