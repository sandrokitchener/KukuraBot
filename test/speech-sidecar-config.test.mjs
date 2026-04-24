import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeSpeechSidecarConfig } from '../lib/speech-sidecar-config.mjs'

test('normalizeSpeechSidecarConfig fills HTTP and launch defaults', () => {
  const config = normalizeSpeechSidecarConfig({
    transport: {
      baseUrl: 'http://127.0.0.1:8892',
    },
    launch: {
      managedByApp: true,
      pythonPath: 'py',
      scriptPath: 'sidecars/parakeet_bridge/server.py',
    },
  })

  assert.equal(config.transport.enabled, true)
  assert.equal(config.transport.healthPath, '/healthz')
  assert.equal(config.transport.transcribePath, '/transcribe')
  assert.equal(config.transport.timeoutMs, 60000)
  assert.equal(config.launch.managedByApp, true)
  assert.equal(config.launch.pythonPath, 'py')
  assert.deepEqual(config.launch.scriptArgs, [])
  assert.equal(config.launch.sidecarReadyTimeoutMs, 120000)
})
