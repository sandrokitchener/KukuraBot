import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('npm start resets local runtime before running app startup', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf-8'))
  const startClean = await readFile('scripts/start-clean.mjs', 'utf-8')

  assert.equal(packageJson.scripts.start, 'node scripts/start-clean.mjs')
  assert.match(startClean, /ROBO_DOGE_LOCAL_PORTS = \[3037, 8891, 8892, 8893, 8894, 8895, 5037\]/)
  assert.match(startClean, /adb kill-server/)
  assert.match(startClean, /await import\('\.\.\/run\.mjs'\)/)
})

test('run startup reuses healthy managed sidecars by default', async () => {
  const run = await readFile('run.mjs', 'utf-8')

  assert.match(run, /options\.replaceManagedSidecars === true \|\| isTruthy\(env\.APP_REPLACE_MANAGED_SIDECARS\)/)
  assert.match(run, /return false\s*\n}/)
  assert.doesNotMatch(run, /return !isFalsy\(env\.APP_REPLACE_MANAGED_SIDECARS\)/)
})

test('npm start binds the desktop app for tailnet access by default', async () => {
  const run = await readFile('run.mjs', 'utf-8')
  const server = await readFile('server.mjs', 'utf-8')

  assert.match(run, /process\.env\.KUKURA_HOST \|\| '0\.0\.0\.0'/)
  assert.match(run, /const APP_URL = `http:\/\/\$\{resolveProbeHost\(HOST\)\}:\$\{PORT\}`/)
  assert.match(server, /process\.env\.KUKURA_HOST \|\| '0\.0\.0\.0'/)
})
