import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'

import {
  getDogzillaLidarHealth,
  getDogzillaLidarScan,
} from '../lib/dogzilla-lidar-client.mjs'

test('getDogzillaLidarScan proxies point payloads from the configured bridge', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      ok: true,
      status: 'ok',
      rangeCount: 2,
      points: [{ x: 0.5, y: 0.1, range: 0.51, angle: 0.2 }],
    }))
  })

  await listen(server)

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const result = await getDogzillaLidarScan({
      config: {
        lidar: {
          enabled: true,
          scanUrl: `${baseUrl}/scan`,
        },
      },
      timeoutMs: 500,
    })

    assert.equal(result.ok, true)
    assert.equal(result.status, 'ok')
    assert.equal(result.points.length, 1)
    assert.equal(result.destination, `${baseUrl}/scan`)
  } finally {
    await close(server)
  }
})

test('getDogzillaLidarHealth reports disabled config loudly', async () => {
  const result = await getDogzillaLidarHealth({
    config: {
      lidar: {
        enabled: false,
      },
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'disabled')
  assert.match(result.detail, /not configured/)
})

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
}

async function close(server) {
  server.close()
  await once(server, 'close')
}
