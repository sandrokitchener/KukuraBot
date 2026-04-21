import test from 'node:test'
import assert from 'node:assert/strict'

import {
  compileIsaacSimPreview,
  describeIsaacDispatchPlan,
} from '../lib/isaacsim-command-compiler.mjs'

test('compileIsaacSimPreview maps move command to Isaac named target action', () => {
  const preview = compileIsaacSimPreview({
    source: {
      input: 'go to the garage',
      rawResponse: '{"command":"move","waypoint":"garage"}',
      parsed: {
        command: 'move',
        waypoint: 'garage',
      },
    },
    commandMapConfig: {
      activeProfile: 'default',
      profiles: {
        default: {
          protocolVersion: 1,
          target: 'isaacsim',
          commands: {
            move: {
              action: 'robot_controller.goto_waypoint',
              requiredFields: ['fields.waypoint'],
              resolvers: ['waypoint', 'sceneWaypoint'],
              defaults: {
                controller: 'robot controller',
              },
              payloadTemplate: {
                waypointName: '{{fields.waypoint}}',
                targetPose: '{{waypoint.definition}}',
                sceneWaypoint: '{{sceneWaypoint.definition}}',
              },
            },
          },
        },
      },
    },
    sidecarConfig: {
      transport: {
        kind: 'http',
        enabled: false,
        dryRun: true,
        baseUrl: 'http://127.0.0.1:8891',
        commandsPath: '/commands',
      },
    },
    waypointConfig: {
      activeSet: 'home',
      sets: {
        home: {
          waypoints: {
            garage: {
              kind: 'map_pose',
              frame: 'map',
              x: 1.25,
              y: -0.5,
              yaw: 0.0,
            },
          },
        },
      },
    },
    sceneWaypointConfig: {
      activeSet: 'blockout',
      sets: {
        blockout: {
          waypoints: {
            garage: {
              frame: 'world',
              position: [0.22, -0.18, 0.0],
              yawDegrees: -35,
            },
          },
        },
      },
    },
    actionConfig: {
      activeMap: 'default',
      maps: {},
    },
  })

  assert.equal(preview.status, 'ready')
  assert.equal(preview.action, 'robot_controller.goto_waypoint')
  assert.equal(preview.payload.waypointName, 'garage')
  assert.equal(preview.payload.controller, 'robot controller')
  assert.equal(preview.payload.targetPose.frame, 'map')
  assert.equal(preview.resolutions.waypoint.exists, true)
  assert.deepEqual(preview.payload.sceneWaypoint.position, [0.22, -0.18, 0.0])
})

test('compileIsaacSimPreview warns when trick mapping has no action id', () => {
  const preview = compileIsaacSimPreview({
    source: {
      rawResponse: '{"command":"trick","waypoint":"current_position","trick":"backflip"}',
      parsed: {
        command: 'trick',
        waypoint: 'current_position',
        trick: 'backflip',
      },
    },
    commandMapConfig: {
      activeProfile: 'default',
      profiles: {
        default: {
          commands: {
            trick: {
              action: 'articulation.play_named_action',
              requiredFields: ['fields.trick'],
              resolvers: ['trickAction'],
              payloadTemplate: {
                actionName: '{{fields.trick}}',
                actionId: '{{trickAction.actionId}}',
              },
            },
          },
        },
      },
    },
    sidecarConfig: {
      transport: {
        kind: 'http',
        enabled: false,
        dryRun: true,
      },
    },
    waypointConfig: {
      activeSet: 'home',
      sets: {},
    },
    actionConfig: {
      activeMap: 'default',
      maps: {
        default: {
          tricks: {
            backflip: {
              actionId: null,
              verified: false,
            },
          },
        },
      },
    },
  })

  assert.equal(preview.status, 'ready')
  assert.equal(preview.payload.actionName, 'backflip')
  assert.equal(preview.payload.actionId, null)
  assert.match(preview.warnings.join('\n'), /has no actionId yet/i)
})

test('describeIsaacDispatchPlan reports destination and dry-run mode', () => {
  const plan = describeIsaacDispatchPlan({
    transport: {
      kind: 'http',
      enabled: false,
      dryRun: true,
      dispatchOnChat: true,
      baseUrl: 'http://127.0.0.1:8891',
      commandsPath: '/commands',
    },
  })

  assert.equal(plan.transport, 'http')
  assert.equal(plan.enabled, false)
  assert.equal(plan.dryRun, true)
  assert.equal(plan.dispatchOnChat, true)
  assert.equal(plan.destination, 'http://127.0.0.1:8891')
})
