import test from 'node:test'
import assert from 'node:assert/strict'

import { queryModel } from '../lib/model-client.mjs'

test('queryModel sends ollama payload with think disabled', async () => {
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
    const result = await queryModel({
      input: 'go to kitchen',
      profile: {
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'test-model',
        think: false,
        temperature: 0.15,
        maxTokens: 120,
      },
      systemPrompt: 'system',
    })

    assert.equal(result, '{"command":"move","waypoint":"kitchen"}')
    assert.equal(requestBody.think, false)
    assert.equal(requestBody.options.num_predict, 120)
  } finally {
    global.fetch = originalFetch
  }
})

test('queryModel supports openai-compatible responses', async () => {
  const originalFetch = global.fetch

  global.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: 'hello from gguf',
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    )

  try {
    const result = await queryModel({
      input: 'hello',
      profile: {
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'llama-gguf',
        temperature: 0.1,
        maxTokens: 64,
        apiKeyEnv: '',
      },
      systemPrompt: 'system',
    })

    assert.equal(result, 'hello from gguf')
  } finally {
    global.fetch = originalFetch
  }
})
