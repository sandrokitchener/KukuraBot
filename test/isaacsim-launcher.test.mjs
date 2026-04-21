import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { resolveManagedIsaacLaunchPlan, startManagedIsaacEnvironment } from '../lib/isaacsim-launcher.mjs'

test('resolveManagedIsaacLaunchPlan builds sidecar and Isaac launch commands from config', () => {
  const rootDir = path.resolve('C:/Users/sandr/OneDrive/Documents/Robo-Doge')
  const plan = resolveManagedIsaacLaunchPlan(
    {
      transport: {
        baseUrl: 'http://0.0.0.0:8891',
      },
      launch: {
        managedByApp: true,
        pythonPath: 'python',
        scriptPath: 'sidecars/isaac_bridge/server.py',
        scriptArgs: ['--verbose'],
        workdir: '.',
        sidecarReadyTimeoutMs: 15000,
        isaacSimLaunchEnabled: true,
        isaacSimLaunchScriptPath: 'scripts/launch-isaac-robot-controller.bat',
        isaacSimLaunchArgs: ['--smoke'],
      },
    },
    rootDir,
  )

  assert.equal(plan.managedByApp, true)
  assert.equal(plan.sidecar.command, 'python')
  assert.equal(plan.sidecar.cwd, rootDir)
  assert.deepEqual(plan.sidecar.args, [
    path.join(rootDir, 'sidecars', 'isaac_bridge', 'server.py'),
    '--host',
    '0.0.0.0',
    '--port',
    '8891',
    '--verbose',
  ])
  assert.equal(plan.sidecarReadyTimeoutMs, 15000)
  assert.equal(plan.isaac.enabled, true)
  assert.equal(plan.isaac.command, path.join(rootDir, 'scripts', 'launch-isaac-robot-controller.bat'))
  assert.deepEqual(plan.isaac.args, ['--smoke'])
})

test('startManagedIsaacEnvironment still launches Isaac when sidecar already healthy', async () => {
  const rootDir = path.resolve('C:/Users/sandr/OneDrive/Documents/Robo-Doge')
  const spawnCalls = []
  const fakeChild = createFakeChild()

  const result = await startManagedIsaacEnvironment({
    rootDir,
    sidecarConfig: {
      transport: {
        baseUrl: 'http://127.0.0.1:8891',
      },
      launch: {
        managedByApp: true,
        pythonPath: 'python',
        scriptPath: 'sidecars/isaac_bridge/server.py',
        workdir: '.',
        isaacSimLaunchEnabled: true,
        isaacSimLaunchScriptPath: 'scripts/launch-isaac-robot-controller.bat',
      },
    },
    logger: {
      log() {},
    },
    probeIsaacSidecarHealthImpl: async () => ({
      status: 'ok',
      destination: 'http://127.0.0.1:8891/healthz',
    }),
    spawnImpl: (...args) => {
      spawnCalls.push(args)
      return fakeChild
    },
  })

  assert.equal(result.reusedSidecar, true)
  assert.equal(spawnCalls.length, 1)
  assert.equal(spawnCalls[0][0], path.join(rootDir, 'scripts', 'launch-isaac-robot-controller.bat'))
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
