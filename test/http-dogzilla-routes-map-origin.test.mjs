import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { tryHandleDogzillaRoute } from '../lib/http-dogzilla-routes.mjs'
import { nav2HealthBody } from '../test-support/robot-http-fixtures.mjs'

test('map-origin capture endpoint is removed', async () => {
  const handled = await tryHandleDogzillaRoute({
    request: { method: 'POST' },
    requestUrl: new URL('http://localhost/api/dogzilla/map-origin/capture'),
    response: {},
    readJsonBody: async () => { throw new Error('removed route must not read a body') },
    sendJson: async () => { throw new Error('removed route must not send a response') },
    getDogzillaPoseTrack: () => [],
  })
  assert.equal(handled, false)
})

test('save-map-pose clears legacy origin and restarts localization without capturing a charger origin', async () => {
  const sent = []
  const actions = []
  let originClearCount = 0

  const handled = await tryHandleDogzillaRoute({
    request: { method: 'POST' },
    requestUrl: new URL('http://localhost/api/dogzilla/connection/action'),
    response: {},
    readJsonBody: async () => ({ action: 'save-map-pose' }),
    sendJson: async (_response, statusCode, payload) => {
      sent.push({ statusCode, payload })
      return true
    },
    getDogzillaPoseTrack: () => [],
    runDogzillaConnectionActionImpl: async (action) => {
      actions.push(action)
      return { action, status: 'ok', message: action === 'save-map-pose' ? 'Map saved.' : '' }
    },
    clearDogzillaMapOriginImpl: async () => { originClearCount += 1 },
    getDogzillaRobotPoseImpl: async () => { throw new Error('save-map-pose must not capture a charger origin') },
  })

  assert.equal(handled, true)
  assert.deepEqual(actions, ['save-map-pose', 'start-map-pose'])
  assert.equal(originClearCount, 1)
  assert.equal(sent[0].statusCode, 200)
  assert.equal(sent[0].payload.mapOriginCleared, true)
  assert.equal(sent[0].payload.origin, undefined)
  assert.match(sent[0].payload.message, /without a charger-origin seed/)
})

test('waypoint capture route stores raw map coordinates without charger-origin transformation', async () => {
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
    loadDogzillaMapOriginImpl: async () => { throw new Error('waypoint capture must not read charger origin') },
  })

  const saved = JSON.parse(await readFile(waypointFile, 'utf-8'))
  const waypoint = saved.sets.home.waypoints.garage

  assert.equal(handled, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].statusCode, 200)
  assert.equal(sent[0].payload.file, waypointFile)
  assert.equal(waypoint.frame, 'map')
  assert.equal(waypoint.x, 10)
  assert.equal(waypoint.y, 21)
  assert.equal(waypoint.yaw, Math.PI)
  assert.equal(waypoint.mapId, 'test_map')
  assert.equal(waypoint.mapFingerprint, 'test-map-fingerprint')
  assert.equal(waypoint.mapOrigin, undefined)
  assert.equal(waypoint.capturedMapPose, undefined)
  await rm(tempDir, { recursive: true, force: true })
})

test('waypoint capture route ignores a legacy origin with a different fingerprint', async () => {
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
  assert.equal(waypoint.frame, 'map')
  assert.equal(waypoint.x, 3)
  assert.equal(waypoint.y, 4)
  assert.equal(waypoint.yaw, 0.25)
  assert.equal(waypoint.mapOrigin, undefined)
  assert.equal(waypoint.capturedMapPose, undefined)
  await rm(tempDir, { recursive: true, force: true })
})

test('waypoint route accepts only finite, in-bounds explicit map poses for active map', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'robodoge-explicit-waypoint-'))
  const waypointFile = path.join(tempDir, 'robot-waypoints.json')
  const health = nav2HealthBody()
  await writeFile(waypointFile, `${JSON.stringify({ activeSet: 'home', sets: { home: { waypoints: {} } } })}\n`, 'utf-8')
  const sent = []
  const handled = await tryHandleDogzillaRoute({
    request: { method: 'POST' }, requestUrl: new URL('http://localhost/api/dogzilla/waypoints'), response: {},
    readJsonBody: async () => ({ name: 'desk', pose: { frame: 'map', x: 3, y: 4, yaw: 0 }, mapId: 'test_map', mapFingerprint: 'test-map-fingerprint' }),
    sendJson: async (_response, statusCode, payload) => { sent.push({ statusCode, payload }); return true },
    getDogzillaPoseTrack: () => [], waypointFile,
    getRobotSidecarHealthImpl: async () => ({ body: { runtime: { map: { ...health.runtime.map, available: true, bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 } } } } }),
    getDogzillaRobotPoseImpl: async () => { throw new Error('explicit pose must not read current pose') },
    loadDogzillaMapOriginImpl: async () => null,
  })
  assert.equal(handled, true)
  assert.equal(sent[0].statusCode, 200)
  assert.deepEqual(JSON.parse(await readFile(waypointFile, 'utf-8')).sets.home.waypoints.desk.x, 3)
  await rm(tempDir, { recursive: true, force: true })
})

