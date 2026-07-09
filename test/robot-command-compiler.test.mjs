import test from 'node:test'
import assert from 'node:assert/strict'

import {
  compileRobotManualControlPreview,
  compileRobotRuntimePreview,
  shouldAutoDispatchRobotRuntime,
} from '../lib/robot-command-compiler.mjs'
import { dogzillaDirectRuntime } from '../test-support/robot-http-fixtures.mjs'
import {
  dogzillaMotionProfile,
  manualControlInput,
  mapWaypoint,
  runtimePreviewInput,
} from '../test-support/robot-compiler-fixtures.mjs'

test('compileRobotRuntimePreview maps move command to named waypoint goto plan', () => {
  const preview = compileRobotRuntimePreview(runtimePreviewInput({
    source: {
      input: 'go to the living room',
      rawResponse: '{"command":"move","waypoint":"living_room"}',
      parsed: {
        command: 'move',
        waypoint: 'living_room',
      },
    },
    waypoints: {
      living_room: mapWaypoint({
        x: 1.2,
        y: -0.5,
        yaw: 0.3,
        physicalSpot: 'Center rug',
      }),
    },
  }))

  assert.equal(preview.status, 'ready')
  assert.equal(preview.action, 'dogzilla.navigate_named_target')
  assert.equal(preview.robot_id, 'dogzilla-local')
  assert.equal(preview.robot_name, 'Questing Beast')
  assert.equal(preview.canonicalPlan.kind, 'locomotion.goto')
  assert.equal(preview.canonicalPlan.params.waypoint, 'living_room')
  assert.equal(preview.payload.robot_id, 'dogzilla-local')
  assert.equal(preview.payload.robot_name, 'Questing Beast')
  assert.equal(preview.payload.planTopic, '/dogzilla/command_plan')
})

test('compileRobotRuntimePreview blocks space-separated waypoint names when config says unverified', () => {
  const preview = compileRobotRuntimePreview(runtimePreviewInput({
    source: {
      parsed: {
        command: 'move',
        waypoint: 'front door',
      },
    },
    waypoints: {
      front_door: mapWaypoint({
        arrivalToleranceMeters: 0.35,
        verified: false,
      }),
    },
  }))

  assert.equal(preview.status, 'waypoint-blocked')
  assert.equal(preview.resolutions.waypoint.normalizedName, 'front_door')
  assert.deepEqual(preview.missingRequired, [])
  assert.equal(preview.canonicalPlan, null)
  assert.match(preview.warnings.join('\n'), /not verified in robot-waypoints config/)
})

test('compileRobotRuntimePreview accepts config waypoint even when notes are operator comments', () => {
  const preview = compileRobotRuntimePreview(runtimePreviewInput({
    source: {
      parsed: {
        command: 'move',
        waypoint: 'living_room',
      },
    },
    waypoints: {
      living_room: mapWaypoint({
        notes: ['Dummy pose. Replace with a real mapped pose later.'],
      }),
    },
  }))

  assert.equal(preview.status, 'ready')
  assert.deepEqual(preview.missingRequired, [])
  assert.equal(preview.canonicalPlan.params.waypoint, 'living_room')
})

test('compileRobotRuntimePreview accepts stored pose as source of truth over stale note text', () => {
  const preview = compileRobotRuntimePreview(runtimePreviewInput({
    source: {
      parsed: {
        command: 'move',
        waypoint: 'kitchen',
      },
    },
    waypoints: {
      kitchen: mapWaypoint({
        x: 9.2,
        y: 6.29,
        yaw: 2.66,
        notes: ['Captured map pose: x=5.18, y=0.38, yaw=2.66.'],
      }),
    },
  }))

  assert.equal(preview.status, 'ready')
  assert.deepEqual(preview.missingRequired, [])
  assert.equal(preview.canonicalPlan.params.x, 9.2)
})

test('compileRobotRuntimePreview converts app_map waypoint through saved origin', () => {
  const preview = compileRobotRuntimePreview(runtimePreviewInput({
    source: {
      parsed: {
        command: 'move',
        waypoint: 'kitchen',
      },
    },
    waypoints: {
      kitchen: mapWaypoint({
        frame: 'app_map',
        x: 1,
        y: 0,
        yaw: Math.PI / 2,
      }),
    },
    mapOrigin: {
      x: 10,
      y: 20,
      yaw: Math.PI / 2,
      map: {
        id: 'test_map',
        fingerprint: 'test-map-fingerprint',
      },
    },
  }))

  assert.equal(preview.status, 'ready')
  assert.equal(preview.canonicalPlan.params.frame, 'map')
  assert.equal(preview.canonicalPlan.params.sourceFrame, 'app_map')
  assert.equal(preview.canonicalPlan.params.x, 10)
  assert.equal(preview.canonicalPlan.params.y, 21)
  assert.equal(preview.canonicalPlan.params.yaw, 3.14159)
  assert.equal(preview.canonicalPlan.params.mapId, 'test_map')
  assert.equal(preview.canonicalPlan.params.mapFingerprint, 'test-map-fingerprint')
})

