import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDogzillaBatteryStateTracker,
  normalizeLastKnownBattery,
  normalizeDogzillaBatterySample,
} from '../lib/dogzilla-battery-state.mjs'

test('DOGZILLA battery tracker keeps last valid battery when current read fails', () => {
  const tracker = createDogzillaBatteryStateTracker()

  const valid = tracker.resolve(normalizeDogzillaBatterySample(73), '2026-06-04T10:00:00.000Z')
  const failed = tracker.resolve(normalizeDogzillaBatterySample(0), '2026-06-04T10:00:01.000Z')

  assert.equal(valid.value, 73)
  assert.equal(valid.status, 'ok')
  assert.equal(failed.value, 73)
  assert.equal(failed.status, 'last-known')
  assert.equal(failed.lastKnownAt, '2026-06-04T10:00:00.000Z')
})

test('DOGZILLA battery tracker stays unavailable until a real number has been seen', () => {
  const tracker = createDogzillaBatteryStateTracker()

  const failed = tracker.resolve(normalizeDogzillaBatterySample(0), '2026-06-04T10:00:01.000Z')

  assert.equal(failed.value, null)
  assert.equal(failed.status, 'read-failed')
})

test('DOGZILLA battery tracker keeps positive out-of-range readings displayable', () => {
  const tracker = createDogzillaBatteryStateTracker()

  const raw = tracker.resolve(normalizeDogzillaBatterySample(118.4), '2026-06-04T10:00:00.000Z')
  const failed = tracker.resolve(normalizeDogzillaBatterySample(Number.NaN), '2026-06-04T10:00:01.000Z')

  assert.equal(raw.value, 118.4)
  assert.equal(raw.status, 'out-of-range')
  assert.equal(raw.unit, 'raw')
  assert.equal(failed.value, 118.4)
  assert.equal(failed.status, 'last-known')
  assert.equal(failed.unit, 'raw')
  assert.equal(failed.lastKnownAt, '2026-06-04T10:00:00.000Z')
})

test('DOGZILLA battery tracker can seed last-known battery from persisted state', () => {
  const tracker = createDogzillaBatteryStateTracker({
    lastKnown: {
      value: 41,
      raw: 41,
      unit: 'percent',
      lastKnownAt: '2026-06-04T10:00:00.000Z',
    },
  })

  const failed = tracker.resolve(normalizeDogzillaBatterySample(null), '2026-06-04T10:00:01.000Z')

  assert.equal(failed.value, 41)
  assert.equal(failed.status, 'last-known')
  assert.equal(failed.unit, 'percent')
  assert.equal(failed.lastKnownAt, '2026-06-04T10:00:00.000Z')
})

test('DOGZILLA battery tracker reports valid samples to persistence callback', () => {
  const updates = []
  const tracker = createDogzillaBatteryStateTracker({
    onUpdate: (state) => updates.push(state),
  })

  tracker.resolve(normalizeDogzillaBatterySample(62), '2026-06-04T10:00:00.000Z')
  tracker.resolve(normalizeDogzillaBatterySample(0), '2026-06-04T10:00:01.000Z')

  assert.deepEqual(updates, [
    {
      value: 62,
      raw: 62,
      unit: 'percent',
      lastKnownAt: '2026-06-04T10:00:00.000Z',
    },
  ])
})

test('normalizeLastKnownBattery rejects empty persisted state', () => {
  assert.equal(normalizeLastKnownBattery({ value: 0, lastKnownAt: 'bad' }), null)
  assert.equal(normalizeLastKnownBattery(null), null)
})
