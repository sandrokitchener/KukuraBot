import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { setDogzillaMapOrigin } from '../scripts/set-dogzilla-map-origin.mjs'
import { nav2HealthBody } from '../test-support/robot-http-fixtures.mjs'

test('setDogzillaMapOrigin stores active map identity from bridge health', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'robodoge-set-origin-'))
  const originFile = path.join(tempDir, 'origin.json')
  const originalFetch = globalThis.fetch
  const calls = []

  globalThis.fetch = async (url) => {
    calls.push(String(url))
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
          x: 1.25,
          y: -0.5,
          theta: 0.75,
          source: 'tf:map->base_link',
        },
      }),
    }
  }

  try {
    const result = await setDogzillaMapOrigin({
      poseUrl: 'http://dogzilla.test/pose',
      bridgeHealthUrl: 'http://dogzilla.test/healthz',
      originFile,
      label: 'charger_origin',
    })

    const saved = JSON.parse(await readFile(originFile, 'utf-8'))
    assert.deepEqual(calls, ['http://dogzilla.test/pose', 'http://dogzilla.test/healthz'])
    assert.equal(result.origin.label, 'charger_origin')
    assert.equal(saved.map.id, 'test_map')
    assert.equal(saved.map.fingerprint, 'test-map-fingerprint')
  } finally {
    globalThis.fetch = originalFetch
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('setDogzillaMapOrigin refuses identity-less origin by default', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'robodoge-set-origin-missing-map-'))
  const originFile = path.join(tempDir, 'origin.json')
  const originalFetch = globalThis.fetch

  globalThis.fetch = async (url) => {
    if (String(url).includes('/healthz')) {
      return {
        ok: true,
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

    return {
      ok: true,
      json: async () => ({
        ok: true,
        pose: {
          frame: 'map',
          x: 1,
          y: 2,
          theta: 0,
        },
      }),
    }
  }

  try {
    await assert.rejects(
      () => setDogzillaMapOrigin({
        poseUrl: 'http://dogzilla.test/pose',
        bridgeHealthUrl: 'http://dogzilla.test/healthz',
        originFile,
      }),
      /without active DOGZILLA map identity/,
    )
  } finally {
    globalThis.fetch = originalFetch
    await rm(tempDir, { recursive: true, force: true })
  }
})
