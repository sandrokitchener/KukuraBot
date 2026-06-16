import test from 'node:test'
import assert from 'node:assert/strict'

import {
  composeSystemPrompt,
  loadPublicConfig,
  processModelResult,
  processUserInput,
  renderCommandTypes,
  renderTemplate,
  renderCommandFormat,
  shouldAutoDispatchIsaacSim,
  tryParseJson,
} from '../lib/app-service.mjs'
import { normalizeAppConfig } from '../lib/app-config.mjs'

test('renderCommandFormat renders fields and rules', () => {
  const result = renderCommandFormat({
    fields: [
      { name: 'command', type: '"string"' },
      { name: 'waypoint', type: '"string"' },
    ],
    allowedCommands: {
      move: 'Move robot to waypoint.',
      speak: 'Speak short status.',
      trick: 'Perform a trick.',
    },
    conditionalFields: {
      detect: [{ name: 'object_to_detect', type: 'string' }],
      trick: [{ name: 'trick', type: 'string' }],
    },
    conditionalDefaults: {
      trick: {
        waypoint: 'current_position',
        trick: 'random',
      },
    },
    conditionalNotes: {
      trick: [
        'If the user names a specific trick, set "trick" to that normalized trick name.',
        'If the user asks for a trick without naming one, set "trick" to "random".',
      ],
    },
    examples: [
      {
        input: 'do a backflip',
        output: {
          command: 'trick',
          waypoint: 'current_position',
          trick: 'backflip',
        },
      },
    ],
    waypointNormalization: 'known waypoint names',
    defaultWaypoint: 'home',
  })

  assert.match(result, /"command": "string"/)
  assert.match(result, /"move" -> Move robot to waypoint\./)
  assert.match(result, /default waypoint to "home"/)
  assert.match(result, /If "command" is "detect", also include:/)
  assert.match(result, /"object_to_detect": string/)
  assert.match(result, /"trick" -> Perform a trick\./)
  assert.match(result, /If "command" is "trick", also include:/)
  assert.match(result, /"trick": string/)
  assert.match(result, /If "command" is "trick" and no better value is provided, default to:/)
  assert.match(result, /"waypoint": "current_position"/)
  assert.match(result, /"trick": "random"/)
  assert.match(result, /If "command" is "trick": If the user names a specific trick/)
  assert.match(result, /Always include every base field/)
  assert.match(result, /User: "do a backflip"/)
  assert.match(result, /Output: \{"command":"trick","waypoint":"current_position","trick":"backflip"\}/)
})

test('tryParseJson returns null on invalid JSON', () => {
  assert.equal(tryParseJson('not json'), null)
  assert.deepEqual(tryParseJson('{"ok":true}'), { ok: true })
})

test('normalizeAppConfig derives brand strings from assistantName', () => {
  const config = normalizeAppConfig({ assistantName: 'Rover' })

  assert.equal(config.assistantName, 'Rover')
  assert.equal(config.appName, 'Rover')
  assert.equal(config.consoleTitle, 'Rover Console')
  assert.equal(config.sendButtonLabel, 'Ask Rover')
  assert.equal(config.thinkingStatus, 'Rover is thinking...')
})

test('normalizeAppConfig accepts app-level brand overrides', () => {
  const config = normalizeAppConfig({
    assistantName: 'Dog',
    appName: 'Questing Beast',
    pageTitle: 'Questing Beast',
    consoleTitle: 'Questing Beast',
  })

  assert.equal(config.assistantName, 'Dog')
  assert.equal(config.appName, 'Questing Beast')
  assert.equal(config.pageTitle, 'Questing Beast')
  assert.equal(config.consoleTitle, 'Questing Beast')
  assert.equal(config.sendButtonLabel, 'Ask Dog')
  assert.equal(config.introDescription, '')
})

test('renderTemplate replaces assistant placeholders', () => {
  const rendered = renderTemplate('Hello {{ASSISTANT_NAME}} {{COMMAND_TYPES}}', {
    ASSISTANT_NAME: 'Rover',
    COMMAND_TYPES: 'tricks',
  })

  assert.equal(rendered, 'Hello Rover tricks')
})

