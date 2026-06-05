import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeDogzillaAudioVolume } from '../public/dogzilla-audio.js'
import {
  createNeutralManualVector,
  hasManualVectorChanged,
  hasManualVectorInput,
  normalizeManualAxis,
  readManualGamepadVector,
  shouldSendVector,
} from '../public/manual-control.js'
import {
  formatLidarFailureSummary,
  getRenderableRobotMapWaypoints,
  getRobotMapRangeMeters,
  poseToMapPosition,
} from '../public/robot-map.js'

test('normalizeDogzillaAudioVolume clamps persisted UI values', () => {
  assert.equal(normalizeDogzillaAudioVolume(0.4), 0.4)
  assert.equal(normalizeDogzillaAudioVolume(2), 1)
  assert.equal(normalizeDogzillaAudioVolume(-1), 0)
  assert.equal(normalizeDogzillaAudioVolume(Number.NaN, 0.75), 0.75)
})

test('manual control normalizes gamepad axes into DOGZILLA vector shape', () => {
  assert.equal(normalizeManualAxis(0.04), 0)
  assert.equal(normalizeManualAxis(0.4567), 0.457)

  assert.deepEqual(readManualGamepadVector({
    axes: [0.25, -0.5, 0.75],
  }), {
    forward: 0.5,
    strafe: -0.25,
    turn: -0.75,
  })
})

test('manual control send gate repeats moving vectors and sends one neutral', () => {
  const moving = { forward: 0.5, strafe: 0, turn: 0 }
  const neutral = createNeutralManualVector()

  assert.equal(hasManualVectorInput(moving), true)
  assert.equal(hasManualVectorInput(neutral), false)
  assert.equal(hasManualVectorChanged(moving, null), true)
  assert.equal(hasManualVectorChanged(moving, { forward: 0.49, strafe: 0, turn: 0 }), false)
  assert.equal(hasManualVectorChanged(moving, { forward: 0.4, strafe: 0, turn: 0 }), true)

  assert.equal(shouldSendVector(moving, {
    pending: false,
    errorRetryAt: 0,
    lastSentAt: 0,
    lastVector: null,
    zeroSent: true,
  }, 1000), true)
  assert.equal(shouldSendVector(neutral, {
    pending: false,
    errorRetryAt: 0,
    lastSentAt: 1000,
    lastVector: moving,
    zeroSent: false,
  }, 1100), true)
  assert.equal(shouldSendVector(neutral, {
    pending: false,
    errorRetryAt: 0,
    lastSentAt: 1000,
    lastVector: neutral,
    zeroSent: true,
  }, 1100), false)
})

test('robot map renders only verified map-frame waypoints and scales range', () => {
  const waypoints = getRenderableRobotMapWaypoints([
    { id: 'kitchen', x: 2, y: -1, frame: 'map', verified: true },
    { id: 'odom-test', x: 1, y: 1, frame: 'odom', verified: true },
    { id: 'draft', x: 3, y: 3, frame: 'map', verified: false },
    { id: 'bad', x: '', y: 3, frame: 'map', verified: true },
  ])

  assert.deepEqual(waypoints.map((waypoint) => waypoint.id), ['kitchen'])
  assert.equal(getRobotMapRangeMeters(waypoints, { pose: { x: 3.2, y: 0 } }), 4)
  assert.deepEqual(poseToMapPosition({ x: 0, y: 0 }, 4), { xPercent: 50, yPercent: 50 })
  assert.deepEqual(poseToMapPosition({ x: 4, y: -4 }, 4), { xPercent: 100, yPercent: 100 })
})

test('formatLidarFailureSummary keeps serial diagnostics visible', () => {
  const summary = formatLidarFailureSummary({
    status: 'no-scan',
    error: 'no frames',
    serialPort: '/dev/ttyAMA1',
    baudrate: 230400,
    serialDiagnostics: {
      exists: true,
      readable: true,
      writable: true,
      realPath: '/dev/ttyAMA1',
    },
  })

  assert.match(summary, /Lidar no-scan: no frames/)
  assert.match(summary, /Serial \/dev\/ttyAMA1 @ 230400 \(present, rw\)/)
})
