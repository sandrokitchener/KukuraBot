import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { tryHandleDogzillaRoute } from '../lib/http-dogzilla-routes.mjs'

test('save-map-pose route saves map, restarts localization, and captures origin', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'robodoge-map-save-'))
  const actions = []
  const sent = []

  try {
    const handled = await tryHandleDogzillaRoute({
      request: { method: 'POST' },
      requestUrl: new URL('http://localhost/api/dogzilla/connection/action'),
      response: {},
      readJsonBody: async () => ({ action: 'save-map-pose', live: true }),
      sendJson: async (_response, statusCode, payload) => {
        sent.push({ statusCode, payload })
        return true
      },
      getDogzillaPoseTrack: () => [],
      mapOriginFile: path.join(tempDir, 'dogzilla-map-origin.json'),
      clearDogzillaMapOriginImpl: async () => {},
      runDogzillaConnectionActionImpl: async (action, options) => {
        actions.push({ action, options })
        return action === 'save-map-pose'
          ? { status: 'ok', id: 'robodoge_home_latest', pbstream: '/maps/latest.pbstream' }
          : { status: 'ok', mode: 'localization' }
      },
      getDogzillaRobotPoseImpl: async () => ({
        ok: true,
        waypointSafe: true,
        frame: 'map',
        x: 1.25,
        y: -0.5,
        theta: 0.1,
        source: 'tf:map->base_link',
      }),
      getRobotSidecarHealthImpl: async () => ({
        body: {
          runtime: {
            map: {
              available: true,
              id: 'robodoge_home_latest',
              fingerprint: 'map-fingerprint',
            },
          },
        },
      }),
    })

    assert.equal(handled, true)
    assert.deepEqual(actions.map((item) => item.action), ['save-map-pose', 'start-map-pose'])
    assert.equal(sent[0].statusCode, 200)
    assert.equal(sent[0].payload.status, 'ok')
    assert.equal(sent[0].payload.mapOriginCleared, true)
    assert.equal(sent[0].payload.localization.status, 'ok')
    assert.equal(sent[0].payload.origin.label, 'charger_origin')
    assert.equal(sent[0].payload.origin.x, 1.25)
    assert.equal(sent[0].payload.origin.map.id, 'robodoge_home_latest')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
