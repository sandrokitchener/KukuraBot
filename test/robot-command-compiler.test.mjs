import test from 'node:test'
import assert from 'node:assert/strict'

import {
  compileRobotManualControlPreview,
  compileRobotRuntimePreview,
  shouldAutoDispatchRobotRuntime,
} from '../lib/robot-command-compiler.mjs'

test('compileRobotRuntimePreview maps move command to named waypoint goto plan', () => {
  const preview = compileRobotRuntimePreview({
    source: {
      input: 'go to the living room',
      rawResponse: '{"command":"move","waypoint":"living_room"}',
      parsed: {
        command: 'move',
        waypoint: 'living_room',
      },
    },
    runtimeConfig: {
      enabled: true,
      dryRun: true,
      robotId: 'dogzilla-local',
      robotModel: 'dogzilla-s2',
      selectedMotionProfile: 'default',
      activeTarget: {
        id: 'ros2_real',
        kind: 'ros2-bridge',
        label: 'ROS2 Real Robot',
      },
    },
    ros2Config: {
      bridge: {
        commandPlanTopic: '/dogzilla/command_plan',
      },
      topics: {
        state: '/dogzilla/state',
      },
      transport: {
        enabled: true,
        dryRun: true,
        dispatchOnChat: true,
        baseUrl: 'http://127.0.0.1:8892',
        commandsPath: '/commands',
        feedbackPath: '/feedback',
      },
      feedback: {
        pollMs: 2500,
      },
    },
    waypointConfig: {
      activeSet: 'home',
      sets: {
        home: {
          waypoints: {
            living_room: {
              kind: 'map_pose',
              frame: 'map',
              x: 1.2,
              y: -0.5,
              yaw: 0.3,
              arrivalToleranceMeters: 0.25,
              verified: true,
              physicalSpot: 'Center rug',
            },
          },
        },
      },
    },
    actionConfig: {
      activeMap: 'default',
      maps: {
        default: {
          tricks: {},
        },
      },
    },
    motionConfig: {
      activeProfile: 'default',
      profiles: {
        default: {},
      },
    },
  })

  assert.equal(preview.status, 'ready')
  assert.equal(preview.action, 'dogzilla.navigate_named_target')
  assert.equal(preview.canonicalPlan.kind, 'locomotion.goto')
  assert.equal(preview.canonicalPlan.params.waypoint, 'living_room')
  assert.equal(preview.payload.planTopic, '/dogzilla/command_plan')
})

test('compileRobotRuntimePreview normalizes space-separated waypoint names', () => {
  const preview = compileRobotRuntimePreview({
    source: {
      parsed: {
        command: 'move',
        waypoint: 'front door',
      },
    },
    runtimeConfig: {
      enabled: true,
      dryRun: true,
      activeTarget: {
        id: 'ros2_real',
        kind: 'ros2-bridge',
        label: 'ROS2 Real Robot',
      },
    },
    ros2Config: {
      bridge: {},
      topics: {},
      transport: {},
      feedback: {},
    },
    waypointConfig: {
      activeSet: 'home',
      sets: {
        home: {
          waypoints: {
            front_door: {
              kind: 'map_pose',
              frame: 'map',
              x: 0,
              y: 0,
              yaw: 0,
              arrivalToleranceMeters: 0.35,
              verified: false,
            },
          },
        },
      },
    },
    actionConfig: {
      activeMap: 'default',
      maps: {
        default: {
          tricks: {},
        },
      },
    },
    motionConfig: {
      activeProfile: 'default',
      profiles: {
        default: {},
      },
    },
  })

  assert.equal(preview.status, 'ready')
  assert.equal(preview.resolutions.waypoint.normalizedName, 'front_door')
  assert.equal(preview.canonicalPlan.params.waypoint, 'front_door')
})

test('compileRobotRuntimePreview rejects trick actions without verified numeric ids', () => {
  const preview = compileRobotRuntimePreview({
    source: {
      parsed: {
        command: 'trick',
        trick: 'backflip',
      },
    },
    runtimeConfig: {
      enabled: true,
      dryRun: true,
      activeTarget: {
        id: 'ros2_real',
        kind: 'ros2-bridge',
        label: 'ROS2 Real Robot',
      },
    },
    ros2Config: {
      bridge: {},
      topics: {},
      transport: {},
      feedback: {},
    },
    waypointConfig: {
      activeSet: 'home',
      sets: {
        home: {
          waypoints: {},
        },
      },
    },
    actionConfig: {
      activeMap: 'default',
      maps: {
        default: {
          tricks: {
            backflip: {
              actionId: 'proxy_backflip_v1',
              verified: true,
            },
          },
        },
      },
    },
    motionConfig: {
      activeProfile: 'default',
      profiles: {
        default: {},
      },
    },
  })

  assert.equal(preview.status, 'unsupported')
  assert.match(preview.warnings[0], /does not have a verified numeric DOGZILLA action id/i)
})

