import assert from 'node:assert/strict'
import test from 'node:test'

import { parseExplicitVisionCommand } from '../public/vision-command.js'

test('explicit vision phrases always produce command JSON intent', () => {
  for (const phrase of ['vision off', 'vision mode off', 'turn vision off', 'disable object detection', 'stop YOLO']) {
    assert.equal(parseExplicitVisionCommand(phrase)?.enabled, false)
  }
  for (const phrase of ['vision on', 'vision mode on', 'enable vision mode', 'turn YOLO on', 'activate object detection']) {
    assert.equal(parseExplicitVisionCommand(phrase)?.enabled, true)
  }
  assert.equal(parseExplicitVisionCommand('is vision working?'), null)
})
