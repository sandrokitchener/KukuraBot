import test from 'node:test'
import assert from 'node:assert/strict'

import {
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

test('shouldAutoDispatchRobotRuntime only enables dispatch when chat dispatch is configured', () => {
  assert.equal(shouldAutoDispatchRobotRuntime(null), false)
  assert.equal(shouldAutoDispatchRobotRuntime({ dispatchPlan: { dispatchOnChat: false } }), false)
  assert.equal(shouldAutoDispatchRobotRuntime({ dispatchPlan: { dispatchOnChat: true } }), true)
})
