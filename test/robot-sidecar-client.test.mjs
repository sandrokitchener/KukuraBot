import test from 'node:test'
import assert from 'node:assert/strict'

import { probeRobotSidecarHealth, sendRobotCommand, sendRobotEmergencyStop } from '../lib/robot-sidecar-client.mjs'
import {
  actionOncePreview,
  dogzillaDirectRuntime,
  dogzillaTransportConfig,
  jsonResponse,
  manualRelativePreview,
  nav2HealthBody,
  parseRequestBody,
  ros2Runtime,
  ros2TransportConfig,
  waypointGotoPreview,
  withMockedFetch,
} from '../test-support/robot-http-fixtures.mjs'

test('probeRobotSidecarHealth reports degraded when bridge body says ok false', async () => {
  await withMockedFetch(
    async () => jsonResponse({
      ok: false,
      runtime: {
        importError: "No module named 'rclpy'",
      },
    }),
    async () => {
      const health = await probeRobotSidecarHealth(ros2Runtime(), ros2TransportConfig())

      assert.equal(health.status, 'degraded')
      assert.equal(health.responseStatus, 200)
    },
  )
})

test('probeRobotSidecarHealth reports connection details from fetch failures', async () => {
  await withMockedFetch(
    async () => {
      throw new TypeError('fetch failed', {
        cause: {
          code: 'ECONNREFUSED',
          address: '10.0.4.32',
          port: 8893,
        },
      })
    },
    async () => {
      const health = await probeRobotSidecarHealth(dogzillaDirectRuntime(), dogzillaTransportConfig())

      assert.equal(health.status, 'error')
      assert.equal(health.error, 'fetch failed (ECONNREFUSED 10.0.4.32:8893)')
    },
  )
})

test('sendRobotCommand annotates command response timeouts', async () => {
  await withMockedFetch(
    async () => {
      const error = new Error('The operation was aborted due to timeout.')
      error.name = 'TimeoutError'
      throw error
    },
    async () => {
      const result = await sendRobotCommand(
        manualRelativePreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig({ timeoutMs: 1234 }),
      )

      assert.equal(result.status, 'error')
      assert.match(result.error, /after 1234ms waiting for robot command response/)
      assert.match(result.error, /bridge feedback/i)
    },
  )
})

