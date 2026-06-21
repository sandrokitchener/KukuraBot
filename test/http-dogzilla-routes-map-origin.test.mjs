import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { tryHandleDogzillaRoute } from '../lib/http-dogzilla-routes.mjs'
import { nav2HealthBody } from '../test-support/robot-http-fixtures.mjs'

test('map-origin capture refuses to save when active map identity is missing', async () => {
  const originalFetch = globalThis.fetch
  const sent = []

  globalThis.fetch = async (url) => {
    if (String(url).includes('/pose')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          pose: {
            frame: 'map',
            x: 1,
            y: 2,
            theta: 0.5,
            source: 'tf:map->base_link',
          },
          mapPose: {
            frame: 'map',
            x: 1,
            y: 2,
            theta: 0.5,
            source: 'tf:map->base_link',
          },
          waypointSafe: true,
        }),
      }
    }

    if (String(url).includes('/healthz')) {
      return {
        ok: true,
        status: 200,
        json: async () => nav2HealthBody({
          runtime: {
            map: {
              available: false,
              id: '',
              fingerprint: '',
            },
          },
        }),
      }
    }

    throw new Error(`unexpected fetch ${url}`)
  }

  try {
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
    })

    assert.equal(handled, true)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].statusCode, 502)
    assert.equal(sent[0].payload.ok, false)
    assert.match(sent[0].payload.error, /active map identity unavailable/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('waypoint capture route stores app_map provenance without touching source config outside target file', async () => {
  const originalFetch = globalThis.fetch
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
  globalThis.fetch = async (url) => {
    if (String(url).includes('/pose')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          waypointSafe: true,
          pose: {
            frame: 'map',
            x: 10,
            y: 21,
            theta: Math.PI,
            source: 'tf:map->base_link',
          },
        }),
      }
    }

    throw new Error(`unexpected fetch ${url}`)
  }

  try {
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
  } finally {
    globalThis.fetch = originalFetch
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('waypoint capture route refuses stale app_map origin and stores raw map pose', async () => {
  const originalFetch = globalThis.fetch
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'robodoge-route-waypoint-stale-'))
  const waypointFile = path.join(tempDir, 'robot-waypoints.json')
  await writeFile(waypointFile, `${JSON.stringify({
    activeSet: 'home',
    sets: { home: { waypoints: {} } },
  }, null, 2)}\n`, 'utf-8')

  const health = nav2HealthBody()
  const sent = []
  globalThis.fetch = async (url) => {
    if (String(url).includes('/pose')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          waypointSafe: true,
          pose: {
            frame: 'map',
            x: 3,
            y: 4,
            theta: 0.25,
            source: 'tf:map->base_link',
          },
        }),
      }
    }

    throw new Error(`unexpected fetch ${url}`)
  }

  try {
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
    assert.match(waypoint.notes.join('\n'), /captured raw map pose instead of stale app_map/)
  } finally {
    globalThis.fetch = originalFetch
    await rm(tempDir, { recursive: true, force: true })
  }
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
    validateDogzillaWaypointsFromFilesImpl: async () => ({
      ok: false,
      readyForMapWaypoints: false,
      writePolicy: 'read-only; config/robot-waypoints.json is never overwritten by this validator',
      blockers: ['map origin not ready: stale-missing-map-identity'],
      summary: {
        ready: 0,
        navigable: 12,
      },
    }),
  })

  assert.equal(handled, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].statusCode, 200)
  assert.equal(sent[0].payload.readyForMapWaypoints, false)
  assert.match(sent[0].payload.writePolicy, /never overwritten/)
  assert.deepEqual(sent[0].payload.blockers, ['map origin not ready: stale-missing-map-identity'])
})
