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
  assert.equal(config.robotName, 'Questing Beast')
  assert.equal(config.feedback.statePollMs, 125)
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

test('normalizeRobotRos2Config accepts env overrides for remote robot bringup', () => {
  const config = normalizeRobotRos2Config(
    {
      transport: {
        baseUrl: 'http://127.0.0.1:8892',
        dryRun: true,
        timeoutMs: 4000,
      },
      launch: {
        managedByApp: true,
      },
    },
    {
      ROBOT_ROS2_BASE_URL: 'http://192.168.8.88:8892',
      ROBOT_ROS2_TRANSPORT_DRY_RUN: '0',
      ROBOT_ROS2_MANAGED_BY_APP: 'false',
      ROBOT_ROS2_TIMEOUT_MS: '9000',
    },
  )

  assert.equal(config.transport.baseUrl, 'http://192.168.8.88:8892')
  assert.equal(config.transport.dryRun, false)
  assert.equal(config.transport.timeoutMs, 9000)
  assert.equal(config.launch.managedByApp, false)
})
