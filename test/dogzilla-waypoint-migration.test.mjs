import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { migrateMapFrameWaypoints } from '../scripts/migrate-waypoints-to-appmap.mjs'

test('waypoint migration preserves entries and creates a source backup', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'robodoge-waypoint-migration-'))
  const waypointFile = path.join(tempDir, 'robot-waypoints.json')
  const originFile = path.join(tempDir, 'origin.json')
  await writeFile(waypointFile, `${JSON.stringify({
    activeSet: 'home',
    sets: {
      home: {
        defaultFrame: 'map',
        waypoints: {
          desk: {
            kind: 'map_pose',
            frame: 'map',
            x: 2,
            y: 3,
            yaw: 0.5,
            verified: true,
            notes: ['keep this note'],
            customField: 'preserve me',
          },
          current_position: { kind: 'special', mode: 'stay_put', verified: true },
        },
      },
    },
  }, null, 2)}\n`, 'utf-8')
  await writeFile(originFile, `${JSON.stringify({
    frame: 'app_map',
    x: 1,
    y: 2,
    yaw: 0.2,
    source: 'test',
    savedAt: '2026-07-13T00:00:00.000Z',
    map: { id: 'test_map', fingerprint: 'test-fingerprint' },
  }, null, 2)}\n`, 'utf-8')

  const result = await migrateMapFrameWaypoints({ waypointFile, originFile, dryRun: false })
  const migrated = JSON.parse(await readFile(waypointFile, 'utf-8')).sets.home.waypoints

  assert.equal(result.ok, true)
  assert.equal(result.migratedCount, 1)
  assert.equal(migrated.desk.frame, 'app_map')
  assert.deepEqual(migrated.desk.capturedMapPose, { frame: 'map', x: 2, y: 3, yaw: 0.5 })
  assert.equal(migrated.desk.customField, 'preserve me')
  assert.deepEqual(migrated.desk.notes.slice(0, 1), ['keep this note'])
  assert.equal(migrated.current_position.mode, 'stay_put')
  await access(result.backupPath)
  await rm(tempDir, { recursive: true, force: true })
})
