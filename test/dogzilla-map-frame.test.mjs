import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  APP_MAP_FRAME,
  appPoseToMapPose,
  mapPoseToAppPose,
  saveDogzillaMapOriginFromPose,
} from '../lib/dogzilla-map-frame.mjs'

test('mapPoseToAppPose makes saved origin the new zero pose', () => {
  const origin = {
    x: 10,
    y: 20,
    yaw: Math.PI / 2,
    label: 'dock',
    savedAt: '2026-06-04T00:00:00.000Z',
  }

  const appPose = mapPoseToAppPose({
    frame: 'map',
    x: 10,
    y: 21,
    yaw: Math.PI,
  }, origin)

  assert.equal(appPose.frame, APP_MAP_FRAME)
  assert.equal(appPose.x, 1)
  assert.equal(appPose.y, 0)
  assert.equal(appPose.yaw, 1.5708)
})

test('appPoseToMapPose converts app frame targets back to ROS map frame', () => {
  const mapPose = appPoseToMapPose({
    frame: APP_MAP_FRAME,
    x: 1,
    y: 0,
    yaw: Math.PI / 2,
  }, {
    x: 10,
    y: 20,
    yaw: Math.PI / 2,
  })

  assert.equal(mapPose.frame, 'map')
  assert.equal(mapPose.x, 10)
  assert.equal(mapPose.y, 21)
  assert.equal(mapPose.yaw, 3.14159)
})

test('saveDogzillaMapOriginFromPose persists map origin from verified pose payload', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'robodoge-origin-'))
  const originFile = path.join(dir, 'origin.json')

  try {
    const origin = await saveDogzillaMapOriginFromPose({
      ok: true,
      pose: {
        frame: 'map',
        x: 1.25,
        y: -0.5,
        theta: 0.75,
        source: 'tf:map->base_link',
      },
    }, {
      originFile,
      label: 'dock',
    })

    const saved = JSON.parse(await readFile(originFile, 'utf-8'))
    assert.equal(origin.label, 'dock')
    assert.equal(saved.frame, APP_MAP_FRAME)
    assert.equal(saved.sourceFrame, 'map')
    assert.equal(saved.x, 1.25)
    assert.equal(saved.yaw, 0.75)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
