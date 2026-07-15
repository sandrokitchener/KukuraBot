import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPreflightChecks,
  summarizeDogzillaPreflight,
} from '../lib/dogzilla-preflight.mjs'

test('summarizeDogzillaPreflight counts states and critical failures', () => {
  const summary = summarizeDogzillaPreflight([
    { status: 'ok' },
    { status: 'warn' },
    { status: 'fail', critical: true },
    { status: 'info' },
  ])

  assert.deepEqual(summary, {
    ok: 1,
    warn: 1,
    fail: 1,
    info: 1,
    total: 4,
    criticalFailures: 1,
  })
})

test('buildPreflightChecks warns loudly when configured YOLO and Pi speaker cues are down', () => {
  const checks = buildPreflightChecks({
    connectionConfig: {
      ssh: {
        host: '10.0.4.32',
        keyPath: 'C:\\Users\\sandr\\.ssh\\robodoge_pi_ed25519',
      },
      bridges: {
        direct: { baseUrl: 'http://10.0.4.32:8893' },
        ros2: { baseUrl: 'http://10.0.4.32:8892' },
      },
      camera: { baseUrl: 'http://10.0.4.32:6500' },
      vision: { enabled: true },
      audio: { enabled: true },
    },
    runtimeConfig: { dryRun: true },
    ros2Config: { transport: { dryRun: true } },
    diagnostics: {
      local: {
        keyExists: true,
        sshTcp: { status: 'ok' },
        directHealth: { status: 'ok', body: { ok: true } },
        directState: { status: 'error', error: 'timeout' },
        ros2Health: { status: 'error' },
        cameraTcp: { status: 'ok' },
        visionHealth: { status: 'error', error: 'ECONNREFUSED' },
        audioHealth: { status: 'error', error: 'ECONNREFUSED' },
      },
      remote: {
        status: 'ok',
        parsed: {
          identity: { hostname: 'raspberrypi' },
          devices: {},
          docker: { images: [] },
          commands: {},
          paths: {},
          processes: [],
          listening: [],
        },
      },
    },
  })

  assert.equal(checks.find((check) => check.id === 'vision-yolo')?.status, 'warn')
  assert.equal(checks.find((check) => check.id === 'vision-process')?.status, 'warn')
  assert.equal(checks.find((check) => check.id === 'audio-cues')?.status, 'warn')
  assert.equal(checks.find((check) => check.id === 'audio-process')?.status, 'warn')
})

test('buildPreflightChecks treats direct YOLO camera device as the source', () => {
  const cameraSource = '/dev/v4l/by-id/usb-Sonix_Technology_Co.__Ltd._USB_2.0_Camera-video-index0'
  const checks = buildPreflightChecks({
    connectionConfig: {
      ssh: {
        host: '10.0.4.32',
        keyPath: 'C:\\Users\\sandr\\.ssh\\robodoge_pi_ed25519',
      },
      bridges: {
        direct: { baseUrl: 'http://10.0.4.32:8893' },
        ros2: { baseUrl: 'http://10.0.4.32:8892' },
      },
      camera: {
        processed: true,
        sourceStreamUrl: cameraSource,
      },
      vision: {
        enabled: true,
        sourceStreamUrl: cameraSource,
      },
      audio: { enabled: false },
    },
    runtimeConfig: { dryRun: true },
    ros2Config: { transport: { dryRun: true } },
    diagnostics: {
      local: {
        keyExists: true,
        sshTcp: { status: 'ok' },
        directHealth: { status: 'ok', body: { ok: true } },
        directState: { status: 'ok', body: { executed: true, battery: 87, batteryUnit: 'percent', batteryReadStatus: 'ok' } },
        ros2Health: { status: 'error' },
        cameraTcp: { status: 'error', error: 'Camera TCP URL not configured.' },
        visionHealth: { status: 'error', error: 'ECONNREFUSED' },
        audioHealth: { status: 'error' },
      },
      remote: {
        status: 'ok',
        parsed: {
          identity: { hostname: 'raspberrypi' },
          devices: {
            video: ['/dev/video0'],
            videoById: [cameraSource],
          },
          docker: { images: [] },
          commands: {},
          paths: {},
          processes: [],
          listening: [],
        },
      },
    },
  })

  const sourceCheck = checks.find((check) => check.id === 'camera-source-device')
  assert.equal(sourceCheck?.status, 'ok')
  assert.match(sourceCheck?.detail || '', /\/dev\/v4l\/by-id\/usb-Sonix/)
})

