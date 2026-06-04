import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  deleteReconSnapshot,
  listReconSnapshots,
  readReconSnapshotArtifact,
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
      lidarScan: { status: 'ok', frameId: 'laser_frame', points: [{ angle: 1.57, x: 0.1, y: 0.2, range: 0.3 }] },
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
    assert.match(record.lidarArtifacts.json.url, new RegExp(`/api/recon/snapshots/${record.id}/lidar\\.json$`))
    assert.match(record.lidarArtifacts.csv.url, new RegExp(`/api/recon/snapshots/${record.id}/lidar\\.csv$`))
    assert.equal(record.lidarArtifacts.csv.pointCount, 1)

    const metadata = JSON.parse(await readFile(path.join(cacheDir, `${record.id}.json`), 'utf-8'))
    assert.equal(metadata.image.fileName, `${record.id}.jpg`)
    assert.equal(metadata.robotState.activeRobot.name, 'DOGZILLA')
    assert.equal(metadata.lidarArtifacts.json.fileName, `${record.id}.lidar.json`)

    const lidarJson = await readReconSnapshotArtifact(record.id, 'json', { cacheDir })
    assert.equal(lidarJson.contentType, 'application/json; charset=utf-8')
    assert.equal(JSON.parse(lidarJson.buffer.toString('utf-8')).frameId, 'laser_frame')

    const lidarCsv = await readReconSnapshotArtifact(record.id, 'csv', { cacheDir })
    assert.equal(lidarCsv.contentType, 'text/csv; charset=utf-8')
    assert.match(lidarCsv.buffer.toString('utf-8'), /^index,angle,range,x,y\n0,1.57,0.3,0.1,0.2\n$/)

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

test('deleteReconSnapshot removes image and metadata files', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'robo-doge-recon-'))
  await usingTempDir(cacheDir, async () => {
    const record = await saveReconSnapshot({
      cacheDir,
      imageBuffer: Buffer.from([0xff, 0xd8, 0x04, 0xff, 0xd9]),
      note: 'delete me',
    })

    const result = await deleteReconSnapshot(record.id, { cacheDir })
    assert.equal(result.deleted, true)
    assert.equal(result.id, record.id)
    assert.ok(result.deletedFiles.includes(`${record.id}.json`))
    assert.ok(result.deletedFiles.includes(`${record.id}.jpg`))
    assert.ok(result.deletedFiles.includes(`${record.id}.lidar.json`))
    assert.ok(result.deletedFiles.includes(`${record.id}.lidar.csv`))
    assert.deepEqual(await listReconSnapshots({ cacheDir }), [])

    await assert.rejects(
      readReconSnapshotImage(record.id, { cacheDir }),
      /was not found/,
    )
  })
})

async function usingTempDir(cacheDir, callback) {
  try {
    await callback()
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
}
