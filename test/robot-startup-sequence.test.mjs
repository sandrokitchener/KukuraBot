import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildRobotStartupGesturePreview,
  runRobotStartupSequence,
  shouldRunRobotStartupSequence,
} from '../lib/robot-startup-sequence.mjs'

test('shouldRunRobotStartupSequence only enables robot HTTP targets', () => {
  assert.equal(shouldRunRobotStartupSequence({
    enabled: true,
    activeTarget: {
      kind: 'dogzilla-direct',
    },
  }, {}), true)

  assert.equal(shouldRunRobotStartupSequence({
    enabled: true,
    activeTarget: {
      kind: 'isaacsim',
    },
  }, {}), false)

  assert.equal(shouldRunRobotStartupSequence({
    enabled: true,
    activeTarget: {
      kind: 'dogzilla-direct',
    },
  }, {
    ROBOT_STARTUP_SEQUENCE: '0',
  }), false)
})

test('buildRobotStartupGesturePreview maps startup shake to handshake action', () => {
  const preview = buildRobotStartupGesturePreview({
    trick: 'shake',
    runtimeConfig: runtimeConfig(),
    ros2Config: ros2Config(),
    waypointConfig: emptyWaypointConfig(),
    actionConfig: handshakeActionConfig(),
    motionConfig: emptyMotionConfig(),
  })

  assert.equal(preview.status, 'ready')
  assert.equal(preview.action, 'dogzilla.perform_action')
  assert.equal(preview.canonicalPlan.kind, 'action.once')
  assert.equal(preview.canonicalPlan.params.trick, 'shake')
  assert.equal(preview.canonicalPlan.params.actionId, 19)
})

test('runRobotStartupSequence barks then dispatches handshake gesture', async () => {
  const calls = []
  const result = await runRobotStartupSequence({
    runtimeConfig: runtimeConfig(),
    ros2Config: ros2Config(),
    waypointConfig: emptyWaypointConfig(),
    actionConfig: handshakeActionConfig(),
    motionConfig: emptyMotionConfig(),
    env: {
      ROBOT_STARTUP_GESTURE_DELAY_MS: '0',
    },
    logger: quietLogger(),
    requiredServicesReady: Promise.resolve({ status: 'ok' }),
    probeRobotSidecarHealthImpl: async () => ({
      status: 'ok',
      body: {
        runtime: {
          dryRun: false,
        },
      },
    }),
    runDogzillaConnectionActionImpl: async () => {
      throw new Error('live bridge should already be ready')
    },
    sendDogzillaAudioCueImpl: async (cue) => {
      calls.push(['audio', cue])
      return {
        status: 'ok',
        ok: true,
        cue,
      }
    },
    sendRobotCommandImpl: async (preview, sentRuntimeConfig, sentRos2Config) => {
      calls.push(['gesture', preview.canonicalPlan])
      assert.equal(sentRuntimeConfig.activeTarget.kind, 'dogzilla-direct')
      assert.equal(sentRos2Config.transport.baseUrl, 'http://127.0.0.1:8893')
      return {
        status: 'sent',
      }
    },
    sleepImpl: async () => {
      calls.push(['sleep'])
    },
  })

  assert.equal(result.status, 'ok')
  assert.deepEqual(calls, [
    ['audio', 'bark'],
    ['gesture', {
      kind: 'action.once',
      params: {
        trick: 'handshake',
        actionId: 19,
        verified: true,
      },
    }],
  ])
})