test('sendRobotEmergencyStop posts a stop action even when runtime dry-run is enabled', async () => {
  let requestBody = null

  await withMockedFetch(
    async (_url, options) => {
      requestBody = parseRequestBody(options)
      return jsonResponse({ accepted: true }, { status: 202 })
    },
    async () => {
      const result = await sendRobotEmergencyStop(
        ros2Runtime({
          dryRun: true,
          robotId: 'dogzilla-local',
          robotName: 'Questing Beast',
          robotModel: 'dogzilla-s2',
        }),
        {
          bridge: {
            commandPlanTopic: '/dogzilla/command_plan',
          },
          topics: {
            state: '/dogzilla/state',
          },
          ...ros2TransportConfig({
            dryRun: true,
          }),
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
    },
  )
})

test('sendRobotCommand posts waypoint goto envelope when live dispatch is enabled', async () => {
  let requestUrl = ''
  const requests = []

  await withMockedFetch(
    async (url, options) => {
      if (String(url).endsWith('/healthz')) {
        return jsonResponse(nav2HealthBody())
      }

      requestUrl = url
      requests.push(parseRequestBody(options))
      return jsonResponse({
        accepted: true,
        result: {
          executed: true,
          delivery: 'Nav2 NavigateToPose',
        },
      }, { status: 202 })
    },
    async () => {
      const result = await sendRobotCommand(
        waypointGotoPreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
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
    },
  )
})

test('sendRobotCommand blocks direct waypoint goto when Nav2 is unavailable', async () => {
  const requests = []

  await withMockedFetch(
    async (url, options = {}) => {
      requests.push({ url: String(url), body: parseRequestBody(options) })
      return jsonResponse(nav2HealthBody({
        nav2: {
          available: false,
          clientAvailable: true,
          serverAvailable: false,
          importError: 'Nav2 NavigateToPose action server is not running in the ROS graph',
        },
      }))
    },
    async () => {
      const result = await sendRobotCommand(
        waypointGotoPreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
      )

      assert.equal(result.status, 'navigation-unavailable')
      assert.equal(result.attempted, false)
      assert.match(result.error, /Waypoint navigation unavailable on DOGZILLA Direct Bridge/)
      assert.match(result.error, /action server is not running/)
      assert.match(result.error, /Docker ROS client is available/)
      assert.equal(requests.length, 1)
      assert.equal(requests[0].url, 'http://10.0.4.32:8893/healthz')
      assert.equal(requests[0].body, null)
    },
  )
})

test('sendRobotCommand allows direct waypoint goto when map-pose navigation fallback is available', async () => {
  const requests = []

  await withMockedFetch(
    async (url, options = {}) => {
      requests.push({ url: String(url), body: parseRequestBody(options) })
      if (String(url).endsWith('/healthz')) {
        return jsonResponse(nav2HealthBody({
          nav2: {
            available: false,
            clientAvailable: true,
            serverAvailable: false,
            importError: 'Nav2 NavigateToPose action server is not running in the ROS graph',
          },
          runtime: {
            navigation: {
              available: true,
              primary: 'map-pose-closed-loop',
            },
          },
        }))
      }

      return jsonResponse({ accepted: true }, { status: 202 })
    },
    async () => {
      const result = await sendRobotCommand(
        waypointGotoPreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
      )

      assert.equal(result.status, 'sent')
      assert.equal(requests.length, 3)
      assert.equal(requests[0].url, 'http://10.0.4.32:8893/healthz')
      assert.equal(requests[2].body.envelope.canonicalPlan.kind, 'locomotion.goto')
    },
  )
})

test('sendRobotCommand gives waypoint movement a long response timeout', async () => {
  const requests = []
  const originalTimeout = AbortSignal.timeout

  AbortSignal.timeout = (timeoutMs) => {
    requests.push(timeoutMs)
    return originalTimeout(timeoutMs)
  }

  try {
    await withMockedFetch(
      async (url) => {
        if (String(url).endsWith('/healthz')) {
          return jsonResponse(nav2HealthBody({
            nav2: {
              available: false,
            },
            runtime: {
              navigation: {
                available: true,
                primary: 'map-pose-closed-loop',
              },
            },
          }))
        }

        return jsonResponse({ accepted: true }, { status: 202 })
      },
      async () => {
        await sendRobotCommand(
          waypointGotoPreview(),
          dogzillaDirectRuntime(),
          dogzillaTransportConfig({ timeoutMs: 12000 }),
        )
      },
    )
  } finally {
    AbortSignal.timeout = originalTimeout
  }

  assert.deepEqual(requests, [12000, 12000, 180000])
})

test('sendRobotCommand uses waypoint timeoutSec when provided', async () => {
  const requests = []
  const originalTimeout = AbortSignal.timeout

  AbortSignal.timeout = (timeoutMs) => {
    requests.push(timeoutMs)
    return originalTimeout(timeoutMs)
  }

  try {
    await withMockedFetch(
      async (url) => {
        if (String(url).endsWith('/healthz')) {
          return jsonResponse(nav2HealthBody({
            nav2: {
              available: false,
            },
            runtime: {
              navigation: {
                available: true,
                primary: 'map-pose-closed-loop',
              },
            },
          }))
        }

        return jsonResponse({ accepted: true }, { status: 202 })
      },
      async () => {
        await sendRobotCommand(
          waypointGotoPreview({ params: { timeoutSec: 45 } }),
          dogzillaDirectRuntime(),
          dogzillaTransportConfig({ timeoutMs: 12000 }),
        )
      },
    )
  } finally {
    AbortSignal.timeout = originalTimeout
  }

  assert.deepEqual(requests, [12000, 12000, 45000])
})

test('sendRobotCommand blocks new command when preempt stop fails', async () => {
  const requests = []

  await withMockedFetch(
    async (_url, options) => {
      requests.push(parseRequestBody(options))
      return jsonResponse({ error: 'stop failed' }, { ok: false, status: 503 })
    },
    async () => {
      const result = await sendRobotCommand(
        actionOncePreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
      )

      assert.equal(result.status, 'preempt-failed')
      assert.equal(result.preempt.status, 'error')
      assert.equal(requests.length, 1)
      assert.equal(requests[0].envelope.canonicalPlan.params.reason, 'command_preempt')
    },
  )
})

test('sendRobotCommand surfaces DOGZILLA bridge result errors from HTTP 422', async () => {
  await withMockedFetch(
    async () => jsonResponse({
      accepted: false,
      result: {
        executed: false,
        error: "No module named 'rclpy'",
        kind: 'locomotion.goto',
      },
    }, { ok: false, status: 422 }),
    async () => {
      const result = await sendRobotCommand(
        manualRelativePreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
      )

      assert.equal(result.status, 'error')
      assert.equal(result.responseStatus, 422)
      assert.equal(result.error, "No module named 'rclpy' (locomotion.goto)")
    },
  )
})

test('sendRobotCommand surfaces command result errors after successful preempt', async () => {
  let callCount = 0

  await withMockedFetch(
    async (url) => {
      if (String(url).endsWith('/healthz')) {
        return jsonResponse(nav2HealthBody())
      }

      callCount += 1
      if (callCount === 1) {
        return jsonResponse({ accepted: true }, { status: 202 })
      }

      return jsonResponse({
        accepted: false,
        result: {
          executed: false,
          delivery: 'lidar-avoidance-unavailable',
          error: 'LiDAR obstacle avoidance unavailable',
          kind: 'locomotion.goto',
        },
      }, { ok: false, status: 422 })
    },
    async () => {
      const result = await sendRobotCommand(
        waypointGotoPreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
      )

      assert.equal(result.status, 'error')
      assert.equal(result.preempt.status, 'sent')
      assert.equal(result.error, 'LiDAR obstacle avoidance unavailable (locomotion.goto)')
    },
  )
})

test('sendRobotCommand does not preempt manual relative motion updates', async () => {
  const requests = []

  await withMockedFetch(
    async (_url, options) => {
      requests.push(parseRequestBody(options))
      return jsonResponse({ accepted: true }, { status: 202 })
    },
    async () => {
      const result = await sendRobotCommand(
        manualRelativePreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
      )

      assert.equal(result.status, 'sent')
      assert.equal(result.preempt, null)
      assert.equal(requests.length, 1)
      assert.equal(requests[0].envelope.canonicalPlan.kind, 'locomotion.relative')
    },
  )
})
