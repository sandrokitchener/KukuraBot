import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'

import {
  getDogzillaAudioCueHealth,
  sendDogzillaAudioCue,
} from '../lib/dogzilla-audio-cue-client.mjs'
import { withMockedFetch } from '../test-support/http-fixtures.mjs'

test('sendDogzillaAudioCue posts cue requests to the configured Pi bridge', async () => {
  let requestBody = null
  const server = createServer(async (request, response) => {
    requestBody = await readJsonBody(request)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      ok: true,
      cue: requestBody.cue,
      file: 'public/sounds/robot-bark-normal-103.wav',
    }))
  })

  await listen(server)

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const result = await sendDogzillaAudioCue('confirm', {
      config: {
        audio: {
          enabled: true,
          cueUrl: `${baseUrl}/cue`,
        },
      },
      timeoutMs: 500,
    })

    assert.equal(result.ok, true)
    assert.equal(result.status, 'ok')
    assert.equal(result.cue, 'confirm')
    assert.deepEqual(requestBody, { cue: 'confirm' })
  } finally {
    await close(server)
  }
})

test('sendDogzillaAudioCue forwards normalized cue volume', async () => {
  let requestBody = null
  const result = await sendDogzillaAudioCue('bark', {
    config: {
      audio: {
        enabled: true,
        cueUrl: 'http://10.0.4.32:8895/cue',
      },
    },
    volume: 35,
    fetchImpl: async (url, options) => {
      requestBody = JSON.parse(options.body)
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            cue: 'bark',
            volume: requestBody.volume,
          }
        },
      }
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.status, 'ok')
  assert.equal(result.cue, 'bark')
  assert.equal(result.volume, 0.35)
  assert.deepEqual(requestBody, { cue: 'bark', volume: 0.35 })
})

test('getDogzillaAudioCueHealth reports disabled config loudly', async () => {
  const result = await getDogzillaAudioCueHealth({
    config: {
      audio: {
        enabled: false,
      },
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'disabled')
  assert.match(result.detail, /not configured/)
})

test('getDogzillaAudioCueHealth reports fetch failure connection details', async () => {
  await withMockedFetch(
    async () => {
      throw new TypeError('fetch failed', {
        cause: {
          code: 'ECONNREFUSED',
          address: '10.0.4.32',
          port: 8895,
        },
      })
    },
    async () => {
      const result = await getDogzillaAudioCueHealth({
        config: {
          audio: {
            enabled: true,
            healthUrl: 'http://10.0.4.32:8895/healthz',
          },
        },
      })

      assert.equal(result.ok, false)
      assert.equal(result.status, 'error')
      assert.equal(result.error, 'fetch failed (ECONNREFUSED 10.0.4.32:8895)')
    },
  )
})

async function readJsonBody(request) {
  const chunks = []
  for await (const chunk of request) {
    chunks.push(chunk)
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
}

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
}

async function close(server) {
  server.close()
  await once(server, 'close')
}
