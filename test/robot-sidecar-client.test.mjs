import test from 'node:test'
import assert from 'node:assert/strict'

import { probeRobotSidecarHealth, sendRobotCommand, sendRobotEmergencyStop, sendRobotEmergencyStopClear } from '../lib/robot-sidecar-client.mjs'
import {
  actionOncePreview,
  dogzillaMapPoseBody,
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

// Avoid holding the test process open for long AbortSignal.timeout() timers
// created by waypoint health checks. Tests that want to inspect timeout values
// patch AbortSignal.timeout themselves and restore to this stub.
AbortSignal.timeout = () => new AbortController().signal

function sendRobotCommandWithDefaultPose(preview, runtimeConfig, ros2Config, options = {}) {
  return sendRobotCommand(
    preview,
    runtimeConfig,
    ros2Config,
    {
      getDogzillaRobotPoseImpl: async () => dogzillaMapPoseBody(),
      ...options,
    },
  )
}

function defaultBridgeResponse(url) {
  if (String(url).endsWith('/healthz-lite')) {
    return jsonResponse({ ok: true, mode: 'http-to-dogzillalib', receivedCount: 0, runtimeSnapshot: false })
  }
  if (String(url).endsWith('/nav2/scan_info')) {
    return jsonResponse({
      ok: true,
      topic: '/scan_nav2',
      publisherCount: 1,
      subscriptionCount: 3,
      available: true,
      messageAvailable: true,
      fresh: true,
      consumerNodes: ['local_costmap', 'global_costmap', 'collision_monitor'],
    })
  }
  return undefined
}

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
      const result = await sendRobotCommandWithDefaultPose(
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
test('sendRobotEmergencyStopClear posts an explicit unlatch command', async () => {
  let requestBody = null

  await withMockedFetch(
    async (_url, options) => {
      requestBody = parseRequestBody(options)
      return jsonResponse({ accepted: true }, { status: 202 })
    },
    async () => {
      const result = await sendRobotEmergencyStopClear(
        ros2Runtime({ dryRun: false }),
        ros2TransportConfig({ dryRun: false }),
      )

      assert.equal(result.status, 'sent')
      assert.equal(requestBody.action, 'clear')
      assert.equal(requestBody.envelope.action, 'clear')
      assert.equal(requestBody.envelope.canonicalPlan.params.reason, 'clear_emergency_stop')
    },
  )
})

test('sendRobotCommand posts waypoint goto envelope when live dispatch is enabled', async () => {
  let requestUrl = ''
  const requests = []

  await withMockedFetch(
    async (url, options) => {
      const defaultResponse = defaultBridgeResponse(url)
      if (defaultResponse) {
        return defaultResponse
      }
      if (String(url).endsWith('/healthz')) {
        return jsonResponse(nav2HealthBody())
      }
      if (String(url).endsWith('/pose')) {
        return jsonResponse(dogzillaMapPoseBody())
      }

      requestUrl = url
      requests.push(parseRequestBody(options))
      const body = parseRequestBody(options)
      const delivery = body?.action === 'stop' ? 'stop' : 'accepted'
      return jsonResponse({
        accepted: true,
        result: {
          executed: true,
          delivery,
        },
      }, { status: 202 })
    },
    async () => {
      const result = await sendRobotCommandWithDefaultPose(
        waypointGotoPreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
        { autoStartWaypointNavigation: false },
      )

assert.equal(result.status, 'accepted')
assert.equal(result.preempt, null)
assert.equal(requestUrl, 'http://10.0.4.32:8893/commands')
assert.equal(requests.length, 1)
assert.equal(requests[0].envelope.canonicalPlan.kind, 'locomotion.goto')
assert.equal(requests[0].envelope.canonicalPlan.params.waypoint, 'living_room')
assert.equal(requests[0].envelope.canonicalPlan.params.frame, 'map')
assert.equal(requests[0].envelope.canonicalPlan.params.mapId, 'test_map')
assert.equal(requests[0].envelope.canonicalPlan.params.mapFingerprint, 'test-map-fingerprint')
assert.equal(requests[0].envelope.canonicalPlan.params.obstacleAvoidance.required, true)
assert.equal(requests[0].envelope.canonicalPlan.params.obstacleAvoidance.mode, 'nav2_costmap')
assert.equal(requests[0].envelope.canonicalPlan.params.obstacleAvoidance.lidarTopic, '/scan_nav2')
assert.match(requests[0].envelope.canonicalPlan.params.obstacleAvoidance.command, /Nav2 costmaps/)
    },
  )
})

test('sendRobotCommand blocks direct waypoint goto when Nav2 is unavailable', async () => {
  const requests = []

  await withMockedFetch(
    async (url, options = {}) => {
      const defaultResponse = defaultBridgeResponse(url)
      if (defaultResponse) {
        return defaultResponse
      }
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
      const result = await sendRobotCommandWithDefaultPose(
        waypointGotoPreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
        { autoStartWaypointNavigation: false },
      )

      assert.equal(result.status, 'navigation-unavailable')
      assert.equal(result.attempted, false)
      assert.equal(result.kind, 'map-waypoint')
      assert.equal(result.directControlAvailable, true)
      assert.match(result.operatorMessage, /Waypoint not sent/)
      assert.match(result.operatorMessage, /Pi-owned Nav2 is not ready/)
      assert.match(result.error, /Waypoint blocked: Pi-owned Nav2 is not ready/)
      assert.match(result.error, /action server is not running/)
      assert.match(result.error, /robodoge-navigation\.service/)
      assert.equal(requests.length, 1)
      assert.equal(requests[0].url, 'http://10.0.4.32:8893/healthz')
      assert.equal(requests[0].body, null)
    },
  )
})

test('sendRobotCommand blocks direct waypoint goto when Nav2 has no odom publisher', async () => {
  const requests = []

  await withMockedFetch(
    async (url, options = {}) => {
      const defaultResponse = defaultBridgeResponse(url)
      if (defaultResponse) {
        return defaultResponse
      }
      requests.push({ url: String(url), body: parseRequestBody(options) })
      return jsonResponse(nav2HealthBody({
        nav2: {
          odom: {
            topic: '/odom',
            publisherCount: 0,
            available: false,
            error: 'No publishers on /odom',
          },
        },
      }))
    },
    async () => {
      const result = await sendRobotCommandWithDefaultPose(
        waypointGotoPreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
        { autoStartWaypointNavigation: false },
      )

      assert.equal(result.status, 'navigation-unavailable')
      assert.equal(result.attempted, false)
      assert.equal(result.kind, 'map-waypoint')
      assert.match(result.operatorMessage, /waypoint prerequisites are not proven/)
      assert.match(result.error, /No publishers on \/odom/)
      assert.equal(requests.length, 1)
      assert.equal(requests[0].url, 'http://10.0.4.32:8893/healthz')
    },
  )
})

test('sendRobotCommand blocks direct waypoint goto when odom publisher has no live sample', async () => {
  const requests = []

  await withMockedFetch(
    async (url, options = {}) => {
      const defaultResponse = defaultBridgeResponse(url)
      if (defaultResponse) {
        return defaultResponse
      }
      requests.push({ url: String(url), body: parseRequestBody(options) })
      return jsonResponse(nav2HealthBody({
        nav2: {
          odom: {
            topic: '/odom',
            publisherCount: 1,
            available: false,
            messageAvailable: false,
            tfAvailable: false,
            error: '/odom has 1 publisher(s), but no live odometry samples were received.',
          },
        },
      }))
    },
    async () => {
      const result = await sendRobotCommandWithDefaultPose(
        waypointGotoPreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
        { autoStartWaypointNavigation: false },
      )

      assert.equal(result.status, 'navigation-unavailable')
      assert.equal(result.attempted, false)
      assert.equal(result.kind, 'map-waypoint')
      assert.match(result.operatorMessage, /waypoint prerequisites are not proven/)
      assert.match(result.error, /no live odometry samples/)
      assert.equal(requests.length, 1)
      assert.equal(requests[0].url, 'http://10.0.4.32:8893/healthz')
    },
  )
})

test('sendRobotCommand still blocks old bridge health when pose only proves odom', async () => {
  const requests = []
  const map = nav2HealthBody().runtime.map

  await withMockedFetch(
    async (url, options = {}) => {
      const defaultResponse = defaultBridgeResponse(url)
      if (defaultResponse) {
        return defaultResponse
      }
      requests.push({ url: String(url), body: parseRequestBody(options) })
      if (String(url).endsWith('/healthz')) {
        return jsonResponse({
          ok: true,
          runtime: {
            map,
            nav2: {
              available: true,
              serverAvailable: true,
            },
            navigation: {
              available: true,
              primary: 'nav2',
            },
          },
        })
      }

      return jsonResponse({ accepted: true }, { status: 202 })
    },
    async () => {
      const result = await sendRobotCommandWithDefaultPose(
        waypointGotoPreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
        {
          autoStartWaypointNavigation: false,
          getDogzillaRobotPoseImpl: async () => dogzillaMapPoseBody(),
        },
      )

      assert.equal(result.status, 'navigation-unavailable')
      assert.equal(result.attempted, false)
      assert.equal(requests.length, 1)
      assert.equal(requests[0].url, 'http://10.0.4.32:8893/healthz')
      assert.match(result.error, /Nav2 lifecycle state was not reported/)
      assert.match(result.error, /No LaserScan publishers visible on \/scan_nav2/)
    },
  )
})

test('sendRobotCommand blocks direct waypoint goto when filtered scan is not wired to Nav2', async () => {
  const requests = []

  await withMockedFetch(
    async (url, options = {}) => {
      const defaultResponse = defaultBridgeResponse(url)
      if (defaultResponse) {
        return defaultResponse
      }
      requests.push({ url: String(url), body: parseRequestBody(options) })
      return jsonResponse(nav2HealthBody({
        nav2: {
          scan: {
            topic: '/scan_nav2',
            publisherCount: 1,
            subscriptionCount: 0,
            available: false,
            error: 'No Nav2 costmap subscribers visible on /scan_nav2',
          },
        },
      }))
    },
    async () => {
      const result = await sendRobotCommandWithDefaultPose(
        waypointGotoPreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
        { autoStartWaypointNavigation: false },
      )

      assert.equal(result.status, 'navigation-unavailable')
      assert.equal(result.attempted, false)
      assert.equal(result.kind, 'map-waypoint')
      assert.match(result.error, /No Nav2 costmap subscribers visible on \/scan_nav2/)
      assert.equal(requests.length, 1)
      assert.equal(requests[0].url, 'http://10.0.4.32:8893/healthz')
    },
  )
})

test('sendRobotCommand does not bypass strict waypoint readiness with loose action and sensor signals', async () => {
  const requests = []

  await withMockedFetch(
    async (url, options = {}) => {
      const defaultResponse = defaultBridgeResponse(url)
      if (defaultResponse) {
        return defaultResponse
      }
      requests.push({ url: String(url), body: parseRequestBody(options) })
      return jsonResponse(nav2HealthBody({
        nav2: {
          available: false,
          waypointReady: false,
          canSendGoal: true,
          serverAvailable: true,
          odom: {
            available: false,
            publisherCount: 1,
            messageAvailable: true,
            tfAvailable: true,
            fresh: false,
            tfFresh: false,
          },
          lifecycle: {
            active: false,
          },
          scan: {
            available: true,
            publisherCount: 1,
            subscriptionCount: 1,
            messageAvailable: true,
            fresh: true,
          },
        },
      }))
    },
    async () => {
      const result = await sendRobotCommandWithDefaultPose(
        waypointGotoPreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
        { autoStartWaypointNavigation: false },
      )

      assert.equal(result.status, 'navigation-unavailable')
      assert.equal(result.attempted, false)
      assert.match(result.error, /lifecycle nodes are not active/i)
      assert.equal(requests.length, 1)
      assert.equal(requests[0].url, 'http://10.0.4.32:8893/healthz')
    },
  )
})

test('sendRobotCommand reports the Pi localization blocker when Nav2 itself is ready', async () => {
  await withMockedFetch(
    async (url) => defaultBridgeResponse(url) ?? jsonResponse(nav2HealthBody({
      navigation: {
        available: false,
        primary: 'unavailable',
        actionServerAvailable: true,
        waypointReady: false,
        blockers: ['Recovered pose disagrees with the saved map pose hint (position error 8.44 m).'],
      },
    })),
    async () => {
      const result = await sendRobotCommandWithDefaultPose(
        waypointGotoPreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
      )

      assert.equal(result.status, 'navigation-unavailable')
      assert.match(result.recovery, /position error 8\.44 m/)
      assert.doesNotMatch(result.recovery, /Check robodoge-navigation\.service/)
    },
  )
})

test('sendRobotCommand sends trusted config waypoint outside active DOGZILLA map bounds', async () => {
  const requests = []

  await withMockedFetch(
    async (url, options = {}) => {
      const defaultResponse = defaultBridgeResponse(url)
      if (defaultResponse) {
        return defaultResponse
      }
      requests.push({ url: String(url), body: parseRequestBody(options) })
      return jsonResponse(nav2HealthBody())
    },
    async () => {
      const result = await sendRobotCommandWithDefaultPose(
        waypointGotoPreview({
          params: {
            waypoint: 'kitchen',
            x: 11,
            y: 0,
          },
        }),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
        { getDogzillaRobotPoseImpl: async () => dogzillaMapPoseBody() },
      )

      assert.equal(result.status, 'sent')
      assert.equal(result.attempted, true)
assert.equal(requests.length, 2)
      assert.equal(requests[0].url, 'http://10.0.4.32:8893/healthz')
      assert.equal(requests.at(-1).url, 'http://10.0.4.32:8893/commands')
    },
  )
})

test('sendRobotCommand blocks trusted waypoint when live robot pose is outside active DOGZILLA map', async () => {
  const requests = []

  await withMockedFetch(
    async (url, options = {}) => {
      const defaultResponse = defaultBridgeResponse(url)
      if (defaultResponse) {
        return defaultResponse
      }
      requests.push({ url: String(url), body: parseRequestBody(options) })
      return jsonResponse(nav2HealthBody({
        runtime: {
          map: {
            ...nav2HealthBody().runtime.map,
            bounds: {
              minX: -11.2,
              maxX: 7.35,
              minY: -12.05,
              maxY: 7.05,
            },
          },
        },
      }))
    },
    async () => {
      const result = await sendRobotCommandWithDefaultPose(
        waypointGotoPreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
        {
          getDogzillaRobotPoseImpl: async () => dogzillaMapPoseBody({
            pose: {
              frame: 'map',
              x: 10.33,
              y: -1.51,
            },
          }),
        },
      )

      assert.equal(result.status, 'navigation-unavailable')
      assert.equal(result.attempted, false)
      assert.equal(result.kind, 'map-waypoint')
      assert.match(result.error, /robot pose is outside active DOGZILLA map bounds/)
      assert.match(result.operatorMessage, /DOGZILLA localization is outside the active map/)
      assert.equal(requests.length, 1)
      assert.equal(requests[0].url, 'http://10.0.4.32:8893/healthz')
    },
  )
})

test('sendRobotCommand blocks a waypoint captured against a different active map', async () => {
  const requests = []

  await withMockedFetch(
    async (url, options = {}) => {
      const defaultResponse = defaultBridgeResponse(url)
      if (defaultResponse) {
        return defaultResponse
      }
      requests.push({ url: String(url), body: parseRequestBody(options) })
      if (String(url).endsWith('/pose')) {
        return jsonResponse(dogzillaMapPoseBody())
      }
      return jsonResponse(nav2HealthBody())
    },
    async () => {
      const result = await sendRobotCommandWithDefaultPose(
        waypointGotoPreview({
          params: {
            waypoint: 'kitchen',
            mapId: 'old_map',
            mapFingerprint: 'old-fingerprint',
          },
        }),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
      )

      assert.equal(result.status, 'waypoint-map-blocked')
      assert.equal(result.attempted, false)
      assert.equal(result.mapIdentity.id, 'old_map')
      assert.equal(result.mapIdentity.fingerprint, 'old-fingerprint')
      assert.match(result.error, /map id.*does not match/i)
      assert.equal(requests.length, 1)
      assert.equal(requests[0].url, 'http://10.0.4.32:8893/healthz')
    },
  )
})

test('sendRobotCommand blocks a waypoint without complete map provenance', async () => {
  const requests = []

  await withMockedFetch(
    async (url, options = {}) => {
      const defaultResponse = defaultBridgeResponse(url)
      if (defaultResponse) {
        return defaultResponse
      }
      requests.push({ url: String(url), body: parseRequestBody(options) })
      return jsonResponse(nav2HealthBody())
    },
    async () => {
      const result = await sendRobotCommandWithDefaultPose(
        waypointGotoPreview({
          params: {
            waypoint: 'kitchen',
            mapId: '',
            mapFingerprint: '',
          },
        }),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
      )

      assert.equal(result.status, 'waypoint-map-blocked')
      assert.equal(result.attempted, false)
      assert.match(result.error, /map identity.*required/i)
      assert.equal(requests.length, 1)
      assert.equal(requests[0].url, 'http://10.0.4.32:8893/healthz')
    },
  )
})

test('sendRobotCommand blocks waypoint dispatch when active map provenance is incomplete', async () => {
  const requests = []

  await withMockedFetch(
    async (url, options = {}) => {
      const defaultResponse = defaultBridgeResponse(url)
      if (defaultResponse) {
        return defaultResponse
      }
      requests.push({ url: String(url), body: parseRequestBody(options) })
      return jsonResponse(nav2HealthBody({
        runtime: {
          map: {
            ...nav2HealthBody().runtime.map,
            fingerprint: '',
          },
        },
      }))
    },
    async () => {
      const result = await sendRobotCommandWithDefaultPose(
        waypointGotoPreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
      )

      assert.equal(result.status, 'waypoint-map-blocked')
      assert.equal(result.attempted, false)
      assert.match(result.error, /active map identity.*required/i)
      assert.equal(requests.length, 1)
      assert.equal(requests[0].url, 'http://10.0.4.32:8893/healthz')
    },
  )
})

test('sendRobotCommand preserves complete map provenance in the direct bridge envelope', async () => {
  const requests = []

  await withMockedFetch(
    async (url, options = {}) => {
      const defaultResponse = defaultBridgeResponse(url)
      if (defaultResponse) {
        return defaultResponse
      }
      if (String(url).endsWith('/healthz')) {
        return jsonResponse(nav2HealthBody())
      }
      requests.push(parseRequestBody(options))
      return jsonResponse({ accepted: true, result: { delivery: 'accepted' } }, { status: 202 })
    },
    async () => {
      const result = await sendRobotCommandWithDefaultPose(
        waypointGotoPreview({
          params: {
            mapSavedAt: '2026-07-15T19:00:00Z',
            mapYaml: '/maps/active.yaml',
            mapPgm: '/maps/active.pgm',
            mapPbstream: '/maps/active.pbstream',
          },
        }),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
      )

      assert.equal(result.status, 'accepted')
      assert.deepEqual(
        Object.fromEntries(Object.entries(requests[0].envelope.canonicalPlan.params).filter(([key]) => key.startsWith('map'))),
        {
          mapId: 'test_map',
          mapFingerprint: 'test-map-fingerprint',
          mapSavedAt: '2026-07-15T19:00:00Z',
          mapYaml: '/maps/active.yaml',
          mapPgm: '/maps/active.pgm',
          mapPbstream: '/maps/active.pbstream',
        },
      )
    },
  )
})

test('sendRobotCommand blocks waypoint unverified by config before Nav2', async () => {
  const requests = []

  await withMockedFetch(
    async (url, options = {}) => {
      const defaultResponse = defaultBridgeResponse(url)
      if (defaultResponse) {
        return defaultResponse
      }
      requests.push({ url: String(url), body: parseRequestBody(options) })
      return jsonResponse(nav2HealthBody())
    },
    async () => {
      const result = await sendRobotCommandWithDefaultPose(
        waypointGotoPreview({
          params: {
            waypoint: 'draft',
            verified: false,
          },
        }),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
      )

      assert.equal(result.status, 'waypoint-blocked')
      assert.equal(result.attempted, false)
      assert.match(result.operatorMessage, /draft is not verified/)
      assert.equal(requests.length, 0)
    },
  )
})

test('sendRobotCommand does not start missing direct waypoint navigator before posting goto', async () => {
  const requests = []
  const actions = []
  let started = false

  await withMockedFetch(
    async (url, options = {}) => {
      const defaultResponse = defaultBridgeResponse(url)
      if (defaultResponse) {
        return defaultResponse
      }
      requests.push({ url: String(url), body: parseRequestBody(options) })

      if (String(url).endsWith('/healthz')) {
        return jsonResponse(nav2HealthBody({
          nav2: {
            available: started,
            clientAvailable: true,
            serverAvailable: started,
            importError: started ? null : 'Nav2 NavigateToPose action server is not running in the ROS graph',
          },
        }))
      }

      return jsonResponse({ accepted: true }, { status: 202 })
    },
    async () => {
      const result = await sendRobotCommandWithDefaultPose(
        waypointGotoPreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
        {
          sleepImpl: async () => {},
          runDogzillaConnectionActionImpl: async (action) => {
            actions.push(action)
            if (action === 'start-navigation') {
              started = true
            }
            return { status: 'ok', action }
          },
        },
      )

      assert.equal(result.status, 'navigation-unavailable')
      assert.equal(result.attempted, false)
      assert.deepEqual(actions, [])
      assert.equal(requests.length, 1)
      assert.equal(requests[0].url, 'http://10.0.4.32:8893/healthz')
    },
  )
})

test('sendRobotCommand does not repair failed Nav2 prerequisites before posting goto', async () => {
  const requests = []
  const actions = []
  let started = false

  await withMockedFetch(
    async (url, options = {}) => {
      const defaultResponse = defaultBridgeResponse(url)
      if (defaultResponse) {
        return defaultResponse
      }
      requests.push({ url: String(url), body: parseRequestBody(options) })

      if (String(url).endsWith('/healthz')) {
        return jsonResponse(nav2HealthBody({
          nav2: {
            lifecycle: {
              active: started,
              error: started ? null : 'Nav2 lifecycle nodes are not active: controller_server',
            },
          },
        }))
      }

      return jsonResponse({ accepted: true }, { status: 202 })
    },
    async () => {
      const result = await sendRobotCommandWithDefaultPose(
        waypointGotoPreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
        {
          sleepImpl: async () => {},
          runDogzillaConnectionActionImpl: async (action) => {
            actions.push(action)
            if (action === 'start-navigation') {
              started = true
            }
            return { status: 'ok', action }
          },
        },
      )

      assert.equal(result.status, 'navigation-unavailable')
      assert.equal(result.attempted, false)
      assert.deepEqual(actions, [])
      assert.equal(requests.length, 1)
      assert.equal(requests[0].url, 'http://10.0.4.32:8893/healthz')
    },
  )
})

test('sendRobotCommand retries when command-time Nav2 action server lookup fails without restarting healthy Nav2', async () => {
  const requests = []
  const actions = []
  let commandAttempts = 0

  await withMockedFetch(
    async (url, options = {}) => {
      const defaultResponse = defaultBridgeResponse(url)
      if (defaultResponse) {
        return defaultResponse
      }
      requests.push({ url: String(url), body: parseRequestBody(options) })

      if (String(url).endsWith('/healthz')) {
        return jsonResponse(nav2HealthBody())
      }

      if (String(url).endsWith('/commands')) {
        const body = parseRequestBody(options)
        if (body?.action !== 'stop') {
          commandAttempts += 1
          if (commandAttempts === 1) {
            return jsonResponse({
              result: {
                executed: false,
                delivery: 'nav2-unavailable',
                error: 'Nav2 NavigateToPose action server unavailable after 2.0s',
              },
            }, { ok: false, status: 503 })
          }
        }
      }

      return jsonResponse({ accepted: true }, { status: 202 })
    },
    async () => {
      const result = await sendRobotCommandWithDefaultPose(
        waypointGotoPreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
        {
          sleepImpl: async () => {},
          runDogzillaConnectionActionImpl: async (action) => {
            actions.push(action)
            return { status: 'ok', action }
          },
        },
      )

      assert.equal(result.status, 'sent')
      assert.equal(result.retriedAfterCommandFailure, true)
      assert.equal(result.firstAttempt.error, 'Nav2 NavigateToPose action server unavailable after 2.0s')
      assert.deepEqual(actions, [])
      assert.equal(commandAttempts, 2)
    },
  )
})

test('sendRobotCommand blocks direct waypoint goto when only map-pose fallback is available', async () => {
  const requests = []

  await withMockedFetch(
    async (url, options = {}) => {
      const defaultResponse = defaultBridgeResponse(url)
      if (defaultResponse) {
        return defaultResponse
      }
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
      const result = await sendRobotCommandWithDefaultPose(
        waypointGotoPreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
        { autoStartWaypointNavigation: false },
      )

      assert.equal(result.status, 'navigation-unavailable')
      assert.equal(result.attempted, false)
      assert.match(result.error, /not a safe waypoint navigator/)
      assert.equal(requests.length, 1)
      assert.equal(requests[0].url, 'http://10.0.4.32:8893/healthz')
    },
  )
})

test('sendRobotCommand does not timeout waypoint movement response', async () => {
  const requests = []
  const originalTimeout = AbortSignal.timeout

  AbortSignal.timeout = (timeoutMs) => {
    requests.push({ kind: 'timeout', timeoutMs })
    return new AbortController().signal
  }

  try {
    await withMockedFetch(
      async (url, options) => {
        const defaultResponse = defaultBridgeResponse(url)
        if (defaultResponse) {
          requests.push({
            kind: 'fetch',
            url: String(url),
            hasSignal: Boolean(options?.signal),
          })
          return defaultResponse
        }

        if (String(url).endsWith('/healthz')) {
          requests.push({
            kind: 'fetch',
            url: String(url),
            hasSignal: Boolean(options?.signal),
          })
          return jsonResponse(nav2HealthBody())
        }

        requests.push({
          kind: 'fetch',
          url: String(url),
          hasSignal: Boolean(options?.signal),
        })
        return jsonResponse({ accepted: true }, { status: 202 })
      },
      async () => {
        await sendRobotCommandWithDefaultPose(
          waypointGotoPreview(),
          dogzillaDirectRuntime(),
          dogzillaTransportConfig({ timeoutMs: 12000 }),
          { getDogzillaRobotPoseImpl: async () => dogzillaMapPoseBody() },
        )
      },
    )
  } finally {
    AbortSignal.timeout = originalTimeout
  }

  assert.deepEqual(requests, [
{ kind: 'timeout', timeoutMs: 8000 },
    { kind: 'fetch', url: 'http://10.0.4.32:8893/healthz-lite', hasSignal: true },
    { kind: 'timeout', timeoutMs: 4000 },
    { kind: 'fetch', url: 'http://10.0.4.32:8893/nav2/scan_info', hasSignal: true },
{ kind: 'timeout', timeoutMs: 6000 },
{ kind: 'fetch', url: 'http://10.0.4.32:8893/healthz', hasSignal: true },
{ kind: 'fetch', url: 'http://10.0.4.32:8893/commands', hasSignal: false },
])
})

test('sendRobotCommand ignores waypoint timeoutSec for desktop response wait', async () => {
  const requests = []
  const originalTimeout = AbortSignal.timeout

  AbortSignal.timeout = (timeoutMs) => {
    requests.push({ kind: 'timeout', timeoutMs })
    return new AbortController().signal
  }

  try {
    await withMockedFetch(
      async (url, options) => {
        const defaultResponse = defaultBridgeResponse(url)
        if (defaultResponse) {
          requests.push({
            kind: 'fetch',
            url: String(url),
            hasSignal: Boolean(options?.signal),
            commandParams: undefined,
          })
          return defaultResponse
        }

        if (String(url).endsWith('/healthz')) {
          requests.push({
            kind: 'fetch',
            url: String(url),
            hasSignal: Boolean(options?.signal),
            commandParams: undefined,
          })
          return jsonResponse(nav2HealthBody())
        }

        const body = options?.body ? JSON.parse(options.body) : null
        requests.push({
          kind: 'fetch',
          url: String(url),
          hasSignal: Boolean(options?.signal),
          commandParams: body?.envelope?.canonicalPlan?.params,
        })
        return jsonResponse({ accepted: true }, { status: 202 })
      },
      async () => {
        await sendRobotCommandWithDefaultPose(
          waypointGotoPreview({ params: { timeoutSec: 45 } }),
          dogzillaDirectRuntime(),
          dogzillaTransportConfig({ timeoutMs: 12000 }),
          { getDogzillaRobotPoseImpl: async () => dogzillaMapPoseBody() },
        )
      },
    )
  } finally {
    AbortSignal.timeout = originalTimeout
  }

  assert.deepEqual(requests, [
    { kind: 'timeout', timeoutMs: 8000 },
    { kind: 'fetch', url: 'http://10.0.4.32:8893/healthz-lite', hasSignal: true, commandParams: undefined },
    { kind: 'timeout', timeoutMs: 4000 },
    { kind: 'fetch', url: 'http://10.0.4.32:8893/nav2/scan_info', hasSignal: true, commandParams: undefined },
{ kind: 'timeout', timeoutMs: 6000 },
{ kind: 'fetch', url: 'http://10.0.4.32:8893/healthz', hasSignal: true, commandParams: undefined },
{
kind: 'fetch',
      url: 'http://10.0.4.32:8893/commands',
      hasSignal: false,
      commandParams: {
        targetKind: 'waypoint',
        waypoint: 'living_room',
        frame: 'map',
        x: 1.25,
        y: -0.5,
        yaw: 0.2,
        verified: true,
        mapId: 'test_map',
        mapFingerprint: 'test-map-fingerprint',
        obstacleAvoidance: {
          required: true,
          mode: 'nav2_costmap',
          lidarTopic: '/scan_nav2',
          command: 'verify Nav2 costmaps have live /scan_nav2; do not start Yahboom laser_Avoidance_xgo_RS200 during Nav2 waypoint control',
          docs: 'sidecars/dogzilla_navigation/README.md',
        },
      },
    },
  ])
})


test('sendRobotCommand reports preempt failure separately without blocking the command', async () => {
  const requests = []

  await withMockedFetch(
    async (url, options) => {
      requests.push({ url: String(url), body: parseRequestBody(options) })
      if (String(url).endsWith('/commands') && parseRequestBody(options)?.action === 'stop') {
        return jsonResponse({ error: 'stop failed' }, { ok: false, status: 503 })
      }
      return jsonResponse({ accepted: true }, { status: 202 })
    },
    async () => {
      const result = await sendRobotCommandWithDefaultPose(
        actionOncePreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
      )

      assert.equal(result.status, 'sent')
      assert.equal(result.preempt.status, 'error')
      assert.equal(requests.length, 2)
      assert.equal(requests[0].body.action, 'stop')
      assert.equal(requests[0].body.envelope.canonicalPlan.params.reason, 'command_preempt')
      assert.equal(requests[1].url, 'http://10.0.4.32:8893/commands')
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
      const result = await sendRobotCommandWithDefaultPose(
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

test('sendRobotCommand surfaces waypoint command result errors without preempt', async () => {
await withMockedFetch(
async (url) => {
const defaultResponse = defaultBridgeResponse(url)
if (defaultResponse) {
return defaultResponse
      }
      if (String(url).endsWith('/healthz')) {
        return jsonResponse(nav2HealthBody())
      }
if (String(url).endsWith('/pose')) {
return jsonResponse(dogzillaMapPoseBody())
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
      const result = await sendRobotCommandWithDefaultPose(
        waypointGotoPreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
      )

assert.equal(result.status, 'rejected')
assert.equal(result.preempt, null)
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
      const result = await sendRobotCommandWithDefaultPose(
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
