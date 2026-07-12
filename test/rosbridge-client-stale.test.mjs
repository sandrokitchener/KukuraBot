import assert from 'node:assert/strict'
import test from 'node:test'

import { createRosbridgeClient } from '../lib/rosbridge-client.mjs'

test('rosbridge scan returns no points when disconnected or stale', () => {
  const client = createRosbridgeClient()
  client.latest.scan = {
    receivedAt: Date.now() - 4000,
    msg: {
      header: { stamp: { sec: 1, nanosec: 0 }, frame_id: 'laser' },
      angle_min: 0,
      angle_max: 0,
      angle_increment: 1,
      range_min: 0.05,
      range_max: 10,
      ranges: [1],
    },
  }

  assert.equal(client.getScan().status, 'disconnected')
  client.connected = true
  const stale = client.getScan()
  assert.equal(stale.ok, false)
  assert.equal(stale.status, 'stale')
  assert.equal(stale.points.length, 0)
  assert.equal(stale.stale, true)
  assert.ok(stale.latestScanAgeSec >= 3)
})
