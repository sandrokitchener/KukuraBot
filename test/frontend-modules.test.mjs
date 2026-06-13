import assert from 'node:assert/strict'
import test from 'node:test'
import { createDogzillaAudioController, normalizeDogzillaAudioVolume } from '../public/dogzilla-audio.js'
import {
  applyForwardRamp,
  createNeutralManualVector,
  createManualControlController,
  hasManualVectorChanged,
  hasManualVectorInput,
  normalizeManualAxis,
  readManualBarkTriggerPressed,
  readManualGamepadVector,
  shouldSendManualCommand,
  shouldSendVector,
  updateManualBarkTriggerState,
} from '../public/manual-control.js'
import {
  formatLidarFailureSummary,
  formatRobotMapWaypointTitle,
  formatWaypointReadinessSummary,
  getRenderableRobotMapWaypoints,
  getRobotMapRangeMeters,
  lidarPointToMapPose,
  poseToMapPosition,
} from '../public/robot-map.js'

test('normalizeDogzillaAudioVolume clamps persisted UI values', () => {
  assert.equal(normalizeDogzillaAudioVolume(0.4), 0.4)
  assert.equal(normalizeDogzillaAudioVolume(2), 1)
  assert.equal(normalizeDogzillaAudioVolume(-1), 0)
  assert.equal(normalizeDogzillaAudioVolume(Number.NaN, 0.75), 0.75)
})

test('dogzilla audio volume control persists changes to backend', () => {
  const calls = []
  const storage = new Map()
  const controller = createDogzillaAudioController({
    input: { value: '0' },
    value: { textContent: '' },
    apiFetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) })
      return { ok: true }
    },
    getRuntimeConfig: () => ({ dogzilla: { audio: { enabled: true, volume: 0.75 } } }),
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  })

  controller.handleVolumeInput()

  assert.deepEqual(calls, [
    { url: '/api/dogzilla/audio/volume', body: { volume: 0 } },
  ])
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

test('manual control reads right trigger as bark button', () => {
  assert.equal(readManualBarkTriggerPressed({
    buttons: [
      {}, {}, {}, {}, {}, {}, {},
      { pressed: false, value: 0.54 },
    ],
  }), false)

  assert.equal(readManualBarkTriggerPressed({
    buttons: [
      {}, {}, {}, {}, {}, {}, {},
      { pressed: false, value: 0.55 },
    ],
  }), true)

  assert.equal(readManualBarkTriggerPressed({
    buttons: [
      {}, {}, {}, {}, {}, {}, {},
      { pressed: true, value: 0 },
    ],
  }), true)
})

test('manual control barks once per right-trigger press with cooldown', () => {
  const state = {
    barkTriggerPressed: false,
    lastBarkAt: 0,
  }

  assert.equal(updateManualBarkTriggerState(false, state, 1000), false)
  assert.equal(updateManualBarkTriggerState(true, state, 1100), true)
  assert.equal(updateManualBarkTriggerState(true, state, 1200), false)
  assert.equal(updateManualBarkTriggerState(false, state, 1300), false)
  assert.equal(updateManualBarkTriggerState(true, state, 1500), false)
  assert.equal(updateManualBarkTriggerState(false, state, 1600), false)
  assert.equal(updateManualBarkTriggerState(true, state, 2100), true)
})