test('buildPreflightChecks treats DOGZILLA battery zero as a failed read', () => {
  const checks = buildPreflightChecks({
    connectionConfig: {
      ssh: {
        host: '10.0.4.32',
        keyPath: 'C:\\Users\\sandr\\.ssh\\robodoge_pi_ed25519',
      },
      bridges: {
        direct: { baseUrl: 'http://10.0.4.32:8893' },
        ros2: { baseUrl: 'http://10.0.4.32:8892' },
      },
      camera: { baseUrl: 'http://10.0.4.32:6500' },
      vision: { enabled: false },
      audio: { enabled: false },
    },
    runtimeConfig: { dryRun: true },
    ros2Config: { transport: { dryRun: true } },
    diagnostics: {
      local: {
        keyExists: true,
        sshTcp: { status: 'ok' },
        directHealth: { status: 'ok', body: { ok: true } },
        directState: { status: 'ok', body: { executed: true, battery: 0, batteryUnit: 'percent', batteryReadStatus: 'read-failed' } },
        ros2Health: { status: 'error' },
        cameraTcp: { status: 'error' },
        visionHealth: { status: 'missing' },
        audioHealth: { status: 'missing' },
      },
      remote: {
        status: 'ok',
        parsed: {
          identity: { hostname: 'raspberrypi' },
          devices: {},
          docker: { images: [] },
          commands: {},
          paths: {},
          processes: [],
          listening: [],
        },
      },
    },
  })

  const stateCheck = checks.find((check) => check.id === 'direct-state')
  assert.equal(stateCheck?.status, 'warn')
  assert.equal(stateCheck?.value, null)
  assert.match(stateCheck?.detail || '', /failure sentinel 0/)
})

test('buildPreflightChecks blocks map pose when ROS TF and odom publishers are missing', () => {
  const checks = buildPreflightChecks({
    connectionConfig: {
      ssh: {
        host: '10.0.4.32',
        keyPath: 'C:\\Users\\sandr\\.ssh\\robodoge_pi_ed25519',
      },
      bridges: {
        direct: { baseUrl: 'http://10.0.4.32:8893' },
        ros2: { baseUrl: 'http://10.0.4.32:8892' },
      },
      camera: { baseUrl: 'http://10.0.4.32:6500' },
      vision: { enabled: false },
      audio: { enabled: false },
      lidar: {
        enabled: true,
        transport: 'rosbridge',
        rosbridgeUrl: 'ws://10.0.4.32:9090',
      },
    },
    runtimeConfig: { dryRun: true },
    ros2Config: { transport: { dryRun: true } },
    diagnostics: {
      local: {
        keyExists: true,
        sshTcp: { status: 'ok' },
        directHealth: { status: 'ok', body: { ok: true } },
        directState: { status: 'ok', body: { executed: true, battery: 73 } },
        ros2Health: { status: 'error' },
        cameraTcp: { status: 'ok' },
        visionHealth: { status: 'missing' },
        audioHealth: { status: 'missing' },
        lidarHealth: {
          status: 'ok',
          body: {
            ok: true,
            frames: 428,
            topic: '/scan',
          },
        },
        lidarPose: {
          status: 'error',
          responseStatus: 503,
          body: {
            ok: false,
            status: 'no-pose',
            error: 'No ROS pose source is visible yet.',
            rosGraph: {
              topics: {
                '/tf': { publisherCount: 0 },
                '/tf_static': { publisherCount: 0 },
                '/odom': { publisherCount: 0 },
              },
            },
          },
        },
      },
      remote: {
        status: 'ok',
        parsed: {
          identity: { hostname: 'raspberrypi' },
          devices: {
            ttyAma: ['/dev/ttyAMA1'],
          },
          docker: { images: [{ name: 'yahboomtechnology/ros-humble:3.6' }] },
          commands: {},
          paths: {},
          processes: [],
          listening: [],
        },
      },
    },
  })

  const lidarCheck = checks.find((check) => check.id === 'lidar-bridge')
  const poseCheck = checks.find((check) => check.id === 'map-pose')
  assert.equal(lidarCheck?.status, 'ok')
  assert.equal(poseCheck?.status, 'fail')
  assert.equal(poseCheck?.critical, true)
  assert.match(poseCheck?.detail || '', /No ROS pose source/)
  assert.match(poseCheck?.value || '', /\/tf:0, \/tf_static:0, \/odom:0/)
})
