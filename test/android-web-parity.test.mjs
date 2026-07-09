import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import test from 'node:test'

test('Android shell and web app share the connection center surface', async () => {
  const [html, css, appJs, dogzillaAudioJs, manualControlJs, robotMapJs, serverJs, tauriConfigText] = await Promise.all([
    readFile('public/index.html', 'utf-8'),
    readCssBundle(),
    readFile('public/app.js', 'utf-8'),
    readFile('public/dogzilla-audio.js', 'utf-8'),
    readFile('public/manual-control.js', 'utf-8'),
    readFile('public/robot-map.js', 'utf-8'),
    readFile('server.mjs', 'utf-8'),
    readFile('src-tauri/tauri.conf.json', 'utf-8'),
  ])
  const browserJs = [appJs, dogzillaAudioJs, manualControlJs, robotMapJs].join('\n')
  const swipeBlocker = appJs.match(/function isSwipeBlockedTarget[\s\S]+?\n}/)?.[0] || ''
  const commandCueHandler = appJs.match(/function playCommandCueIfNeeded[\s\S]+?\n}/)?.[0] || ''
  const piConfirmCue = appJs.match(/async function playRobotConfirmCue[\s\S]+?\n}/)?.[0] || ''
  const piThinkingCue = appJs.match(/async function playRobotThinkingCue[\s\S]+?\n}/)?.[0] || ''
  const dogzillaPiCue = dogzillaAudioJs.match(/async function playPiCue[\s\S]+?\n  }/)?.[0] || ''
  const suppressLocalAudio = dogzillaAudioJs.match(/function shouldSuppressLocalAudio[\s\S]+?\n  }/)?.[0] || ''
  const lidarFailureFormatter = robotMapJs.match(/export function formatLidarFailureSummary[\s\S]+?export function toFiniteNumber/)?.[0] || ''
  const assistantMetaFormatter = appJs.match(/function buildAssistantMeta[\s\S]+?function buildCompletionStatus/)?.[0] || ''
  const completionStatusFormatter = appJs.match(/function buildCompletionStatus[\s\S]+?function formatParsedOutput/)?.[0] || ''
  const parsedOutputFormatter = appJs.match(/function formatParsedOutput[\s\S]+?function formatActiveRuntimeSummary/)?.[0] || ''
  const chatSubmitHandler = appJs.match(/async function handleChatSubmit[\s\S]+?async function submitChatMessage/)?.[0] || ''
  const assistantTextFormatter = appJs.match(/function buildAssistantText[\s\S]+?function buildCompletionStatus/)?.[0] || ''
  const settingsDrawerIndex = html.indexOf('id="settings-drawer"')
  const audioVolumeIndex = html.indexOf('id="dogzilla-audio-volume-input"')
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
  assert.match(html, /Quadruped inspection console/)
  assert.doesNotMatch(html, /operator notes in one inspection trail/)
  assert.doesNotMatch(html, /Use Questing Beast for safety/)
  assert.doesNotMatch(html, /robot-control test/)
  assert.match(html, /id="connection-toggle"/)
  assert.match(html, /class="router-icon"/)
  assert.match(html, /id="connection-drawer"/)
  assert.match(html, /id="dogzilla-backend-url-input"/)
  assert.match(html, /id="dogzilla-audio-volume-input"/)
  assert.match(html, /id="dogzilla-audio-volume-value"/)
  assert.ok(audioVolumeIndex > settingsDrawerIndex, 'audio volume control belongs in Settings')
  assert.doesNotMatch(html, /Selection saves/)
  assert.doesNotMatch(html, /Speech config files/)
  assert.doesNotMatch(html, /Runtime config files/)
  assert.doesNotMatch(html, /Prompt file/)
  assert.doesNotMatch(html, /Schema file/)
  assert.doesNotMatch(html, /Robot runtime file/)
  assert.doesNotMatch(html, /ROS2 config file/)
  assert.doesNotMatch(appJs, /Selection saves/)
  assert.doesNotMatch(appJs, /Speech config files/)
  assert.doesNotMatch(appJs, /Runtime config files/)
  assert.doesNotMatch(appJs, /Trigger window/)
  assert.doesNotMatch(appJs, /Sidecar model/)
  assert.doesNotMatch(appJs, /Source: \$\{formatSource/)
  assert.doesNotMatch(html, /id="backend-url-input"/)
  assert.doesNotMatch(html, /id="save-backend-button"/)
  assert.match(html, /data-connection-action="sync-bridges"/)
  assert.match(html, /data-connection-action="probe-support"/)
  assert.match(html, /data-connection-action="start-direct"/)
  assert.match(html, /data-connection-action="start-ros2"/)
  assert.match(html, /data-connection-action="start-yolo"/)
  assert.match(html, /data-connection-action="start-audio"/)
  assert.match(html, /data-connection-action="start-lidar"/)
  assert.match(html, /data-connection-action="start-map-pose"/)
  assert.match(html, /data-connection-action="start-navigation"/)
  assert.match(html, /data-connection-action="capture-map-origin"/)
  assert.match(html, /Mark Origin/)
  assert.match(html, /data-connection-action="save-map-pose"/)
  assert.match(html, /data-connection-action="start-map-pose-mapping"/)
  assert.match(html, /Restart Nav/)
  assert.match(html, /id="run-dogzilla-preflight-button"/)
  assert.match(html, /id="persistent-emergency-stop"/)
  assert.match(html, /id="manual-control-panel"/)
  assert.match(html, /id="manual-control-toggle-button"/)
  assert.match(html, /id="manual-control-speed-slider"/)
  assert.match(html, /id="recon-gallery-toggle"/)
  assert.match(html, /class="camera-rail-icon"/)
  assert.match(html, /id="recon-gallery-drawer"/)
  assert.match(html, /id="robot-camera-snapshot-button"/)
  assert.match(html, /id="robot-camera-snapshot-note"/)
  assert.match(html, /id="recon-snapshot-list"/)
  assert.match(html, /id="robot-map-track"/)
  assert.match(html, /id="robot-map-waypoints"/)
  assert.match(html, /id="robot-map-layer-grid"/)
  assert.match(html, /id="robot-map-layer-scan"/)
  assert.doesNotMatch(html, /><>/)
  assert.doesNotMatch(html, />&lt;&gt;</)
  assert.doesNotMatch(html, />Scout</)
  assert.doesNotMatch(html, />Dock</)
  assert.match(appJs, /handleConnectionToggle/)
  assert.match(appJs, /handleDogzillaBackendSave/)
  assert.match(appJs, /handleDogzillaPreflight/)
  assert.match(appJs, /handleEmergencyStop/)
  assert.match(appJs, /manualControl\.handleToggle/)
  assert.match(appJs, /handleReconSnapshot/)
  assert.match(appJs, /handleReconGalleryToggle/)
  assert.match(appJs, /handleReconSnapshotListClick/)
  assert.match(browserJs, /apiFetch\('\/api\/robot\/manual-control'/)
  assert.match(appJs, /apiFetch\('\/api\/robot\/stop'/)
  assert.match(appJs, /apiFetch\('\/api\/recon\/snapshots'/)
  assert.match(appJs, /method: 'PATCH'/)
  assert.match(appJs, /navigation-unavailable/)
  assert.match(appJs, /Waypoint not sent/)
  assert.match(appJs, /Manual controls and non-waypoint actions are still available/)
  assert.match(appJs, /Robot command JSON/)
  assert.doesNotMatch(appJs, /Robot command sent/)
  assert.doesNotMatch(appJs, /setRobotPoseReadout\(robot\.telemetry\?\.pose/)
  assert.match(browserJs, /Waiting for verified map-frame localization/)
  assert.match(browserJs, /DOGZILLA direct bridge unreachable/)
  assert.match(appJs, /Stale robot pose cleared/)
  assert.match(appJs, /robotMap\.renderPoseTrack\(snapshot\?\.poseTrack/)
  assert.ok(assistantMetaFormatter)
  assert.ok(completionStatusFormatter)
  assert.ok(parsedOutputFormatter)
  assert.ok(chatSubmitHandler)
  assert.ok(assistantTextFormatter)
  assert.match(chatSubmitHandler, /text: buildAssistantText\(payload\)/)
  assert.doesNotMatch(chatSubmitHandler, /text: payload\.response/)
  assert.match(assistantTextFormatter, /buildTrickAssistantText\(payload\)/)
  assert.match(assistantMetaFormatter, /formatActiveRuntimeSummary\(payload\)/)
  assert.doesNotMatch(assistantMetaFormatter, /formatIsaacSummary\(payload\.isaacSim/)
  assert.match(completionStatusFormatter, /formatActiveRuntimeSummary\(payload\)/)
  assert.doesNotMatch(completionStatusFormatter, /formatIsaacSummary\(payload\.isaacSim/)
  assert.match(parsedOutputFormatter, /isIsaacRuntimeTarget\(payload\) && payload\.isaacSim/)
  assert.match(parsedOutputFormatter, /isRobotRuntimeTarget\(payload\) && payload\.robotRuntime/)
  assert.doesNotMatch(serverJs, /pose:\s*localPose/)
  assert.doesNotMatch(serverJs, /local-odom-only/)
  assert.match(serverJs, /bridgeOwnsActiveRobot/)
  assert.match(serverJs, /removeDogzillaStreamRobots/)
  assert.match(serverJs, /recordDogzillaMapPose/)
  assert.match(serverJs, /telemetry\.waypointSafe !== true/)
  assert.match(css, /\.robot-map-track-dot/)
  assert.match(css, /\.robot-map-waypoint/)
  assert.doesNotMatch(css, /floorplan\.png/)
  assert.match(appJs, /robotMap\.renderWaypoints/)
  assert.match(robotMapJs, /getRobotMapRangeMeters/)
  assert.match(appJs, /document\.addEventListener\('touchmove', handleMobileTouchMove, \{ passive: false \}\)/)
  assert.ok(swipeBlocker)
  assert.match(swipeBlocker, /\.recon-gallery-drawer/)
  assert.doesNotMatch(swipeBlocker, /\.output-scroll/)
  assert.ok(commandCueHandler)
  assert.match(commandCueHandler, /playRobotConfirmCue/)
  assert.doesNotMatch(commandCueHandler, /commandCuePlayer\.play/)
  assert.match(piConfirmCue, /dogzillaAudio\.playPiCue\('confirm'\)/)
  assert.match(piConfirmCue, /dogzillaAudio\.shouldSuppressLocalAudio\(\)/)
  assert.match(piConfirmCue, /return commandCuePlayer\.play\(\)/)
  assert.match(piThinkingCue, /dogzillaAudio\.playPiCue\('thinking-start'\)/)
  assert.match(piThinkingCue, /dogzillaAudio\.shouldSuppressLocalAudio\(\)/)
  assert.match(piThinkingCue, /return thinkingCuePlayer\.play\(\)/)
  assert.match(suppressLocalAudio, /isAndroidAppShell/)
  assert.match(dogzillaPiCue, /const volume = getVolume\(\)/)
  assert.match(dogzillaAudioJs, /DOGZILLA_AUDIO_VOLUME_KEY/)
  assert.match(lidarFailureFormatter, /serialDiagnostics/)
  assert.match(lidarFailureFormatter, /realPath/)
  assert.match(appJs, /apiFetch\('\/api\/dogzilla\/connection'/)
  assert.match(dogzillaAudioJs, /apiFetch\('\/api\/dogzilla\/audio\/cue'/)
  assert.match(appJs, /apiFetch\('\/api\/dogzilla\/preflight'/)
  assert.match(css, /html\.android-app \.connection-toggle/)
  assert.match(css, /html\.android-app \.connection-drawer/)
  assert.match(css, /\.confirm-modal-overlay\[hidden\]\s*{\s*display:\s*none;/)
  assert.match(css, /\.camera-rail-icon/)
  assert.match(css, /\.dogzilla-audio-volume/)
  assert.match(css, /\.recon-gallery-drawer/)
  assert.match(css, /\.recon-snapshot-list/)
  assert.match(css, /\.recon-snapshot-note-editor/)
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(css, /html\.android-app \.settings-drawer[\s\S]+background: var\(--panel\)/)
  assert.match(css, /html\.android-app \.connection-drawer[\s\S]+background: var\(--panel\)/)
  assert.match(css, /html\.android-app \.console-layout[\s\S]+touch-action: pan-y/)
  assert.match(css, /html\.android-app \.connection-backend-row/)
})

async function readCssBundle() {
  const [mainCss, chunkNames] = await Promise.all([
    readFile('public/styles.css', 'utf-8'),
    readdir('public/styles'),
  ])
  const chunks = await Promise.all(
    chunkNames
      .filter((name) => name.endsWith('.css'))
      .sort()
      .map((name) => readFile(`public/styles/${name}`, 'utf-8')),
  )
  return [mainCss, ...chunks].join('\n')
}
