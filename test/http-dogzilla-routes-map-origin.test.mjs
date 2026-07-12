import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { tryHandleDogzillaRoute } from '../lib/http-dogzilla-routes.mjs'
import { nav2HealthBody } from '../test-support/robot-http-fixtures.mjs'

test('map-origin capture saves from current pose without map identity requirement', async () => {
  const sent = []

  const handled = await tryHandleDogzillaRoute({
    request: { method: 'POST' },
    requestUrl: new URL('http://localhost/api/dogzilla/map-origin/capture'),
    response: {},
    readJsonBody: async () => ({ label: 'charger_origin' }),
    sendJson: async (_response, statusCode, payload) => {
      sent.push({ statusCode, payload })
      return true
    },
    getDogzillaPoseTrack: () => [],
    getDogzillaRobotPoseImpl: async () => ({
      ok: true,
      waypointSafe: true,
      x: 1,
      y: 2,
      theta: 0.5,
      frame: 'map',
      source: 'tf:map->base_link',
      status: 'ok',
      pose: null,
      mapPose: null,
    }),
  })

  assert.equal(handled, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].statusCode, 200)
  assert.equal(sent[0].payload.ok, true)
})

test('waypoint capture route stores app_map provenance without touching source config outside target file', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'robodoge-route-waypoint-'))
  const waypointFile = path.join(tempDir, 'robot-waypoints.json')
  const originalConfig = {
    activeSet: 'home',
    sets: {
      home: {
        waypoints: {},
      },
    },
  }
  await writeFile(waypointFile, `${JSON.stringify(originalConfig, null, 2)}\n`, 'utf-8')

  const health = nav2HealthBody()
  const sent = []

  const handled = await tryHandleDogzillaRoute({
    request: { method: 'POST' },
    requestUrl: new URL('http://localhost/api/dogzilla/waypoints'),
    response: {},
    readJsonBody: async () => ({ name: 'Garage', label: 'garage' }),
    sendJson: async (_response, statusCode, payload) => {
      sent.push({ statusCode, payload })
      return true
    },
    getDogzillaPoseTrack: () => [],
    waypointFile,
    getDogzillaRobotPoseImpl: async () => ({
      ok: true,
      waypointSafe: true,
      x: 10,
      y: 21,
      theta: Math.PI,
      frame: 'map',
      source: 'tf:map->base_link',
      status: 'ok',
      pose: null,
      mapPose: null,
    }),
    getRobotSidecarHealthImpl: async () => ({ body: { runtime: { map: health.runtime.map } } }),
    loadDogzillaMapOriginImpl: async () => ({
      frame: 'app_map',
      sourceFrame: 'map',
      label: 'charger_origin',
      x: 10,
      y: 20,
      yaw: Math.PI / 2,
      savedAt: '2026-06-15T19:25:00.000Z',
      map: health.runtime.map,
    }),
  })

  const saved = JSON.parse(await readFile(waypointFile, 'utf-8'))
  const waypoint = saved.sets.home.waypoints.garage

  assert.equal(handled, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].statusCode, 200)
  assert.equal(sent[0].payload.file, waypointFile)
  assert.equal(waypoint.frame, 'app_map')
  assert.equal(waypoint.x, 1)
  assert.equal(waypoint.y, 0)
  assert.equal(waypoint.yaw, 1.5708)
  assert.equal(waypoint.mapId, 'test_map')
  assert.equal(waypoint.mapFingerprint, 'test-map-fingerprint')
  assert.equal(waypoint.mapOrigin.label, 'charger_origin')
  assert.equal(waypoint.mapOrigin.x, 10)
  assert.equal(waypoint.mapOrigin.y, 20)
  assert.equal(waypoint.mapOrigin.yaw, Math.PI / 2)
  assert.equal(waypoint.mapOrigin.mapFingerprint, 'test-map-fingerprint')
  assert.equal(waypoint.capturedMapPose.frame, 'map')
  assert.equal(waypoint.capturedMapPose.x, 10)
  assert.equal(waypoint.capturedMapPose.y, 21)
  assert.equal(waypoint.capturedMapPose.yaw, Math.PI)
  await rm(tempDir, { recursive: true, force: true })
})

