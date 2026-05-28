import test from 'node:test'
import assert from 'node:assert/strict'

import { probeRobotSidecarHealth, sendRobotEmergencyStop } from '../lib/robot-sidecar-client.mjs'

test('probeRobotSidecarHealth reports degraded when bridge body says ok false', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        ok: false,
        runtime: {
          importError: "No module named 'rclpy'",
        },
      }
    },
  })

  try {
    const health = await probeRobotSidecarHealth(
      {
        activeTarget: {
          id: 'ros2_real',
          kind: 'ros2-bridge',
        },
      },
      {
        transport: {
          kind: 'http',
          enabled: true,
          baseUrl: 'http://192.168.8.88:8892',
          healthPath: '/healthz',
          timeoutMs: 1000,
        },
      },
    )

    assert.equal(health.status, 'degraded')
    assert.equal(health.responseStatus, 200)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('probeRobotSidecarHealth reports connection details from fetch failures', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed', {
      cause: {
        code: 'ECONNREFUSED',
        address: '10.0.4.32',
        port: 8893,
      },
    })
  }

  try {
    const health = await probeRobotSidecarHealth(
      {
        activeTarget: {
          id: 'dogzilla_direct',
          kind: 'dogzilla-direct',
        },
      },
      {
        transport: {
          kind: 'http',
          enabled: true,
          baseUrl: 'http://10.0.4.32:8893',
          healthPath: '/healthz',
          timeoutMs: 1000,
        },
      },
    )

    assert.equal(health.status, 'error')
    assert.equal(health.error, 'fetch failed (ECONNREFUSED 10.0.4.32:8893)')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('sendRobotEmergencyStop posts a stop action even when runtime dry-run is enabled', async () => {
  const originalFetch = globalThis.fetch
  let requestBody = null
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body)
    return {
      ok: true,
      status: 202,
      async json() {
        return { accepted: true }
      },
    }
  }

  try {
    const result = await sendRobotEmergencyStop(
      {
        dryRun: true,
        robotId: 'dogzilla-local',
        robotModel: 'dogzilla-s2',
        activeTarget: {
          id: 'ros2_real',
          kind: 'ros2-bridge',
          label: 'ROS2 Real Robot',
        },
      },
      {
        bridge: {
          commandPlanTopic: '/dogzilla/command_plan',
        },
        topics: {
          state: '/dogzilla/state',
        },
        transport: {
          kind: 'http',
          enabled: true,
          dryRun: true,
          baseUrl: 'http://192.168.8.88:8892',
          commandsPath: '/commands',
          timeoutMs: 1000,
        },
      },
    )

    assert.equal(result.status, 'sent')
    assert.equal(requestBody.action, 'stop')
    assert.equal(requestBody.envelope.action, 'stop')
    assert.equal(requestBody.envelope.canonicalPlan.kind, 'noop')
    assert.equal(requestBody.envelope.canonicalPlan.params.reason, 'emergency_stop')
  } finally {
    globalThis.fetch = originalFetch
  }
})
