import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import {
  resolveManagedSpeechSidecarPlan,
  startManagedSpeechSidecar,
  windowsPathToWslPath,
} from '../lib/speech-sidecar-launcher.mjs'

test('resolveManagedSpeechSidecarPlan builds launch command from config', () => {
  const rootDir = path.resolve('C:/Users/sandr/OneDrive/Documents/Robo-Doge')
  const plan = resolveManagedSpeechSidecarPlan(
    {
      transport: {
        baseUrl: 'http://0.0.0.0:8893',
      },
      launch: {
        managedByApp: true,
        pythonPath: 'python',
        scriptPath: 'sidecars/parakeet_onnx_bridge/server.py',
        scriptArgs: ['--warm'],
        workdir: '.',
        sidecarReadyTimeoutMs: 15000,
      },
    },
    rootDir,
  )

  assert.equal(plan.managedByApp, true)
  assert.equal(plan.transportEnabled, true)
  assert.equal(plan.sidecar.command, 'python')
  assert.equal(plan.sidecar.cwd, rootDir)
  assert.deepEqual(plan.sidecar.args, [
    path.join(rootDir, 'sidecars', 'parakeet_onnx_bridge', 'server.py'),
    '--host',
    '0.0.0.0',
    '--port',
    '8893',
    '--warm',
  ])
  assert.equal(plan.sidecarReadyTimeoutMs, 15000)
})

test('resolveManagedSpeechSidecarPlan builds Windows-friendly WSL launch command', () => {
  const rootDir = path.resolve('C:/Users/sandr/OneDrive/Documents/Robo-Doge')
  const plan = resolveManagedSpeechSidecarPlan(
    {
      transport: {
        baseUrl: 'http://127.0.0.1:8893',
      },
      launch: {
        managedByApp: true,
        runtime: 'wsl',
        wslCommand: 'wsl.exe',
        wslDistribution: 'Ubuntu-22.04',
        pythonPath: '/home/sandr/parakeet/.venv/bin/python',
        scriptPath: 'sidecars/parakeet_onnx_bridge/server.py',
        scriptArgs: ['--warm'],
        workdir: '.',
      },
    },
    rootDir,
  )

  assert.equal(plan.sidecar.runtime, 'wsl')
  assert.equal(plan.sidecar.command, 'wsl.exe')
  assert.equal(plan.sidecar.cwd, rootDir)
  assert.equal(plan.sidecar.scriptPath, path.join(rootDir, 'sidecars', 'parakeet_onnx_bridge', 'server.py'))
  assert.deepEqual(plan.sidecar.args, [
    '-d',
    'Ubuntu-22.04',
    '--cd',
    '/mnt/c/Users/sandr/OneDrive/Documents/Robo-Doge',
    '--',
    '/home/sandr/parakeet/.venv/bin/python',
    '/mnt/c/Users/sandr/OneDrive/Documents/Robo-Doge/sidecars/parakeet_onnx_bridge/server.py',
    '--host',
    '127.0.0.1',
    '--port',
    '8893',
    '--warm',
  ])
})

test('windowsPathToWslPath maps drive paths and preserves spaces', () => {
  assert.equal(
    windowsPathToWslPath('C:\\Users\\sandr\\OneDrive\\Documents\\Robo Doge\\server.py'),
    '/mnt/c/Users/sandr/OneDrive/Documents/Robo Doge/server.py',
  )
})

test('startManagedSpeechSidecar reuses running bridge when already healthy', async () => {
  const rootDir = path.resolve('C:/Users/sandr/OneDrive/Documents/Robo-Doge')
  const spawnCalls = []
  const fakeChild = createFakeChild()

  const result = await startManagedSpeechSidecar({
    rootDir,
    sidecarConfig: {
      transport: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:8893',
      },
      launch: {
        managedByApp: true,
        pythonPath: 'python',
        scriptPath: 'sidecars/parakeet_onnx_bridge/server.py',
        workdir: '.',
      },
    },
    logger: {
      log() {},
    },
    probeSpeechSidecarHealthImpl: async () => ({
      status: 'ok',
      destination: 'http://127.0.0.1:8893/healthz',
    }),
    spawnImpl: (...args) => {
      spawnCalls.push(args)
      return fakeChild
    },
  })

  assert.equal(result.reusedSidecar, true)
  assert.equal(spawnCalls.length, 0)
})

test('startManagedSpeechSidecar starts bridge after unavailable health check', async () => {
  const rootDir = path.resolve('C:/Users/sandr/OneDrive/Documents/Robo-Doge')
  const spawnCalls = []
  const fakeChild = createFakeChild()
  let probeCount = 0

  const result = await startManagedSpeechSidecar({
    rootDir,
    sidecarConfig: {
      transport: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:8893',
      },
      launch: {
        managedByApp: true,
        pythonPath: 'python',
        scriptPath: 'sidecars/parakeet_onnx_bridge/server.py',
        workdir: '.',
        sidecarReadyTimeoutMs: 1000,
      },
    },
    logger: {
      log() {},
    },
    probeSpeechSidecarHealthImpl: async () => {
      probeCount += 1

      if (probeCount === 1) {
        return {
          status: 'error',
          destination: 'http://127.0.0.1:8893/healthz',
          error: 'connect ECONNREFUSED',
        }
      }

      return {
        status: 'ok',
        destination: 'http://127.0.0.1:8893/healthz',
      }
    },
    spawnImpl: (...args) => {
      spawnCalls.push(args)
      return fakeChild
    },
  })

  assert.equal(result.enabled, true)
  assert.equal(result.reusedSidecar, false)
  assert.equal(spawnCalls.length, 1)
  assert.equal(probeCount, 2)
  await result.stop()
  assert.equal(fakeChild.killed, true)
})

function createFakeChild() {
  const child = new EventEmitter()
  child.pid = 4242
  child.exitCode = null
  child.killed = false
  child.kill = () => {
    child.killed = true
    child.exitCode = 0
    return true
  }
  return child
}
