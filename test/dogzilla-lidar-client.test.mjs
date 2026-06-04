import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'

import {
  getDogzillaLidarDiagnostics,
  getDogzillaLidarHealth,
  getDogzillaLidarScan,
  getDogzillaRobotPose,
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

test('getDogzillaRobotPose exposes map pose from configured bridge', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, '/pose')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      ok: true,
      status: 'ok',
      waypointSafe: true,
      mapPose: {
        x: 0.25,
        y: -0.5,
        theta: 1.57,
        frame: 'map',
        source: 'tf:map->base_link',
      },
    }))
  })

  await listen(server)

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const result = await getDogzillaRobotPose({
      config: {
        lidar: {
          enabled: true,
          poseUrl: `${baseUrl}/pose`,
        },
      },
      timeoutMs: 500,
    })

    assert.equal(result.ok, true)
    assert.equal(result.status, 'ok')
    assert.equal(result.waypointSafe, true)
    assert.equal(result.mapPose.frame, 'map')
    assert.equal(result.destination, `${baseUrl}/pose`)
  } finally {
    await close(server)
  }
})

test('getDogzillaLidarScan preserves no-scan diagnostics from the bridge', async () => {
  const server = createServer((request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      ok: false,
      status: 'no-scan',
      error: '/scan is advertised but no frames arrived.',
      frames: 0,
      serialPort: '/dev/ttyAMA1',
      serialDiagnostics: {
        path: '/dev/ttyAMA1',
        exists: true,
        realPath: '/dev/ttyAMA1',
        readable: true,
        writable: true,
      },
      rosGraph: {
        publisherCount: 1,
      },
      points: [],
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

    assert.equal(result.ok, false)
    assert.equal(result.status, 'no-scan')
    assert.equal(result.frames, 0)
    assert.equal(result.serialDiagnostics.exists, true)
    assert.equal(result.rosGraph.publisherCount, 1)
    assert.match(result.error, /no frames/i)
  } finally {
    await close(server)
  }
})

test('getDogzillaLidarDiagnostics reads explicit diagnostics endpoint', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, '/diagnostics')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      ok: false,
      status: 'no-scan',
      driver: 'oradar',
      serialDiagnostics: {
        path: '/dev/ttyAMA1',
        exists: true,
      },
      rosGraph: {
        publisherCount: 1,
      },
      nextChecks: [
        '/scan is advertised but no frames arrived.',
      ],
    }))
  })

  await listen(server)

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const result = await getDogzillaLidarDiagnostics({
      config: {
        lidar: {
          enabled: true,
          diagnosticsUrl: `${baseUrl}/diagnostics`,
        },
      },
      timeoutMs: 500,
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'no-scan')
    assert.equal(result.driver, 'oradar')
    assert.equal(result.serialDiagnostics.exists, true)
    assert.equal(result.rosGraph.publisherCount, 1)
    assert.match(result.nextChecks[0], /no frames/i)
  } finally {
    await close(server)
  }
})

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
}

async function close(server) {
  server.close()
  await once(server, 'close')
}
