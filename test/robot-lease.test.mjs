import test from 'node:test'
import assert from 'node:assert/strict'
import {
  acquireRobotLease,
  getRobotLease,
  releaseRobotLease,
  renewRobotLease,
  resetRobotLeases,
} from '../lib/robot-lease.mjs'

test.beforeEach(() => resetRobotLeases())

test('one active owner gets monotonic fencing token and stale owner is rejected', () => {
  const first = acquireRobotLease({ robotId: 'r1', holder: 'client-a', at: 1000 })
  const conflict = acquireRobotLease({ robotId: 'r1', holder: 'client-b', at: 1001 })
  assert.equal(first.ok, true)
  assert.equal(first.lease.fencingToken, 1)
  assert.equal(conflict.status, 'conflict')
  assert.equal(conflict.lease.holder, 'client-a')
  assert.equal(renewRobotLease({ robotId: 'r1', holder: 'client-b', fencingToken: 1, at: 1002 }).ok, false)
})

test('expired lease can be acquired and release requires current fencing token', () => {
  const first = acquireRobotLease({ robotId: 'r1', holder: 'client-a', at: 1000 })
  const second = acquireRobotLease({ robotId: 'r1', holder: 'client-b', at: 11_001 })
  assert.equal(second.ok, true)
  assert.equal(second.lease.fencingToken > first.lease.fencingToken, true)
  assert.equal(releaseRobotLease({ robotId: 'r1', holder: 'client-a', fencingToken: first.lease.fencingToken, at: 11_002 }).ok, false)
  assert.equal(releaseRobotLease({ robotId: 'r1', holder: 'client-b', fencingToken: second.lease.fencingToken, at: 11_003 }).ok, true)
  assert.equal(getRobotLease('r1').active, false)
})
