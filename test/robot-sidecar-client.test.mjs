import test from 'node:test'
import assert from 'node:assert/strict'

import { probeRobotSidecarHealth, sendRobotCommand, sendRobotEmergencyStop } from '../lib/robot-sidecar-client.mjs'

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
        robotName: 'Questing Beast',
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
    assert.equal(requestBody.envelope.robot_id, 'dogzilla-local')
    assert.equal(requestBody.envelope.robot_name, 'Questing Beast')
    assert.equal(requestBody.envelope.payload.robot_id, 'dogzilla-local')
    assert.equal(requestBody.envelope.payload.robot_name, 'Questing Beast')
    assert.equal(requestBody.envelope.canonicalPlan.kind, 'noop')
    assert.equal(requestBody.envelope.canonicalPlan.params.reason, 'emergency_stop')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('sendRobotCommand posts waypoint goto envelope when live dispatch is enabled', async () => {
  const originalFetch = globalThis.fetch
  let requestUrl = ''
  const requests = []
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/healthz')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            runtime: {
              nav2: {
                available: true,
              },
            },
          }
        },
      }
    }

    requestUrl = url
    requests.push(JSON.parse(options.body))
    return {
      ok: true,
      status: 202,
      async json() {
        return {
          accepted: true,
          result: {
            executed: true,
            delivery: 'Nav2 NavigateToPose',
          },
        }
      },
    }
  }

  try {
    const preview = {
      status: 'ready',
      canonicalPlan: {
        kind: 'locomotion.goto',
        params: {
          targetKind: 'waypoint',
          waypoint: 'living_room',
          frame: 'map',
          x: 1.25,
          y: -0.5,
          yaw: 0.2,
        },
      },
    }

    const result = await sendRobotCommand(
      preview,
      {
        dryRun: false,
        activeTarget: {
          id: 'dogzilla_direct',
          kind: 'dogzilla-direct',
          label: 'DOGZILLA Direct Bridge',
        },
      },
      {
        transport: {
          kind: 'http',
          enabled: true,
          dryRun: false,
          baseUrl: 'http://10.0.4.32:8893',
          healthPath: '/healthz',
          commandsPath: '/commands',
          timeoutMs: 1000,
        },
      },
    )

    assert.equal(result.status, 'sent')
    assert.equal(result.preempt.status, 'sent')
    assert.equal(requestUrl, 'http://10.0.4.32:8893/commands')
    assert.equal(requests.length, 2)
    assert.equal(requests[0].action, 'stop')
    assert.equal(requests[0].envelope.canonicalPlan.kind, 'noop')
    assert.equal(requests[0].envelope.canonicalPlan.params.reason, 'command_preempt')
    assert.equal(requests[1].envelope.canonicalPlan.kind, 'locomotion.goto')
    assert.equal(requests[1].envelope.canonicalPlan.params.waypoint, 'living_room')
    assert.equal(requests[1].envelope.canonicalPlan.params.frame, 'map')
    assert.equal(requests[1].envelope.canonicalPlan.params.obstacleAvoidance.required, true)
    assert.equal(requests[1].envelope.canonicalPlan.params.obstacleAvoidance.mode, 'yahboom_laser')
    assert.equal(requests[1].envelope.canonicalPlan.params.obstacleAvoidance.lidarTopic, '/scan')
    assert.match(requests[1].envelope.canonicalPlan.params.obstacleAvoidance.command, /laser_Avoidance_xgo_RS200/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('sendRobotCommand blocks direct waypoint goto when Nav2 is unavailable', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null })
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          runtime: {
            nav2: {
              available: false,
              importError: "No module named 'rclpy'",
            },
          },
        }
      },
    }
  }

  try {
    const result = await sendRobotCommand(
      {
        status: 'ready',
        command: 'move',
        canonicalPlan: {
          kind: 'locomotion.goto',
          params: {
            targetKind: 'waypoint',
            waypoint: 'living_room',
            frame: 'map',
            x: 1.25,
            y: -0.5,
            yaw: 0.2,
          },
        },
      },
      {
        dryRun: false,
        activeTarget: {
          id: 'dogzilla_direct',
          kind: 'dogzilla-direct',
          label: 'DOGZILLA Direct Bridge',
        },
      },
      {
        transport: {
          kind: 'http',
          enabled: true,
          dryRun: false,
          baseUrl: 'http://10.0.4.32:8893',
          healthPath: '/healthz',
          commandsPath: '/commands',
          timeoutMs: 1000,
        },
      },
    )

    assert.equal(result.status, 'navigation-unavailable')
    assert.equal(result.attempted, false)
    assert.match(result.error, /Waypoint navigation unavailable on DOGZILLA Direct Bridge/)
    assert.match(result.error, /No module named 'rclpy'/)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, 'http://10.0.4.32:8893/healthz')
    assert.equal(requests[0].body, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('sendRobotCommand blocks new command when preempt stop fails', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body))
    return {
      ok: false,
      status: 503,
      async json() {
        return { error: 'stop failed' }
      },
    }
  }

  try {
    const result = await sendRobotCommand(
      {
        status: 'ready',
        command: 'trick',
        canonicalPlan: {
          kind: 'action.once',
          params: {
            trick: 'sit',
            actionId: 12,
          },
        },
      },
      {
        dryRun: false,
        activeTarget: {
          id: 'dogzilla_direct',
          kind: 'dogzilla-direct',
          label: 'DOGZILLA Direct Bridge',
        },
      },
      {
        transport: {
          kind: 'http',
          enabled: true,
          dryRun: false,
          baseUrl: 'http://10.0.4.32:8893',
          commandsPath: '/commands',
          timeoutMs: 1000,
        },
      },
    )

    assert.equal(result.status, 'preempt-failed')
    assert.equal(result.preempt.status, 'error')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].envelope.canonicalPlan.params.reason, 'command_preempt')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('sendRobotCommand surfaces DOGZILLA bridge result errors from HTTP 422', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 422,
    async json() {
      return {
        accepted: false,
        result: {
          executed: false,
          error: "No module named 'rclpy'",
          kind: 'locomotion.goto',
        },
      }
    },
  })

  try {
    const result = await sendRobotCommand(
      {
        status: 'ready',
        command: 'manual',
        canonicalPlan: {
          kind: 'locomotion.relative',
          params: {
            x_step: 1,
            y_step: 0,
            turn_rate: 0,
          },
        },
      },
      {
        dryRun: false,
        activeTarget: {
          id: 'dogzilla_direct',
          kind: 'dogzilla-direct',
          label: 'DOGZILLA Direct Bridge',
        },
      },
      {
        transport: {
          kind: 'http',
          enabled: true,
          dryRun: false,
          baseUrl: 'http://10.0.4.32:8893',
          commandsPath: '/commands',
          timeoutMs: 1000,
        },
      },
    )

    assert.equal(result.status, 'error')
    assert.equal(result.responseStatus, 422)
    assert.equal(result.error, "No module named 'rclpy' (locomotion.goto)")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('sendRobotCommand surfaces command result errors after successful preempt', async () => {
  const originalFetch = globalThis.fetch
  let callCount = 0
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/healthz')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            runtime: {
              nav2: {
                available: true,
              },
            },
          }
        },
      }
    }

    callCount += 1
    if (callCount === 1) {
      return {
        ok: true,
        status: 202,
        async json() {
          return { accepted: true }
        },
      }
    }

    return {
      ok: false,
      status: 422,
      async json() {
        return {
          accepted: false,
          result: {
            executed: false,
            delivery: 'lidar-avoidance-unavailable',
            error: 'LiDAR obstacle avoidance unavailable',
            kind: 'locomotion.goto',
          },
        }
      },
    }
  }

  try {
    const result = await sendRobotCommand(
      {
        status: 'ready',
        command: 'move',
        canonicalPlan: {
          kind: 'locomotion.goto',
          params: {
            targetKind: 'waypoint',
            waypoint: 'living_room',
            frame: 'map',
            x: 1.25,
            y: -0.5,
            yaw: 0.2,
          },
        },
      },
      {
        dryRun: false,
        activeTarget: {
          id: 'dogzilla_direct',
          kind: 'dogzilla-direct',
          label: 'DOGZILLA Direct Bridge',
        },
      },
      {
        transport: {
          kind: 'http',
          enabled: true,
          dryRun: false,
          baseUrl: 'http://10.0.4.32:8893',
          healthPath: '/healthz',
          commandsPath: '/commands',
          timeoutMs: 1000,
        },
      },
    )

    assert.equal(result.status, 'error')
    assert.equal(result.preempt.status, 'sent')
    assert.equal(result.error, 'LiDAR obstacle avoidance unavailable (locomotion.goto)')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('sendRobotCommand does not preempt manual relative motion updates', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body))
    return {
      ok: true,
      status: 202,
      async json() {
        return { accepted: true }
      },
    }
  }

  try {
    const result = await sendRobotCommand(
      {
        status: 'ready',
        command: 'manual',
        canonicalPlan: {
          kind: 'locomotion.relative',
          params: {
            x_step: 1,
            y_step: 0,
            turn_rate: 0,
          },
        },
      },
      {
        dryRun: false,
        activeTarget: {
          id: 'dogzilla_direct',
          kind: 'dogzilla-direct',
          label: 'DOGZILLA Direct Bridge',
        },
      },
      {
        transport: {
          kind: 'http',
          enabled: true,
          dryRun: false,
          baseUrl: 'http://10.0.4.32:8893',
          commandsPath: '/commands',
          timeoutMs: 1000,
        },
      },
    )

    assert.equal(result.status, 'sent')
    assert.equal(result.preempt, null)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].envelope.canonicalPlan.kind, 'locomotion.relative')
  } finally {
    globalThis.fetch = originalFetch
  }
})
