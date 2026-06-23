import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deriveNavigationStatus } from '../lib/dogzilla-navigation-status.mjs'

function pose(x, y, receivedAt) {
  return { x, y, yaw: 0, theta: 0, frame: 'app_map', sourceFrame: 'map', receivedAt }
}

function now() {
  return Date.now()
}

function recently(offsetMs) {
  return Date.now() - offsetMs
}

describe('deriveNavigationStatus', () => {
  it('returns unknown when no robot data', () => {
    const result = deriveNavigationStatus({})
    assert.equal(result.status, 'unknown')
    assert.equal(result.severity, 'gray')
  })

  it('returns blocked when stale map origin mismatch', () => {
    const result = deriveNavigationStatus({
      mapOriginStatus: { status: 'stale-map-mismatch', configured: false },
      dispatchState: { status: 'navigating' },
    })
    assert.equal(result.status, 'blocked')
    assert.equal(result.severity, 'orange')
    assert.match(result.text, /stale-map-mismatch/)
  })

  it('returns blocked when stale missing map identity', () => {
    const result = deriveNavigationStatus({
      mapOriginStatus: { status: 'stale-missing-map-identity', configured: false },
    })
    assert.equal(result.status, 'blocked')
    assert.match(result.text, /stale-missing-map-identity/)
  })

  it('returns blocked when active map identity is unavailable', () => {
    const result = deriveNavigationStatus({
      mapOriginStatus: { status: 'active-map-identity-unavailable', configured: false },
    })
    assert.equal(result.status, 'blocked')
    assert.match(result.text, /active-map-identity-unavailable/)
  })

  it('returns repairing when repairState is active', () => {
    const result = deriveNavigationStatus({
      mapOriginStatus: { status: 'stale-map-mismatch', configured: false },
      repairState: { repairing: true, lastRepairAt: '2026-06-22T00:00:00Z' },
    })
    assert.equal(result.status, 'repairing')
    assert.equal(result.severity, 'yellow')
    assert.match(result.text, /Repairing/)
  })

  it('keeps active dispatch visible while repair monitor is active', () => {
    const t = now()
    const result = deriveNavigationStatus({
      dispatchState: { status: 'navigating', waypointName: 'kitchen', dispatchedAt: t - 6000 },
      repairState: { repairing: true, lastRepairAt: '2026-06-22T00:00:00Z' },
    })

    assert.equal(result.status, 'navigating')
    assert.equal(result.severity, 'blue')
    assert.equal(result.text, 'Walking to kitchen')
  })

  it('uses waypoint readiness blocker before fallback map-origin noise', () => {
    const result = deriveNavigationStatus({
      mapOriginStatus: { status: 'active-map-identity-unavailable', configured: false },
      dogzillaWaypointReadiness: {
        readyForMapWaypoints: false,
        blockers: ['5 invalid map waypoint(s) in source of truth'],
      },
      bridgeRuntime: {
        navigation: {
          waypointReady: true,
          nav2: {
            serverAvailable: true,
            lifecycle: { active: true },
            scan: { available: true },
          },
        },
      },
    })
    assert.equal(result.status, 'blocked')
    assert.match(result.text, /5 invalid map waypoint/)
    assert.doesNotMatch(result.text, /active-map-identity-unavailable/)
  })

  it('returns blocked when nav readiness fails', () => {
    const result = deriveNavigationStatus({
      dogzillaWaypointReadiness: { ready: false, reason: 'No odom on /odom' },
      bridgeRuntime: { nav2: {} },
    })
    assert.equal(result.status, 'blocked')
    assert.match(result.text, /No odom/)
  })

  it('returns blocked when Nav2 lifecycle is up but NavigateToPose action is missing', () => {
    const result = deriveNavigationStatus({
      bridgeRuntime: {
        navigation: {
          waypointReady: false,
          blockers: ['Nav2 NavigateToPose action server is not running in the ROS graph for action navigate_to_pose'],
          nav2: {
            serverAvailable: false,
            lifecycle: { active: true },
            scan: { available: true },
          },
        },
      },
    })

    assert.equal(result.status, 'blocked')
    assert.equal(result.severity, 'red')
    assert.equal(result.code, 'nav2_action_missing')
    assert.match(result.text, /NavigateToPose/)
  })

  it('returns navigating when dispatch active and pose moving', () => {
    const t = now()
    const result = deriveNavigationStatus({
      dispatchState: { status: 'navigating', waypointName: 'kitchen', dispatchedAt: t - 15000 },
      poseTrack: [
        pose(1, 0, t - 9000),
        pose(2, 0, t - 5000),
        pose(3, 0, t - 1000),
      ],
    })
    assert.equal(result.status, 'navigating')
    assert.equal(result.severity, 'blue')
    assert.equal(result.text, 'Walking to kitchen')
    assert.equal(result.targetWaypoint, 'kitchen')
  })

  it('returns stuck when dispatch active but no pose progress', () => {
    const t = now()
    const result = deriveNavigationStatus({
      dispatchState: { status: 'navigating', waypointName: 'garage', dispatchedAt: t - 20000 },
      poseTrack: [
        pose(1.5, 0.5, t - 12000),
        pose(1.51, 0.5, t - 8000),
        pose(1.5, 0.51, t - 2000),
      ],
    })
    assert.equal(result.status, 'stuck')
    assert.equal(result.severity, 'red')
    assert.match(result.text, /No movement/)
    assert.equal(result.targetWaypoint, 'garage')
  })

  it('returns finding_waypoint for very recent dispatch', () => {
    const t = now()
    const result = deriveNavigationStatus({
      dispatchState: { status: 'navigating', waypointName: 'living_room', dispatchedAt: t - 2000 },
      poseTrack: [
        pose(0, 0, t - 3000),
        pose(0.01, 0, t - 1000),
      ],
    })
    assert.equal(result.status, 'finding_waypoint')
    assert.equal(result.severity, 'yellow')
    assert.match(result.text, /Finding/)
    assert.equal(result.targetWaypoint, 'living_room')
  })

  it('returns arrived when dispatch arrived and not decayed', () => {
    const result = deriveNavigationStatus({
      dispatchState: { status: 'arrived', waypointName: 'kitchen', arrivedAt: Date.now() - 5000 },
      poseTrack: [],
    })
    assert.equal(result.status, 'arrived')
    assert.equal(result.severity, 'green')
    assert.match(result.text, /Arrived/)
    assert.equal(result.targetWaypoint, 'kitchen')
  })

  it('decays arrived to ready after 30s', () => {
    const result = deriveNavigationStatus({
      dispatchState: { status: 'arrived', waypointName: 'kitchen', arrivedAt: Date.now() - 35000 },
      dogzillaWaypointReadiness: { ready: true },
    })
    assert.equal(result.status, 'ready')
  })

  it('returns ready when Nav2 readiness green and no dispatch', () => {
    const result = deriveNavigationStatus({
      dogzillaWaypointReadiness: { ready: true },
      bridgeRuntime: { nav2: {} },
    })
    assert.equal(result.status, 'ready')
    assert.equal(result.severity, 'green')
    assert.match(result.text, /Nav2 ready/)
  })

  it('returns idle when pose data present but no readiness and no dispatch', () => {
    const result = deriveNavigationStatus({
      poseTrack: [pose(0, 0, Date.now() - 10000)],
    })
    assert.equal(result.status, 'idle')
    assert.equal(result.severity, 'green')
  })

  it('handles arrived state auto-detection from pose track (no movement after 10s)', () => {
    const t = now()
    const result = deriveNavigationStatus({
      dispatchState: { status: 'navigating', waypointName: 'charger', dispatchedAt: t - 20000 },
      poseTrack: [
        pose(2.0, 1.0, t - 11000),
        pose(2.01, 1.0, t - 7000),
        pose(2.0, 1.01, t - 3000),
        pose(2.01, 1.01, t - 500),
      ],
    })
    assert.equal(result.status, 'arrived')
    assert.equal(result.targetWaypoint, 'charger')
  })

  it('tolerates empty poseTrack', () => {
    const result = deriveNavigationStatus({
      dispatchState: { status: 'navigating', waypointName: 'kitchen', dispatchedAt: Date.now() - 5000 },
      poseTrack: [],
    })
    assert.ok(result.status)
  })
})
