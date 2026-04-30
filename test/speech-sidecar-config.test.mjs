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
  assert.equal(config.launch.runtime, 'python')
  assert.equal(config.launch.pythonPath, 'py')
  assert.equal(config.launch.wslCommand, 'wsl.exe')
  assert.equal(config.launch.wslDistribution, '')
  assert.equal(config.launch.linuxWorkdir, '')
  assert.equal(config.launch.linuxScriptPath, '')
  assert.deepEqual(config.launch.scriptArgs, [])
  assert.equal(config.launch.sidecarReadyTimeoutMs, 120000)
})

test('normalizeSpeechSidecarConfig defaults Parakeet sidecar away from ROS2 bridge port', () => {
  const config = normalizeSpeechSidecarConfig()

  assert.equal(config.transport.baseUrl, 'http://127.0.0.1:8893')
  assert.equal(config.launch.scriptPath, 'sidecars/parakeet_onnx_bridge/server.py')
})

test('normalizeSpeechSidecarConfig keeps WSL launch fields for Parakeet', () => {
  const config = normalizeSpeechSidecarConfig({
    launch: {
      managedByApp: true,
      runtime: 'wsl',
      wslCommand: 'wsl',
      wslDistribution: 'Ubuntu-22.04',
      pythonPath: '/home/me/parakeet/.venv/bin/python',
      linuxWorkdir: '/mnt/c/Users/me/Robo-Doge',
      linuxScriptPath: '/mnt/c/Users/me/Robo-Doge/sidecars/parakeet_bridge/server.py',
      scriptArgs: ['--warm'],
    },
  })

  assert.equal(config.launch.managedByApp, true)
  assert.equal(config.launch.runtime, 'wsl')
  assert.equal(config.launch.wslCommand, 'wsl')
  assert.equal(config.launch.wslDistribution, 'Ubuntu-22.04')
  assert.equal(config.launch.pythonPath, '/home/me/parakeet/.venv/bin/python')
  assert.equal(config.launch.linuxWorkdir, '/mnt/c/Users/me/Robo-Doge')
  assert.equal(config.launch.linuxScriptPath, '/mnt/c/Users/me/Robo-Doge/sidecars/parakeet_bridge/server.py')
  assert.deepEqual(config.launch.scriptArgs, ['--warm'])
})

test('normalizeSpeechSidecarConfig defaults WSL runtime to python3', () => {
  const config = normalizeSpeechSidecarConfig({
    launch: {
      runtime: 'wsl',
    },
  })

  assert.equal(config.launch.runtime, 'wsl')
  assert.equal(config.launch.pythonPath, 'python3')
})
