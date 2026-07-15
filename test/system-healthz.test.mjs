import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildHealthzPayload,
  collectHealthzProbes,
} from '../lib/system-healthz.mjs'

test('buildHealthzPayload exposes generation id, per-sensor age, and authority', () => {
  const payload = buildHealthzPayload({
    generationId: 'gen-test-123',
    startedAt: '2026-06-04T12:00:00.000Z',
    checkedAt: '2026-06-04T12:00:10.000Z',
    uptimeSec: 10.25,
    pid: 4242,
    probeResults: {
      dogzillaConfig: {
        camera: {
          processed: true,
          streamUrl: 'http://10.0.4.32:8894/stream.mjpg',
        },
        vision: {
          enabled: true,
          statusUrl: 'http://10.0.4.32:8894/healthz',
        },
        audio: {
          enabled: true,
          healthUrl: 'http://10.0.4.32:8895/healthz',
        },
        lidar: {
          enabled: true,
          transport: 'rosbridge',
          rosbridgeUrl: 'ws://10.0.4.32:9090',
        },
      },
      robotState: {
        status: 'ok',
        activeTarget: {
          id: 'dogzilla-direct',
          kind: 'dogzilla-direct',
        },
        mapOrigin: {
          configured: true,
          status: 'ready',
          origin: {
            label: 'charger_origin',
            savedAt: '2026-06-04T12:00:06.000Z',
          },
          identity: {
            id: 'robodoge_home',
            fingerprint: 'abc123',
          },
          activeMap: {
            id: 'robodoge_home',
            fingerprint: 'abc123',
          },
        },
        activeRobot: {
          timestamp: '2026-06-04T12:00:08.000Z',
          receivedAt: '2026-06-04T12:00:08.500Z',
          telemetry: {
            battery: 82,
            batteryRaw: 82,
            batteryStatus: 'ok',
            batteryReadStatus: 'ok',
            batteryLastKnownAt: '2026-06-04T12:00:05.000Z',
            batteryUnit: 'percent',
            batterySource: 'DOGZILLALib.read_battery',
            batterySafety: {
              status: 'ok',
              motionAllowed: true,
              warningPercent: 20,
              cutoffPercent: 10,
              recoveryPercent: 15,
              cause: 'Battery is above the configured warning threshold.',
            },
            roll: 1,
            pitch: 2,
            yaw: 3,
            waypointSafe: true,
          },
        },
      },
      robotBridge: {
        status: 'ok',
        destination: 'http://10.0.4.32:8893/healthz',
        body: {
          mode: 'http-to-dogzillalib',
          runtime: {
            serialPort: '/dev/ttyAMA0',
          },
        },
      },
      lidarHealth: {
        ok: true,
        status: 'ok',
        latestScanAgeSec: 0.42,
        frames: 18,
        driver: 'oradar',
        topic: '/scan',
        destination: 'ws://10.0.4.32:9090',
      },
      pose: {
        ok: true,
        status: 'ok',
        waypointSafe: true,
        destination: 'ws://10.0.4.32:9090',
        mapPose: {
          frame: 'map',
          childFrame: 'base_footprint',
          source: 'tf:map->base_footprint',
          receivedAt: '2026-06-04T12:00:09.900Z',
          ageSec: 0.1,
        },
      },
      camera: {
        ok: true,
        status: 'ok',
        streamUrl: 'http://10.0.4.32:8894/stream.mjpg',
      },
      vision: {
        ok: true,
        status: 'ok',
        latestFrameAgeSec: 0.5,
        frames: 200,
        inferences: 199,
        detections: 3,
        modelLoaded: true,
      },
      audio: {
        ok: true,
        status: 'ok',
        destination: 'http://10.0.4.32:8895/healthz',
        body: {
          lastCue: 'confirm',
          playCount: 7,
        },
      },
      speech: {
        status: 'disabled',
        destination: '',
      },
      isaac: {
        status: 'ok',
        destination: 'http://127.0.0.1:8891/healthz',
      },
    },
  })

  assert.equal(payload.ok, true)
  assert.equal(payload.status, 'ok')
  assert.equal(payload.generationId, 'gen-test-123')
  assert.equal(payload.startedAt, '2026-06-04T12:00:00.000Z')
  assert.equal(payload.checkedAt, '2026-06-04T12:00:10.000Z')
  assert.equal(payload.pid, 4242)
  assert.equal(payload.authority, 'robo-doge-node-app')
  assert.equal(payload.sensors.robotControl.authority, 'dogzilla-direct /dev/ttyAMA0')
  assert.equal(payload.sensors.robotControl.ageSec, 1.5)
  assert.equal(payload.sensors.battery.authority, 'DOGZILLALib.read_battery')
  assert.equal(payload.sensors.battery.ageSec, 5)
  assert.equal(payload.sensors.battery.motionAllowed, true)
  assert.equal(payload.sensors.battery.cutoffPercent, 10)
  assert.equal(payload.sensors.lidarScan.authority, 'oradar /scan')
  assert.equal(payload.sensors.lidarScan.ageSec, 0.42)
  assert.equal(payload.sensors.mapPose.authority, 'tf:map->base_footprint')
  assert.equal(payload.sensors.mapPose.ageSec, 0.1)
  assert.equal(payload.sensors.mapOrigin.status, 'ready')
  assert.equal(payload.sensors.yoloVision.authority, 'DOGZILLA YOLO vision sidecar')
  assert.equal(payload.sensors.yoloVision.ageSec, 0.5)
  assert.equal(payload.sensors.isaac, undefined)
  assert.equal(payload.sidecars.lidarBridge.destination, 'ws://10.0.4.32:9090')
  assert.equal(payload.sidecars.isaac.status, 'ok')
})