test('compileRobotRuntimePreview keeps app_map waypoint fixed when current origin is reset', () => {
  const preview = compileRobotRuntimePreview(runtimePreviewInput({
    source: {
      parsed: {
        command: 'move',
        waypoint: 'kitchen',
      },
    },
    waypoints: {
      kitchen: mapWaypoint({
        frame: 'app_map',
        x: 1,
        y: 0,
        yaw: Math.PI / 2,
        mapOrigin: {
          frame: 'app_map',
          sourceFrame: 'map',
          label: 'charger_origin',
          x: 10,
          y: 20,
          yaw: Math.PI / 2,
          savedAt: '2026-06-15T19:25:00.000Z',
          map: {
            id: 'test_map',
            fingerprint: 'test-map-fingerprint',
          },
        },
      }),
    },
    mapOrigin: {
      x: -5,
      y: -3,
      yaw: -0.8,
      label: 'charger_origin',
      savedAt: '2026-06-15T19:55:00.000Z',
      map: {
        id: 'test_map',
        fingerprint: 'test-map-fingerprint',
      },
    },
  }))

  assert.equal(preview.status, 'ready')
  assert.equal(preview.canonicalPlan.params.frame, 'map')
  assert.equal(preview.canonicalPlan.params.sourceFrame, 'app_map')
  assert.equal(preview.canonicalPlan.params.appMapResolution, 'waypoint-origin')
  assert.equal(preview.canonicalPlan.params.x, 10)
  assert.equal(preview.canonicalPlan.params.y, 21)
  assert.equal(preview.canonicalPlan.params.yaw, 3.14159)
})

test('compileRobotRuntimePreview uses captured map pose for legacy app_map waypoint after origin reset', () => {
  const preview = compileRobotRuntimePreview(runtimePreviewInput({
    source: {
      parsed: {
        command: 'move',
        waypoint: 'garage',
      },
    },
    waypoints: {
      garage: mapWaypoint({
        frame: 'app_map',
        x: -3.10505,
        y: -2.38933,
        yaw: -1.77342,
        capturedMapPose: {
          frame: 'map',
          x: -0.51338,
          y: 0.60067,
          yaw: 1.14547,
        },
      }),
    },
    mapOrigin: {
      x: -5.07624,
      y: -2.9796,
      yaw: -0.85922,
      label: 'charger_origin',
      savedAt: '2026-06-15T19:55:13.969Z',
      map: {
        id: 'test_map',
        fingerprint: 'test-map-fingerprint',
      },
    },
  }))

  assert.equal(preview.status, 'ready')
  assert.equal(preview.canonicalPlan.params.frame, 'map')
  assert.equal(preview.canonicalPlan.params.sourceFrame, 'app_map')
  assert.equal(preview.canonicalPlan.params.appMapResolution, 'captured-map-pose')
  assert.equal(preview.canonicalPlan.params.x, -0.51338)
  assert.equal(preview.canonicalPlan.params.y, 0.60067)
  assert.equal(preview.canonicalPlan.params.yaw, 1.14547)
  assert.match(preview.warnings.join('\n'), /using its captured map pose/)
})

test('compileRobotRuntimePreview blocks app_map waypoint without saved origin', () => {
  const preview = compileRobotRuntimePreview(runtimePreviewInput({
    source: {
      parsed: {
        command: 'move',
        waypoint: 'kitchen',
      },
    },
    waypoints: {
      kitchen: mapWaypoint({
        frame: 'app_map',
        x: 1,
      }),
    },
  }))

  assert.equal(preview.status, 'invalid')
  assert.deepEqual(preview.missingRequired, ['waypoint.mapOrigin'])
  assert.match(preview.warnings.at(-1), /no saved DOGZILLA map origin/)
})

test('compileRobotRuntimePreview accepts app_map waypoint even when saved origin has no map identity', () => {
  const preview = compileRobotRuntimePreview(runtimePreviewInput({
    source: {
      parsed: {
        command: 'move',
        waypoint: 'kitchen',
      },
    },
    waypoints: {
      kitchen: mapWaypoint({
        frame: 'app_map',
        x: 1,
        y: 0,
      }),
    },
    mapOrigin: {
      x: 10,
      y: 20,
      yaw: Math.PI / 2,
    },
  }))

  assert.equal(preview.status, 'ready')
})

test('compileRobotRuntimePreview rejects trick actions without verified numeric ids', () => {
  const preview = compileRobotRuntimePreview(runtimePreviewInput({
    source: {
      parsed: {
        command: 'trick',
        trick: 'backflip',
      },
    },
    tricks: {
      backflip: {
        actionId: 'proxy_backflip_v1',
        verified: true,
      },
    },
  }))

  assert.equal(preview.status, 'unsupported')
  assert.match(preview.warnings[0], /does not have a verified numeric DOGZILLA action id/i)
})

