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
  const swipeBlocker = appJs.match(/function isSwipeBlockedTarget[\s\S]+?\n}/)?.[0] || ''
  const commandCueHandler = appJs.match(/function playCommandCueIfNeeded[\s\S]+?\n}/)?.[0] || ''
  const piConfirmCue = appJs.match(/async function playRobotConfirmCue[\s\S]+?\n}/)?.[0] || ''
  const piThinkingCue = appJs.match(/async function playRobotThinkingCue[\s\S]+?\n}/)?.[0] || ''
  const lidarFailureFormatter = appJs.match(/function formatLidarFailureSummary[\s\S]+?function setRobotMapMeta/)?.[0] || ''
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
  assert.doesNotMatch(html, /id="backend-url-input"/)
  assert.doesNotMatch(html, /id="save-backend-button"/)
  assert.match(html, /data-connection-action="sync-bridges"/)
  assert.match(html, /data-connection-action="probe-support"/)
  assert.match(html, /data-connection-action="start-audio"/)
  assert.match(html, /data-connection-action="start-lidar"/)
  assert.match(html, /id="run-dogzilla-preflight-button"/)
  assert.match(html, /id="emergency-stop-button"/)
  assert.match(html, /id="manual-control-panel"/)
  assert.match(html, /id="manual-control-toggle-button"/)
  assert.match(html, /id="robot-camera-snapshot-button"/)
  assert.match(html, /id="robot-camera-snapshot-note"/)
  assert.match(html, /id="recon-snapshot-list"/)
  assert.match(appJs, /handleConnectionToggle/)
  assert.match(appJs, /handleDogzillaBackendSave/)
  assert.match(appJs, /handleDogzillaPreflight/)
  assert.match(appJs, /handleEmergencyStop/)
  assert.match(appJs, /handleManualControlToggle/)
  assert.match(appJs, /handleReconSnapshot/)
  assert.match(appJs, /apiFetch\('\/api\/robot\/manual-control'/)
  assert.match(appJs, /apiFetch\('\/api\/robot\/stop'/)
  assert.match(appJs, /apiFetch\('\/api\/recon\/snapshots'/)
  assert.match(appJs, /document\.addEventListener\('touchmove', handleMobileTouchMove, \{ passive: false \}\)/)
  assert.ok(swipeBlocker)
  assert.doesNotMatch(swipeBlocker, /\.output-scroll/)
  assert.ok(commandCueHandler)
  assert.match(commandCueHandler, /playRobotConfirmCue/)
  assert.doesNotMatch(commandCueHandler, /commandCuePlayer\.play/)
  assert.match(piConfirmCue, /playDogzillaPiCue\('confirm'\)/)
  assert.match(piThinkingCue, /playDogzillaPiCue\('thinking-start'\)/)
  assert.match(lidarFailureFormatter, /serialDiagnostics/)
  assert.match(lidarFailureFormatter, /byIdPaths/)
  assert.match(appJs, /apiFetch\('\/api\/dogzilla\/connection'/)
  assert.match(appJs, /apiFetch\('\/api\/dogzilla\/audio\/cue'/)
  assert.match(appJs, /apiFetch\('\/api\/dogzilla\/preflight'/)
  assert.match(css, /html\.android-app \.connection-toggle/)
  assert.match(css, /html\.android-app \.connection-drawer/)
  assert.match(css, /\.recon-snapshot-list/)
  assert.match(css, /html\.android-app \.settings-drawer[\s\S]+background: var\(--panel\)/)
  assert.match(css, /html\.android-app \.connection-drawer[\s\S]+background: var\(--panel\)/)
  assert.match(css, /html\.android-app \.console-layout[\s\S]+touch-action: pan-y/)
  assert.match(css, /html\.android-app \.connection-backend-row/)
})