test('runRobotStartupSequence restarts dry-run direct bridge live before gesture', async () => {
  const calls = []
  const healthSequence = [
    {
      status: 'ok',
      body: {
        runtime: {
          dryRun: true,
        },
      },
    },
    {
      status: 'ok',
      body: {
        runtime: {
          dryRun: false,
        },
      },
    },
  ]
  const result = await runRobotStartupSequence({
    runtimeConfig: {
      ...runtimeConfig(),
      dryRun: true,
    },
    ros2Config: {
      ...ros2Config(),
      transport: {
        ...ros2Config().transport,
        dryRun: true,
      },
    },
    waypointConfig: emptyWaypointConfig(),
    actionConfig: handshakeActionConfig(),
    motionConfig: emptyMotionConfig(),
    env: {
      ROBOT_STARTUP_GESTURE_DELAY_MS: '0',
    },
    logger: quietLogger(),
    sendDogzillaAudioCueImpl: async (cue) => {
      calls.push(['audio', cue])
      return {
        status: 'ok',
        ok: true,
        cue,
      }
    },
    probeRobotSidecarHealthImpl: async () => healthSequence.shift() || healthSequence.at(-1),
    runDogzillaConnectionActionImpl: async (action, options) => {
      calls.push(['bridge', action, options])
      return {
        status: 'ok',
      }
    },
    sendRobotCommandImpl: async (_preview, sentRuntimeConfig, sentRos2Config) => {
      calls.push(['gesture', sentRuntimeConfig.dryRun, sentRos2Config.transport.dryRun])
      return {
        status: 'sent',
      }
    },
    sleepImpl: async () => {},
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.liveStartup, true)
  assert.equal(result.liveBridge.status, 'ok')
  assert.deepEqual(calls, [
    ['bridge', 'start-direct', { live: true }],
    ['audio', 'bark'],
    ['gesture', false, false],
  ])
})

test('runRobotStartupSequence skips redundant bridge probe when existingDirectBridgeHealth is live', async () => {
  let probeCalls = 0
  let actionCalls = 0
  const result = await runRobotStartupSequence({
    runtimeConfig: runtimeConfig(),
    ros2Config: ros2Config(),
    waypointConfig: emptyWaypointConfig(),
    actionConfig: handshakeActionConfig(),
    motionConfig: emptyMotionConfig(),
    env: {
      ROBOT_STARTUP_GESTURE_DELAY_MS: '0',
    },
    logger: quietLogger(),
    existingDirectBridgeHealth: {
      status: 'ok',
      body: {
        runtime: {
          dryRun: false,
        },
      },
    },
    sendDogzillaAudioCueImpl: async () => ({ status: 'ok', ok: true, cue: 'bark' }),
    probeRobotSidecarHealthImpl: async () => {
      probeCalls += 1
      return { status: 'ok', body: { runtime: { dryRun: false } } }
    },
    runDogzillaConnectionActionImpl: async () => {
      actionCalls += 1
      return { status: 'ok' }
    },
    sendRobotCommandImpl: async () => ({ status: 'sent' }),
    sleepImpl: async () => {},
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.liveBridge.status, 'ok')
  assert.equal(result.liveBridge.probeReused, true)
  assert.equal(probeCalls, 0)
  assert.equal(actionCalls, 0)
})

test('runRobotStartupSequence retries transient live bridge restart failures', async () => {
  const calls = []
  const healthSequence = [
    {
      status: 'ok',
      body: {
        runtime: {
          dryRun: true,
        },
      },
    },
    {
      status: 'error',
    },
    {
      status: 'ok',
      body: {
        runtime: {
          dryRun: false,
        },
      },
    },
  ]
  let startAttempts = 0
  const result = await runRobotStartupSequence({
    runtimeConfig: {
      ...runtimeConfig(),
      dryRun: true,
    },
    ros2Config: {
      ...ros2Config(),
      transport: {
        ...ros2Config().transport,
        dryRun: true,
      },
    },
    waypointConfig: emptyWaypointConfig(),
    actionConfig: handshakeActionConfig(),
    motionConfig: emptyMotionConfig(),
    env: {
      ROBOT_STARTUP_GESTURE_DELAY_MS: '0',
    },
    logger: quietLogger(),
    sendDogzillaAudioCueImpl: async (cue) => {
      calls.push(['audio', cue])
      return {
        status: 'ok',
        ok: true,
        cue,
      }
    },
    probeRobotSidecarHealthImpl: async () => healthSequence.shift() || healthSequence.at(-1),
    runDogzillaConnectionActionImpl: async (action, options) => {
      startAttempts += 1
      calls.push(['bridge', action, options, startAttempts])
      return startAttempts === 1
        ? {
          status: 'error',
          error: 'transient ssh failure',
        }
        : {
          status: 'ok',
        }
    },
    sendRobotCommandImpl: async () => {
      calls.push(['gesture'])
      return {
        status: 'sent',
      }
    },
    sleepImpl: async () => {},
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.liveBridge.status, 'ok')
  assert.deepEqual(calls, [
    ['bridge', 'start-direct', { live: true }, 1],
    ['bridge', 'start-direct', { live: true }, 2],
    ['audio', 'bark'],
    ['gesture'],
  ])
})

function runtimeConfig() {
  return {
    enabled: true,
    dryRun: false,
    robotId: 'dogzilla-local',
    robotName: 'Questing Beast',
    robotModel: 'dogzilla-s2',
    selectedMotionProfile: 'default',
    activeTarget: {
      id: 'dogzilla_direct',
      kind: 'dogzilla-direct',
      label: 'DOGZILLA Direct Bridge',
    },
  }
}

function ros2Config() {
  return {
    bridge: {
      commandPlanTopic: '/dogzilla/command_plan',
    },
    topics: {
      state: '/dogzilla/state',
    },
    transport: {
      kind: 'http',
      enabled: true,
      dryRun: false,
      dispatchOnChat: true,
      baseUrl: 'http://127.0.0.1:8893',
      commandsPath: '/commands',
    },
    feedback: {},
  }
}

function emptyWaypointConfig() {
  return {
    activeSet: 'home',
    sets: {
      home: {
        waypoints: {},
      },
    },
  }
}

function handshakeActionConfig() {
  return {
    activeMap: 'default',
    maps: {
      default: {
        tricks: {
          shake: {
            actionId: 19,
            verified: true,
          },
          handshake: {
            actionId: 19,
            verified: true,
          },
        },
      },
    },
  }
}

function emptyMotionConfig() {
  return {
    activeProfile: 'default',
    profiles: {
      default: {},
    },
  }
}

function quietLogger() {
  return {
    log() {},
    warn() {},
  }
}