test('renderCommandTypes resolves valid waypoint placeholders', () => {
  const rendered = renderCommandTypes(
    'Pick from {{VALID_WAYPOINTS}}',
    '- kitchen\n- garage',
  )

  assert.equal(rendered, 'Pick from - kitchen\n- garage')
})

test('composeSystemPrompt keeps command contract config-driven', async () => {
  const { systemPrompt } = await composeSystemPrompt()

  assert.equal((systemPrompt.match(/Conditional rules:/g) ?? []).length, 1)
  assert.equal((systemPrompt.match(/"object_to_detect": string/g) ?? []).length, 1)
  assert.equal((systemPrompt.match(/"trick": string/g) ?? []).length, 1)
  assert.doesNotMatch(systemPrompt, /- Base format:/)
  assert.doesNotMatch(systemPrompt, /User: come here/)
})

test('loadPublicConfig exposes active speech profile metadata', async () => {
  const previousSpeechProfile = process.env.APP_SPEECH_PROFILE
  process.env.APP_SPEECH_PROFILE = 'local_whisper_base_en'

  let payload
  try {
    payload = await loadPublicConfig()
  } finally {
    if (previousSpeechProfile == null) {
      delete process.env.APP_SPEECH_PROFILE
    } else {
      process.env.APP_SPEECH_PROFILE = previousSpeechProfile
    }
  }

  assert.equal(payload.speech.activeProfile.provider, 'whisper-browser')
  assert.equal(payload.speech.activeProfile.modelId, 'Xenova/whisper-base.en')
  assert.equal(payload.speech.activeProfile.device, 'webgpu')
  assert.equal(payload.speech.activeProfile.silenceDurationMs, 500)
  assert.equal(payload.speech.profileFile, 'config/speech-profiles.json')
  assert.equal(payload.speech.runtimeFile, 'config/speech-runtime.json')
  assert.equal(payload.speech.sidecarConfigFile, 'config/speech-sidecar.json')
  assert.equal(payload.speech.activationPhrasesFile, 'config/activation_phrases.txt')
  assert.ok(Array.isArray(payload.speech.activationPhrases))
  assert.ok(payload.speech.activationPhrases.length > 0)
  assert.equal(payload.robotRuntime.robotName, 'Questing Beast')
  assert.equal(payload.robotRuntime.robot_name, 'Questing Beast')
  assert.equal(payload.robotRuntime.waypointSet, 'home')
  assert.equal(typeof payload.robotRuntime.mapOrigin.configured, 'boolean')
  const kitchenWaypoint = payload.robotRuntime.waypoints.find((waypoint) => waypoint.id === 'kitchen')
  assert.ok(kitchenWaypoint)
  assert.equal(kitchenWaypoint.sourceVerified, true)
  assert.equal(kitchenWaypoint.verified, true)
  assert.equal(kitchenWaypoint.enabled, true)
  assert.equal(kitchenWaypoint.navigable, true)
  assert.doesNotMatch(kitchenWaypoint.verificationProblem, /captured-pose note|notes still|dummy|stored pose does not match/i)
  assert.match(payload.robotRuntime.mapOrigin.status, /ready|stale-missing-map-identity|missing/)
  assert.equal(kitchenWaypoint.frame, 'app_map')
  assert.equal(kitchenWaypoint.capturedMapPose?.frame, 'map')
  if (payload.robotRuntime.mapOrigin.configured) {
    assert.equal(kitchenWaypoint.appMapPose?.frame, 'app_map')
    assert.equal(kitchenWaypoint.appMapPose?.sourceFrame, 'map')
    assert.equal(kitchenWaypoint.appMapPose?.storedFrame, 'app_map')
    assert.equal(payload.robotRuntime.mapOrigin.origin.label, 'charger_origin')
  }
  const garageWaypoint = payload.robotRuntime.waypoints.find((waypoint) => waypoint.id === 'garage')
  if (garageWaypoint?.frame === 'app_map') {
    assert.equal(garageWaypoint.capturedMapPose?.frame, 'map')
  }
  assert.equal(payload.app.appName, 'Questing Beast')
})

