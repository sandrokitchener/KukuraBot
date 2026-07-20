import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getRosbridgeClient,
  getDogzillaLidarDiagnostics,
  getDogzillaLidarHealth,
  getDogzillaLidarScan,
  getDogzillaRobotPose,
} from '../lib/dogzilla-lidar-client.mjs'

function withFakeRosbridge(overrides, callback) {
  const client = getRosbridgeClient()
  const original = {
    connectionState: client.connectionState,
    intentionalClose: client.intentionalClose,
    getHealth: client.getHealth,
    getScan: client.getScan,
    getPose: client.getPose,
    topics: client.topics,
    url: client.url,
  }
  Object.assign(client, {
    connectionState: 'connected',
    intentionalClose: false,
    ...overrides,
  })
  return Promise.resolve()
    .then(callback)
    .finally(() => Object.assign(client, original))
}

test('getDogzillaLidarScan reads the configured rosbridge singleton without opening a Pi socket', async () => {
  await withFakeRosbridge({
    getScan: () => ({
      ok: true,
      status: 'ok',
      rangeCount: 2,
      points: [{ x: 0.5, y: 0.1, range: 0.51, angle: 0.2 }],
    }),
    url: 'ws://127.0.0.1:1',
  }, async () => {
    const result = await getDogzillaLidarScan({
      config: {
        lidar: {
          enabled: true,
        },
      },
      timeoutMs: 500,
    })

    assert.equal(result.ok, true)
    assert.equal(result.status, 'ok')
    assert.equal(result.points.length, 1)
    assert.equal(result.destination, 'ws://127.0.0.1:1')
  })
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
  await withFakeRosbridge({
    getPose: () => ({
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
    }),
    url: 'ws://127.0.0.1:1',
  }, async () => {
    const result = await getDogzillaRobotPose({
      config: {
        lidar: {
          enabled: true,
        },
      },
      timeoutMs: 500,
    })

    assert.equal(result.ok, true)
    assert.equal(result.status, 'ok')
    assert.equal(result.waypointSafe, true)
    assert.equal(result.mapPose.frame, 'map')
    assert.equal(result.destination, 'ws://127.0.0.1:1')
  })
})

test('getDogzillaLidarScan preserves no-scan diagnostics from the bridge', async () => {
  await withFakeRosbridge({
    getScan: () => ({
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
    }),
    url: 'ws://127.0.0.1:1',
  }, async () => {
    const result = await getDogzillaLidarScan({
      config: {
        lidar: {
          enabled: true,
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
  })
})

test('getDogzillaLidarDiagnostics reads singleton diagnostics state', async () => {
  await withFakeRosbridge({
    getHealth: () => ({
      ok: false,
      status: 'no-scan',
      connected: false,
      frames: 0,
      latestScanAgeSec: null,
      error: '/scan is advertised but no frames arrived.',
    }),
    getScan: () => ({ rangeCount: 0, status: 'no-scan' }),
    url: 'ws://127.0.0.1:1',
  }, async () => {
    const result = await getDogzillaLidarDiagnostics({
      config: {
        lidar: {
          enabled: true,
        },
      },
      timeoutMs: 500,
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'no-scan')
    assert.equal(result.connected, false)
    assert.equal(result.frames, 0)
    assert.ok(result.nextChecks.length > 0)
  })
})
