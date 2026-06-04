import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeWaypointName,
  poseToWaypoint,
  upsertWaypoint,
} from '../scripts/capture-dogzilla-map-pose.mjs'
import { APP_MAP_FRAME } from '../lib/dogzilla-map-frame.mjs'

test('poseToWaypoint converts lidar bridge map pose to waypoint entry', () => {
  const waypoint = poseToWaypoint({
    ok: true,
    pose: {
      frameId: 'map',
      x: 1.2,
      y: -0.4,
      theta: 0.75,
      source: 'tf:map->base_link',
    },
  }, {
    physicalSpot: 'Living room rug',
    arrivalToleranceMeters: 0.3,
  })

  assert.deepEqual(waypoint, {
    kind: 'map_pose',
    frame: 'map',
    x: 1.2,
    y: -0.4,
    yaw: 0.75,
    arrivalToleranceMeters: 0.3,
    physicalSpot: 'Living room rug',
    verified: true,
    notes: [
      waypoint.notes[0],
      'Use with command JSON: {"command":"move","waypoint":"<name>"}',
    ],
  })
  assert.match(waypoint.notes[0], /Captured from tf:map->base_link/)
})

test('poseToWaypoint marks odom captures as temporary unverified targets', () => {
  const waypoint = poseToWaypoint({
    ok: true,
    pose: {
      frame: 'odom',
      x: 0.4,
      y: 0.1,
      theta: -0.25,
      source: 'scan-odom:/scan',
    },
  }, {
    physicalSpot: 'local test spot',
  })

  assert.equal(waypoint.kind, 'map_pose')
  assert.equal(waypoint.frame, 'odom')
  assert.equal(waypoint.x, 0.4)
  assert.equal(waypoint.y, 0.1)
  assert.equal(waypoint.yaw, -0.25)
  assert.equal(waypoint.verified, false)
  assert.match(waypoint.notes[0], /scan-odom/)
})

test('poseToWaypoint stores map captures relative to saved app origin', () => {
  const waypoint = poseToWaypoint({
    ok: true,
    pose: {
      frame: 'map',
      x: 10,
      y: 21,
      theta: Math.PI,
      source: 'tf:map->base_link',
    },
  }, {
    mapOrigin: {
      x: 10,
      y: 20,
      yaw: Math.PI / 2,
      label: 'dock',
      savedAt: '2026-06-04T00:00:00.000Z',
    },
  })

  assert.equal(waypoint.frame, APP_MAP_FRAME)
  assert.equal(waypoint.sourceFrame, 'map')
  assert.equal(waypoint.x, 1)
  assert.equal(waypoint.y, 0)
  assert.equal(waypoint.yaw, 1.5708)
  assert.equal(waypoint.verified, true)
  assert.equal(waypoint.mapOrigin.label, 'dock')
  assert.match(waypoint.notes[1], /app_map origin/)
})


test('upsertWaypoint preserves command waypoint key normalization', () => {
  const config = {
    activeSet: 'home',
    sets: {
      home: {
        waypoints: {
          living_room: {
            kind: 'map_pose',
            frame: 'map',
            x: 0,
            y: 0,
            yaw: 0,
            anchorHint: 'keep me',
          },
        },
      },
    },
  }

  const name = normalizeWaypointName('Living Room')
  upsertWaypoint(config, name, {
    kind: 'map_pose',
    frame: 'map',
    x: 2,
    y: 3,
    yaw: 1,
    verified: true,
  })

  assert.equal(name, 'living_room')
  assert.deepEqual(config.sets.home.waypoints.living_room, {
    kind: 'map_pose',
    frame: 'map',
    x: 2,
    y: 3,
    yaw: 1,
    anchorHint: 'keep me',
    verified: true,
  })
})