test('shouldAutoDispatchIsaacSim only enables dispatch when chat dispatch is configured', () => {
  assert.equal(shouldAutoDispatchIsaacSim(null), false)
  assert.equal(shouldAutoDispatchIsaacSim({ dispatchPlan: { dispatchOnChat: false } }), false)
  assert.equal(shouldAutoDispatchIsaacSim({ dispatchPlan: { dispatchOnChat: true } }), true)
})

test('processUserInput dispatches Isaac command when preview opts into chat dispatch', async () => {
  let dispatchedPreview = null
  const result = await processUserInput('go to the garage', {
    queryModelImpl: async () => '{"command":"move","waypoint":"garage"}',
    buildIsaacSimPreviewImpl: async () => ({
      status: 'ready',
      action: 'robot_controller.goto_waypoint',
      dispatchPlan: {
        dispatchOnChat: true,
      },
    }),
    dispatchIsaacSimCommandImpl: async (preview) => {
      dispatchedPreview = preview
      return {
        status: 'sent',
      }
    },
    loadRobotRuntimeConfigImpl: async () => ({
      activeTarget: {
        id: 'isaacsim',
        kind: 'isaacsim',
        label: 'Isaac Sim',
      },
    }),
  })

  assert.equal(result.parsed.command, 'move')
  assert.equal(result.isaacDispatch.status, 'sent')
  assert.deepEqual(dispatchedPreview, result.isaacSim)
})

test('processUserInput dispatches ROS2 command when ROS2 target is active', async () => {
  let dispatchedPreview = null
  const result = await processUserInput('go to the living room', {
    queryModelImpl: async () => '{"command":"move","waypoint":"living_room"}',
    buildIsaacSimPreviewImpl: async () => ({
      status: 'ready',
      dispatchPlan: {
        dispatchOnChat: true,
      },
    }),
    buildRobotRuntimePreviewImpl: async () => ({
      status: 'ready',
      canonicalPlan: {
        kind: 'locomotion.goto',
      },
      dispatchPlan: {
        dispatchOnChat: true,
      },
    }),
    dispatchRobotCommandImpl: async (preview) => {
      dispatchedPreview = preview
      return {
        status: 'sent',
      }
    },
    loadRobotRuntimeConfigImpl: async () => ({
      activeTarget: {
        id: 'ros2_real',
        kind: 'ros2-bridge',
        label: 'ROS2 Real Robot',
      },
    }),
  })

  assert.equal(result.robotDispatch.status, 'sent')
  assert.deepEqual(dispatchedPreview, result.robotRuntime)
  assert.equal(result.isaacDispatch, null)
})

test('processModelResult parses local model output and dispatches active ROS2 target', async () => {
  let dispatchedPreview = null
  const result = await processModelResult({
    input: 'go to the kitchen',
    rawResponse: '{"command":"move","waypoint":"kitchen"}',
    activeProfileConfig: {
      activeProfileId: 'android_llama_cpp',
      source: 'runtime',
      activeProfile: {
        label: 'Android llama.cpp',
        provider: 'llama-cpp-http',
        model: 'robo-doge-local-gguf',
      },
    },
    robotRuntimeConfig: {
      activeTarget: {
        id: 'ros2_real',
        kind: 'ros2-bridge',
        label: 'ROS2 Real Robot',
      },
    },
    options: {
      buildIsaacSimPreviewImpl: async () => ({
        status: 'ready',
        dispatchPlan: {
          dispatchOnChat: true,
        },
      }),
      buildRobotRuntimePreviewImpl: async () => ({
        status: 'ready',
        canonicalPlan: {
          kind: 'locomotion.goto',
        },
        dispatchPlan: {
          dispatchOnChat: true,
        },
      }),
      dispatchRobotCommandImpl: async (preview) => {
        dispatchedPreview = preview
        return {
          status: 'sent',
        }
      },
    },
  })

  assert.equal(result.provider, 'llama-cpp-http')
  assert.equal(result.parsed.waypoint, 'kitchen')
  assert.equal(result.robotDispatch.status, 'sent')
  assert.deepEqual(dispatchedPreview, result.robotRuntime)
  assert.equal(result.isaacDispatch, null)
})
