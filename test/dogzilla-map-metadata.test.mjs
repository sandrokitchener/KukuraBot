import assert from 'node:assert/strict'
import test from 'node:test'

import { validateWaypointMapIdentity } from '../lib/dogzilla-map-metadata.mjs'

const ACTIVE_MAP = {
  available: true,
  id: 'active-map',
  fingerprint: 'active-fingerprint',
  bounds: {
    minX: -1,
    maxX: 1,
    minY: -1,
    maxY: 1,
  },
}

test('validateWaypointMapIdentity requires matching waypoint and active map provenance', () => {
  const result = validateWaypointMapIdentity({
    mapId: 'active-map',
    mapFingerprint: 'active-fingerprint',
  }, ACTIVE_MAP)

  assert.equal(result.ok, true)
  assert.equal(result.reason, 'map-identity-match')
})

test('validateWaypointMapIdentity fails closed when either identity is incomplete', () => {
  for (const [waypoint, map] of [
    [{ mapId: '', mapFingerprint: 'active-fingerprint' }, ACTIVE_MAP],
    [{ mapId: 'active-map', mapFingerprint: '' }, ACTIVE_MAP],
    [{ mapId: 'active-map', mapFingerprint: 'active-fingerprint' }, { ...ACTIVE_MAP, id: '' }],
    [{ mapId: 'active-map', mapFingerprint: 'active-fingerprint' }, { ...ACTIVE_MAP, fingerprint: '' }],
  ]) {
    const result = validateWaypointMapIdentity(waypoint, map)

    assert.equal(result.ok, false)
    assert.equal(result.reason, 'map-identity-missing')
  }
})

test('validateWaypointMapIdentity rejects stale map ids and fingerprints', () => {
  const idMismatch = validateWaypointMapIdentity({
    mapId: 'old-map',
    mapFingerprint: 'active-fingerprint',
  }, ACTIVE_MAP)
  const fingerprintMismatch = validateWaypointMapIdentity({
    mapId: 'active-map',
    mapFingerprint: 'old-fingerprint',
  }, ACTIVE_MAP)

  assert.equal(idMismatch.ok, false)
  assert.equal(idMismatch.reason, 'map-id-mismatch')
  assert.equal(fingerprintMismatch.ok, false)
  assert.equal(fingerprintMismatch.reason, 'map-fingerprint-mismatch')
})
