import test from 'node:test'
import assert from 'node:assert/strict'

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
