import test from 'node:test'
import assert from 'node:assert/strict'

import { probeRobotSidecarHealth } from '../lib/robot-sidecar-client.mjs'

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
