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
        sourceStreamUrl: '/dev/video0',
      },
      vision: {
        enabled: true,
        sourceStreamUrl: '/dev/video0',
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
        directState: { status: 'ok', body: { executed: true, battery: 87 } },
        ros2Health: { status: 'error' },
        cameraTcp: { status: 'error', error: 'Camera TCP URL not configured.' },
        visionHealth: { status: 'error', error: 'ECONNREFUSED' },
        audioHealth: { status: 'error' },
      },
      remote: {
        status: 'ok',
        parsed: {
          identity: { hostname: 'raspberrypi' },
          devices: { video: ['/dev/video0'] },
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
  assert.match(sourceCheck?.detail || '', /\/dev\/video0 visible/)
})
