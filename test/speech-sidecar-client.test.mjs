import test from 'node:test'
import assert from 'node:assert/strict'

import {
  probeSpeechSidecarHealth,
  sendSpeechTranscriptionRequest,
} from '../lib/speech-sidecar-client.mjs'

test('probeSpeechSidecarHealth calls configured health endpoint', async () => {
  let calledUrl = ''
  const result = await probeSpeechSidecarHealth(
    {
      transport: {
        enabled: true,
        kind: 'http',
        baseUrl: 'http://127.0.0.1:8892',
        healthPath: '/healthz',
        timeoutMs: 1000,
      },
    },
    {
      fetchImpl: async (url) => {
        calledUrl = url
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        })
      },
    },
  )

  assert.equal(calledUrl, 'http://127.0.0.1:8892/healthz')
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.body, { ok: true })
})

test('sendSpeechTranscriptionRequest posts audio payload to configured endpoint', async () => {
  const calls = []
  const result = await sendSpeechTranscriptionRequest(
    {
      audioBase64: 'Zm9v',
      sampleRate: 16000,
      modelId: 'nvidia/parakeet-tdt-0.6b-v3',
    },
    {
      transport: {
        enabled: true,
        kind: 'http',
        baseUrl: 'http://127.0.0.1:8892',
        transcribePath: '/transcribe',
        timeoutMs: 1000,
      },
    },
    {
      fetchImpl: async (url, options) => {
        calls.push({ url, options })
        return new Response(JSON.stringify({ text: 'go home' }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        })
      },
    },
  )

  assert.equal(calls[0].url, 'http://127.0.0.1:8892/transcribe')
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.body, { text: 'go home' })
})