test('manual control right trigger calls bark callback while enabled', async () => {
  const originalWindow = globalThis.window
  const originalNavigator = globalThis.navigator
  let frameCallback = null
  let barkCount = 0
  const gamepad = {
    connected: true,
    index: 0,
    id: 'Test Pad',
    axes: [0, 0, 0],
    buttons: [
      {}, {}, {}, {}, {}, {}, {},
      { pressed: true, value: 1 },
    ],
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      requestAnimationFrame(callback) {
        frameCallback = callback
        return 1
      },
      cancelAnimationFrame() {},
    },
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      getGamepads: () => [gamepad],
      sendBeacon: () => true,
    },
  })

  try {
    const controller = createManualControlController({
      elements: createManualControlElements(),
      apiFetch: async () => ({
        ok: true,
        json: async () => ({ dispatch: { status: 'idle' }, preview: { canonicalPlan: { params: {} } } }),
      }),
      toApiUrl: (path) => path,
      getRuntimeConfig: () => ({ robotRuntime: { dryRun: false } }),
      isRealRobotTargetActive: () => true,
      formatError: (error) => error.message,
      setStatus: () => {},
      runtimeFeedbackOutput: { textContent: '' },
      playBarkCue: async () => {
        barkCount += 1
      },
    })

    controller.enable()
    frameCallback()
    await Promise.resolve()
    assert.equal(barkCount, 1)

    frameCallback()
    await Promise.resolve()
    assert.equal(barkCount, 1)
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator })
  }
})

function createManualControlElements() {
  const meter = () => ({
    dataset: {},
    style: { setProperty() {} },
  })
  return {
    panel: { dataset: {} },
    chip: { textContent: '' },
    toggleButton: { textContent: '', disabled: false },
    neutralButton: { disabled: false },
    status: { textContent: '' },
    padName: { textContent: '' },
    forwardValue: { textContent: '' },
    strafeValue: { textContent: '' },
    turnValue: { textContent: '' },
    forwardMeter: meter(),
    strafeMeter: meter(),
    turnMeter: meter(),
  }
}

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

test('manual control ramps held forward input through walk, trot, and high pace', () => {
  const state = { forwardRampStartedAt: 0 }
  const fullForward = { forward: 1, strafe: 0, turn: 0 }

  const start = applyForwardRamp(fullForward, state, 1000)
  assert.equal(start.vector.forward, 0.25)
  assert.equal(start.gait, 'walk')
  assert.equal(start.pace, 'slow')

  const mid = applyForwardRamp(fullForward, state, 1500)
  assert(mid.vector.forward > start.vector.forward)
  assert(mid.vector.forward < 1)
  assert.equal(mid.gait, 'trot')
  assert.equal(mid.pace, 'normal')

  const end = applyForwardRamp(fullForward, state, 2000)
  assert.equal(end.vector.forward, 1)
  assert.equal(end.gait, 'trot')
  assert.equal(end.pace, 'high')
})

test('manual control resets forward ramp when forward input is released', () => {
  const state = { forwardRampStartedAt: 1000 }

  const neutral = applyForwardRamp(createNeutralManualVector(), state, 1500)
  assert.equal(neutral.vector.forward, 0)
  assert.equal(state.forwardRampStartedAt, 0)

  const next = applyForwardRamp({ forward: 0.8, strafe: 0, turn: 0 }, state, 2000)
  assert.equal(next.vector.forward, 0.2)
  assert.equal(next.gait, 'walk')
})

test('manual control sends when forward ramp changes gait stage', () => {
  assert.equal(shouldSendManualCommand(
    { forward: 0.99, strafe: 0, turn: 0 },
    {
      pending: false,
      errorRetryAt: 0,
      lastSentAt: 1000,
      lastVector: { forward: 0.98, strafe: 0, turn: 0 },
      zeroSent: false,
      lastGait: 'trot',
      lastPace: 'normal',
    },
    { gait: 'trot', pace: 'high' },
    1200,
  ), true)
})

test('manual control keeps non-forward movement in normal trot mode', () => {
  const state = { forwardRampStartedAt: 1000 }
  const strafe = applyForwardRamp({ forward: 0, strafe: 0.6, turn: 0 }, state, 1200)

  assert.equal(strafe.vector.forward, 0)
  assert.equal(strafe.gait, 'trot')
  assert.equal(strafe.pace, 'normal')
  assert.equal(state.forwardRampStartedAt, 0)
})