test('compileRobotRuntimePreview maps sit trick to verified DOGZILLA action id', () => {
  const preview = compileRobotRuntimePreview(runtimePreviewInput({
    source: {
      parsed: {
        command: 'trick',
        trick: 'sit',
      },
    },
    tricks: {
      sit: {
        actionId: 12,
        verified: true,
      },
    },
  }))

  assert.equal(preview.status, 'ready')
  assert.equal(preview.canonicalPlan.kind, 'action.once')
  assert.equal(preview.canonicalPlan.params.actionId, 12)
})

test('compileRobotRuntimePreview normalizes paw shake trick to handshake action id', () => {
  const preview = compileRobotRuntimePreview(runtimePreviewInput({
    source: {
      parsed: {
        command: 'trick',
        trick: 'paw shake',
      },
    },
    runtimeConfig: dogzillaDirectRuntime({
      enabled: true,
      dryRun: false,
    }),
    tricks: {
      paw_shake: {
        actionId: 19,
        verified: true,
      },
    },
  }))

  assert.equal(preview.status, 'ready')
  assert.equal(preview.canonicalPlan.kind, 'action.once')
  assert.equal(preview.canonicalPlan.params.trick, 'paw_shake')
  assert.equal(preview.canonicalPlan.params.actionId, 19)
})

test('compileRobotRuntimePreview refuses plain dance as an implicit performance loop', () => {
  const preview = compileRobotRuntimePreview(runtimePreviewInput({
    source: {
      input: 'do a trick',
      parsed: {
        command: 'trick',
        trick: 'dance',
      },
    },
    runtimeConfig: dogzillaDirectRuntime({
      enabled: true,
      dryRun: false,
    }),
    tricks: {
      dance: {
        planKind: 'action.loop',
        enabled: true,
        verified: true,
      },
    },
  }))

  assert.equal(preview.status, 'unsupported')
  assert.equal(preview.canonicalPlan, null)
  assert.match(preview.warnings.join('\n'), /continuous DOGZILLA performance mode/i)
})

test('compileRobotRuntimePreview maps explicit dance loop request to performance loop', () => {
  const preview = compileRobotRuntimePreview(runtimePreviewInput({
    source: {
      input: 'start dance loop',
      parsed: {
        command: 'trick',
        trick: 'start_dance_loop',
      },
    },
    runtimeConfig: dogzillaDirectRuntime({
      enabled: true,
      dryRun: false,
    }),
    tricks: {
      start_dance_loop: {
        planKind: 'action.loop',
        enabled: true,
        verified: true,
      },
    },
  }))

  assert.equal(preview.status, 'ready')
  assert.equal(preview.canonicalPlan.kind, 'action.loop')
  assert.deepEqual(preview.canonicalPlan.params, {
    trick: 'start_dance_loop',
    enabled: true,
    verified: true,
  })
})

test('compileRobotManualControlPreview maps gamepad axes to DOGZILLA relative motion', () => {
  const preview = compileRobotManualControlPreview(manualControlInput({
    control: {
      forward: 1,
      strafe: 0.5,
      turn: -0.75,
      source: 'gamepad',
    },
  }))

  assert.equal(preview.status, 'ready')
  assert.equal(preview.command, 'manual')
  assert.equal(preview.action, 'dogzilla.manual_control')
  assert.equal(preview.payload.robot_id, 'dogzilla-local')
  assert.equal(preview.payload.robot_name, 'Questing Beast')
  assert.equal(preview.canonicalPlan.kind, 'locomotion.relative')
  assert.deepEqual(preview.canonicalPlan.params, {
    x_step: 25,
    y_step: 9,
    turn_rate: -75,
    gait: 'trot',
    pace: 'normal',
    source: 'gamepad',
  })
  assert.equal(preview.payload.canonicalPlan, preview.canonicalPlan)
})

test('compileRobotManualControlPreview deadbands neutral gamepad drift', () => {
  const preview = compileRobotManualControlPreview(manualControlInput({
    control: {
      forward: 0.03,
      strafe: -0.04,
      turn: 0.049,
    },
    runtimeConfig: dogzillaDirectRuntime(),
    motionProfile: dogzillaMotionProfile({
      twistCalibration: {
        deadband: 0.05,
        linearXFullScaleStep: 25,
        linearYFullScaleStep: 18,
        angularZFullScaleStep: 100,
      },
    }),
  }))

  assert.equal(preview.canonicalPlan.params.x_step, 0)
  assert.equal(preview.canonicalPlan.params.y_step, 0)
  assert.equal(preview.canonicalPlan.params.turn_rate, 0)
})

test('shouldAutoDispatchRobotRuntime only enables dispatch when chat dispatch is configured', () => {
  assert.equal(shouldAutoDispatchRobotRuntime(null), false)
  assert.equal(shouldAutoDispatchRobotRuntime({ dispatchPlan: { dispatchOnChat: false } }), false)
  assert.equal(shouldAutoDispatchRobotRuntime({ dispatchPlan: { dispatchOnChat: true } }), true)
})
