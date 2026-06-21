const STUCK_WINDOW_MS = 10_000
const STUCK_DISTANCE_M = 0.1
const ARRIVAL_WINDOW_MS = 5_000
const ARRIVAL_DISTANCE_M = 0.05
const ARRIVAL_MIN_ELAPSED_MS = 10_000
const ARRIVAL_DECAY_MS = 30_000
const FINDING_WAYPOINT_MS = 5_000

export function deriveNavigationStatus({
  poseTrack = [],
  dispatchState = null,
  mapOriginStatus = null,
  bridgeRuntime = null,
  poseState = null,
  dogzillaWaypointReadiness = null,
} = {}) {
  const hasRobotData = dispatchState || poseTrack.length || bridgeRuntime || mapOriginStatus || dogzillaWaypointReadiness
  if (!hasRobotData) {
    return { status: 'unknown', text: 'No robot data', severity: 'gray' }
  }

  const runtimeReadiness = deriveRuntimeReadiness(bridgeRuntime)
  if (runtimeReadiness && !runtimeReadiness.ready) {
    return {
      status: 'blocked',
      text: `Blocked: ${runtimeReadiness.reason}`,
      severity: runtimeReadiness.code === 'nav2_action_missing' ? 'red' : 'orange',
      code: runtimeReadiness.code,
    }
  }

  if (dogzillaWaypointReadiness) {
    const ready = dogzillaWaypointReadiness.ready === true
      || dogzillaWaypointReadiness.readyForMapWaypoints === true
    if (!ready) {
      const blockers = Array.isArray(dogzillaWaypointReadiness.blockers)
        ? dogzillaWaypointReadiness.blockers.map((item) => String(item || '').trim()).filter(Boolean)
        : []
      const blocker = dogzillaWaypointReadiness.reason || blockers[0] || 'navigation not ready'
      return { status: 'blocked', text: `Blocked: ${blocker}`, severity: 'orange' }
    }
    return { status: 'ready', text: 'Nav2 ready', severity: 'green' }
  }

  const originStale = mapOriginStatus?.status === 'stale-map-mismatch'
    || mapOriginStatus?.status === 'stale-missing-map-identity'
    || mapOriginStatus?.status === 'active-map-identity-unavailable'
  if (originStale) {
    return { status: 'blocked', text: `Blocked: ${mapOriginStatus.status}`, severity: 'orange' }
  }

  if (dispatchState && dispatchState.status === 'navigating') {
    const elapsedMs = Date.now() - dispatchState.dispatchedAt
    const elapsedSec = Math.round(elapsedMs / 1000)
    const wpName = dispatchState.waypointName || 'target'

    if (elapsedMs > ARRIVAL_MIN_ELAPSED_MS) {
      const recent = getRecentPoses(poseTrack, ARRIVAL_WINDOW_MS)
      if (recent.length >= 2) {
        const drift = maxPoseDrift(recent)
        if (drift < ARRIVAL_DISTANCE_M) {
          return {
            status: 'arrived',
            text: `Arrived at ${wpName}`,
            severity: 'green',
            targetWaypoint: wpName,
          }
        }
      }
    }

    if (elapsedMs > STUCK_WINDOW_MS) {
      const recent = getRecentPoses(poseTrack, STUCK_WINDOW_MS)
      if (recent.length >= 2) {
        const drift = maxPoseDrift(recent)
        if (drift < STUCK_DISTANCE_M) {
          return {
            status: 'stuck',
            text: `No movement for ${elapsedSec}s`,
            severity: 'red',
            targetWaypoint: wpName,
          }
        }
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
      status: 'navigating',
      text: `Walking to ${wpName}`,
      severity: 'blue',
      targetWaypoint: wpName,
    }
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

  if (runtimeReadiness?.ready) {
    return { status: 'ready', text: 'Nav2 ready', severity: 'green' }
  }

  return { status: 'idle', text: 'Robot idle', severity: 'green' }
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

  if (nav2?.serverAvailable === false || blockers.some((item) => /NavigateToPose action server is not running/i.test(item))) {
    return {
      ready: false,
      code: 'nav2_action_missing',
      reason: 'Nav2 NavigateToPose action server is not running',
    }
  }

  const ready = navigation?.ready === true
    || navigation?.waypointReady === true
    || nav2?.waypointReady === true
    || (nav2?.serverAvailable === true && nav2?.lifecycle?.active === true && nav2?.scan?.available === true)

  if (ready) {
    return { ready: true }
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

function stringList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : []
}

function getRecentPoses(poseTrack, windowMs) {
  const cutoff = Date.now() - windowMs
  return poseTrack.filter((p) => {
    const t = typeof p.receivedAt === 'number' ? p.receivedAt : Date.parse(p.receivedAt || p.timestamp)
    return t >= cutoff
  })
}

function maxPoseDrift(poses) {
  if (poses.length < 2) return 0
  let minX = Infinity; let maxX = -Infinity
  let minY = Infinity; let maxY = -Infinity
  for (const p of poses) {
    const x = Number(p.x); const y = Number(p.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2)
}