test('robot map renders numeric map/app-map waypoints and marks config-disabled styling separately', () => {
  const waypoints = getRenderableRobotMapWaypoints([
    { id: 'kitchen', x: 2, y: -1, frame: 'map', verified: true },
    {
      id: 'dock',
      x: 0,
      y: 0,
      frame: 'app_map',
      sourceFrame: 'map',
      originLabel: 'charger_origin',
      verified: true,
      mapFramePose: {
        frame: 'map',
        x: 4.8677,
        y: 2.18303,
        yaw: -1.28204,
      },
    },
    {
      id: 'trusted-warning',
      x: 1.5,
      y: 1.25,
      frame: 'map',
      verified: true,
      enabled: true,
      advisoryProblems: ['missing map fingerprint'],
    },
    { id: 'slash-map', x: -1, y: 1, frame: '/map', verified: true },
    { id: 'odom-test', x: 1, y: 1, frame: 'odom', verified: true },
    { id: 'draft', x: 3, y: 3, frame: 'map', verified: false, enabled: false, disabledReason: 'not verified' },
    { id: 'bad', x: '', y: 3, frame: 'map', verified: true },
  ])

  assert.deepEqual(waypoints.map((waypoint) => waypoint.id), ['kitchen', 'dock', 'trusted-warning', 'slash-map', 'draft'])
  assert.equal(waypoints[1].frame, 'app_map')
  assert.equal(waypoints[1].sourceFrame, 'map')
  assert.equal(waypoints[1].originLabel, 'charger_origin')
  assert.deepEqual(waypoints[1].mapFramePose, {
    frame: 'map',
    x: 4.8677,
    y: 2.18303,
    yaw: -1.28204,
  })
  assert.equal(
    formatRobotMapWaypointTitle(waypoints[1]),
    'dock: app_map x 0.00m, y 0.00m, yaw 0.00rad. source map x 4.87m, y 2.18m, yaw -1.28rad. origin charger_origin.',
  )
  assert.equal(waypoints[2].enabled, true)
  assert.equal(
    formatRobotMapWaypointTitle(waypoints[2]),
    'trusted-warning: map x 1.50m, y 1.25m, yaw 0.00rad. advisory missing map fingerprint.',
  )
  assert.equal(waypoints[4].enabled, false)
  assert.equal(
    formatRobotMapWaypointTitle(waypoints[4]),
    'draft: map x 3.00m, y 3.00m, yaw 0.00rad. disabled not verified.',
  )
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

test('lidar points transform around the current robot map pose', () => {
  assert.deepEqual(lidarPointToMapPose({
    x: 1,
    y: 0,
  }, {
    frame: 'app_map',
    x: 2,
    y: 3,
    theta: 0,
  }), {
    frame: 'app_map',
    x: 3,
    y: 3,
  })

  const rotatedForward = lidarPointToMapPose({
    x: 1,
    y: 0,
  }, {
    frame: 'app_map',
    x: 2,
    y: 3,
    theta: Math.PI / 2,
  })
  assert.equal(rotatedForward.frame, 'app_map')
  assert(Math.abs(rotatedForward.x - 2) < 0.000001)
  assert(Math.abs(rotatedForward.y - 4) < 0.000001)

  const rotatedLeft = lidarPointToMapPose({
    x: 0,
    y: 1,
  }, {
    frame: 'app_map',
    x: 2,
    y: 3,
    theta: Math.PI / 2,
  })
  assert(Math.abs(rotatedLeft.x - 1) < 0.000001)
  assert(Math.abs(rotatedLeft.y - 3) < 0.000001)
})

test('formatWaypointReadinessSummary distinguishes ready and blocked map waypoint state', () => {
  assert.equal(formatWaypointReadinessSummary({
    readyForMapWaypoints: true,
    summary: {
      ready: 2,
      navigable: 2,
    },
  }), 'Waypoints: ready (2/2).')

  assert.equal(formatWaypointReadinessSummary({
    readyForMapWaypoints: false,
    blockers: [
      'map origin not ready: stale-missing-map-identity',
      '12 invalid map waypoint(s) in source of truth',
      'no ready map waypoints in source of truth',
    ],
  }), 'Waypoints not ready: map origin not ready: stale-missing-map-identity; 12 invalid map waypoint(s) in source of truth.')
})
