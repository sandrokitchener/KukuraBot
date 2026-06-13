import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  captureWaypoint,
  normalizeWaypointName,
  poseToWaypoint,
  upsertWaypoint,
} from '../scripts/capture-dogzilla-map-pose.mjs'
import { nav2HealthBody } from '../test-support/robot-http-fixtures.mjs'

test('poseToWaypoint converts lidar bridge map pose to app_map when origin exists', () => {
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
    mapOrigin: {
      x: 0.5,
      y: 0.1,
      yaw: 0,
      label: 'home',
      savedAt: '2026-06-04T00:00:00.000Z',
    },
    mapMetadata: nav2HealthBody().runtime.map,
  })

  assert.equal(waypoint.kind, 'map_pose')
  assert.equal(waypoint.frame, 'app_map')
  assert.equal(waypoint.x, 0.7)
  assert.equal(waypoint.y, -0.5)
  assert.equal(waypoint.yaw, 0.75)
  assert.equal(waypoint.arrivalToleranceMeters, 0.3)
  assert.equal(waypoint.physicalSpot, 'Living room rug')
  assert.equal(waypoint.verified, true)
  assert.equal(waypoint.mapId, 'test_map')
  assert.equal(waypoint.mapFingerprint, 'test-map-fingerprint')
  assert.equal(waypoint.map.fingerprint, 'test-map-fingerprint')
  assert.ok(waypoint.capturedMapPose)
  assert.equal(waypoint.capturedMapPose.frame, 'map')
  assert.equal(waypoint.capturedMapPose.x, 1.2)
  assert.equal(waypoint.capturedMapPose.y, -0.4)
  assert.equal(waypoint.capturedMapPose.yaw, 0.75)
  assert.match(waypoint.notes[0], /Captured from tf:map->base_link/)
  assert.match(waypoint.notes.join('\n'), /Captured map pose: x=1.2, y=-0.4, yaw=0.75/)
  assert.match(waypoint.notes.join('\n'), /Captured map identity: id=test_map/)
  assert.match(waypoint.notes.join('\n'), /Stored in app_map frame/)
})

test('poseToWaypoint stores raw map frame when no app origin is available', () => {
  const waypoint = poseToWaypoint({
    ok: true,
    pose: {
      frame: 'map',
      x: 1.2,
      y: -0.4,
      theta: 0.75,
      source: 'tf:map->base_link',
    },
  }, {
    physicalSpot: 'Living room rug',
    arrivalToleranceMeters: 0.3,
    mapMetadata: nav2HealthBody().runtime.map,
  })

  assert.equal(waypoint.frame, 'map')
  assert.equal(waypoint.x, 1.2)
  assert.equal(waypoint.y, -0.4)
  assert.equal(waypoint.capturedMapPose, undefined)
  assert.equal(waypoint.verified, true)
  assert.equal(waypoint.mapId, 'test_map')
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

test('poseToWaypoint converts map pose to app_map when app origin exists', () => {
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
    mapMetadata: nav2HealthBody().runtime.map,
  })

  assert.equal(waypoint.frame, 'app_map')
  assert.equal(waypoint.x, 1)
  assert.equal(waypoint.y, 0)
  assert.equal(waypoint.yaw, 1.5708)
  assert.equal(waypoint.verified, true)
  assert.equal(waypoint.mapFingerprint, 'test-map-fingerprint')
  assert.equal(waypoint.mapOrigin.label, 'dock')
  assert.equal(waypoint.mapOrigin.displayOnly, undefined)
  assert.ok(waypoint.capturedMapPose)
  assert.equal(waypoint.capturedMapPose.frame, 'map')
  assert.equal(waypoint.capturedMapPose.x, 10)
  assert.equal(waypoint.capturedMapPose.y, 21)
  assert.equal(waypoint.capturedMapPose.yaw, Math.PI)
  assert.match(waypoint.notes.join('\n'), /Stored in app_map frame/)
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

test('captureWaypoint writes proposal without overwriting robot-waypoints source', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'robodoge-capture-'))
  const waypointFile = path.join(tempDir, 'robot-waypoints.json')
  const captureDir = path.join(tempDir, 'captures')
  const originalConfig = '{"activeSet":"home","sets":{"home":{"waypoints":{}}}}\n'
  const originalFetch = globalThis.fetch
  await writeFile(waypointFile, originalConfig, 'utf-8')

  globalThis.fetch = async (url) => {
    if (String(url).includes('/healthz')) {
      return {
        ok: true,
        json: async () => nav2HealthBody(),
      }
    }

    return {
      ok: true,
      json: async () => ({
        ok: true,
        pose: {
          frame: 'map',
          x: 1.2,
          y: -0.4,
          theta: 0.75,
          source: 'tf:map->base_link',
        },
      }),
    }
  }

  try {
    const result = await captureWaypoint({
      name: 'Kitchen',
      waypointFile,
      captureDir,
      originFile: path.join(tempDir, 'missing-origin.json'),
      allowMissingMapIdentity: true,
    })

    assert.equal(await readFile(waypointFile, 'utf-8'), originalConfig)
    assert.match(result.captureFile, /kitchen\.json$/)
    const proposal = JSON.parse(await readFile(result.captureFile, 'utf-8'))
    assert.equal(proposal.waypointName, 'kitchen')
    assert.equal(proposal.waypoint.mapFingerprint, 'test-map-fingerprint')
    assert.equal(proposal.mapIdentityRequired, false)
    assert.equal(proposal.sourceOfTruthFile, waypointFile)
    assert.match(proposal.writePolicy, /not overwritten/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
