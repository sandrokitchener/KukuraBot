import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { reviewDogzillaWaypointProposal } from '../scripts/review-dogzilla-waypoint-proposal.mjs'
import { mapWaypoint, waypointConfig } from '../test-support/robot-compiler-fixtures.mjs'
import { nav2HealthBody } from '../test-support/robot-http-fixtures.mjs'

test('reviewDogzillaWaypointProposal accepts a current-map proposal without modifying source', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'robodoge-review-'))
  const waypointFile = path.join(tempDir, 'robot-waypoints.json')
  const proposalFile = path.join(tempDir, 'proposal.json')
  const originFile = path.join(tempDir, 'missing-origin.json')
  const originalConfig = `${JSON.stringify(waypointConfig({
    kitchen: mapWaypoint({
      verified: false,
      notes: ['Placeholder.'],
    }),
  }), null, 2)}\n`

  await writeFile(waypointFile, originalConfig, 'utf-8')
  await writeFile(proposalFile, `${JSON.stringify({
    ok: true,
    waypointName: 'Kitchen',
    waypoint: mapWaypoint({
      x: 1.2,
      y: -0.4,
      yaw: 0.75,
      notes: [
        'Captured map pose: x=1.2, y=-0.4, yaw=0.75.',
        'Captured map identity: id=test_map, fingerprint=test-map-fingerprint.',
      ],
    }),
    sourceOfTruthFile: waypointFile,
    writePolicy: 'proposal-only; config/robot-waypoints.json is not overwritten by capture',
  }, null, 2)}\n`, 'utf-8')

  const report = await reviewDogzillaWaypointProposal({
    proposalFile,
    originFile,
    fetchImpl: async () => ({
      ok: true,
      json: async () => nav2HealthBody(),
    }),
  })

  assert.equal(report.ok, true)
  assert.equal(report.waypointName, 'kitchen')
  assert.equal(report.proposalResult.status, 'ready')
  assert.equal(report.sourceResult.status, 'disabled-by-config')
  assert.equal(report.copyCandidate.waypoint.x, 1.2)
  assert.equal(report.source.activeSet, 'home')
  assert.match(report.source.sha256, /^[a-f0-9]{64}$/)
  assert.equal(report.source.waypointExists, true)
  assert.equal(report.jsonPatch[0].op, 'replace')
  assert.equal(report.jsonPatch[0].path, '/sets/home/waypoints/kitchen')
  assert.equal(report.jsonPatch[0].value.x, 1.2)
  assert.match(report.writePolicy, /read-only/)
  assert.equal(await readFile(waypointFile, 'utf-8'), originalConfig)
})

test('reviewDogzillaWaypointProposal rejects proposal from a different active map', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'robodoge-review-stale-'))
  const waypointFile = path.join(tempDir, 'robot-waypoints.json')
  const proposalFile = path.join(tempDir, 'proposal.json')
  await writeFile(waypointFile, `${JSON.stringify(waypointConfig({}), null, 2)}\n`, 'utf-8')
  await writeFile(proposalFile, `${JSON.stringify({
    ok: true,
    waypointName: 'kitchen',
    waypoint: mapWaypoint({
      mapId: 'old_map',
      mapFingerprint: 'old-fingerprint',
    }),
    sourceOfTruthFile: waypointFile,
  }, null, 2)}\n`, 'utf-8')

  const report = await reviewDogzillaWaypointProposal({
    proposalFile,
    originFile: path.join(tempDir, 'missing-origin.json'),
    fetchImpl: async () => ({
      ok: true,
      json: async () => nav2HealthBody(),
    }),
  })

  assert.equal(report.ok, false)
  assert.equal(report.proposalResult.status, 'map-id-mismatch')
  assert.equal(report.proposalResult.enabled, false)
  assert.match(report.proposalResult.problems.join('\n'), /does not match active map/i)
})
