import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  APP_MAP_FRAME,
  applyMapOriginToPose,
  appPoseToMapPose,
  buildDogzillaMapOriginSnapshot,
  getDogzillaMapOriginIdentity,
  getDogzillaMapOriginStatus,
  hasDogzillaMapOriginIdentity,
  mapPoseToAppPose,
  resolveAppMapPoseToMapPose,
  saveDogzillaMapOriginFromOccupancyGrid,
  saveDogzillaMapOriginFromPose,
} from '../lib/dogzilla-map-frame.mjs'

test('mapPoseToAppPose makes saved origin the new zero pose', () => {
  const origin = {
    x: 10,
    y: 20,
    yaw: Math.PI / 2,
    label: 'dock',
    savedAt: '2026-06-04T00:00:00.000Z',
  }

  const appPose = mapPoseToAppPose({
    frame: 'map',
    x: 10,
    y: 21,
    yaw: Math.PI,
  }, origin)

  assert.equal(appPose.frame, APP_MAP_FRAME)
  assert.equal(appPose.x, 1)
  assert.equal(appPose.y, 0)
  assert.equal(appPose.yaw, 1.5708)
  assert.equal(appPose.theta, 1.5708)
})

test('appPoseToMapPose converts app frame targets back to ROS map frame', () => {
  const mapPose = appPoseToMapPose({
    frame: APP_MAP_FRAME,
    x: 1,
    y: 0,
    yaw: Math.PI / 2,
  }, {
    x: 10,
    y: 20,
    yaw: Math.PI / 2,
    map: {
      id: 'test_map',
      fingerprint: 'test-map-fingerprint',
    },
  })

  assert.equal(mapPose.frame, 'map')
  assert.equal(mapPose.x, 10)
  assert.equal(mapPose.y, 21)
  assert.equal(mapPose.yaw, 3.14159)
  assert.equal(mapPose.theta, 3.14159)
  assert.equal(mapPose.originMap.id, 'test_map')
})

test('resolveAppMapPoseToMapPose uses waypoint origin snapshot instead of reset current origin', () => {
  const capturedOrigin = {
    x: 10,
    y: 20,
    yaw: Math.PI / 2,
    label: 'dock',
    savedAt: '2026-06-04T00:00:00.000Z',
    map: {
      id: 'test_map',
      fingerprint: 'test-map-fingerprint',
    },
  }
  const resetOrigin = {
    x: -5,
    y: -3,
    yaw: -0.8,
    label: 'dock',
    savedAt: '2026-06-15T19:55:13.969Z',
    map: {
      id: 'test_map',
      fingerprint: 'test-map-fingerprint',
    },
  }

  const waypointOrigin = buildDogzillaMapOriginSnapshot(capturedOrigin)
  const mapPose = resolveAppMapPoseToMapPose({
    frame: APP_MAP_FRAME,
    x: 1,
    y: 0,
    yaw: Math.PI / 2,
  }, {
    currentOrigin: resetOrigin,
    waypointOrigin,
  })

  assert.equal(mapPose.frame, 'map')
  assert.equal(mapPose.x, 10)
  assert.equal(mapPose.y, 21)
  assert.equal(mapPose.yaw, 3.14159)
  assert.equal(mapPose.appMapResolution, 'waypoint-origin')
})

test('resolveAppMapPoseToMapPose uses captured map pose for legacy app_map waypoints', () => {
  const mapPose = resolveAppMapPoseToMapPose({
    frame: APP_MAP_FRAME,
    x: -3.10505,
    y: -2.38933,
    yaw: -1.77342,
  }, {
    currentOrigin: {
      x: -5.07624,
      y: -2.9796,
      yaw: -0.85922,
      map: {
        id: 'robodoge_home',
        fingerprint: 'test-map-fingerprint',
      },
    },
    capturedMapPose: {
      frame: 'map',
      x: -0.51338,
      y: 0.60067,
      yaw: 1.14547,
    },
  })

  assert.equal(mapPose.frame, 'map')
  assert.equal(mapPose.x, -0.51338)
  assert.equal(mapPose.y, 0.60067)
  assert.equal(mapPose.yaw, 1.14547)
  assert.equal(mapPose.appMapResolution, 'captured-map-pose')
})

test('getDogzillaMapOriginIdentity reports whether saved origin belongs to a map', () => {
  assert.equal(hasDogzillaMapOriginIdentity({
    x: 1,
    y: 2,
    yaw: 0,
  }), false)

  const identity = getDogzillaMapOriginIdentity({
    x: 1,
    y: 2,
    yaw: 0,
    map: {
      id: 'robodoge_home',
      fingerprint: 'abc123',
      pbstream: '/maps/home.pbstream',
    },
  })

  assert.equal(hasDogzillaMapOriginIdentity({
    x: 1,
    y: 2,
    yaw: 0,
    map: identity,
  }), true)
  assert.equal(identity.id, 'robodoge_home')
  assert.equal(identity.fingerprint, 'abc123')
  assert.equal(identity.pbstream, '/maps/home.pbstream')
})

