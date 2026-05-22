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
  const [logo, appIcon, qbMark] = await Promise.all([
    stat('public/assets/questing-beast-logo.png'),
    stat('public/assets/questing-beast-app-icon.png'),
    stat('public/assets/questing-beast-qb-mark.png'),
  ])

  assert.equal(tauriConfig.build.frontendDist, '../public')
  assert.equal(tauriConfig.productName, 'Questing Beast')
  assert.ok(logo.size > 0)
  assert.ok(appIcon.size > 0)
  assert.ok(qbMark.size > 0)
  assert.match(html, /rel="icon"[^>]+questing-beast-app-icon\.png/)
  assert.match(html, /class="app-header"/)
  assert.match(html, /class="app-header-actions"/)
  assert.match(html, /rail-brand[\s\S]+questing-beast-qb-mark\.png/)
  assert.match(html, /mascot-chip[\s\S]+questing-beast-qb-mark\.png/)
  assert.match(html, /brand-title-logo[\s\S]+questing-beast-logo\.png/)
  assert.match(html, /id="connection-toggle"/)
  assert.match(html, /class="router-icon"/)
  assert.match(html, /id="connection-drawer"/)
  assert.match(html, /id="dogzilla-backend-url-input"/)
  assert.match(html, /data-connection-action="sync-bridges"/)
  assert.match(html, /id="run-dogzilla-preflight-button"/)
  assert.match(appJs, /handleConnectionToggle/)
  assert.match(appJs, /handleDogzillaBackendSave/)
  assert.match(appJs, /handleDogzillaPreflight/)
  assert.match(appJs, /apiFetch\('\/api\/dogzilla\/connection'/)
  assert.match(appJs, /apiFetch\('\/api\/dogzilla\/preflight'/)
  assert.match(css, /html\.android-app \.connection-toggle/)
  assert.match(css, /html\.android-app \.connection-drawer/)
  assert.match(css, /html\.android-app \.connection-backend-row/)
})