test('buildHealthzPayload keeps Isaac sidecar failure out of real DOGZILLA sensor status', () => {
  const payload = buildHealthzPayload({
    generationId: 'gen-isaac-sidecar-failed',
    checkedAt: '2026-06-04T12:00:10.000Z',
    probeResults: {
      dogzillaConfig: {},
      robotState: {
        status: 'ok',
        activeTarget: {
          id: 'dogzilla-direct',
          kind: 'dogzilla-direct',
        },
        mapOrigin: {
          configured: true,
          status: 'ready',
          identity: {
            id: 'robodoge_home',
            fingerprint: 'abc123',
          },
          activeMap: {
            id: 'robodoge_home',
            fingerprint: 'abc123',
          },
        },
        activeRobot: {
          timestamp: '2026-06-04T12:00:08.000Z',
          receivedAt: '2026-06-04T12:00:08.500Z',
          telemetry: {
            battery: 81,
            batteryStatus: 'ok',
            batteryUnit: 'percent',
            batterySafety: { status: 'ok', motionAllowed: true },
            roll: 0,
          },
        },
      },
      robotBridge: {
        status: 'ok',
        destination: 'http://10.0.4.32:8893/healthz',
      },
      lidarHealth: {
        status: 'disabled',
      },
      pose: {
        status: 'disabled',
      },
      camera: {
        status: 'unconfigured',
      },
      vision: {
        status: 'disabled',
      },
      audio: {
        status: 'disabled',
      },
      speech: {
        status: 'disabled',
      },
      isaac: {
        status: 'error',
        destination: 'http://127.0.0.1:8891/healthz',
        error: 'connect ECONNREFUSED 127.0.0.1:8891',
      },
    },
  })

  assert.equal(payload.ok, true)
  assert.equal(payload.status, 'ok')
  assert.equal(payload.sensors.isaac, undefined)
  assert.deepEqual(payload.failedRequiredSensors, [])
  assert.deepEqual(payload.failedEnabledSensors, [])
  assert.equal(payload.sidecars.isaac.status, 'error')
  assert.equal(payload.sidecars.isaac.error, 'connect ECONNREFUSED 127.0.0.1:8891')
})

test('buildHealthzPayload marks missing required map pose as failed', () => {
  const payload = buildHealthzPayload({
    generationId: 'gen-no-pose',
    checkedAt: '2026-06-04T12:00:10.000Z',
    probeResults: {
      dogzillaConfig: {
        lidar: {
          enabled: true,
          transport: 'rosbridge',
          rosbridgeUrl: 'ws://10.0.4.32:9090',
        },
      },
      lidarHealth: {
        ok: true,
        status: 'ok',
        latestScanAgeSec: 0.2,
      },
      pose: {
        ok: false,
        status: 'no-pose',
        waypointSafe: false,
        error: 'TF lookup odom->base_footprint unavailable.',
        destination: 'ws://10.0.4.32:9090',
      },
    },
  })

  assert.equal(payload.ok, false)
  assert.equal(payload.status, 'error')
  assert.equal(payload.sensors.mapPose.required, true)
  assert.equal(payload.sensors.mapPose.status, 'no-pose')
  assert.match(payload.sensors.mapPose.error, /TF lookup/)
  assert.deepEqual(payload.failedRequiredSensors, ['mapPose'])
})