test('getDogzillaMapOriginStatus detects missing, ready, and mismatched origin maps', () => {
  assert.equal(getDogzillaMapOriginStatus(null, { id: 'active', fingerprint: 'fp' }).status, 'missing')
  assert.equal(getDogzillaMapOriginStatus({
    x: 1,
    y: 2,
    yaw: 0,
  }, { id: 'active', fingerprint: 'fp' }).status, 'stale-missing-map-identity')
  assert.equal(getDogzillaMapOriginStatus({
    x: 1,
    y: 2,
    yaw: 0,
    map: {
      id: 'old',
      fingerprint: 'old-fp',
    },
  }, { id: 'active', fingerprint: 'fp' }).status, 'stale-map-mismatch')
  assert.equal(getDogzillaMapOriginStatus({
    x: 1,
    y: 2,
    yaw: 0,
    map: {
      id: 'active',
      fingerprint: 'fp',
    },
  }, null).status, 'active-map-identity-unavailable')
  assert.equal(getDogzillaMapOriginStatus({
    x: 1,
    y: 2,
    yaw: 0,
    map: {
      id: 'active',
      fingerprint: 'fp',
    },
  }, { id: 'active', fingerprint: 'fp' }).status, 'ready')
})

test('applyMapOriginToPose keeps raw map pose while exposing saved app origin coordinates', () => {
  const displayPose = applyMapOriginToPose({
    frame: '/map',
    x: 10,
    y: 21,
    theta: Math.PI,
    source: 'tf:map->base_link',
  }, {
    x: 10,
    y: 20,
    yaw: Math.PI / 2,
    label: 'dock',
    savedAt: '2026-06-04T00:00:00.000Z',
    map: {
      id: 'test_map',
      fingerprint: 'test-map-fingerprint',
    },
  })

  assert.equal(displayPose.frame, APP_MAP_FRAME)
  assert.equal(displayPose.sourceFrame, 'map')
  assert.equal(displayPose.x, 1)
  assert.equal(displayPose.y, 0)
  assert.equal(displayPose.theta, 1.5708)
  assert.equal(displayPose.originLabel, 'dock')
  assert.deepEqual(displayPose.mapFramePose, {
    frame: 'map',
    x: 10,
    y: 21,
    yaw: Math.PI,
    theta: Math.PI,
    source: 'tf:map->base_link',
  })
})

test('applyMapOriginToPose ignores saved origin without map identity', () => {
  const pose = {
    frame: 'map',
    x: 10,
    y: 21,
    theta: Math.PI,
    source: 'tf:map->base_link',
  }

  assert.equal(applyMapOriginToPose(pose, {
    x: 10,
    y: 20,
    yaw: Math.PI / 2,
    label: 'old-dock',
  }), pose)
})

test('saveDogzillaMapOriginFromPose persists map origin from verified pose payload', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'robodoge-origin-'))
  const originFile = path.join(dir, 'origin.json')

  try {
    const origin = await saveDogzillaMapOriginFromPose({
      ok: true,
      pose: {
        frame: 'map',
        x: 1.25,
        y: -0.5,
        theta: 0.75,
        source: 'tf:map->base_link',
      },
    }, {
      originFile,
      label: 'dock',
    })

    const saved = JSON.parse(await readFile(originFile, 'utf-8'))
    assert.equal(origin.label, 'dock')
    assert.equal(saved.frame, APP_MAP_FRAME)
    assert.equal(saved.sourceFrame, 'map')
    assert.equal(saved.x, 1.25)
    assert.equal(saved.yaw, 0.75)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test("saveDogzillaMapOriginFromOccupancyGrid preserves map identity when mapMetadata is provided", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "robodoge-occi-"))
  const originFile = path.join(dir, "origin.json")
  try {
    const origin = await saveDogzillaMapOriginFromOccupancyGrid({
      ok: true,
      origin: { x: 0, y: 0, yaw: 0 },
      width: 100,
      height: 100,
      resolution: 0.05,
      cells: "",
    }, {
      originFile,
      mapMetadata: { id: "test_map", fingerprint: "test-fingerprint" },
    })
    assert.equal(origin.map.id, "test_map")
    assert.equal(origin.map.fingerprint, "test-fingerprint")
    const saved = JSON.parse(await readFile(originFile, "utf-8"))
    assert.equal(saved.map.id, "test_map")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('saveDogzillaMapOriginFromPose can require active map identity', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'robodoge-origin-identity-'))
  const originFile = path.join(dir, 'origin.json')

  try {
    await assert.rejects(
      () => saveDogzillaMapOriginFromPose({
        pose: {
          frame: 'map',
          x: 1,
          y: 2,
          theta: 0,
        },
      }, {
        originFile,
        requireMapIdentity: true,
      }),
      /without active map identity/,
    )

    const origin = await saveDogzillaMapOriginFromPose({
      pose: {
        frame: 'map',
        x: 1,
        y: 2,
        theta: 0,
      },
    }, {
      originFile,
      requireMapIdentity: true,
      mapMetadata: {
        id: 'robodoge_home',
        fingerprint: 'map-fp',
      },
    })

    assert.equal(origin.map.id, 'robodoge_home')
    assert.equal(origin.map.fingerprint, 'map-fp')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
