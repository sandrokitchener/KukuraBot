import test from 'node:test'
import assert from 'node:assert/strict'

import {
  queryOllama,
  renderTemplate,
  renderCommandFormat,
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
    },
    waypointNormalization: 'known waypoint names',
    defaultWaypoint: 'home',
  })

  assert.match(result, /"command": "string"/)
  assert.match(result, /"move" -> Move robot to waypoint\./)
  assert.match(result, /default waypoint to "home"/)
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
  const rendered = renderTemplate('Hello {{ASSISTANT_NAME}}', {
    ASSISTANT_NAME: 'Rover',
  })

  assert.equal(rendered, 'Hello Rover')
})

test('queryOllama returns message content when present', async () => {
  const originalFetch = global.fetch
  let requestBody = null

  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body)

    return new Response(
      JSON.stringify({
        message: {
          content: '{"command":"move","waypoint":"kitchen"}',
        },
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    )
  }

  try {
    const result = await queryOllama({
      input: 'go to kitchen',
      modelConfig: {
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        model: 'test-model',
      },
      systemPrompt: 'system',
    })

    assert.equal(result, '{"command":"move","waypoint":"kitchen"}')
    assert.equal(requestBody.think, false)
  } finally {
    global.fetch = originalFetch
  }
})

test('queryOllama falls back to extracted thinking output when content empty', async () => {
  const originalFetch = global.fetch

  global.fetch = async () =>
    new Response(
      JSON.stringify({
        message: {
          content: '',
          thinking: `Need compact reply.
Let's output something like "{\"command\":\"speak\"}"`,
        },
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    )

  try {
    const result = await queryOllama({
      input: 'say status',
      modelConfig: {
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        model: 'test-model',
      },
      systemPrompt: 'system',
    })

    assert.equal(result, '{"command":"speak"}')
  } finally {
    global.fetch = originalFetch
  }
})
