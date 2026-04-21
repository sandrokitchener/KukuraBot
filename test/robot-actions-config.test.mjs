import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('robot actions config maps backflip to a verified proxy action', async () => {
  const raw = JSON.parse(await readFile('config/robot-actions.json', 'utf8'))
  const activeMap = raw.maps[raw.activeMap]
  const backflip = activeMap.tricks.backflip

  assert.equal(backflip.actionId, 'proxy_backflip_v1')
  assert.equal(backflip.verified, true)
})