test('waypoint capture route stores app_map pose even with different origin fingerprint', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'robodoge-route-waypoint-stale-'))
  const waypointFile = path.join(tempDir, 'robot-waypoints.json')
  await writeFile(waypointFile, `${JSON.stringify({
    activeSet: 'home',
    sets: { home: { waypoints: {} } },
  }, null, 2)}\n`, 'utf-8')

  const health = nav2HealthBody()
  const sent = []

  const handled = await tryHandleDogzillaRoute({
    request: { method: 'POST' },
    requestUrl: new URL('http://localhost/api/dogzilla/waypoints'),
    response: {},
    readJsonBody: async () => ({ name: 'Kitchen', label: 'kitchen' }),
    sendJson: async (_response, statusCode, payload) => {
      sent.push({ statusCode, payload })
      return true
    },
    getDogzillaPoseTrack: () => [],
    waypointFile,
    getDogzillaRobotPoseImpl: async () => ({
      ok: true,
      waypointSafe: true,
      x: 3,
      y: 4,
      theta: 0.25,
      frame: 'map',
      source: 'tf:map->base_link',
      status: 'ok',
      pose: null,
      mapPose: null,
    }),
    getRobotSidecarHealthImpl: async () => ({ body: { runtime: { map: health.runtime.map } } }),
    loadDogzillaMapOriginImpl: async () => ({
      frame: 'app_map',
      sourceFrame: 'map',
      label: 'old_origin',
      x: 10,
      y: 20,
      yaw: Math.PI / 2,
      savedAt: '2026-06-15T19:25:00.000Z',
      map: {
        ...health.runtime.map,
        fingerprint: 'old-map-fingerprint',
      },
    }),
  })

  const saved = JSON.parse(await readFile(waypointFile, 'utf-8'))
  const waypoint = saved.sets.home.waypoints.kitchen

  assert.equal(handled, true)
  assert.equal(sent[0].statusCode, 200)
  assert.equal(waypoint.frame, 'app_map')
  assert.ok(waypoint.capturedMapPose !== undefined)
  await rm(tempDir, { recursive: true, force: true })
})

test('waypoint-readiness route returns validator report without requiring writes', async () => {
  const sent = []
  const handled = await tryHandleDogzillaRoute({
    request: { method: 'GET' },
    requestUrl: new URL('http://localhost/api/dogzilla/waypoint-readiness'),
    response: {},
    readJsonBody: async () => ({}),
    sendJson: async (_response, statusCode, payload) => {
      sent.push({ statusCode, payload })
      return true
    },
    getDogzillaPoseTrack: () => [],
    getDogzillaLidarHealthImpl: async () => ({ ok: true, topic: '/scan' }),
    getDogzillaRobotPoseImpl: async () => ({
      ok: false,
      status: 'stale',
      waypointSafe: false,
      error: 'Pose frame is stale.',
    }),
    validateDogzillaWaypointsFromFilesImpl: async () => ({
      ok: false,
      readyForMapWaypoints: false,
      writePolicy: 'read-only; config/robot-waypoints.json is never overwritten by this validator',
      blockers: ['no ready map waypoints in source of truth'],
      summary: {
        ready: 0,
        navigable: 12,
      },
    }),
  })

  assert.equal(handled, true)
  assert.deepEqual(sent[0].payload.sensors, {
    lidar: { ok: true, topic: '/scan' },
    localization: {
      ok: false,
      status: 'stale',
      waypointSafe: false,
      error: 'Pose frame is stale.',
    },
  })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].statusCode, 200)
  assert.equal(sent[0].payload.readyForMapWaypoints, false)
  assert.match(sent[0].payload.writePolicy, /never overwritten/)
  assert.deepEqual(sent[0].payload.blockers, ['no ready map waypoints in source of truth'])
})
