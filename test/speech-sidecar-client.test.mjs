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
        baseUrl: 'http://127.0.0.1:8893',
        healthPath: '/healthz',
        timeoutMs: 1000,
      },
    },
    {
      fetchImpl: async (url) => {
        calledUrl = url
        return new Response(JSON.stringify({ ok: true, modelId: 'nvidia/parakeet-tdt-0.6b-v3' }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        })
      },
    },
  )

  assert.equal(calledUrl, 'http://127.0.0.1:8893/healthz')
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.body, { ok: true, modelId: 'nvidia/parakeet-tdt-0.6b-v3' })
})

test('probeSpeechSidecarHealth rejects healthy responses from the wrong sidecar', async () => {
  const result = await probeSpeechSidecarHealth(
    {
      transport: {
        enabled: true,
        kind: 'http',
        baseUrl: 'http://127.0.0.1:8893',
        healthPath: '/healthz',
        timeoutMs: 1000,
      },
    },
    {
      fetchImpl: async () => new Response(JSON.stringify({ ok: true, bridge: 'ros2' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    },
  )

  assert.equal(result.status, 'error')
  assert.equal(result.destination, 'http://127.0.0.1:8893/healthz')
  assert.match(result.error, /Parakeet bridge/)
})

test('probeSpeechSidecarHealth reports unavailable sidecar as health error', async () => {
  const result = await probeSpeechSidecarHealth(
    {
      transport: {
        enabled: true,
        kind: 'http',
        baseUrl: 'http://127.0.0.1:8893',
        healthPath: '/healthz',
        timeoutMs: 1000,
      },
    },
    {
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8893')
      },
    },
  )

  assert.equal(result.attempted, true)
  assert.equal(result.status, 'error')
  assert.equal(result.destination, 'http://127.0.0.1:8893/healthz')
  assert.match(result.error, /ECONNREFUSED/)
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
        baseUrl: 'http://127.0.0.1:8893',
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

  assert.equal(calls[0].url, 'http://127.0.0.1:8893/transcribe')
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.body, { text: 'go home' })
})
