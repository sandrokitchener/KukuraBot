import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import {
  resolveManagedSpeechSidecarPlan,
  startManagedSpeechSidecar,
} from '../lib/speech-sidecar-launcher.mjs'

test('resolveManagedSpeechSidecarPlan builds launch command from config', () => {
  const rootDir = path.resolve('C:/Users/sandr/OneDrive/Documents/Robo-Doge')
  const plan = resolveManagedSpeechSidecarPlan(
    {
      transport: {
        baseUrl: 'http://0.0.0.0:8892',
      },
      launch: {
        managedByApp: true,
        pythonPath: 'python',
        scriptPath: 'sidecars/parakeet_bridge/server.py',
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
    path.join(rootDir, 'sidecars', 'parakeet_bridge', 'server.py'),
    '--host',
    '0.0.0.0',
    '--port',
    '8892',
    '--warm',
  ])
  assert.equal(plan.sidecarReadyTimeoutMs, 15000)
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
        baseUrl: 'http://127.0.0.1:8892',
      },
      launch: {
        managedByApp: true,
        pythonPath: 'python',
        scriptPath: 'sidecars/parakeet_bridge/server.py',
        workdir: '.',
      },
    },
    logger: {
      log() {},
    },
    probeSpeechSidecarHealthImpl: async () => ({
      status: 'ok',
      destination: 'http://127.0.0.1:8892/healthz',
    }),
    spawnImpl: (...args) => {
      spawnCalls.push(args)
      return fakeChild
    },
  })

  assert.equal(result.reusedSidecar, true)
  assert.equal(spawnCalls.length, 0)
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
