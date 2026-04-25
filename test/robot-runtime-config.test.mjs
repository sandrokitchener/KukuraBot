import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeRobotRos2Config,
  normalizeRobotRuntimeConfig,
} from '../lib/robot-runtime-config.mjs'

test('normalizeRobotRuntimeConfig prefers env override target and dry-run flag', () => {
  const config = normalizeRobotRuntimeConfig(
    {
      enabled: true,
      dryRun: true,
      defaultTarget: 'isaacsim',
      targets: {
        isaacsim: {
          label: 'Isaac Sim',
          kind: 'isaacsim',
        },
        ros2_real: {
          label: 'ROS2 Real Robot',
          kind: 'ros2-bridge',
        },
      },
    },
    {
      ROBOT_RUNTIME_TARGET: 'ros2_real',
      ROBOT_RUNTIME_DRY_RUN: 'false',
    },
  )

  assert.equal(config.activeTarget.id, 'ros2_real')
  assert.equal(config.activeTarget.kind, 'ros2-bridge')
  assert.equal(config.selectionLocked, true)
  assert.equal(config.dryRun, false)
})

test('normalizeRobotRos2Config fills transport and launch defaults', () => {
  const config = normalizeRobotRos2Config({
    bridge: {
      namespace: '/dogzilla',
    },
    transport: {
      baseUrl: 'http://127.0.0.1:8892',
    },
  })

  assert.equal(config.bridge.commandPlanTopic, '/dogzilla/command_plan')
  assert.equal(config.transport.kind, 'http')
  assert.equal(config.transport.dispatchOnChat, true)
  assert.equal(config.launch.scriptPath, 'sidecars/ros2_bridge/server.py')
  assert.equal(config.windows.preferredDistro, 'humble')
})
