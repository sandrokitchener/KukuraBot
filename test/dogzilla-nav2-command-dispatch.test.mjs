import assert from 'node:assert/strict'
import test from 'node:test'

import { sendRobotCommand } from '../lib/robot-sidecar-client.mjs'
import { getNav2Stability, resetNav2Stability } from '../lib/dogzilla-nav2-stability.mjs'
import {
  dogzillaDirectRuntime,
  dogzillaTransportConfig,
  jsonResponse,
  nav2HealthBody,
  parseRequestBody,
  waypointGotoPreview,
  withMockedFetch,
} from '../test-support/robot-http-fixtures.mjs'

function defaultBridgeResponse(url) {
  if (String(url).endsWith('/healthz-lite')) {
    return jsonResponse({ ok: true, mode: 'http-to-dogzillalib', receivedCount: 0, runtimeSnapshot: false })
  }
  if (String(url).endsWith('/nav2/scan_info')) {
    return jsonResponse({ ok: true, topic: '/scan_nav2', publisherCount: 1, subscriptionCount: 2, available: true })
  }
  return undefined
}

test('first waypoint command failure is recorded in nav2 event log even after retry succeeds', async () => {
  resetNav2Stability()
  const originalBlocker = 'Nav2 NavigateToPose action server unavailable after 2.0s'
  let commandAttempts = 0

  await withMockedFetch(
    async (url, options = {}) => {
      const defaultResponse = defaultBridgeResponse(url)
      if (defaultResponse) {
        return defaultResponse
      }

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
                error: originalBlocker,
              },
            }, { ok: false, status: 503 })
          }
        }
      }

      return jsonResponse({ accepted: true }, { status: 202 })
    },
    async () => {
      const result = await sendRobotCommand(
        waypointGotoPreview(),
        dogzillaDirectRuntime(),
        dogzillaTransportConfig(),
        {
          sleepImpl: async () => {},
          runDogzillaConnectionActionImpl: async (action) => ({ status: 'ok', action }),
        },
      )

      assert.equal(result.status, 'sent')
      assert.equal(result.retriedAfterCommandFailure, true)
      assert.equal(result.firstAttempt.error, originalBlocker)

      const events = getNav2Stability().recentEvents
      const failureEvent = events.find(
        (event) => event.source === 'command-dispatch' && event.nextState === 'blocked' && event.blocker === originalBlocker,
      )
      assert.ok(failureEvent, 'event log records the original command-dispatch blocker')
      assert.equal(failureEvent.repairAction, 'command-retry')
      assert.equal(failureEvent.readinessStep, 'action_server')

      const failureIndex = events.indexOf(failureEvent)
      const retrySuccess = events
        .slice(failureIndex + 1)
        .find((event) => event.source === 'command-dispatch' && event.nextState === 'ready')
      assert.ok(retrySuccess, 'retry success logged after the original blocker')
      assert.equal(retrySuccess.repairAction, 'command-retry')
    },
  )

  resetNav2Stability()
})
