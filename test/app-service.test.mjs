import test from 'node:test'
import assert from 'node:assert/strict'

import {
  composeSystemPrompt,
  loadPublicConfig,
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
  assert.equal(config.consoleTitle, 'Rover Console')
  assert.equal(config.sendButtonLabel, 'Ask Rover')
  assert.equal(config.thinkingStatus, 'Rover is thinking...')
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
  const payload = await loadPublicConfig()

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
  })

  assert.equal(result.parsed.command, 'move')
  assert.equal(result.isaacDispatch.status, 'sent')
  assert.deepEqual(dispatchedPreview, result.isaacSim)
})