test('buildHealthzPayload degrades when map origin is missing', () => {
  const payload = buildHealthzPayload({
    generationId: 'gen-stale-origin',
    checkedAt: '2026-06-04T12:00:10.000Z',
    probeResults: {
      robotState: {
        status: 'ok',
        activeTarget: {
          id: 'dogzilla-direct',
          kind: 'dogzilla-direct',
        },
    mapOrigin: {
      configured: false,
      status: 'missing',
      origin: null,
    },
        activeRobot: {
          timestamp: '2026-06-04T12:00:08.000Z',
          receivedAt: '2026-06-04T12:00:08.500Z',
          telemetry: {
            battery: 80,
            batteryStatus: 'ok',
            batteryReadStatus: 'ok',
            batteryUnit: 'percent',
            batterySafety: { status: 'ok', motionAllowed: true },
          },
        },
      },
      robotBridge: {
        status: 'ok',
        destination: 'http://10.0.4.32:8893/healthz',
      },
    },
  })

  assert.equal(payload.ok, true)
  assert.equal(payload.status, 'degraded')
  assert.equal(payload.sensors.mapOrigin.ok, false)
  assert.equal(payload.sensors.mapOrigin.status, 'missing')
  assert.match(payload.sensors.mapOrigin.detail, /No saved/)
  assert.deepEqual(payload.failedRequiredSensors, [])
  assert.ok(payload.failedEnabledSensors.includes('mapOrigin'))
})

test('buildHealthzPayload fails required battery sensor when motion cutoff is active', () => {
  const payload = buildHealthzPayload({
    checkedAt: '2026-06-04T12:00:10.000Z',
    probeResults: {
      robotState: {
        status: 'ok',
        activeTarget: { kind: 'dogzilla-direct' },
        activeRobot: {
          timestamp: '2026-06-04T12:00:09.000Z',
          telemetry: {
            battery: 9,
            batteryStatus: 'ok',
            batteryReadStatus: 'ok',
            batteryUnit: 'percent',
            batterySafety: {
              status: 'cutoff',
              motionAllowed: false,
              warningPercent: 20,
              cutoffPercent: 10,
              recoveryPercent: 15,
              cause: 'Battery 9% is at or below the 10% motion cutoff.',
              recovery: 'Charge until a fresh reading is at least 15%.',
            },
          },
        },
      },
      robotBridge: { status: 'ok' },
    },
  })

  assert.equal(payload.ok, false)
  assert.equal(payload.status, 'error')
  assert.equal(payload.sensors.battery.status, 'cutoff')
  assert.equal(payload.sensors.battery.motionAllowed, false)
  assert.equal(payload.sensors.battery.recoveryPercent, 15)
  assert.deepEqual(payload.failedRequiredSensors, ['battery'])
})

test('collectHealthzProbes reads the configured YOLO vision health endpoint', async () => {
  const calledUrls = []
  const probes = await collectHealthzProbes({
    timeoutMs: 250,
    loadDogzillaConnectionConfigImpl: async () => ({
      vision: {
        enabled: true,
        statusUrl: 'http://dogzilla.local:8894/healthz',
      },
    }),
    buildRobotStateSnapshotImpl: async () => ({ status: 'ok' }),
    getRobotSidecarHealthImpl: async () => ({ status: 'disabled' }),
    getDogzillaLidarHealthImpl: async () => ({ status: 'disabled' }),
    getDogzillaRobotPoseImpl: async () => ({ status: 'disabled' }),
    getDogzillaCameraStatusImpl: async () => ({ status: 'unconfigured' }),
    getDogzillaAudioCueHealthImpl: async () => ({ status: 'disabled' }),
    getSpeechSidecarHealthImpl: async () => ({ status: 'disabled' }),
    getIsaacSidecarHealthImpl: async () => ({ status: 'disabled' }),
    fetchImpl: async (url) => {
      calledUrls.push(url)
      return Response.json({
        ok: true,
        latestFrameAgeSec: 0.25,
        frames: 9,
      })
    },
  })

  assert.deepEqual(calledUrls, ['http://dogzilla.local:8894/healthz'])
  assert.equal(probes.vision.status, 'ok')
  assert.equal(probes.vision.latestFrameAgeSec, 0.25)
  assert.equal(probes.vision.frames, 9)
})

test('collectHealthzProbes gives slow direct bridge health a longer timeout', async () => {
  const probes = await collectHealthzProbes({
    timeoutMs: 10,
    robotBridgeTimeoutMs: 80,
    loadDogzillaConnectionConfigImpl: async () => ({}),
    buildRobotStateSnapshotImpl: async () => ({ status: 'ok' }),
    getRobotSidecarHealthImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
      return { status: 'ok' }
    },
    getDogzillaLidarHealthImpl: async () => ({ status: 'disabled' }),
    getDogzillaRobotPoseImpl: async () => ({ status: 'disabled' }),
    getDogzillaCameraStatusImpl: async () => ({ status: 'unconfigured' }),
    getDogzillaAudioCueHealthImpl: async () => ({ status: 'disabled' }),
    getSpeechSidecarHealthImpl: async () => ({ status: 'disabled' }),
    getIsaacSidecarHealthImpl: async () => ({ status: 'disabled' }),
    fetchImpl: async () => Response.json({ ok: false }),
  })

  assert.equal(probes.robotBridge.status, 'ok')
})
