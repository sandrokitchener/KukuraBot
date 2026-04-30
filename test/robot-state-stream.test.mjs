import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getRobotStateSnapshot,
  ingestRobotStateMessage,
  normalizeRobotStateMessage,
  resetRobotStateForTests,
} from '../lib/robot-state-stream.mjs'

const VALID_STATE = {
  type: 'robot.state',
  uuid: 'dogzilla-local-demo',
  name: 'Robo Doge',
  pose: {
    x: 0.25,
    y: -0.5,
    theta: 1.57,
  },
  task: 'MOVING',
  timestamp: '2026-04-28T15:00:00Z',
  seq: 0,
}

test('normalizeRobotStateMessage accepts spec-shaped robot state', () => {
  const normalized = normalizeRobotStateMessage(VALID_STATE, new Date('2026-04-28T15:00:01Z'))

  assert.equal(normalized.type, 'robot.state')
  assert.equal(normalized.uuid, 'dogzilla-local-demo')
  assert.deepEqual(normalized.pose, {
    x: 0.25,
    y: -0.5,
    theta: 1.57,
  })
  assert.equal(normalized.receivedAt, '2026-04-28T15:00:01.000Z')
})

test('normalizeRobotStateMessage allows null pose', () => {
  const normalized = normalizeRobotStateMessage({
    ...VALID_STATE,
    pose: null,
    task: 'IDLE',
  })

  assert.equal(normalized.pose, null)
})

test('normalizeRobotStateMessage rejects missing fields and unknown tasks', () => {
  assert.throws(
    () => normalizeRobotStateMessage({
      ...VALID_STATE,
      pose: {
        x: 'nope',
        y: 0,
        theta: 0,
      },
    }),
    /pose.x must be a finite number/,
  )
  assert.throws(
    () => normalizeRobotStateMessage({ ...VALID_STATE, task: 'NAPPING' }),
    /task must be one of/,
  )
  assert.throws(
    () => {
      const { seq, ...withoutSeq } = VALID_STATE
      normalizeRobotStateMessage(withoutSeq)
      return seq
    },
    /missing required field "seq"/,
  )
})

test('ingestRobotStateMessage stores latest robot and marks sequence gaps', () => {
  resetRobotStateForTests()

  const first = ingestRobotStateMessage(VALID_STATE, {
    now: new Date('2026-04-28T15:00:01Z'),
  })
  const next = ingestRobotStateMessage({
    ...VALID_STATE,
    pose: {
      x: 1,
      y: 2,
      theta: 3,
    },
    seq: 3,
    timestamp: '2026-04-28T15:00:02Z',
  }, {
    now: new Date('2026-04-28T15:00:03Z'),
  })
  const snapshot = getRobotStateSnapshot()

  assert.equal(first.sequenceStatus, 'first')
  assert.equal(next.sequenceStatus, 'gap')
  assert.equal(snapshot.status, 'ok')
  assert.equal(snapshot.activeRobot.seq, 3)
  assert.equal(snapshot.activeRobot.pose.x, 1)
  assert.equal(snapshot.stats.acceptedMessages, 2)
})
