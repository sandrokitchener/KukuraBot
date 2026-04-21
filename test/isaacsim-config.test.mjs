import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { normalizeIsaacSidecarConfig } from '../lib/isaacsim-config.mjs'

test('normalizeIsaacSidecarConfig fills managed launch defaults', () => {
  const config = normalizeIsaacSidecarConfig({
    transport: {
      enabled: true,
      dispatchOnChat: true,
      baseUrl: 'http://127.0.0.1:8891',
    },
    launch: {
      managedByApp: true,
      pythonPath: 'py',
      scriptPath: 'sidecars/isaac_bridge/server.py',
      workdir: '.',
      isaacSimLaunchEnabled: true,
      isaacSimLaunchScriptPath: 'scripts/launch-isaac-robot-controller.bat',
    },
  })

  assert.equal(config.transport.enabled, true)
  assert.equal(config.transport.dispatchOnChat, true)
  assert.equal(config.launch.managedByApp, true)
  assert.equal(config.launch.pythonPath, 'py')
  assert.deepEqual(config.launch.scriptArgs, [])
  assert.equal(config.launch.sidecarReadyTimeoutMs, 10000)
  assert.equal(config.launch.isaacSimLaunchEnabled, true)
  assert.equal(config.launch.isaacSimLaunchScriptPath, 'scripts/launch-isaac-robot-controller.bat')
  assert.deepEqual(config.launch.isaacSimLaunchArgs, [])
})

test('workspace Isaac launch config defaults to viewport-only startup', async () => {
  const raw = JSON.parse(await readFile('config/isaacsim-sidecar.json', 'utf8'))

  assert.deepEqual(raw.launch.isaacSimLaunchArgs, [
    '--/app/window/hideUi=true',
    '--/app/window/width=960',
    '--/app/window/height=600',
  ])
})
