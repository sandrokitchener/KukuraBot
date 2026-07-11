import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const PROMOTION_SCRIPT = join(TEST_DIR, '..', 'sidecars', 'dogzilla_map_pose', 'promote-candidate-map-in-container.sh')
const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash'
const canRunBash = process.platform !== 'win32' || existsSync(bash)

function bashPath(value) {
  return value.replaceAll('\\', '/')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function writeActiveMap(mapsDir) {
  await Promise.all([
    writeFile(join(mapsDir, 'robodoge_home.pbstream'), 'old pbstream\n'),
    writeFile(join(mapsDir, 'robodoge_home.pgm'), 'old pgm\n'),
    writeFile(join(mapsDir, 'robodoge_home.yaml'), 'image: old.pgm\nresolution: 0.05\n'),
    writeFile(join(mapsDir, 'robodoge_home_map.json'), JSON.stringify({ state: 'active', id: 'old' }) + '\n'),
  ])
}

async function runPromotion(root, candidateId) {
  return execFileAsync(bash, [PROMOTION_SCRIPT], {
    env: {
      ...process.env,
      REMOTE_ROOT: bashPath(root),
      DOGZILLA_MAP_CANDIDATE_ID: candidateId,
    },
  })
}

test('candidate promotion rewrites map image alias and records active aliases', { skip: !canRunBash }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'robodoge-map-promotion-'))
  try {
    const mapsDir = join(root, 'maps')
    const candidateId = 'floor_a'
    const candidateDir = join(mapsDir, 'candidates', candidateId)
    await mkdir(candidateDir, { recursive: true })
    await writeActiveMap(mapsDir)
    await Promise.all([
      writeFile(join(candidateDir, 'map.pbstream'), 'new pbstream\n'),
      writeFile(join(candidateDir, 'map.pgm'), 'new pgm\n'),
      writeFile(join(candidateDir, 'map.yaml'), 'image: map.pgm\nresolution: 0.05\n'),
      writeFile(join(candidateDir, 'candidate.json'), JSON.stringify({
        id: candidateId,
        pbstream: bashPath(join(candidateDir, 'map.pbstream')),
        yaml: bashPath(join(candidateDir, 'map.yaml')),
        pgm: bashPath(join(candidateDir, 'map.pgm')),
        artifacts: {
          pbstream: { sha256: sha256('new pbstream\n') },
          yaml: { sha256: sha256('image: map.pgm\nresolution: 0.05\n') },
          pgm: { sha256: sha256('new pgm\n') },
        },
        state: 'candidate',
      }) + '\n'),
    ])
    await mkdir(join(root, 'output', 'app-cache'), { recursive: true })
    await writeFile(join(root, 'output', 'app-cache', 'dogzilla-map-origin.json'), '{"x":1}\n')

    await runPromotion(root, candidateId)

    assert.equal(await readFile(join(mapsDir, 'robodoge_home.pbstream'), 'utf8'), 'new pbstream\n')
    assert.equal(await readFile(join(mapsDir, 'robodoge_home.pgm'), 'utf8'), 'new pgm\n')
    assert.match(await readFile(join(mapsDir, 'robodoge_home.yaml'), 'utf8'), /^image: robodoge_home\.pgm$/m)
    const metadata = JSON.parse(await readFile(join(mapsDir, 'robodoge_home_map.json'), 'utf8'))
    assert.equal(metadata.state, 'active')
    assert.equal(metadata.candidateId, candidateId)
    assert.equal(metadata.pbstream, join(mapsDir, 'robodoge_home.pbstream'))
    assert.equal(metadata.yaml, join(mapsDir, 'robodoge_home.yaml'))
    assert.equal(metadata.pgm, join(mapsDir, 'robodoge_home.pgm'))
    assert.equal(metadata.artifacts.pbstream.path, join(mapsDir, 'robodoge_home.pbstream'))
    assert.equal(metadata.artifacts.yaml.path, join(mapsDir, 'robodoge_home.yaml'))
    assert.equal(metadata.artifacts.pgm.path, join(mapsDir, 'robodoge_home.pgm'))
    assert.equal(metadata.artifacts.pbstream.sha256, sha256('new pbstream\n'))
    assert.equal(existsSync(join(root, 'output', 'app-cache', 'dogzilla-map-origin.json')), false)
    const [backupName] = await readdir(join(mapsDir, '.promotion-backups'))
    assert.equal(await readFile(join(mapsDir, '.promotion-backups', backupName, 'robodoge_home.pbstream'), 'utf8'), 'old pbstream\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('invalid candidate leaves active aliases unchanged', { skip: !canRunBash }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'robodoge-map-promotion-'))
  try {
    const mapsDir = join(root, 'maps')
    const candidateId = 'bad_floor'
    const candidateDir = join(mapsDir, 'candidates', candidateId)
    await mkdir(candidateDir, { recursive: true })
    await writeActiveMap(mapsDir)
    await Promise.all([
      writeFile(join(candidateDir, 'map.pgm'), 'new pgm\n'),
      writeFile(join(candidateDir, 'map.yaml'), 'image: map.pgm\nresolution: 0.05\n'),
      writeFile(join(candidateDir, 'candidate.json'), JSON.stringify({
        id: candidateId,
        pbstream: bashPath(join(candidateDir, 'missing.pbstream')),
        yaml: bashPath(join(candidateDir, 'map.yaml')),
        pgm: bashPath(join(candidateDir, 'map.pgm')),
        artifacts: {
          pbstream: { sha256: sha256('new pbstream\n') },
          yaml: { sha256: sha256('image: map.pgm\nresolution: 0.05\n') },
          pgm: { sha256: sha256('new pgm\n') },
        },
        state: 'candidate',
      }) + '\n'),
    ])

    await assert.rejects(runPromotion(root, candidateId), /Candidate pbstream/)
    assert.equal(await readFile(join(mapsDir, 'robodoge_home.pbstream'), 'utf8'), 'old pbstream\n')
    assert.equal(await readFile(join(mapsDir, 'robodoge_home.yaml'), 'utf8'), 'image: old.pgm\nresolution: 0.05\n')
    assert.equal(await readFile(join(mapsDir, 'robodoge_home.pgm'), 'utf8'), 'old pgm\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
