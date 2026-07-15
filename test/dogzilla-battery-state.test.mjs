import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDogzillaBatteryStateTracker,
  normalizeLastKnownBattery,
  normalizeDogzillaBatterySample,
} from '../lib/dogzilla-battery-state.mjs'

test('DOGZILLA battery tracker keeps last valid battery when current read fails', () => {
  const tracker = createDogzillaBatteryStateTracker()

  const valid = tracker.resolve(normalizeDogzillaBatterySample({ value: 73, unit: 'percent' }), '2026-06-04T10:00:00.000Z')
  const failed = tracker.resolve(normalizeDogzillaBatterySample({ value: 0, unit: 'percent' }), '2026-06-04T10:00:01.000Z')

  assert.equal(valid.value, 73)
  assert.equal(valid.status, 'ok')
  assert.equal(failed.value, 73)
  assert.equal(failed.status, 'last-known')
  assert.equal(failed.lastKnownAt, '2026-06-04T10:00:00.000Z')
})

test('DOGZILLA battery tracker stays unavailable until a real number has been seen', () => {
  const tracker = createDogzillaBatteryStateTracker()

  const failed = tracker.resolve(normalizeDogzillaBatterySample({ value: 0, unit: 'percent' }), '2026-06-04T10:00:01.000Z')

  assert.equal(failed.value, null)
  assert.equal(failed.status, 'read-failed')
})

test('DOGZILLA battery tracker does not cache voltage as percent', () => {
  const tracker = createDogzillaBatteryStateTracker()

  const raw = tracker.resolve(normalizeDogzillaBatterySample({ value: 12.4, unit: 'volts' }), '2026-06-04T10:00:00.000Z')
  const failed = tracker.resolve(normalizeDogzillaBatterySample(Number.NaN), '2026-06-04T10:00:01.000Z')

  assert.equal(raw.value, 12.4)
  assert.equal(raw.status, 'unsupported-unit')
  assert.equal(raw.unit, 'volts')
  assert.equal(failed.value, null)
  assert.equal(failed.status, 'unavailable')
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

  tracker.resolve(normalizeDogzillaBatterySample({ value: 62, unit: 'percent' }), '2026-06-04T10:00:00.000Z')
  tracker.resolve(normalizeDogzillaBatterySample({ value: 0, unit: 'percent' }), '2026-06-04T10:00:01.000Z')

  assert.deepEqual(updates, [
    {
      value: 62,
      raw: 62,
      unit: 'percent',
      lastKnownAt: '2026-06-04T10:00:00.000Z',
    },
  ])
})

test('cached battery telemetry stays visibly last-known', () => {
  const tracker = createDogzillaBatteryStateTracker()
  tracker.resolve({ value: 73, unit: 'percent', status: 'ok' }, '2026-06-04T10:00:00.000Z')

  const cached = tracker.resolve({ value: 72, unit: 'percent', status: 'cached' }, '2026-06-04T10:00:01.000Z')

  assert.equal(cached.value, 73)
  assert.equal(cached.status, 'last-known')
  assert.equal(cached.readStatus, 'cached')
})

test('normalizeLastKnownBattery rejects empty persisted state', () => {
  assert.equal(normalizeLastKnownBattery({ value: 0, lastKnownAt: 'bad' }), null)
  assert.equal(normalizeLastKnownBattery(null), null)
})

test('untyped numeric battery data is not treated as percent', () => {
  assert.deepEqual(normalizeDogzillaBatterySample(73), {
    value: 73,
    raw: 73,
    status: 'untyped',
    unit: 'raw',
  })
})
