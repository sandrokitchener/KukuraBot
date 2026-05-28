import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  listReconSnapshots,
  readReconSnapshotImage,
  saveReconSnapshot,
  updateReconSnapshotNote,
} from '../lib/recon-snapshot-store.mjs'

test('saveReconSnapshot writes image and metadata with robot context', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'robo-doge-recon-'))
  await usingTempDir(cacheDir, async () => {
    const imageBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9])
    const robotState = {
      status: 'ok',
      activeTarget: { id: 'dogzilla', label: 'DOGZILLA', kind: 'dogzilla-direct' },
      activeRobot: {
        uuid: 'dogzilla-local',
        name: 'DOGZILLA',
        pose: { x: 1.2, y: -0.4, theta: 0.3 },
        task: 'SCANNING',
        seq: 42,
        telemetry: { battery: 87, yaw: 12 },
      },
    }

    const record = await saveReconSnapshot({
      cacheDir,
      imageBuffer,
      imageContentType: 'image/jpeg',
      robotState,
      lidarScan: { status: 'ok', points: [{ x: 0.1, y: 0.2, range: 0.3 }] },
      map: { status: 'pose', pose: robotState.activeRobot.pose },
      camera: { label: 'YOLO camera', processed: true },
      note: 'human needs to inspect this doorway',
      tags: ['needs-review', 'needs-review', 'doorway'],
      capturedAt: new Date('2026-05-28T12:34:56Z'),
    })

    assert.match(record.id, /^recon-20260528T123456Z-[a-f0-9-]+/)
    assert.equal(record.capturedAt, '2026-05-28T12:34:56.000Z')
    assert.equal(record.note, 'human needs to inspect this doorway')
    assert.deepEqual(record.tags, ['needs-review', 'doorway'])
    assert.equal(record.activeRobot.seq, 42)
    assert.equal(record.image.contentType, 'image/jpeg')
    assert.equal(record.image.bytes, imageBuffer.length)
    assert.match(record.image.url, new RegExp(`/api/recon/snapshots/${record.id}/image$`))

    const metadata = JSON.parse(await readFile(path.join(cacheDir, `${record.id}.json`), 'utf-8'))
    assert.equal(metadata.image.fileName, `${record.id}.jpg`)
    assert.equal(metadata.robotState.activeRobot.name, 'DOGZILLA')

    const image = await readReconSnapshotImage(record.id, { cacheDir })
    assert.equal(image.contentType, 'image/jpeg')
    assert.deepEqual(image.buffer, imageBuffer)
  })
})

test('listReconSnapshots returns newest records first and honors limit', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'robo-doge-recon-'))
  await usingTempDir(cacheDir, async () => {
    const older = await saveReconSnapshot({
      cacheDir,
      imageBuffer: Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]),
      note: 'older',
      capturedAt: new Date('2026-05-28T10:00:00Z'),
    })
    const newer = await saveReconSnapshot({
      cacheDir,
      imageBuffer: Buffer.from([0xff, 0xd8, 0x02, 0xff, 0xd9]),
      note: 'newer',
      capturedAt: new Date('2026-05-28T11:00:00Z'),
    })

    const snapshots = await listReconSnapshots({ cacheDir, limit: 1 })
    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0].id, newer.id)
    assert.notEqual(snapshots[0].id, older.id)
  })
})

test('updateReconSnapshotNote edits saved inspection notes without losing context', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'robo-doge-recon-'))
  await usingTempDir(cacheDir, async () => {
    const record = await saveReconSnapshot({
      cacheDir,
      imageBuffer: Buffer.from([0xff, 0xd8, 0x03, 0xff, 0xd9]),
      note: 'initial note',
      tags: ['inspection'],
      robotState: {
        activeRobot: {
          name: 'DOGZILLA',
          pose: { x: 2.5, y: -1.5, theta: 0.7 },
          task: 'INSPECTING',
          seq: 9,
        },
      },
    })

    const updated = await updateReconSnapshotNote(record.id, {
      cacheDir,
      note: 'pipe corrosion visible behind the service panel',
    })

    assert.equal(updated.note, 'pipe corrosion visible behind the service panel')
    assert.deepEqual(updated.tags, ['inspection'])
    assert.equal(updated.activeRobot.name, 'DOGZILLA')
    assert.deepEqual(updated.activeRobot.pose, { x: 2.5, y: -1.5, theta: 0.7 })

    const snapshots = await listReconSnapshots({ cacheDir })
    assert.equal(snapshots[0].id, record.id)
    assert.equal(snapshots[0].note, 'pipe corrosion visible behind the service panel')
  })
})

async function usingTempDir(cacheDir, callback) {
  try {
    await callback()
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
}
