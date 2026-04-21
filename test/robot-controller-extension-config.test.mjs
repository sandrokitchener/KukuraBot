import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('robot controller extension toml declares module and dependencies', async () => {
  const raw = await readFile('isaacsim/extensions/omni.robot.controller/config/extension.toml', 'utf8')

  assert.match(raw, /\[package\]/)
  assert.match(raw, /title = "robot controller"/)
  assert.match(raw, /"omni\.kit\.uiapp"/)
  assert.match(raw, /\[\[python\.module\]\]/)
  assert.match(raw, /name = "omni\.robot\.controller"/)
})
