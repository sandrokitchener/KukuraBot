import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('Isaac launch batch script forwards extra launch args', async () => {
  const raw = await readFile('scripts/launch-isaac-robot-controller.bat', 'utf8')

  assert.match(raw, /%\*/i)
  assert.match(raw, /--enable isaacsim\.sensors\.physx/i)
  assert.match(raw, /--enable omni\.robot\.controller/i)
  assert.match(raw, /call "%ISAAC_SIM_BAT%".*%\*/is)
})
