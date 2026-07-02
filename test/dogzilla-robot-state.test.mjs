import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizePoseFromBridge,
  resolveRobotPoseFromBridgeState,
} from '../lib/dogzilla-robot-state.mjs'

test('resolveRobotPoseFromBridgeState prefers waypoint-safe mapPose', () => {
  const pose = resolveRobotPoseFromBridgeState({
    pose: { x: 1, y: 2, theta: 0.5, frame: 'odom' },
    mapPose: { x: 3, y: 4, theta: 1.25, frame: 'map', childFrame: 'base_link', source: 'tf' },
  })

  assert.deepEqual(pose, {
    x: 3,
    y: 4,
    theta: 1.25,
    frame: 'map',
    childFrame: 'base_link',
    source: 'tf',
  })
})

test('resolveRobotPoseFromBridgeState falls back to non-waypoint-safe pose', () => {
  const pose = resolveRobotPoseFromBridgeState({
    status: 'local-odom',
    waypointSafe: false,
    pose: { x: 1.5, y: -0.25, theta: 0.75, frame: 'odom', childFrame: 'base_footprint', source: 'odom' },
    mapPose: null,
  })

  assert.deepEqual(pose, {
    x: 1.5,
    y: -0.25,
    theta: 0.75,
    frame: 'odom',
    childFrame: 'base_footprint',
    source: 'odom',
  })
})

test('resolveRobotPoseFromBridgeState also accepts flattened pose payloads', () => {
  const pose = resolveRobotPoseFromBridgeState({
    x: 0.4,
    y: 0.8,
    theta: -0.2,
    frame: '/map',
    childFrame: '/base_link',
    source: 'bridge-cache',
  })

  assert.deepEqual(pose, {
    x: 0.4,
    y: 0.8,
    theta: -0.2,
    frame: 'map',
    childFrame: 'base_link',
    source: 'bridge-cache',
  })
})

test('normalizePoseFromBridge rejects incomplete poses', () => {
  assert.equal(normalizePoseFromBridge({ x: 1, y: 2, frame: 'map' }), null)
})
