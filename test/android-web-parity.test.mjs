import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import test from 'node:test'

test('Android shell and web app share the connection center surface', async () => {
  const [html, css, appJs, tauriConfigText] = await Promise.all([
    readFile('public/index.html', 'utf-8'),
    readFile('public/styles.css', 'utf-8'),
    readFile('public/app.js', 'utf-8'),
    readFile('src-tauri/tauri.conf.json', 'utf-8'),
  ])
  const tauriConfig = JSON.parse(tauriConfigText)
  const mascot = await stat('public/assets/robo-doge-mascot.png')

  assert.equal(tauriConfig.build.frontendDist, '../public')
  assert.ok(mascot.size > 0)
  assert.match(html, /rel="icon"[^>]+robo-doge-mascot\.png/)
  assert.match(html, /rail-brand[\s\S]+robo-doge-mascot\.png/)
  assert.match(html, /mascot-chip[\s\S]+robo-doge-mascot\.png/)
  assert.match(html, /id="connection-toggle"/)
  assert.match(html, /class="router-icon"/)
  assert.match(html, /id="connection-drawer"/)
  assert.match(html, /id="dogzilla-backend-url-input"/)
  assert.match(html, /data-connection-action="sync-bridges"/)
  assert.match(appJs, /handleConnectionToggle/)
  assert.match(appJs, /handleDogzillaBackendSave/)
  assert.match(appJs, /apiFetch\('\/api\/dogzilla\/connection'/)
  assert.match(css, /html\.android-app \.connection-toggle/)
  assert.match(css, /html\.android-app \.connection-drawer/)
  assert.match(css, /html\.android-app \.connection-backend-row/)
})