test('explicit waypoint route rejects missing or stale active-map identity', async () => {
  const health = nav2HealthBody()
  const cases = [
    { name: 'missing identity', body: { name: 'desk', pose: { frame: 'map', x: 3, y: 4, yaw: 0 } } },
    { name: 'stale identity', body: { name: 'desk', pose: { frame: 'map', x: 3, y: 4, yaw: 0 }, mapId: 'old_map', mapFingerprint: 'old-fingerprint' } },
  ]

  for (const { name, body } of cases) {
    const sent = []
    const handled = await tryHandleDogzillaRoute({
      request: { method: 'POST' },
      requestUrl: new URL('http://localhost/api/dogzilla/waypoints'),
      response: {},
      readJsonBody: async () => body,
      sendJson: async (_response, statusCode, payload) => {
        sent.push({ statusCode, payload })
        return true
      },
      getDogzillaPoseTrack: () => [],
      getRobotSidecarHealthImpl: async () => ({ body: { runtime: { map: health.runtime.map } } }),
      getDogzillaRobotPoseImpl: async () => { throw new Error(`${name} must not read current pose`) },
    })

    assert.equal(handled, true)
    assert.equal(sent[0].statusCode, 422)
    assert.match(sent[0].payload.error, /active map/)
  }
})

test('waypoint writes preserve source file when atomic save fails', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'robodoge-atomic-waypoint-'))
  const waypointFile = path.join(tempDir, 'robot-waypoints.json')
  const originalConfig = { activeSet: 'home', sets: { home: { waypoints: {} } } }
  const originalText = `${JSON.stringify(originalConfig, null, 2)}\n`
  await writeFile(waypointFile, originalText, 'utf-8')
  const health = nav2HealthBody()
  const sent = []

  await tryHandleDogzillaRoute({
    request: { method: 'POST' },
    requestUrl: new URL('http://localhost/api/dogzilla/waypoints'),
    response: {},
    readJsonBody: async () => ({ name: 'desk', pose: { frame: 'map', x: 3, y: 4, yaw: 0 }, mapId: 'test_map', mapFingerprint: 'test-map-fingerprint' }),
    sendJson: async (_response, statusCode, payload) => {
      sent.push({ statusCode, payload })
      return true
    },
    getDogzillaPoseTrack: () => [],
    waypointFile,
    getRobotSidecarHealthImpl: async () => ({ body: { runtime: { map: health.runtime.map } } }),
    writeWaypointConfigImpl: async () => { throw new Error('disk full') },
  })

  assert.equal(sent[0].statusCode, 500)
  assert.equal(await readFile(waypointFile, 'utf-8'), originalText)
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

test('waypoint controls rename, delete, and revalidate against the active map', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'robodoge-route-waypoint-controls-'))
  const waypointFile = path.join(tempDir, 'robot-waypoints.json')
  const health = nav2HealthBody()
  await writeFile(waypointFile, `${JSON.stringify({
    activeSet: 'home',
    sets: { home: { waypoints: {
      old_name: {
        kind: 'map_pose',
        frame: 'map',
        x: 1,
        y: 1,
        yaw: 0,
        verified: true,
        mapId: health.runtime.map.id,
        mapFingerprint: health.runtime.map.fingerprint,
      },
      remove_me: { kind: 'map_pose', frame: 'map', x: 2, y: 2, yaw: 0, verified: true },
    } } },
  }, null, 2)}\n`, 'utf-8')

  const call = async (method, url, body) => {
    const sent = []
    await tryHandleDogzillaRoute({
      request: { method },
      requestUrl: new URL(`http://localhost${url}`),
      response: {},
      readJsonBody: async () => body || {},
      sendJson: async (_response, statusCode, payload) => {
        sent.push({ statusCode, payload })
        return true
      },
      getDogzillaPoseTrack: () => [],
      waypointFile,
      getRobotSidecarHealthImpl: async () => ({ body: { runtime: { map: {
        ...health.runtime.map,
        available: true,
        bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
      } } } }),
      loadDogzillaMapOriginImpl: async () => null,
    })
    return sent[0]
  }

  assert.equal((await call('PATCH', '/api/dogzilla/waypoints/old_name', { name: 'renamed' })).statusCode, 200)
  assert.equal((await call('POST', '/api/dogzilla/waypoints/renamed/revalidate')).statusCode, 200)
  assert.equal((await call('DELETE', '/api/dogzilla/waypoints/remove_me')).statusCode, 200)

  const saved = JSON.parse(await readFile(waypointFile, 'utf-8'))
  assert.equal(saved.sets.home.waypoints.renamed.verified, true)
  assert.equal(saved.sets.home.waypoints.renamed.x, 1)
  assert.equal(saved.sets.home.waypoints.remove_me, undefined)
  await rm(tempDir, { recursive: true, force: true })
})