test('compileRobotRuntimePreview maps sit trick to verified DOGZILLA action id', () => {
  const preview = compileRobotRuntimePreview({
    source: {
      parsed: {
        command: 'trick',
        trick: 'sit',
      },
    },
    runtimeConfig: {
      enabled: true,
      dryRun: false,
      activeTarget: {
        id: 'ros2_real',
        kind: 'ros2-bridge',
        label: 'ROS2 Real Robot',
      },
    },
    ros2Config: {
      bridge: {},
      topics: {},
      transport: {},
      feedback: {},
    },
    waypointConfig: {
      activeSet: 'home',
      sets: {
        home: {
          waypoints: {},
        },
      },
    },
    actionConfig: {
      activeMap: 'default',
      maps: {
        default: {
          tricks: {
            sit: {
              actionId: 12,
              verified: true,
            },
          },
        },
      },
    },
    motionConfig: {
      activeProfile: 'default',
      profiles: {
        default: {},
      },
    },
  })

  assert.equal(preview.status, 'ready')
  assert.equal(preview.canonicalPlan.kind, 'action.once')
  assert.equal(preview.canonicalPlan.params.actionId, 12)
})

test('compileRobotManualControlPreview maps gamepad axes to DOGZILLA relative motion', () => {
  const preview = compileRobotManualControlPreview({
    control: {
      forward: 1,
      strafe: 0.5,
      turn: -0.75,
      source: 'gamepad',
    },
    runtimeConfig: {
      enabled: true,
      dryRun: false,
      robotId: 'dogzilla-local',
      robotModel: 'dogzilla-s2',
      selectedMotionProfile: 'default',
      activeTarget: {
        id: 'dogzilla_direct',
        kind: 'dogzilla-direct',
        label: 'DOGZILLA Direct Bridge',
      },
    },
    ros2Config: {
      bridge: {
        commandPlanTopic: '/dogzilla/command_plan',
      },
      topics: {
        state: '/dogzilla/state',
      },
      transport: {
        enabled: true,
        dryRun: false,
        dispatchOnChat: true,
        baseUrl: 'http://127.0.0.1:8893',
        commandsPath: '/commands',
      },
      feedback: {},
    },
    motionConfig: {
      activeProfile: 'default',
      profiles: {
        default: {
          gaits: ['walk', 'trot'],
          paceModes: ['slow', 'normal', 'high'],
          limits: {
            xStep: { min: -25, max: 25 },
            yStep: { min: -18, max: 18 },
            turnRate: { min: -100, max: 100 },
          },
          twistCalibration: {
            deadband: 0.05,
            linearXFullScaleStep: 25,
            linearYFullScaleStep: 18,
            angularZFullScaleStep: 100,
          },
        },
      },
    },
  })

  assert.equal(preview.status, 'ready')
  assert.equal(preview.command, 'manual')
  assert.equal(preview.action, 'dogzilla.manual_control')
  assert.equal(preview.canonicalPlan.kind, 'locomotion.relative')
  assert.deepEqual(preview.canonicalPlan.params, {
    x_step: 25,
    y_step: 9,
    turn_rate: -75,
    gait: 'walk',
    pace: 'normal',
    source: 'gamepad',
  })
  assert.equal(preview.payload.canonicalPlan, preview.canonicalPlan)
})

test('compileRobotManualControlPreview deadbands neutral gamepad drift', () => {
  const preview = compileRobotManualControlPreview({
    control: {
      forward: 0.03,
      strafe: -0.04,
      turn: 0.049,
    },
    runtimeConfig: {
      activeTarget: {
        id: 'dogzilla_direct',
        kind: 'dogzilla-direct',
        label: 'DOGZILLA Direct Bridge',
      },
    },
    ros2Config: {
      bridge: {},
      topics: {},
      transport: {},
      feedback: {},
    },
    motionConfig: {
      activeProfile: 'default',
      profiles: {
        default: {
          twistCalibration: {
            deadband: 0.05,
            linearXFullScaleStep: 25,
            linearYFullScaleStep: 18,
            angularZFullScaleStep: 100,
          },
        },
      },
    },
  })

  assert.equal(preview.canonicalPlan.params.x_step, 0)
  assert.equal(preview.canonicalPlan.params.y_step, 0)
  assert.equal(preview.canonicalPlan.params.turn_rate, 0)
})

test('shouldAutoDispatchRobotRuntime only enables dispatch when chat dispatch is configured', () => {
  assert.equal(shouldAutoDispatchRobotRuntime(null), false)
  assert.equal(shouldAutoDispatchRobotRuntime({ dispatchPlan: { dispatchOnChat: false } }), false)
  assert.equal(shouldAutoDispatchRobotRuntime({ dispatchPlan: { dispatchOnChat: true } }), true)
})
