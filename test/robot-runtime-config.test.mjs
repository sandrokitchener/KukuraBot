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
  assert.equal(config.feedback.statePollMs, 1000)
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

test('normalizeRobotRuntimeConfig exposes reversible safety-preserving performance profiles', () => {
  const config = normalizeRobotRuntimeConfig({
    activePerformanceProfile: 'endurance',
    performanceProfiles: {
      balanced: { label: 'Balanced', feedbackPollMs: 2500, statePollMs: 1000, lidarPollMs: 750, cameraStream: 'raw' },
      endurance: { label: 'Endurance', feedbackPollMs: 5000, statePollMs: 2500, lidarPollMs: 1500, cameraStream: 'off', visionEnabled: false },
    },
  })

  assert.equal(config.activePerformanceProfile.id, 'endurance')
  assert.equal(config.activePerformanceProfile.cameraStream, 'off')
  assert.equal(config.activePerformanceProfile.visionEnabled, false)
  assert.equal(config.activePerformanceProfile.localizationMode, 'continuous')
  assert.equal(config.activePerformanceProfile.safetyTelemetry, true)
  assert.equal(config.feedback.pollMs, 5000)
  assert.equal(config.feedback.statePollMs, 2500)
  assert.equal(config.availablePerformanceProfiles.length, 2)
})

test('ROBOT_PERFORMANCE_PROFILE locks profile selection without changing safety mode', () => {
  const config = normalizeRobotRuntimeConfig({
    activePerformanceProfile: 'balanced',
    performanceProfiles: { balanced: {}, endurance: {} },
  }, { ROBOT_PERFORMANCE_PROFILE: 'endurance' })

  assert.equal(config.activePerformanceProfile.id, 'endurance')
  assert.equal(config.performanceSelectionLocked, true)
  assert.equal(config.activePerformanceProfile.localizationMode, 'continuous')
  assert.equal(config.activePerformanceProfile.safetyTelemetry, true)
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
