import { createSpeechInputController } from './speech-input.js'
import { createCommandCuePlayer } from './command-cue.js'
import { splitRecentChatHistory } from './chat-history.js'
import { apiFetch, getApiBaseUrl, setApiBaseUrl, toApiUrl } from './api-client.js'
import { createDogzillaAudioController } from './dogzilla-audio.js'
import { createManualControlController } from './manual-control.js'
import {
  createRobotMapRenderer,
  formatWaypointReadinessSummary,
} from './robot-map.js'
import {
  buildNavChainComponents,
  deriveOperatorLastCommand,
  deriveSafeNextAction,
  getConnectionActionConfirmation,
  isDangerousConnectionAction,
  summarizeNavChain,
} from './operator-status.js'

const appEyebrow = document.querySelector('#app-eyebrow')
const appTitle = document.querySelector('#app-title')
const appTitleText = document.querySelector('#app-title-text')
const appDescription = document.querySelector('#app-description')
const profileName = document.querySelector('#profile-name')
const profileSource = document.querySelector('#profile-source')
const providerName = document.querySelector('#provider-name')
const modelName = document.querySelector('#model-name')
const promptFile = document.querySelector('#prompt-file')
const schemaFile = document.querySelector('#schema-file')
const commandTypesFile = document.querySelector('#command-types-file')
const waypointsFile = document.querySelector('#waypoints-file')
const robotRuntimeFile = document.querySelector('#robot-runtime-file')
const robotRos2File = document.querySelector('#robot-ros2-file')
const profileSelect = document.querySelector('#profile-select')
const saveProfileButton = document.querySelector('#save-profile-button')
const profileLockNote = document.querySelector('#profile-lock-note')
const settingsStatus = document.querySelector('#settings-status')
const robotTargetSelect = document.querySelector('#robot-target-select')
const saveRobotTargetButton = document.querySelector('#save-robot-target-button')
const robotTargetLockNote = document.querySelector('#robot-target-lock-note')
const robotTargetStatus = document.querySelector('#robot-target-status')
const testRobotSitButton = document.querySelector('#test-robot-sit-button')
const robotSitTestStatus = document.querySelector('#robot-sit-test-status')
const manualControlPanel = document.querySelector('#manual-control-panel')
const manualControlChip = document.querySelector('#manual-control-chip')
const manualControlToggleButton = document.querySelector('#manual-control-toggle-button')
const manualControlNeutralButton = document.querySelector('#manual-control-neutral-button')
const manualControlStatus = document.querySelector('#manual-control-status')
const manualControlPadName = document.querySelector('#manual-control-pad-name')
const manualControlForwardValue = document.querySelector('#manual-control-forward-value')
const manualControlStrafeValue = document.querySelector('#manual-control-strafe-value')
const manualControlTurnValue = document.querySelector('#manual-control-turn-value')
const manualControlForwardMeter = document.querySelector('#manual-control-forward-meter')
const manualControlStrafeMeter = document.querySelector('#manual-control-strafe-meter')
const manualControlTurnMeter = document.querySelector('#manual-control-turn-meter')
const speechPanel = document.querySelector('.speech-panel')
const speechProfileName = document.querySelector('#speech-profile-name')
const speechProfileSelect = document.querySelector('#speech-profile-select')
const saveSpeechProfileButton = document.querySelector('#save-speech-profile-button')
const speechLockNote = document.querySelector('#speech-lock-note')
const speechSettingsStatus = document.querySelector('#speech-settings-status')
const speechStatus = document.querySelector('#speech-status')
const speechPreview = document.querySelector('#speech-preview')
const NAV_STATUS_ICONS = {
  navigating: '\u2192',
  finding_waypoint: '\u2753',
  arrived: '\u2713',
  stuck: '\u2717',
  blocked: '\u26A0',
  ready: '\u25CF',
  idle: '\u25CB',
  repairing: '\u2699',
  unknown: '',
}

const speechFiles = document.querySelector('#speech-files')
const runtimePanel = document.querySelector('.runtime-panel')
const runtimeTargetChip = document.querySelector('#runtime-target-chip')
const runtimeFeedbackStatus = document.querySelector('#runtime-feedback-status')
const runtimeFeedbackOutput = document.querySelector('#runtime-feedback-output')
const runtimeFiles = document.querySelector('#runtime-files')
const robotStatePanel = document.querySelector('#robot-state-panel')
const robotStateChip = document.querySelector('#robot-state-chip')
const robotStateName = document.querySelector('#robot-state-name')
const robotStateTask = document.querySelector('#robot-state-task')
const robotStateSeq = document.querySelector('#robot-state-seq')
const robotBatteryMeter = document.querySelector('#robot-battery-meter')
const robotBatteryValue = document.querySelector('#robot-battery-value')
const robotTelemetryMeta = document.querySelector('#robot-telemetry-meta')
const robotNavStatus = document.querySelector('#robot-nav-status')
const robotNavTarget = document.querySelector('#robot-nav-target')
const robotNavStatusRow = document.querySelector('#robot-nav-status-row')
const robotMapTrack = document.querySelector('#robot-map-track')
const robotMapWaypoints = document.querySelector('#robot-map-waypoints')
const robotMapDot = document.querySelector('#robot-map-dot')
const robotMapElement = document.querySelector('#robot-map')
const robotLidarScan = document.querySelector('#robot-lidar-scan')
const robotMapMeta = document.querySelector('#robot-map-meta')
const robotMapGridMeta = document.querySelector('#robot-map-grid-meta')
const robotPoseReadout = document.querySelector('#robot-pose-readout')
const robotNavBadge = document.querySelector('#robot-nav-badge')
const robotMapPanel = document.querySelector('.robot-map-panel')
const robotCameraPanel = document.querySelector('#robot-camera-panel')
const robotCameraFrame = document.querySelector('#robot-camera-frame')
const robotCameraChip = document.querySelector('#robot-camera-chip')
const robotCameraMeta = document.querySelector('#robot-camera-meta')
const robotCameraRefreshButton = document.querySelector('#robot-camera-refresh-button')
const robotCameraRecoverButton = document.querySelector('#robot-camera-recover-button')
const robotCameraSnapshotButton = document.querySelector('#robot-camera-snapshot-button')
const robotCameraSnapshotNote = document.querySelector('#robot-camera-snapshot-note')
const reconGalleryToggle = document.querySelector('#recon-gallery-toggle')
const reconGalleryDrawer = document.querySelector('#recon-gallery-drawer')
const reconGalleryClose = document.querySelector('#recon-gallery-close')
const reconGalleryStatus = document.querySelector('#recon-gallery-status')
const reconGalleryCount = document.querySelector('#recon-gallery-count')
const reconSnapshotList = document.querySelector('#recon-snapshot-list')
const settingsToggle = document.querySelector('#settings-toggle')
const settingsDrawer = document.querySelector('#settings-drawer')
const connectionToggle = document.querySelector('#connection-toggle')
const connectionDrawer = document.querySelector('#connection-drawer')
const helpToggle = document.querySelector('#help-toggle')
const helpDrawer = document.querySelector('#help-drawer')
const helpMermaidContainer = document.querySelector('#help-mermaid-container')
const helpMermaidFallback = document.querySelector('#help-mermaid-fallback')
const connectionChip = document.querySelector('#connection-chip')
const dogzillaBackendUrlInput = document.querySelector('#dogzilla-backend-url-input')
const saveDogzillaBackendButton = document.querySelector('#save-dogzilla-backend-button')
const connectionBackendStatus = document.querySelector('#connection-backend-status')
const dogzillaHostInput = document.querySelector('#dogzilla-host-input')
const dogzillaUserInput = document.querySelector('#dogzilla-user-input')
const dogzillaRemoteRootInput = document.querySelector('#dogzilla-remote-root-input')
const saveDogzillaConnectionButton = document.querySelector('#save-dogzilla-connection-button')
const connectionStatus = document.querySelector('#connection-status')
const dogzillaRobotId = document.querySelector('#dogzilla-robot-id')
const dogzillaDirectUrl = document.querySelector('#dogzilla-direct-url')
const dogzillaRos2Url = document.querySelector('#dogzilla-ros2-url')
const dogzillaAudioVolumeInput = document.querySelector('#dogzilla-audio-volume-input')
const dogzillaAudioVolumeValue = document.querySelector('#dogzilla-audio-volume-value')
const connectionOutput = document.querySelector('#connection-output')
const connectionActionButtons = document.querySelectorAll('[data-connection-action]')
const runDogzillaPreflightButton = document.querySelector('#run-dogzilla-preflight-button')
const dogzillaPreflightStatus = document.querySelector('#dogzilla-preflight-status')
const dogzillaPreflightSummary = document.querySelector('#dogzilla-preflight-summary')
const dogzillaPreflightChecks = document.querySelector('#dogzilla-preflight-checks')
const dogzillaPreflightOutput = document.querySelector('#dogzilla-preflight-output')
const robotTabs = document.querySelectorAll('.robot-tab')
const primaryRobotTab = document.querySelector('.robot-tab[data-robot-view="overview"]')
const primaryRobotTabName = document.querySelector('#primary-robot-tab-name')
const robotNameEditButton = document.querySelector('#robot-name-edit-button')
const robotNameEditForm = document.querySelector('#robot-name-edit-form')
const robotNameInput = document.querySelector('#robot-name-input')
const form = document.querySelector('#chat-form')
const input = document.querySelector('#user-input')
const sendButton = document.querySelector('#send-button')
const status = document.querySelector('#status')
const statusText = document.querySelector('#status-text')
const statusTimer = document.querySelector('#status-timer')
const chatLog = document.querySelector('#chat-log')
const parsedOutput = document.querySelector('#parsed-output')
const emptyMessageRole = document.querySelector('#empty-message-role')
const emptyMessageBubble = document.querySelector('#empty-message-bubble')
const emptyMessageMeta = document.querySelector('#empty-message-meta')
const EMPTY_CHAT_SELECTOR = '.message-empty'
const MESSAGE_SELECTOR = '.message:not(.message-empty)'
const COMMAND_CUE_URLS = [
  '/sounds/robot-bark-synthetic.wav',
]
const THINKING_CUE_URLS = [
  '/sounds/robot-think-whimper-1.wav',
  '/sounds/robot-think-whimper-2.wav',
  '/sounds/robot-think-pant-1.wav',
]
const ANDROID_LOCAL_MODEL_PROVIDER = 'llama-cpp-http'
const MOBILE_VIEWS = ['robot', 'chat', 'audio']
const MOBILE_DEFAULT_VIEW = 'chat'
const MOBILE_SWIPE_INTENT_PX = 14
const MOBILE_SWIPE_MIN_PX = 34
const MOBILE_SWIPE_MAX_MS = 1200
const MOBILE_SWIPE_HORIZONTAL_RATIO = 1.05
const MOBILE_SWIPE_VERTICAL_CANCEL_RATIO = 1.2
const DEFAULT_ACTIVATION_PHRASES = ['hey kukura', 'ok kukura', 'okay kukura', 'kukura']
const DEFAULT_SPEECH_ACTIVE_PROFILE = {
  silenceDurationMs: 500,
  activationCommandWindowMs: 8000,
  minimumSpeechMs: 300,
  speechThreshold: 0.015,
}
const DEFAULT_ROBOT_RUNTIME = {
  robotId: 'dogzilla-local',
  robotName: 'Questing Beast',
  robotModel: 'dogzilla-s2',
  activeTarget: {
    id: 'isaacsim',
    label: 'Isaac Sim',
    kind: 'isaacsim',
    source: 'runtime',
    selectionLocked: false,
  },
  availableTargets: [],
  enabled: true,
  dryRun: true,
  runtimeFile: 'config/robot-runtime.json',
  ros2ConfigFile: 'config/robot-ros2.json',
  waypointsFile: 'config/robot-waypoints.json',
  motionFile: 'config/robot-motion.json',
  feedbackPollMs: 2500,
  statePollMs: 125,
  stateSnapshotPath: '/api/robot/state',
  stateStreamPath: '/api/robot/state/stream',
  waypointReadinessPath: '/api/dogzilla/waypoint-readiness',
  waypointSet: 'home',
  waypoints: [],
  waypointReadiness: null,
  selectionLocked: false,
  source: 'runtime',
}
const DOGZILLA_CAMERA_LOAD_TIMEOUT_MS = 8000

let thinkingState = null
let robotFeedbackTimerId = null
let robotStateTimerId = null
let robotLidarTimerId = null
let robotMapTimerId = null
let robotCameraLoadTimerId = null
let activeThinkingCue = null
let thinkingCueToken = 0
let reconSnapshots = []
const commandCuePlayer = createCommandCuePlayer(COMMAND_CUE_URLS, {
  gain: 0.28,
  playbackRate: 1,
  detune: -20,
  distortion: 5,
  bits: 14,
  reduction: 1,
})
const thinkingCuePlayer = createCommandCuePlayer(THINKING_CUE_URLS, {
  gain: 0.12,
  playbackRate: 0.98,
  detune: -70,
  distortion: 8,
  bits: 13,
  reduction: 1,
})
let appConfig = {
  assistantName: 'Assistant',
  pageTitle: 'Questing Beast',
  consoleTitle: 'Questing Beast',
  sendButtonLabel: 'Ask Assistant',
  thinkingStatus: 'Assistant is thinking',
  introEyebrow: 'Quadruped inspection console',
  introDescription: '',
  emptyChatMessage: 'Waiting for first message.',
  emptyChatMeta: 'Prompt ready.',
  waitingForJsonMessage: 'Waiting for valid JSON.',
}
let runtimeConfig = {
  activeProfile: {
    id: '',
    label: 'No profile',
    provider: 'Unknown',
    model: 'Unknown',
    baseUrl: '',
    modelPath: '',
    temperature: 0.15,
    maxTokens: 120,
    source: 'default',
    selectionLocked: false,
  },
  availableProfiles: [],
  systemPromptPreview: '',
  speech: {
    activeProfile: null,
    availableProfiles: [],
    profileFile: 'config/speech-profiles.json',
    runtimeFile: 'config/speech-runtime.json',
    sidecarConfigFile: 'config/speech-sidecar.json',
    activationPhrasesFile: 'config/activation_phrases.txt',
    activationPhrases: DEFAULT_ACTIVATION_PHRASES,
  },
  robotRuntime: { ...DEFAULT_ROBOT_RUNTIME },
  dogzilla: {
    camera: null,
    lidar: null,
  },
}
let dogzillaConnection = null
let speechController = null
let mobileView = MOBILE_DEFAULT_VIEW
let mobileTouch = null
let dogzillaStartupRepairAttempted = false
let lastOperatorCommand = null

function recordOperatorCommand({ command, result } = {}) {
  const cmd = typeof command === 'string' ? command.trim() : ''
  const res = typeof result === 'string' || typeof result === 'number' ? String(result).trim() : ''
  if (!cmd && !res) {
    return
  }
  lastOperatorCommand = {
    command: cmd || null,
    result: res || null,
    at: Date.now(),
  }
}
const isaacCompletionState = {
  initialized: false,
  lastEventId: null,
}
const dogzillaAudio = createDogzillaAudioController({
  input: dogzillaAudioVolumeInput,
  value: dogzillaAudioVolumeValue,
  apiFetch,
  getRuntimeConfig: () => runtimeConfig,
  isAndroidAppShell,
})
const manualControl = createManualControlController({
  elements: {
    panel: manualControlPanel,
    chip: manualControlChip,
    toggleButton: manualControlToggleButton,
    neutralButton: manualControlNeutralButton,
    status: manualControlStatus,
    padName: manualControlPadName,
    forwardValue: manualControlForwardValue,
    strafeValue: manualControlStrafeValue,
    turnValue: manualControlTurnValue,
    forwardMeter: manualControlForwardMeter,
    strafeMeter: manualControlStrafeMeter,
    turnMeter: manualControlTurnMeter,
  },
  apiFetch,
  toApiUrl,
  getRuntimeConfig: () => runtimeConfig,
  isRealRobotTargetActive,
  formatError,
  setStatus,
  runtimeFeedbackOutput,
  playBarkCue: () => dogzillaAudio.playPiCue('bark'),
})
const robotMap = createRobotMapRenderer({
  elements: {
    map: robotMapElement,
    dot: robotMapDot,
    lidarScan: robotLidarScan,
    meta: robotMapMeta,
    poseReadout: robotPoseReadout,
    track: robotMapTrack,
    waypoints: robotMapWaypoints,
    navStatusBadge: robotNavBadge,
  },
  defaultRobotRuntime: DEFAULT_ROBOT_RUNTIME,
  getRuntimeConfig: () => runtimeConfig,
  formatEventTimestamp,
})

initAndroidAppShell()
boot()

form.addEventListener('submit', handleChatSubmit)
saveProfileButton.addEventListener('click', handleProfileSave)
saveSpeechProfileButton.addEventListener('click', handleSpeechProfileSave)
saveRobotTargetButton.addEventListener('click', handleRobotTargetSave)
testRobotSitButton.addEventListener('click', handleRobotSitTest)
const persistentEmergencyStop = document.getElementById('persistent-emergency-stop')
persistentEmergencyStop?.addEventListener('click', handleEmergencyStop)

const confirmModalOverlay = document.getElementById('confirm-modal-overlay')
const confirmModalTitle = document.getElementById('confirm-modal-title')
const confirmModalMessage = document.getElementById('confirm-modal-message')
const confirmModalCancel = document.getElementById('confirm-modal-cancel')
const confirmModalConfirm = document.getElementById('confirm-modal-confirm')
let confirmModalResolve = null

function showConfirmModal(title, message) {
  return new Promise((resolve) => {
    confirmModalResolve = resolve
    confirmModalTitle.textContent = title
    confirmModalMessage.textContent = message
    confirmModalOverlay.hidden = false
    confirmModalCancel.focus()
  })
}

function hideConfirmModal() {
  confirmModalOverlay.hidden = true
  confirmModalResolve = null
}

confirmModalCancel?.addEventListener('click', () => {
  if (confirmModalResolve) {
    confirmModalResolve(false)
  }
  hideConfirmModal()
})

confirmModalConfirm?.addEventListener('click', () => {
  if (confirmModalResolve) {
    confirmModalResolve(true)
  }
  hideConfirmModal()
})

confirmModalOverlay?.addEventListener('click', (event) => {
  if (event.target === confirmModalOverlay) {
    if (confirmModalResolve) {
      confirmModalResolve(false)
    }
    hideConfirmModal()
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !confirmModalOverlay?.hidden) {
    if (confirmModalResolve) {
      confirmModalResolve(false)
    }
    hideConfirmModal()
  }
})
manualControlToggleButton.addEventListener('click', manualControl.handleToggle)
manualControlNeutralButton.addEventListener('click', manualControl.handleNeutral)
settingsToggle.addEventListener('click', handleSettingsToggle)
connectionToggle.addEventListener('click', handleConnectionToggle)
helpToggle.addEventListener('click', handleHelpToggle)
const navChainDots = document.querySelector('#robot-nav-chain-dots')
navChainDots?.addEventListener('click', handleNavChainDotsClick)
navChainDots?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    handleNavChainDotsClick()
  }
})
robotNameEditButton.addEventListener('click', handleRobotNameEditStart)
robotNameEditForm.addEventListener('submit', handleRobotNameSave)
robotNameInput.addEventListener('keydown', handleRobotNameInputKeydown)
saveDogzillaBackendButton.addEventListener('click', handleDogzillaBackendSave)
saveDogzillaConnectionButton.addEventListener('click', handleDogzillaConnectionSave)
runDogzillaPreflightButton.addEventListener('click', handleDogzillaPreflight)
dogzillaAudioVolumeInput?.addEventListener('input', dogzillaAudio.handleVolumeInput)
robotCameraSnapshotButton.addEventListener('click', handleReconSnapshot)
robotCameraRefreshButton.addEventListener('click', handleDogzillaCameraRefresh)
robotCameraRecoverButton.addEventListener('click', handleDogzillaCameraRecover)
reconGalleryToggle.addEventListener('click', handleReconGalleryToggle)
reconGalleryClose.addEventListener('click', closeReconGallery)
reconSnapshotList.addEventListener('click', handleReconSnapshotListClick)

for (const button of connectionActionButtons) {
  button.addEventListener('click', handleDogzillaConnectionAction)
}

const waypointCaptureButton = document.getElementById('waypoint-capture-button')
const waypointCaptureInput = document.getElementById('waypoint-capture-name')
const waypointCaptureStatus = document.getElementById('waypoint-capture-status')
const waypointReadinessButton = document.getElementById('waypoint-readiness-button')
const mapWorkflowPanel = document.getElementById('map-workflow-panel')
const mapWorkflowStatus = document.getElementById('map-workflow-status')
waypointCaptureButton?.addEventListener('click', handleWaypointCapture)
waypointReadinessButton?.addEventListener('click', handleWaypointReadinessCheck)

const mapViewToggle = document.getElementById('map-view-toggle')
const mapViewModeLabel = document.querySelector('.map-view-mode-label')
mapViewToggle?.addEventListener('click', handleMapViewToggle)

document.querySelectorAll('.robot-map-zoom-btn[data-zoom-action]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.getAttribute('data-zoom-action')
    if (action === 'in') {
      robotMap.setZoom(robotMap.getZoom() - 0.25)
    } else if (action === 'out') {
      robotMap.setZoom(robotMap.getZoom() + 0.25)
    }
  })
})

for (const tab of robotTabs) {
  tab.addEventListener('click', handleRobotTabClick)
}

robotCameraFrame.addEventListener('error', handleDogzillaCameraFrameError)
robotCameraFrame.addEventListener('load', handleDogzillaCameraFrameLoad)
window.addEventListener('gamepadconnected', manualControl.handleGamepadConnected)
window.addEventListener('gamepaddisconnected', manualControl.handleGamepadDisconnected)

function initAndroidAppShell() {
  if (!isAndroidAppShell()) {
    return
  }

  document.documentElement.classList.add('android-app')
  setMobileView(MOBILE_DEFAULT_VIEW)
  document.addEventListener('touchstart', handleMobileTouchStart, { passive: true })
  document.addEventListener('touchmove', handleMobileTouchMove, { passive: false })
  document.addEventListener('touchend', handleMobileTouchEnd, { passive: true })
  document.addEventListener('touchcancel', handleMobileTouchCancel, { passive: true })
}

function isAndroidAppShell() {
  const userAgent = navigator.userAgent || ''
  return /Android/i.test(userAgent) && (/\bwv\b/i.test(userAgent) || !!window.__TAURI_INTERNALS__)
}

function handleMobileTouchStart(event) {
  if (
    !document.documentElement.classList.contains('android-app') ||
    isSwipeBlockedTarget(event.target) ||
    event.touches?.length > 1
  ) {
    mobileTouch = null
    return
  }

  const touch = event.changedTouches?.[0] || event.touches?.[0]
  mobileTouch = touch
    ? {
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      at: Date.now(),
      horizontal: false,
      canceled: false,
    }
    : null
}

function handleMobileTouchMove(event) {
  if (!mobileTouch || mobileTouch.canceled) {
    return
  }

  const touch = findTouchById(event.changedTouches, mobileTouch.id) ||
    findTouchById(event.touches, mobileTouch.id)
  if (!touch) {
    return
  }

  const deltaX = touch.clientX - mobileTouch.x
  const deltaY = touch.clientY - mobileTouch.y
  const absX = Math.abs(deltaX)
  const absY = Math.abs(deltaY)

  if (!mobileTouch.horizontal) {
    if (absY >= MOBILE_SWIPE_INTENT_PX && absY > absX * MOBILE_SWIPE_VERTICAL_CANCEL_RATIO) {
      mobileTouch.canceled = true
      return
    }

    mobileTouch.horizontal = absX >= MOBILE_SWIPE_INTENT_PX && absX > absY * MOBILE_SWIPE_HORIZONTAL_RATIO
  }

  if (mobileTouch.horizontal) {
    event.preventDefault()
  }
}

function handleMobileTouchEnd(event) {
  if (!mobileTouch) {
    return
  }

  const touch = findTouchById(event.changedTouches, mobileTouch.id)
  const start = mobileTouch
  mobileTouch = null

  if (!touch || start.canceled) {
    return
  }

  const deltaX = touch.clientX - start.x
  const deltaY = touch.clientY - start.y
  const elapsedMs = Date.now() - start.at

  if (
    elapsedMs > MOBILE_SWIPE_MAX_MS ||
    Math.abs(deltaX) < MOBILE_SWIPE_MIN_PX ||
    Math.abs(deltaX) < Math.abs(deltaY) * MOBILE_SWIPE_HORIZONTAL_RATIO
  ) {
    return
  }

  const currentIndex = MOBILE_VIEWS.indexOf(mobileView)
  const nextIndex = deltaX < 0
    ? Math.min(MOBILE_VIEWS.length - 1, currentIndex + 1)
    : Math.max(0, currentIndex - 1)
  setMobileView(MOBILE_VIEWS[nextIndex])
}

function handleMobileTouchCancel() {
  mobileTouch = null
}

function setMobileView(view) {
  mobileView = MOBILE_VIEWS.includes(view) ? view : MOBILE_DEFAULT_VIEW
  document.documentElement.dataset.mobileView = mobileView
}

function isSwipeBlockedTarget(target) {
  return !!target?.closest?.('textarea, input, select, button, a, [contenteditable="true"], .settings-drawer, .connection-drawer, .recon-gallery-drawer')
}

function findTouchById(touchList, id) {
  for (let index = 0; index < (touchList?.length || 0); index += 1) {
    const touch = touchList[index]
    if (touch.identifier === id) {
      return touch
    }
  }

  return null
}

async function boot() {
  applyBackendControls()
  dogzillaAudio.applyVolumeControl()

  try {
    const payload = await fetchConfig()
    applyPayload(payload)
    await refreshDogzillaConnection()
    startRobotFeedbackPolling()
    startRobotStatePolling()
    startRobotLidarPolling()
    startRobotMapPolling()

    try {
      await initializeSpeechController()
    } catch (error) {
      setSpeechStatus(`Speech setup failed: ${formatError(error)}`, true)
    }

    await refreshRobotFeedback()
    void refreshReconSnapshots()
    void ensureDogzillaRobotLinkReady()
    setStatus(`Ready on ${runtimeConfig.activeProfile.label}. Target: ${runtimeConfig.robotRuntime.activeTarget.label}.`)
  } catch (error) {
    setStatus(`Config load failed: ${formatError(error)}`, 'error')
    setSpeechStatus(`Speech setup failed: ${formatError(error)}`, true)
    setRuntimeFeedbackStatus(`Runtime setup failed: ${formatError(error)}`, true)
  }
}

async function handleChatSubmit(event) {
  event.preventDefault()

  sendButton.disabled = true
  input.disabled = true

  let message = input.value.trim()

  try {
    if (!message && speechController?.prepareInputForSubmit) {
      message = (await speechController.prepareInputForSubmit())?.trim() || ''
    }
  } catch (error) {
    setStatus(`Speech transcription failed: ${formatError(error)}`, 'error')
    sendButton.disabled = false
    input.disabled = false
    input.focus()
    return
  }

  if (!message) {
    setStatus('Enter a message first.', 'error')
    sendButton.disabled = false
    input.disabled = false
    input.focus()
    return
  }

  clearEmptyChat()
  appendMessage({
    role: 'You',
    text: message,
    type: 'user',
    meta: 'Sent just now.',
  })

  const pendingMessage = appendMessage({
    role: appConfig.assistantName,
    text: 'Thinking.',
    type: 'assistant',
    pending: true,
    meta: `Using ${runtimeConfig.activeProfile.label}. Target ${runtimeConfig.robotRuntime.activeTarget.label}.`,
  })

  input.value = ''
  thinkingState = startThinkingFeedback(pendingMessage)

  try {
    const payload = await submitChatMessage(message)

    recordOperatorCommand({
      command: message,
      result: payload?.robotDispatch?.status || payload?.isaacDispatch?.status || null,
    })

    const completionMeta = buildAssistantMeta(payload, thinkingState?.startedAt ?? Date.now())
    const completionState = isActiveDispatchFailure(payload) ? 'error' : 'idle'

    finishThinkingFeedback(pendingMessage, {
      text: buildAssistantText(payload),
      meta: completionMeta,
    })
    playCommandCueIfNeeded(payload.parsed)
    parsedOutput.textContent = formatParsedOutput(payload)
    setStatus(buildCompletionStatus(payload), completionState)
    await refreshRobotFeedback()
  } catch (error) {
    finishThinkingFeedback(pendingMessage, {
      text: `Error: ${formatError(error)}`,
      meta: 'Request failed.',
      error: true,
    })
    parsedOutput.textContent = 'No JSON parsed.'
    setStatus(formatError(error), 'error')
  } finally {
    sendButton.disabled = false
    input.disabled = false
    input.focus()
    thinkingState = null
  }
}

async function submitChatMessage(message) {
  if (shouldUseAndroidLocalModel()) {
    return submitAndroidLocalModelMessage(message)
  }

  const response = await apiFetch('/api/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ input: message }),
  })

  const payload = await response.json()
  if (!response.ok) {
    throw new Error(payload.error || 'Request failed.')
  }

  return payload
}

function shouldUseAndroidLocalModel() {
  return isAndroidAppShell() && runtimeConfig.activeProfile.provider === ANDROID_LOCAL_MODEL_PROVIDER
}

async function submitAndroidLocalModelMessage(message) {
  const rawResponse = await queryAndroidLocalModel({
    input: message,
    profile: runtimeConfig.activeProfile,
    systemPrompt: runtimeConfig.systemPromptPreview,
  })
  const response = await apiFetch('/api/chat/result', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      input: message,
      rawResponse,
    }),
  })
  const payload = await response.json()

  if (!response.ok) {
    throw new Error(payload.error || 'Local model result failed.')
  }

  return payload
}

async function queryAndroidLocalModel({ input, profile, systemPrompt }) {
  const baseUrl = profile.baseUrl || 'http://127.0.0.1:8080/v1'
  const endpoint = `${trimTrailingSlash(baseUrl)}/chat/completions`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: profile.model || 'robo-doge-local-gguf',
      temperature: profile.temperature ?? 0.1,
      max_tokens: profile.maxTokens ?? 96,
      messages: [
        { role: 'system', content: systemPrompt || '' },
        { role: 'user', content: input },
      ],
    }),
  })

  if (!response.ok) {
    const detail = await safeReadText(response)
    throw new Error(`Android llama.cpp request failed (${response.status}): ${detail || response.statusText}`)
  }

  const payload = await response.json()
  const content = normalizeOpenAiCompatibleContent(payload?.choices?.[0]?.message?.content)

  if (content) {
    return content
  }

  throw new Error('Android llama.cpp returned an empty response.')
}

async function handleProfileSave() {
  const nextProfileId = profileSelect.value

  if (!nextProfileId) {
    settingsStatus.textContent = 'Select a profile first.'
    return
  }

  if (nextProfileId === runtimeConfig.activeProfile.id) {
    settingsStatus.textContent = `Already using ${runtimeConfig.activeProfile.label}.`
    return
  }

  saveProfileButton.disabled = true
  profileSelect.disabled = true
  settingsStatus.textContent = 'Saving profile...'

  try {
    const response = await apiFetch('/api/settings/profile', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ profileId: nextProfileId }),
    })
    const payload = await response.json()

    if (!response.ok) {
      throw new Error(payload.error || 'Could not update profile.')
    }

    applyPayload(payload)
    settingsStatus.textContent = `Using ${runtimeConfig.activeProfile.label}.`
    setStatus(`Profile changed to ${runtimeConfig.activeProfile.label}.`)
  } catch (error) {
    settingsStatus.textContent = formatError(error)
    setStatus(formatError(error), 'error')
  } finally {
    applyProfileSelectionState()
  }
}

async function handleSpeechProfileSave() {
  const nextProfileId = speechProfileSelect.value
  const activeSpeechProfile = runtimeConfig.speech.activeProfile

  if (!nextProfileId) {
    speechSettingsStatus.textContent = 'Select a speech profile first.'
    return
  }

  if (nextProfileId === activeSpeechProfile?.id) {
    speechSettingsStatus.textContent = `Already using ${activeSpeechProfile.label}.`
    return
  }

  saveSpeechProfileButton.disabled = true
  speechProfileSelect.disabled = true
  speechSettingsStatus.textContent = 'Saving speech profile...'

  try {
    const response = await apiFetch('/api/settings/speech-profile', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ profileId: nextProfileId }),
    })
    const payload = await response.json()

    if (!response.ok) {
      throw new Error(payload.error || 'Could not update speech profile.')
    }

    applyPayload(payload)
    try {
      await initializeSpeechController()
      speechSettingsStatus.textContent = `Using ${runtimeConfig.speech.activeProfile.label}.`
    } catch (error) {
      speechSettingsStatus.textContent = `Using ${runtimeConfig.speech.activeProfile.label} with speech error.`
      setSpeechStatus(formatError(error), true)
    }
    setStatus(`Speech profile changed to ${runtimeConfig.speech.activeProfile.label}.`)
  } catch (error) {
    speechSettingsStatus.textContent = formatError(error)
    setSpeechStatus(formatError(error), true)
  } finally {
    const locked = runtimeConfig.speech.activeProfile?.selectionLocked
    speechProfileSelect.disabled = locked
    saveSpeechProfileButton.disabled = locked
  }
}

async function handleRobotTargetSave() {
  const nextTargetId = robotTargetSelect.value
  const activeTarget = runtimeConfig.robotRuntime.activeTarget

  if (!nextTargetId) {
    robotTargetStatus.textContent = 'Select a robot target first.'
    return
  }

  if (nextTargetId === activeTarget?.id) {
    robotTargetStatus.textContent = `Already targeting ${activeTarget.label}.`
    return
  }

  saveRobotTargetButton.disabled = true
  robotTargetSelect.disabled = true
  robotTargetStatus.textContent = 'Saving runtime target...'
  if (manualControl.isEnabled()) {
    manualControl.disable({ sendNeutral: true })
  }

  try {
    const response = await apiFetch('/api/settings/robot-target', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ targetId: nextTargetId }),
    })
    const payload = await response.json()

    if (!response.ok) {
      throw new Error(payload.error || 'Could not update robot target.')
    }

    applyPayload(payload)
    startRobotFeedbackPolling()
    startRobotStatePolling()
    startRobotLidarPolling()
    startRobotMapPolling()
    await refreshRobotFeedback()
    robotTargetStatus.textContent = `Targeting ${runtimeConfig.robotRuntime.activeTarget.label}.`
    setStatus(`Runtime target changed to ${runtimeConfig.robotRuntime.activeTarget.label}.`)
  } catch (error) {
    robotTargetStatus.textContent = formatError(error)
    setStatus(formatError(error), 'error')
  } finally {
    applyRobotTargetSelectionState()
  }
}

async function handleRobotSitTest() {
  testRobotSitButton.disabled = true
  robotSitTestStatus.textContent = 'Sending sit test...'

  try {
    const healthResponse = await apiFetch('/api/robot/health')
    const healthPayload = await healthResponse.json()

    if (!healthResponse.ok) {
      throw new Error(healthPayload.error || 'Robot health check failed.')
    }
    if (!['ok', 'degraded'].includes(healthPayload.status)) {
      throw new Error(`Robot bridge ${healthPayload.status || 'unavailable'}.`)
    }

    const dispatchResponse = await apiFetch('/api/robot/dispatch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        input: 'settings:sit-test',
        parsed: {
          command: 'trick',
          waypoint: 'current_position',
          trick: 'sit',
        },
      }),
    })
    const dispatchPayload = await dispatchResponse.json()

    if (!dispatchResponse.ok) {
      throw new Error(dispatchPayload.error || 'Robot sit test failed.')
    }

    const summary = formatRobotSitTestSummary(healthPayload, dispatchPayload.preview, dispatchPayload.dispatch)
    robotSitTestStatus.textContent = summary
    runtimeFeedbackOutput.textContent = JSON.stringify({
      health: healthPayload,
      sitTest: dispatchPayload,
    }, null, 2)
    setRuntimeFeedbackStatus(summary, dispatchPayload.dispatch?.status === 'error' || healthPayload.status === 'error')
    setStatus(summary, dispatchPayload.dispatch?.status === 'error' ? 'error' : 'idle')
    recordOperatorCommand({
      command: 'sit-test',
      result: dispatchPayload.dispatch?.status || null,
    })
    await refreshRobotState()
  } catch (error) {
    const message = formatError(error)
    robotSitTestStatus.textContent = message
    setStatus(message, 'error')
  } finally {
    testRobotSitButton.disabled = false
  }
}

async function handleEmergencyStop(event) {
  const triggerButton = event?.currentTarget
  if (triggerButton) {
    triggerButton.disabled = true
  }
  setStatus('Sending emergency stop.', 'busy')

  try {
    const response = await apiFetch('/api/robot/stop', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'stop' }),
    })
    const payload = await response.json()

    if (!response.ok || payload.dispatch?.status === 'error') {
      throw new Error(payload.dispatch?.error || payload.error || 'Emergency stop failed.')
    }

    const summary = formatEmergencyStopSummary(payload.dispatch)
    runtimeFeedbackOutput.textContent = JSON.stringify({
      emergencyStop: payload,
    }, null, 2)
    setRuntimeFeedbackStatus(summary, false)
    setStatus(summary)
    recordOperatorCommand({
      command: 'emergency-stop',
      result: payload.dispatch?.status || null,
    })
    await refreshRobotFeedback()
    await refreshRobotState()
  } catch (error) {
    const message = formatError(error)
    setStatus(message, 'error')
  } finally {
    if (triggerButton) {
      triggerButton.disabled = false
    }
  }
}

async function handleDogzillaBackendSave() {
  saveDogzillaBackendButton.disabled = true
  dogzillaBackendUrlInput.disabled = true
  connectionBackendStatus.textContent = 'Checking backend...'

  try {
    const label = await saveBackendUrl(dogzillaBackendUrlInput.value)
    connectionBackendStatus.textContent = `Connected: ${label}`
  } catch (error) {
    connectionBackendStatus.textContent = formatError(error)
    setStatus(`Backend failed: ${formatError(error)}`, 'error')
  } finally {
    saveDogzillaBackendButton.disabled = false
    dogzillaBackendUrlInput.disabled = false
  }
}

async function saveBackendUrl(value) {
  const requestedBackendUrl = String(value || '').trim()
  const nextBaseUrl = setApiBaseUrl(requestedBackendUrl)
  if (requestedBackendUrl && !nextBaseUrl) {
    throw new Error('Backend URL must start with http:// or https://.')
  }
  applyBackendControls()

  const payload = await fetchConfig()
  applyPayload(payload)
  await refreshDogzillaConnection()
  startRobotFeedbackPolling()
  startRobotStatePolling()
  startRobotLidarPolling()
  startRobotMapPolling()

  try {
    await initializeSpeechController()
  } catch (error) {
    setSpeechStatus(`Speech setup failed: ${formatError(error)}`, true)
  }

  await refreshRobotFeedback()
  const label = nextBaseUrl || 'same-origin backend'
  setStatus(`Backend connected: ${label}.`)
  return label
}

async function initializeSpeechController() {
  await speechController?.dispose?.()
  speechController?.stop?.()
  speechController = await createSpeechInputController({
    input,
    speechConfig: runtimeConfig.speech,
    onStatus: setSpeechStatus,
    onTranscript: updateSpeechPreview,
    onVoiceCommand: handleVoiceCommand,
    submitLabel: appConfig.sendButtonLabel,
  })
  await speechController.start()
}

async function refreshRobotFeedback() {
  try {
    const activeTarget = runtimeConfig.robotRuntime.activeTarget

    if (activeTarget.kind === 'isaacsim') {
      const [healthResponse, feedbackResponse] = await Promise.all([
        apiFetch('/api/isaac/health'),
        apiFetch('/api/isaac/feedback'),
      ])
      const healthPayload = await healthResponse.json()
      const feedbackPayload = await feedbackResponse.json()

      renderRobotFeedback(healthPayload, feedbackPayload)
      announceIsaacCompletionIfNeeded(feedbackPayload)
      return
    }

    const [healthResponse, feedbackResponse] = await Promise.all([
      apiFetch('/api/robot/health'),
      apiFetch('/api/robot/feedback'),
    ])
    const healthPayload = await healthResponse.json()
    const feedbackPayload = await feedbackResponse.json()

    renderRobotFeedback(healthPayload, feedbackPayload)
    void refreshDogzillaWaypointReadiness()
  } catch (error) {
    setRuntimeFeedbackStatus(`Runtime feedback failed: ${formatError(error)}`, true)
    runtimeFeedbackOutput.textContent = 'Runtime feedback unavailable.'
  }
}

function startRobotFeedbackPolling() {
  if (robotFeedbackTimerId) {
    window.clearInterval(robotFeedbackTimerId)
  }

  const pollMs = runtimeConfig.robotRuntime.feedbackPollMs || DEFAULT_ROBOT_RUNTIME.feedbackPollMs
  robotFeedbackTimerId = window.setInterval(() => {
    void refreshRobotFeedback()
  }, pollMs)
}

function startRobotStatePolling() {
  if (robotStateTimerId) {
    window.clearInterval(robotStateTimerId)
    robotStateTimerId = null
  }

  if (!isRealRobotTargetActive()) {
    renderRobotStateInactive()
    return
  }

  robotStatePanel.hidden = false
  void refreshRobotState()

  const pollMs = runtimeConfig.robotRuntime.statePollMs || DEFAULT_ROBOT_RUNTIME.statePollMs
  robotStateTimerId = window.setInterval(() => {
    void refreshRobotState()
  }, pollMs)
}

function startRobotLidarPolling() {
  if (robotLidarTimerId) {
    window.clearInterval(robotLidarTimerId)
    robotLidarTimerId = null
  }

  robotMap.clearLidarScan()

  if (!isRealRobotTargetActive()) {
    robotMap.setLidarSummary('')
    robotMap.setMeta(robotMap.getBaseMeta() || 'Real robot target required for live map.')
    return
  }

  const lidar = runtimeConfig.dogzilla?.lidar
  if (!lidar?.enabled) {
    robotMap.setLidarSummary('Lidar: bridge disabled.')
    robotMap.setMeta(robotMap.getBaseMeta())
    return
  }

  void refreshDogzillaLidarScan()
  robotLidarTimerId = window.setInterval(() => {
    void refreshDogzillaLidarScan()
  }, 750)
}

async function refreshRobotState() {
  if (!isRealRobotTargetActive()) {
    renderRobotStateInactive()
    return
  }

  try {
    const response = await apiFetch(runtimeConfig.robotRuntime.stateSnapshotPath || DEFAULT_ROBOT_RUNTIME.stateSnapshotPath)
    const payload = await response.json()

    if (!response.ok) {
      throw new Error(payload.error || 'Robot state unavailable.')
    }

    renderRobotStateSnapshot(payload)
  } catch (error) {
    robotStatePanel.hidden = false
    robotStatePanel.dataset.state = 'error'
    robotStateChip.textContent = 'Error'
    robotStateName.textContent = 'State stream'
    robotStateTask.textContent = 'Unavailable'
    robotStateSeq.textContent = '-'
    renderBatteryMeter(Number.NaN)
    robotTelemetryMeta.textContent = ''
    robotMap.hideDot()
    robotMap.renderWaypoints()
    robotMap.clearPoseTrack()
    robotMap.setMeta(formatError(error))
  }
}

function startRobotMapPolling() {
  if (robotMapTimerId) {
    window.clearInterval(robotMapTimerId)
    robotMapTimerId = null
  }

  robotMap.setMapData(null)
  document.querySelector('.robot-map-head')?.classList.remove('has-map')

  if (!isRealRobotTargetActive()) {
    return
  }

  void refreshDogzillaMap()
  robotMapTimerId = window.setInterval(() => {
    void refreshDogzillaMap()
  }, 3000)
}

async function refreshDogzillaMap() {
  const mapPath = '/api/dogzilla/map'

  try {
    const response = await apiFetch(mapPath)
    const payload = await response.json()

    if (!response.ok || payload.ok !== true) {
      robotMap.setMapData(null)
      document.querySelector('.robot-map-head')?.classList.remove('has-map')
      if (robotMapGridMeta) {
        robotMapGridMeta.textContent = payload?.status === 'no-map' ? 'No map' : 'Map unavailable'
      }
      return
    }

    robotMap.setMapData(payload)
    if (robotMapGridMeta) {
      robotMapGridMeta.textContent = robotMap.getMapGridMeta() || `Map ${payload.width}x${payload.height}`
    }
    document.querySelector('.robot-map-head')?.classList.add('has-map')
  } catch {
    robotMap.setMapData(null)
    document.querySelector('.robot-map-head')?.classList.remove('has-map')
    if (robotMapGridMeta) {
      robotMapGridMeta.textContent = 'Map unavailable'
    }
  }
}

async function refreshDogzillaLidarScan() {
  const lidar = runtimeConfig.dogzilla?.lidar
  const scanPath = lidar?.proxyScanPath || '/api/dogzilla/lidar/scan'

  try {
    const response = await apiFetch(scanPath)
    const payload = await response.json()

    if (!response.ok || payload.ok !== true) {
      robotMap.clearLidarScan()
      robotMap.setLidarSummary(robotMap.formatLidarFailureSummary(payload))
      return
    }

    robotMap.renderLidarScan(payload)
    robotMap.setLidarSummary(robotMap.formatLidarSummary(payload))
  } catch (error) {
    robotMap.clearLidarScan()
    robotMap.setLidarSummary(`Lidar: ${formatError(error)}`)
  }
}

async function refreshDogzillaWaypointReadiness() {
  if (!isRealRobotTargetActive()) {
    runtimeConfig.robotRuntime.waypointReadiness = null
    robotMap.setWaypointReadiness('')
    renderStaleWaypoints([])
    renderNavigationChainHealth(null)
    return null
  }

  const readinessPath = runtimeConfig.robotRuntime.waypointReadinessPath || DEFAULT_ROBOT_RUNTIME.waypointReadinessPath
  try {
    const response = await apiFetch(readinessPath)
    const payload = await response.json()
    if (!response.ok) {
      throw new Error(payload.error || 'DOGZILLA waypoint readiness unavailable.')
    }

    runtimeConfig.robotRuntime.waypointReadiness = payload
    robotMap.setWaypointReadiness(formatWaypointReadinessSummary(payload))
    renderStaleWaypoints(extractStaleWaypoints(payload))
    renderNavigationChainHealth(payload)
    return payload
  } catch (error) {
    runtimeConfig.robotRuntime.waypointReadiness = null
    robotMap.setWaypointReadiness(`Waypoints not ready: ${formatError(error)}.`)
    renderStaleWaypoints([])
    renderNavigationChainHealth(null)
    return null
  }
}

function extractStaleWaypoints(payload) {
  if (!payload || typeof payload !== 'object') return []
  const results = Array.isArray(payload.results) ? payload.results : []
  return results
    .filter((result) => {
      if (!result || result.kind !== 'map_pose') return false
      if (result.enabled === false && result.verified === true) return true
      if (result.ok === false && result.verified === true) return true
      return false
    })
    .map((result) => {
      const problems = Array.isArray(result.problems) ? result.problems.filter(Boolean) : []
      const reason = problems[0] || result.status || 'stale map identity'
      return {
        name: result.name || 'unknown',
        reason: String(reason),
      }
    })
}

function renderStaleWaypoints(staleWaypoints) {
  const panel = document.querySelector('#stale-waypoints-panel')
  const list = document.querySelector('#stale-waypoints-list')
  if (!panel || !list) return

  if (!staleWaypoints || staleWaypoints.length === 0) {
    panel.hidden = true
    list.replaceChildren()
    return
  }

  panel.hidden = false
  const items = staleWaypoints.map((waypoint) => {
    const li = document.createElement('li')
    li.className = 'stale-waypoints-item'
    li.dataset.waypointName = waypoint.name

    const nameSpan = document.createElement('span')
    nameSpan.className = 'stale-waypoints-name'
    nameSpan.textContent = waypoint.name

    const reasonSpan = document.createElement('span')
    reasonSpan.className = 'stale-waypoints-reason'
    reasonSpan.textContent = waypoint.reason

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'stale-waypoints-recapture'
    button.textContent = 'Re-save'
    button.dataset.waypointName = waypoint.name
    button.addEventListener('click', () => handleStaleWaypointRecapture(waypoint.name))

    li.append(nameSpan, reasonSpan, button)
    return li
  })
  list.replaceChildren(...items)
}

async function handleStaleWaypointRecapture(waypointName) {
  const captureNameInput = document.querySelector('#waypoint-capture-name')
  if (captureNameInput) {
    captureNameInput.value = waypointName
  }
  await handleWaypointCapture({ preventDefault: () => {} })
}

async function handleReconSnapshot() {
  const streamUrl = robotCameraFrame.dataset.streamUrl || ''
  if (!streamUrl) {
    setStatus('Camera stream not configured.', 'error')
    setReconGalleryStatus('Camera stream not configured.', true)
    return
  }

  const originalLabel = robotCameraSnapshotButton.textContent
  robotCameraSnapshotButton.disabled = true
  robotCameraSnapshotButton.textContent = 'Saving'
  robotCameraChip.textContent = 'Snapshot'
  setReconGalleryStatus('Capturing inspection snapshot...')

  try {
    const response = await apiFetch('/api/recon/snapshots', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        note: robotCameraSnapshotNote.value,
        tags: ['inspection'],
      }),
    })
    const payload = await response.json()

    if (!response.ok) {
      throw new Error(payload.error || 'Recon snapshot failed.')
    }

    robotCameraSnapshotNote.value = ''
    reconSnapshots = [payload, ...reconSnapshots.filter((snapshot) => snapshot.id !== payload.id)].slice(0, 8)
    renderReconSnapshots()
    robotCameraChip.textContent = 'Saved'
    robotCameraMeta.textContent = formatReconSnapshotSavedMeta(payload)
    setReconGalleryStatus(formatReconSnapshotSavedMeta(payload))
    setStatus(`Recon snapshot saved: ${formatEventTimestamp(payload.capturedAt)}.`)
  } catch (error) {
    robotCameraChip.textContent = 'Snapshot failed'
    setReconGalleryStatus(formatError(error), true)
    setStatus(`Recon snapshot failed: ${formatError(error)}`, 'error')
  } finally {
    robotCameraSnapshotButton.disabled = !robotCameraFrame.dataset.streamUrl
    robotCameraSnapshotButton.textContent = originalLabel
  }
}

async function refreshReconSnapshots() {
  try {
    const response = await apiFetch('/api/recon/snapshots?limit=8')
    const payload = await response.json()

    if (!response.ok) {
      throw new Error(payload.error || 'Recon snapshots unavailable.')
    }

    reconSnapshots = Array.isArray(payload.snapshots) ? payload.snapshots : []
    renderReconSnapshots()
    setReconGalleryStatus(reconSnapshots.length ? 'Inspection gallery ready.' : 'No inspection snapshots yet.')
  } catch (error) {
    if (reconSnapshotList) {
      reconSnapshotList.replaceChildren(buildReconSnapshotEmpty(`Snapshot cache unavailable: ${formatError(error)}`))
    }
    setReconGalleryStatus(`Snapshot cache unavailable: ${formatError(error)}`, true)
  }
}

function handleReconGalleryToggle() {
  const shouldOpen = reconGalleryDrawer.hidden

  reconGalleryDrawer.hidden = !shouldOpen
  reconGalleryToggle.setAttribute('aria-expanded', String(shouldOpen))
  reconGalleryToggle.classList.toggle('is-active', shouldOpen)
  if (shouldOpen) {
    settingsDrawer.hidden = true
    settingsToggle.setAttribute('aria-expanded', 'false')
    connectionDrawer.hidden = true
    connectionToggle.setAttribute('aria-expanded', 'false')
    helpDrawer.hidden = true
    helpToggle.setAttribute('aria-expanded', 'false')
    void refreshReconSnapshots()
  }
}

function closeReconGallery() {
  reconGalleryDrawer.hidden = true
  reconGalleryToggle.setAttribute('aria-expanded', 'false')
  reconGalleryToggle.classList.remove('is-active')
}

function handleSettingsToggle() {
  const shouldOpen = settingsDrawer.hidden

  settingsDrawer.hidden = !shouldOpen
  settingsToggle.setAttribute('aria-expanded', String(shouldOpen))
  if (shouldOpen) {
    connectionDrawer.hidden = true
    connectionToggle.setAttribute('aria-expanded', 'false')
    helpDrawer.hidden = true
    helpToggle.setAttribute('aria-expanded', 'false')
    closeReconGallery()
  }
}

function handleConnectionToggle() {
  const shouldOpen = connectionDrawer.hidden

  connectionDrawer.hidden = !shouldOpen
  connectionToggle.setAttribute('aria-expanded', String(shouldOpen))
  if (shouldOpen) {
    settingsDrawer.hidden = true
    settingsToggle.setAttribute('aria-expanded', 'false')
    helpDrawer.hidden = true
    helpToggle.setAttribute('aria-expanded', 'false')
    closeReconGallery()
    void refreshDogzillaConnection()
  }
}

let mermaidLoaded = false

async function loadMermaidOnce() {
  if (mermaidLoaded) return
  try {
    const mermaid = await import('mermaid')
    mermaid.default.initialize({ startOnLoad: false, theme: 'default' })
    mermaidLoaded = true
    const mermaidEl = helpMermaidContainer.querySelector('.mermaid')
    if (mermaidEl && !mermaidEl.dataset.rendered) {
      const { svg } = await mermaid.default.render('help-mermaid-svg', mermaidEl.textContent.trim())
      mermaidEl.innerHTML = svg
      mermaidEl.dataset.rendered = 'true'
    }
  } catch (error) {
    console.warn('Mermaid load failed:', error)
    helpMermaidContainer.hidden = true
    helpMermaidFallback.hidden = false
  }
}

function handleHelpToggle() {
  const shouldOpen = helpDrawer.hidden

  helpDrawer.hidden = !shouldOpen
  helpToggle.setAttribute('aria-expanded', String(shouldOpen))
  if (shouldOpen) {
    connectionDrawer.hidden = true
    connectionToggle.setAttribute('aria-expanded', 'false')
    settingsDrawer.hidden = true
    settingsToggle.setAttribute('aria-expanded', 'false')
    closeReconGallery()
    void loadMermaidOnce()
  }
}

function handleRobotTabClick(event) {
  for (const tab of robotTabs) {
    const isActive = tab === event.currentTarget

    tab.classList.toggle('is-active', isActive)
    tab.setAttribute('aria-selected', String(isActive))
  }

  const selectedRobot = event.currentTarget.textContent.trim()
  const selectedView = event.currentTarget.dataset.robotView || 'overview'

  applyRobotView(selectedView)

  const primaryRobotName = runtimeConfig.robotRuntime.robotName || DEFAULT_ROBOT_RUNTIME.robotName

  if (selectedView === 'overview' && selectedRobot !== primaryRobotName) {
    setStatus(`${selectedRobot} selected. Telemetry stream still follows ${primaryRobotName}.`)
  }
}

function handleRobotNameEditStart() {
  const currentName = runtimeConfig.robotRuntime.robotName || DEFAULT_ROBOT_RUNTIME.robotName
  robotNameInput.value = currentName
  robotNameEditForm.hidden = false
  robotNameInput.focus()
  robotNameInput.select()
}

function handleRobotNameInputKeydown(event) {
  if (event.key === 'Escape') {
    robotNameEditForm.hidden = true
    robotNameInput.value = runtimeConfig.robotRuntime.robotName || DEFAULT_ROBOT_RUNTIME.robotName
    robotNameEditButton.focus()
  }
}

async function handleRobotNameSave(event) {
  event.preventDefault()

  const nextName = robotNameInput.value.trim().replace(/\s+/g, ' ')
  if (!nextName) {
    setStatus('Robot name cannot be empty.', 'error')
    return
  }

  robotNameInput.disabled = true
  robotNameEditForm.querySelector('button').disabled = true
  setStatus('Saving robot name...', 'busy')

  try {
    const response = await apiFetch('/api/dogzilla/identity', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ robot_name: nextName }),
    })
    const payload = await response.json()

    if (!response.ok) {
      throw new Error(payload.error || 'Could not save robot name.')
    }

    if (payload.connection) {
      renderDogzillaConnection(payload.connection)
    }

    const configPayload = await fetchConfig()
    applyPayload(configPayload)
    robotNameEditForm.hidden = true
    setStatus(`Robot renamed to ${runtimeConfig.robotRuntime.robotName || nextName}.`)
  } catch (error) {
    setStatus(formatError(error), 'error')
    connectionStatus.textContent = formatError(error)
  } finally {
    robotNameInput.disabled = false
    robotNameEditForm.querySelector('button').disabled = false
  }
}

async function fetchConfig() {
  const response = await apiFetch('/api/config')
  const payload = await response.json()

  if (!response.ok) {
    throw new Error(payload.error || 'Could not load app config.')
  }

  return payload
}

async function refreshDogzillaConnection() {
  try {
    const response = await apiFetch('/api/dogzilla/connection')
    const payload = await response.json()

    if (!response.ok) {
      throw new Error(payload.error || 'Could not load DOGZILLA connection.')
    }

    renderDogzillaConnection(payload)
  } catch (error) {
    connectionChip.textContent = 'Error'
    connectionStatus.textContent = formatError(error)
  }
}

async function handleDogzillaConnectionSave() {
  saveDogzillaConnectionButton.disabled = true
  connectionStatus.textContent = 'Saving connection...'

  try {
    const response = await apiFetch('/api/dogzilla/connection', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ssh: {
          host: dogzillaHostInput.value,
          user: dogzillaUserInput.value,
        },
        remoteRoot: dogzillaRemoteRootInput.value,
      }),
    })
    const payload = await response.json()

    if (!response.ok) {
      throw new Error(payload.error || 'Could not save DOGZILLA connection.')
    }

    renderDogzillaConnection(payload)
    if (payload.identity?.status === 'error') {
      const message = `Connection saved. Robot ID setup failed: ${payload.identity.error || 'unknown error'}`
      connectionStatus.textContent = message
      setStatus(message, 'error')
    } else {
      connectionStatus.textContent = 'Connection saved.'
      setStatus('DOGZILLA connection saved.')
    }
  } catch (error) {
    connectionStatus.textContent = formatError(error)
    setStatus(formatError(error), 'error')
  } finally {
    saveDogzillaConnectionButton.disabled = false
  }
}

async function handleDogzillaConnectionAction(event) {
  const action = event.currentTarget.dataset.connectionAction

  const confirmation = getConnectionActionConfirmation(action)
  if (confirmation) {
    const confirmed = await showConfirmModal(
      confirmation.title,
      confirmation.message,
    )
    if (!confirmed) {
      return
    }
  }

  setConnectionActionsDisabled(true)
  connectionStatus.textContent = `Running ${formatConnectionAction(action)}...`
  connectionOutput.textContent = `Running ${formatConnectionAction(action)}...`

  try {
    if (action === 'capture-map-origin') {
      const response = await apiFetch('/api/dogzilla/map-origin/capture', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ label: 'charger_origin' }),
      })
      const payload = await response.json()

      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || 'DOGZILLA charger origin calibration failed.')
      }

      await loadPublicConfig()
      const origin = payload.origin || {}
      const originText = formatMapOriginCapture(origin)
      connectionStatus.textContent = originText
      connectionOutput.textContent = JSON.stringify({
        action,
        status: 'saved',
        origin,
      }, null, 2)
      setMapWorkflowStatus(originText, 'success')
      setStatus(originText)
      return
    }

    const response = await apiFetch('/api/dogzilla/connection/action', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action }),
    })
    const payload = await response.json()

    if (!response.ok || payload.status === 'error') {
      throw new Error(payload.error || payload.stderr || `DOGZILLA action failed: ${action}`)
    }

    connectionStatus.textContent = `${formatConnectionAction(action)}: ${payload.status}.`
    connectionOutput.textContent = formatDogzillaActionOutput(payload)
    setStatus(`DOGZILLA ${formatConnectionAction(action)} ${payload.status}.`)

    if (action === 'probe-bridges' || action === 'probe-support') {
      renderServiceProbe(payload)
    }

    // Show capture/save buttons when mapping starts, hide when map is saved
    const mapHead = document.querySelector('.robot-map-head')
    const mapPanel = document.querySelector('.robot-map-panel')
    for (const panel of [mapHead, mapPanel]) {
      if (!panel) {
        continue
      }
      if (action === 'start-map-pose-mapping') {
        panel.classList.add('is-slam-mode')
      } else if (action === 'save-map-pose') {
        panel.classList.remove('is-slam-mode')
      }
    }
    if (action === 'start-map-pose' || action === 'start-map-pose-mapping' || action === 'save-map-pose') {
      setMapWorkflowStatus(`${formatConnectionAction(action)}: ${payload.status}.`, payload.status === 'ok' ? 'success' : '')
    }
  } catch (error) {
    connectionStatus.textContent = formatError(error)
    connectionOutput.textContent = formatError(error)
    if (event.currentTarget.closest?.('.map-workflow-panel')) {
      setMapWorkflowStatus(formatError(error), 'error')
    }
    setStatus(formatError(error), 'error')
  } finally {
    setConnectionActionsDisabled(false)
  }
}

async function handleWaypointCapture() {
  const name = (waypointCaptureInput?.value || '').trim()
  if (!name) {
    waypointCaptureStatus.textContent = 'Enter a name'
    waypointCaptureStatus.className = 'waypoint-capture-status error'
    return
  }

  waypointCaptureButton.disabled = true
  waypointCaptureStatus.textContent = 'Capturing...'
  waypointCaptureStatus.className = 'waypoint-capture-status'

  try {
    const response = await apiFetch('/api/dogzilla/waypoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const payload = await response.json()

    if (!response.ok || payload.ok !== true) {
      throw new Error(payload.error || payload.status || 'Waypoint capture failed')
    }

    waypointCaptureStatus.textContent = `Saved "${name}" at (${payload.waypoint?.x?.toFixed?.(2) || '?'}, ${payload.waypoint?.y?.toFixed?.(2) || '?'})`
    waypointCaptureStatus.className = 'waypoint-capture-status success'
    waypointCaptureInput.value = ''
    // Refresh waypoints on the map immediately
    const readiness = await refreshDogzillaWaypointReadiness()
    setMapWorkflowStatus(formatWaypointReadinessSummary(readiness) || `Saved waypoint "${name}".`, readiness?.readyForMapWaypoints === true ? 'success' : 'error')
  } catch (error) {
    waypointCaptureStatus.textContent = formatError(error)
    waypointCaptureStatus.className = 'waypoint-capture-status error'
    setMapWorkflowStatus(formatError(error), 'error')
  } finally {
    waypointCaptureButton.disabled = false
  }
}

async function handleWaypointReadinessCheck() {
  if (!waypointReadinessButton) {
    return
  }

  waypointReadinessButton.disabled = true
  setMapWorkflowStatus('Checking waypoint readiness...', '')

  try {
    const readiness = await refreshDogzillaWaypointReadiness()
    const summary = formatWaypointReadinessSummary(readiness) || 'Waypoint readiness unavailable.'
    const state = readiness?.readyForMapWaypoints === true ? 'success' : 'error'
    setMapWorkflowStatus(summary, state)
    setStatus(summary, state === 'success' ? undefined : 'error')
  } catch (error) {
    const message = formatError(error)
    setMapWorkflowStatus(message, 'error')
    setStatus(message, 'error')
  } finally {
    waypointReadinessButton.disabled = false
  }
}

function handleMapViewToggle() {
  const currentMode = robotMap.getViewMode()
  const newMode = currentMode === 'follow' ? 'map' : 'follow'
  robotMap.setViewMode(newMode)
  mapViewToggle.textContent = newMode === 'follow' ? 'Top-down map' : 'Follow robot'
  mapViewToggle.dataset.viewMode = newMode
  if (mapViewModeLabel) {
    mapViewModeLabel.textContent = robotMap.getViewModeLabel()
  }
}

async function ensureDogzillaRobotLinkReady() {
  if (dogzillaStartupRepairAttempted || runtimeConfig.robotRuntime.activeTarget?.kind !== 'dogzilla-direct') {
    return
  }

  dogzillaStartupRepairAttempted = true

  try {
    const healthResponse = await apiFetch('/api/robot/health')
    const healthPayload = await healthResponse.json()
    const error = String(healthPayload?.error || '')
    const repairable = healthPayload?.status === 'error' && /ECONNREFUSED/i.test(error)

    if (!repairable) {
      return
    }

    connectionStatus.textContent = 'Repairing robot link...'
    connectionOutput.textContent = 'Repairing robot link...'
    const response = await apiFetch('/api/dogzilla/connection/action', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'start-direct' }),
    })
    const payload = await response.json()

    if (!response.ok || payload.status === 'error') {
      throw new Error(payload.error || payload.stderr || 'Robot link repair failed.')
    }

    connectionStatus.textContent = 'Robot link repaired.'
    connectionOutput.textContent = formatDogzillaActionOutput(payload)
    setStatus('DOGZILLA robot link repaired.')
    await refreshRobotFeedback()
  } catch (error) {
    const message = formatError(error)
    connectionStatus.textContent = message
    connectionOutput.textContent = message
  }
}

async function handleDogzillaPreflight() {
  setConnectionActionsDisabled(true)
  dogzillaPreflightStatus.textContent = 'Running diagnostics...'
  dogzillaPreflightOutput.textContent = 'Checking network, robot bridge, battery, camera, audio, lidar, and Pi processes...'
  dogzillaPreflightChecks.replaceChildren()

  try {
    const response = await apiFetch('/api/dogzilla/preflight', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    const payload = await response.json()

    if (!response.ok) {
      throw new Error(payload.error || 'DOGZILLA diagnostics failed.')
    }

    renderDogzillaPreflight(payload)
    setStatus(`DOGZILLA diagnostics ${payload.status}.`)
  } catch (error) {
    const message = formatError(error)
    dogzillaPreflightStatus.textContent = message
    dogzillaPreflightOutput.textContent = message
    setStatus(message, 'error')
  } finally {
    setConnectionActionsDisabled(false)
  }
}

function renderDogzillaConnection(payload) {
  dogzillaConnection = payload
  const config = payload.config || {}
  const ssh = config.ssh || {}
  const bridges = config.bridges || {}
  const robotId = payload.robot_id || payload.identity?.robot_id || config.robot_id || runtimeConfig.robotRuntime.robotId || '-'
  const robotName = payload.robot_name || payload.identity?.robot_name || config.robot_name || runtimeConfig.robotRuntime.robotName || DEFAULT_ROBOT_RUNTIME.robotName

  dogzillaHostInput.value = ssh.host || ''
  dogzillaUserInput.value = ssh.user || 'pi'
  dogzillaRemoteRootInput.value = config.remoteRoot || '/home/pi/robodoge'
  dogzillaRobotId.textContent = robotId || '-'
  dogzillaDirectUrl.textContent = bridges.direct?.baseUrl || '-'
  dogzillaRos2Url.textContent = bridges.ros2?.baseUrl || '-'
  connectionChip.textContent = ssh.host ? ssh.host : 'No IP'
  const identityStatus = payload.identity?.status === 'error'
    ? ` Robot ID failed: ${payload.identity.error || 'unknown error'}`
    : robotId && robotId !== '-' ? ` Robot ID ${robotId}.` : ''
  connectionStatus.textContent = ssh.host
    ? `${ssh.user}@${ssh.host}:${ssh.port}. SSH config ${payload.sshConfigExists ? 'ready' : 'not written'}.${identityStatus}`
    : 'Set DOGZILLA IP.'
}

function renderServiceProbe(payload) {
  const labels = Object.entries(payload.results || {})
    .map(([id, result]) => `${formatServiceName(id)} ${result?.status || 'unknown'}`)

  connectionStatus.textContent = labels.length ? `${labels.join('. ')}.` : 'No service results.'
}

function renderDogzillaPreflight(payload) {
  const summary = payload.summary || {}
  const checks = Array.isArray(payload.checks) ? payload.checks : []
  const statusLabel = payload.status === 'ready'
    ? 'Ready'
    : payload.status === 'blocked'
      ? 'Blocked'
      : 'Attention'

  dogzillaPreflightStatus.textContent =
    `${statusLabel}: ${summary.ok || 0} ok, ${summary.warn || 0} warn, ${summary.fail || 0} fail. ` +
    `Ran ${formatEventTimestamp(payload.ranAt)} in ${Math.round(payload.durationMs || 0)}ms.`
  dogzillaPreflightSummary.replaceChildren(
    buildPreflightSummaryCard('OK', summary.ok || 0, 'ok'),
    buildPreflightSummaryCard('Warn', summary.warn || 0, 'warn'),
    buildPreflightSummaryCard('Fail', summary.fail || 0, 'fail'),
  )
  dogzillaPreflightChecks.replaceChildren(...checks.map(buildPreflightCheckRow))
  dogzillaPreflightOutput.textContent = JSON.stringify({
    status: payload.status,
    config: payload.config,
    checks,
    notes: payload.notes,
    diagnostics: payload.diagnostics,
  }, null, 2)
}

function buildPreflightSummaryCard(label, value, statusName) {
  const card = document.createElement('div')
  card.dataset.state = statusName
  const labelNode = document.createElement('span')
  labelNode.className = 'meta-label'
  labelNode.textContent = label
  const valueNode = document.createElement('strong')
  valueNode.textContent = String(value)
  card.append(labelNode, valueNode)
  return card
}

function buildPreflightCheckRow(check) {
  const row = document.createElement('div')
  row.className = 'preflight-check'
  row.dataset.state = check.status || 'info'

  const chip = document.createElement('span')
  chip.className = 'preflight-check-chip'
  chip.textContent = check.status || 'info'

  const body = document.createElement('div')
  const title = document.createElement('strong')
  title.textContent = check.label || check.id || 'Check'
  const detail = document.createElement('p')
  detail.textContent = check.detail || ''
  body.append(title, detail)

  row.append(chip, body)
  return row
}

function setConnectionActionsDisabled(disabled) {
  saveDogzillaConnectionButton.disabled = disabled
  saveDogzillaBackendButton.disabled = disabled
  dogzillaBackendUrlInput.disabled = disabled
  runDogzillaPreflightButton.disabled = disabled
  if (waypointReadinessButton) {
    waypointReadinessButton.disabled = disabled
  }
  for (const button of connectionActionButtons) {
    button.disabled = disabled
  }
}

function setWaypointButtonsEnabled(enabled, reason = '') {
  const captureButton = document.querySelector('#waypoint-capture-button')
  if (captureButton) {
    captureButton.disabled = !enabled
    captureButton.title = enabled ? '' : (reason || 'Waypoint capture unavailable while navigation is not ready')
  }
  for (const button of document.querySelectorAll('[data-connection-action="start-navigation"]')) {
    button.disabled = !enabled
    if (!enabled) {
      button.title = reason || 'Start navigation is unavailable'
    }
  }
}

function setMapWorkflowStatus(message, state = '') {
  if (!mapWorkflowStatus) {
    return
  }

  mapWorkflowStatus.textContent = message || 'Ready check not run.'
  mapWorkflowStatus.dataset.state = state
  if (state === 'error') {
    mapWorkflowPanel?.setAttribute('open', '')
  }
}

function formatConnectionAction(action) {
  switch (action) {
    case 'check-ssh':
      return 'network check'
    case 'probe-bridges':
      return 'robot link check'
    case 'probe-support':
      return 'extras check'
    case 'sync-bridges':
      return 'bridge code deploy'
    case 'start-direct':
      return 'direct bridge restart'
    case 'start-ros2':
      return 'ROS2 bridge restart'
    case 'start-yolo':
      return 'YOLO vision restart'
    case 'start-audio':
      return 'Pi audio restart'
    case 'start-lidar':
      return 'lidar bridge restart'
    case 'start-map-pose':
      return 'map localization restart'
    case 'start-navigation':
      return 'waypoint navigator start'
    case 'start-map-pose-mapping':
      return 'SLAM mapping mode start'
    case 'capture-map-origin':
      return 'charger origin calibration'
    case 'save-map-pose':
      return 'SLAM map save'
    case 'stop-vendor-app':
      return 'vendor DOGZILLA app stop'
    case 'stop-bridges':
      return 'bridge stop'
    default:
      return action || 'connection action'
  }
}

function formatMapOriginCapture(origin = {}) {
  const x = toFiniteNumber(origin.x)
  const y = toFiniteNumber(origin.y)
  const yaw = toFiniteNumber(origin.yaw)
  const parts = [
    'Charger origin calibrated for new captures. Existing app_map waypoints keep their stored capture anchor.',
  ]
  if (Number.isFinite(x) && Number.isFinite(y)) {
    parts.push(`Raw map anchor x ${formatTelemetryNumber(x)}, y ${formatTelemetryNumber(y)}.`)
  }
  if (Number.isFinite(yaw)) {
    parts.push(`Yaw ${formatTelemetryNumber(yaw)} rad.`)
  }
  return parts.join(' ')
}

function formatDogzillaActionOutput(payload) {
  const lines = [
    `Status: ${payload.status}`,
    `Action: ${payload.action || 'n/a'}`,
  ]

  if (payload.pid) {
    lines.push(`PID: ${payload.pid}`)
  }

  if (payload.stdout) {
    lines.push(`\nstdout\n${payload.stdout}`)
  }

  if (payload.stderr) {
    lines.push(`\nstderr\n${payload.stderr}`)
  }

  if (payload.results) {
    lines.push(`\nservices\n${JSON.stringify(payload.results, null, 2)}`)
  }

  if (payload.plan) {
    lines.push(`\nplan\n${JSON.stringify(payload.plan, null, 2)}`)
  }

  return lines.join('\n')
}

function formatServiceName(id) {
  switch (id) {
    case 'direct':
      return 'Robot bridge'
    case 'ros2':
      return 'ROS2 bridge'
    case 'audio':
      return 'Audio'
    case 'lidar':
      return 'Lidar'
    case 'camera':
      return 'Camera'
    case 'vision':
      return 'Object recognition'
    default:
      return id
  }
}

function applyBackendControls() {
  const apiBaseUrl = getApiBaseUrl()
  dogzillaBackendUrlInput.value = apiBaseUrl
  connectionBackendStatus.textContent = apiBaseUrl ? `Using ${apiBaseUrl}` : 'Using same-origin backend.'
}

function applyPayload(payload) {
  appConfig = payload.app || appConfig
  runtimeConfig = {
    activeProfile: payload.activeProfile || runtimeConfig.activeProfile,
    availableProfiles: payload.availableProfiles || [],
    systemPromptPreview: payload.systemPromptPreview || runtimeConfig.systemPromptPreview,
    speech: {
      ...runtimeConfig.speech,
      ...(payload.speech || {}),
      activeProfile: payload.speech?.activeProfile
        ? { ...DEFAULT_SPEECH_ACTIVE_PROFILE, ...payload.speech.activeProfile }
        : runtimeConfig.speech.activeProfile,
      activationPhrases: payload.speech?.activationPhrases || runtimeConfig.speech.activationPhrases,
    },
    robotRuntime: {
      ...DEFAULT_ROBOT_RUNTIME,
      ...(payload.robotRuntime || {}),
      activeTarget: payload.robotRuntime?.activeTarget
        ? { ...DEFAULT_ROBOT_RUNTIME.activeTarget, ...payload.robotRuntime.activeTarget }
        : runtimeConfig.robotRuntime.activeTarget,
      availableTargets: payload.robotRuntime?.availableTargets || runtimeConfig.robotRuntime.availableTargets,
    },
    dogzilla: {
      ...(runtimeConfig.dogzilla || {}),
      ...(payload.dogzilla || {}),
    },
  }

  applyAppConfig()
  applyModelConfig(payload)
  applySpeechConfig()
  applyRobotRuntimeConfig()
  robotMap.renderWaypoints()
  applyDogzillaCameraConfig()
  startDogzillaCameraViewer()
}

function applyModelConfig(payload) {
  profileName.textContent = runtimeConfig.activeProfile.label
  if (profileSource) {
    profileSource.textContent = ''
  }
  providerName.textContent = runtimeConfig.activeProfile.provider
  modelName.textContent = payload.model || runtimeConfig.activeProfile.model
  if (promptFile) {
    promptFile.textContent = payload.systemPromptFile
  }
  if (schemaFile) {
    schemaFile.textContent = payload.commandFormatFile
  }
  if (commandTypesFile) {
    commandTypesFile.textContent = payload.commandTypesFile
  }
  if (waypointsFile) {
    waypointsFile.textContent = payload.validWaypointsFile
  }
  renderProfileOptions()
  applyProfileSelectionState()
}

function applySpeechConfig() {
  const activeSpeechProfile = runtimeConfig.speech.activeProfile

  speechProfileName.textContent = activeSpeechProfile?.label || 'Speech unavailable'
  if (speechFiles) {
    speechFiles.textContent = ''
  }
  renderSpeechProfileOptions()
  applySpeechSelectionState()

  if (!activeSpeechProfile) {
    setSpeechStatus('No speech profile configured.', true)
    speechPreview.textContent = 'Speech input unavailable.'
    return
  }

  if (activeSpeechProfile.provider === 'whisper-browser') {
    speechPreview.textContent =
      `Ready: ${activeSpeechProfile.label}\n` +
      `Device: ${activeSpeechProfile.device || 'browser'}`
    return
  }

  if (activeSpeechProfile.provider === 'parakeet-sidecar') {
    speechPreview.textContent =
      `Ready: ${activeSpeechProfile.label}\n` +
      `Device: ${activeSpeechProfile.device || 'auto'}`
    return
  }

  speechPreview.textContent =
    `Ready: ${activeSpeechProfile.label}\n` +
    `Mode: ${activeSpeechProfile.useVad ? 'VAD' : 'streaming'}`
}

function applyRobotRuntimeConfig() {
  const robotRuntime = runtimeConfig.robotRuntime
  const activeTarget = robotRuntime.activeTarget

  runtimeTargetChip.textContent = activeTarget.label
  const robotName = robotRuntime.robotName || DEFAULT_ROBOT_RUNTIME.robotName
  if (primaryRobotTabName) {
    primaryRobotTabName.textContent = robotName
  } else if (primaryRobotTab) {
    primaryRobotTab.textContent = robotName
  }
  if (robotNameInput) {
    robotNameInput.value = robotName
  }
  if (robotRuntimeFile) {
    robotRuntimeFile.textContent = robotRuntime.runtimeFile
  }
  if (robotRos2File) {
    robotRos2File.textContent = robotRuntime.ros2ConfigFile
  }
  if (runtimeFiles) {
    runtimeFiles.textContent = ''
  }
  renderRobotTargetOptions()
  applyRobotTargetSelectionState()
}

function announceIsaacCompletionIfNeeded(feedbackPayload) {
  const event = feedbackPayload?.feedback?.runtimeFeedback?.lastEvent
    || feedbackPayload?.runtimeFeedback?.lastEvent
    || feedbackPayload?.feedback?.lastEvent
    || feedbackPayload?.lastEvent
  const eventId = event?.eventId || null

  if (!isaacCompletionState.initialized) {
    isaacCompletionState.initialized = true
    isaacCompletionState.lastEventId = eventId
    return
  }

  if (!eventId) {
    return
  }

  if (isaacCompletionState.lastEventId === eventId) {
    return
  }

  isaacCompletionState.lastEventId = eventId
  clearEmptyChat()
  appendMessage({
    role: appConfig.assistantName,
    text: event.message || `Arrived at ${formatWaypointName(event.waypoint)}.`,
    type: 'assistant',
    meta: `Isaac runtime reported completion${event.commandId ? ` for ${event.commandId}` : ''}${event.completedAt ? ` at ${formatEventTimestamp(event.completedAt)}` : '.'}`,
  })
  setStatus(event.message || `Arrived at ${formatWaypointName(event.waypoint)}.`)
}

function renderRobotFeedback(healthPayload, feedbackPayload) {
  const activeTarget = runtimeConfig.robotRuntime.activeTarget
  const lines = [
    `Target: ${activeTarget.label} (${activeTarget.kind})`,
    `Runtime enabled: ${runtimeConfig.robotRuntime.enabled ? 'yes' : 'no'}`,
    `Dry run: ${runtimeConfig.robotRuntime.dryRun ? 'yes' : 'no'}`,
  ]

  if (activeTarget.kind === 'isaacsim') {
    const healthStatus = healthPayload?.status || 'unknown'
    const feedbackStatus = feedbackPayload?.status || 'unknown'
    const runtimeFeedback = feedbackPayload?.feedback?.runtimeFeedback || feedbackPayload?.runtimeFeedback || null
    const controller = runtimeFeedback?.controller || null
    const lastEvent = runtimeFeedback?.lastEvent || feedbackPayload?.feedback?.lastEvent || feedbackPayload?.lastEvent || null

    setRuntimeFeedbackStatus(
      healthStatus === 'error'
        ? `Isaac sidecar error: ${healthPayload.error || `HTTP ${healthPayload.responseStatus || 'unknown'}`}.`
        : feedbackStatus === 'error'
          ? `Isaac feedback error: ${feedbackPayload.error || `HTTP ${feedbackPayload.responseStatus || 'unknown'}`}.`
          : `Isaac health ${healthStatus}. Feedback ${feedbackStatus}.`,
      healthStatus === 'error' || feedbackStatus === 'error',
    )
    lines.push(`Destination: ${healthPayload.destination || feedbackPayload.destination || 'n/a'}`)
    lines.push(`Isaac health: ${healthStatus}`)
    lines.push(`Feedback status: ${feedbackStatus}`)

    if (feedbackPayload?.feedback?.lastCommandId || feedbackPayload?.lastCommandId) {
      lines.push(`Last command id: ${feedbackPayload?.feedback?.lastCommandId || feedbackPayload?.lastCommandId}`)
    }

    if (controller?.status) {
      lines.push(`Controller status: ${controller.status}`)
    }

    if (controller?.targetWaypoint) {
      lines.push(`Target waypoint: ${controller.targetWaypoint}`)
    }

    if (lastEvent?.message) {
      lines.push(`Last event: ${lastEvent.message}`)
    }

    runtimeFeedbackOutput.textContent = `${lines.join('\n')}\n\n${JSON.stringify({
      health: healthPayload,
      feedback: feedbackPayload,
    }, null, 2)}`
    return
  }

  const healthStatus = healthPayload?.status || 'unknown'
  const feedbackStatus = feedbackPayload?.status || 'unknown'
  const feedbackBody = feedbackPayload?.feedback ?? null

  setRuntimeFeedbackStatus(
    healthStatus === 'error'
      ? `${activeTarget.label} error: ${healthPayload.error || `HTTP ${healthPayload.responseStatus || 'unknown'}`}.`
      : `${activeTarget.label} health ${healthStatus}. Feedback ${feedbackStatus}.`,
    healthStatus === 'error' || feedbackStatus === 'error',
  )
  lines.push(`Destination: ${healthPayload.destination || feedbackPayload.destination || 'n/a'}`)
  lines.push(`Bridge health: ${healthStatus}`)
  lines.push(`Feedback status: ${feedbackStatus}`)

  if (feedbackBody?.lastCommandId) {
    lines.push(`Last command id: ${feedbackBody.lastCommandId}`)
  }

  if (feedbackBody?.lastStateMessage) {
    lines.push(`Last state: ${stringifyForOneLine(feedbackBody.lastStateMessage)}`)
  }

  runtimeFeedbackOutput.textContent = `${lines.join('\n')}\n\n${JSON.stringify({
    health: healthPayload,
    feedback: feedbackPayload,
  }, null, 2)}`
}

function renderNavigationChainHealth(readinessPayload) {
  const chainRow = document.querySelector('#robot-nav-chain-row')
  const chainDots = document.querySelector('#robot-nav-chain-dots')
  const chainSummary = document.querySelector('#robot-nav-chain-summary')
  const chainDetail = document.querySelector('#robot-nav-chain-detail')
  const chainDetailContent = document.querySelector('#robot-nav-chain-detail-content')

  if (!chainRow || !chainDots || !chainSummary) return

  const components = buildNavChainComponents(readinessPayload)
  const anyUnknown = components.some((c) => c.status === 'unknown')

  chainRow.hidden = false

  const statusIconFor = (status) => status === 'ok' ? '✓' : status === 'fail' ? '✗' : '?'

  for (const dot of chainDots.querySelectorAll('.robot-nav-chain-dot')) {
    const componentId = dot.dataset.component
    const component = components.find((c) => c.id === componentId)
    if (component) {
      dot.dataset.status = component.status
      dot.title = `${component.label}: ${component.detail}`
    } else {
      dot.dataset.status = 'unknown'
    }
  }

  chainSummary.textContent = summarizeNavChain(components)

  if (chainDetail && chainDetailContent) {
    const rowsToShow = anyUnknown ? components : components.filter((c) => c.status !== 'ok')
    const detailRows = rowsToShow
      .map((c) => {
        const statusIcon = statusIconFor(c.status)
        let actions = ''
        if (c.status !== 'ok') {
          if (c.id === 'localization') {
            actions = '<div class="robot-nav-chain-detail-actions"><button type="button" data-connection-action="start-map-pose">Restart map localization</button></div>'
          } else if (c.id === 'action') {
            actions = '<div class="robot-nav-chain-detail-actions"><button type="button" data-connection-action="start-navigation">Start Nav</button></div>'
          }
        }
        return `
          <div class="robot-nav-chain-detail-row">
            <span class="robot-nav-chain-detail-status" data-status="${c.status}">${statusIcon}</span>
            <div class="robot-nav-chain-detail-content">
              <strong>${c.label}</strong>
              <p>${c.detail}</p>
              ${actions}
            </div>
          </div>
        `
      })
      .join('')

    if (detailRows) {
      chainDetailContent.innerHTML = detailRows
      chainDetail.hidden = false
    } else {
      chainDetail.hidden = true
    }

    for (const button of chainDetail.querySelectorAll('[data-connection-action]')) {
      button.addEventListener('click', handleDogzillaConnectionAction)
    }
  }
}

function handleNavChainDotsClick() {
  const chainDetail = document.querySelector('#robot-nav-chain-detail')
  const chainDots = document.querySelector('#robot-nav-chain-dots')
  if (!chainDetail || !chainDots) return
  const isHidden = chainDetail.hidden
  chainDetail.hidden = !isHidden
  chainDots.setAttribute('aria-expanded', String(!isHidden))
}

function renderRobotStateSnapshot(snapshot) {
  robotStatePanel.hidden = false

  const robot = snapshot?.activeRobot
  const activeConnections = snapshot?.stats?.activeConnections ?? 0

  if (!robot) {
    robotStatePanel.dataset.state = 'waiting'
    robotStateChip.textContent = activeConnections > 0 ? 'Connected' : 'Waiting'
    robotStateName.textContent = 'No robot'
    robotStateTask.textContent = 'Waiting'
    robotStateSeq.textContent = '-'
    renderBatteryMeter(Number.NaN)
    robotTelemetryMeta.textContent = ''
    robotNavStatus.textContent = '-'
    delete robotNavStatusRow?.dataset?.severity
    robotNavTarget.textContent = ''
    robotMap.hideDot()
    robotMap.clearPoseTrack()
    robotMap.setPoseReadout(null)
    robotMap.setMeta(formatNoRobotMapMessage(snapshot))
    return
  }

  const receivedAt = Date.parse(robot.receivedAt)
  const ageMs = Number.isFinite(receivedAt) ? Date.now() - receivedAt : Infinity
  const isStale = ageMs > 3000

  const poseState = snapshot?.poseState || {}
  const waypointSafe = poseState.waypointSafe === true
  const poseStatus = poseState.status || ''
  const poseAgeOk = !poseState.pose?.ageSec || poseState.pose.ageSec <= 2
  const poseTrusted = !isStale && waypointSafe && poseAgeOk && poseStatus !== 'error'

  robotStatePanel.dataset.state = isStale ? 'stale' : 'ready'
  robotStateChip.textContent = isStale ? 'Stale' : 'Live'
  robotStateName.textContent = robot.name
  robotStateTask.textContent = robot.task
  robotStateSeq.textContent = String(robot.seq)
  renderRobotTelemetry(robot)

  const navStatus = snapshot?.navigationStatus
  if (navStatus) {
    const icon = NAV_STATUS_ICONS[navStatus.status] || ''
    robotNavStatus.textContent = navStatus.text ? `${icon} ${navStatus.text}` : '-'
    if (navStatus.severity) {
      robotNavStatusRow.dataset.severity = navStatus.severity
    } else {
      delete robotNavStatusRow?.dataset?.severity
    }
    robotNavTarget.textContent = navStatus.targetWaypoint ? `Target: ${navStatus.targetWaypoint}` : ''
    if (robotMap.setNavStatusBadge) {
      robotMap.setNavStatusBadge(`${icon} ${navStatus.text || ''}`, navStatus.severity)
    }
  } else {
    robotNavStatus.textContent = '-'
    delete robotNavStatusRow?.dataset?.severity
    robotNavTarget.textContent = ''
    if (robotMap.setNavStatusBadge) {
      robotMap.setNavStatusBadge('', null)
    }
  }

  robotMap.setPoseTrust(poseTrusted)
  document.getElementById('robot-map')?.setAttribute('data-pose-trusted', String(poseTrusted))
  robotMap.renderWaypoints(robot)
  robotMap.renderPoseTrack(snapshot?.poseTrack || [], robot)
  robotMap.renderDot(robot)
  applyWaypointButtonsToNavStatus(navStatus)
  renderOperatorStatus(snapshot)
}

function applyWaypointButtonsToNavStatus(navStatus) {
  if (!navStatus) {
    setWaypointButtonsEnabled(true, '')
    return
  }
  if (navStatus.status === 'ready' || navStatus.status === 'idle' || navStatus.status === 'navigating' || navStatus.status === 'arrived' || navStatus.status === 'finding_waypoint' || navStatus.status === 'repairing') {
    setWaypointButtonsEnabled(true, '')
    return
  }
  if (navStatus.status === 'blocked' || navStatus.status === 'stuck') {
    setWaypointButtonsEnabled(false, navStatus.text || 'Navigation not ready')
    return
  }
  setWaypointButtonsEnabled(true, '')
}

function renderOperatorStatus(snapshot) {
  const strip = document.getElementById('operator-status-strip')
  if (!strip) return

  const robot = snapshot?.activeRobot

  strip.dataset.state = robot ? 'ready' : 'waiting'

  const lastCmdEl = document.getElementById('operator-last-cmd-state')
  if (lastCmdEl) {
    lastCmdEl.textContent = deriveOperatorLastCommand(snapshot, lastOperatorCommand)
  }

  const safeNext = deriveSafeNextAction(snapshot)
  const safeNextEl = document.getElementById('operator-safe-next-action')
  const safeNextBlockerEl = document.getElementById('operator-safe-next-blocker')
  if (safeNextEl) {
    safeNextEl.textContent = safeNext.action
  }
  if (safeNextBlockerEl) {
    if (safeNext.blocker) {
      safeNextBlockerEl.textContent = safeNext.blocker
      safeNextBlockerEl.hidden = false
    } else {
      safeNextBlockerEl.textContent = ''
      safeNextBlockerEl.hidden = true
    }
  }
}

function renderRobotStateInactive() {
  robotStatePanel.hidden = false
  robotStatePanel.dataset.state = 'waiting'
  robotStateChip.textContent = 'Waiting'
  robotStateName.textContent = 'No robot'
  robotStateTask.textContent = 'Waiting'
  robotStateSeq.textContent = '-'
  renderBatteryMeter(Number.NaN)
  robotTelemetryMeta.textContent = ''
  robotNavStatus.textContent = '-'
  delete robotNavStatusRow?.dataset?.severity
  robotNavTarget.textContent = ''
  robotMap.hideDot()
  robotMap.renderWaypoints()
  robotMap.clearPoseTrack()
  robotMap.setPoseReadout(null)
  robotMap.setWaypointReadiness('')
  robotMap.setMeta('Real robot target required for live map.')
}

function formatNoRobotMapMessage(snapshot) {
  const activeTarget = snapshot?.activeTarget || runtimeConfig.robotRuntime?.activeTarget
  const bridgeState = snapshot?.bridgeState || {}
  const poseState = snapshot?.poseState || {}
  const streamPath = runtimeConfig.robotRuntime.stateStreamPath || DEFAULT_ROBOT_RUNTIME.stateStreamPath

  if (activeTarget?.kind === 'dogzilla-direct') {
    const bridgeError = typeof bridgeState.error === 'string' ? bridgeState.error.trim() : ''
    const poseError = typeof poseState.error === 'string' ? poseState.error.trim() : ''

    if (bridgeState.status === 'error' || bridgeError) {
      return `DOGZILLA direct bridge unreachable.${bridgeError ? ` ${bridgeError}.` : ''} Stale robot pose cleared; waiting for fresh bridge state.`
    }

    if (poseState.status === 'error' || poseError) {
      return `DOGZILLA pose bridge unreachable.${poseError ? ` ${poseError}.` : ''} Waiting for verified map-frame localization.`
    }

    return 'Waiting for fresh DOGZILLA direct bridge state.'
  }

  return `Stream: ${streamPath}`
}

function renderRobotTelemetry(robot) {
  const telemetry = robot.telemetry || {}
  const battery = toFiniteNumber(telemetry.battery)
  renderBatteryMeter(battery)

  const parts = []
  const roll = toFiniteNumber(telemetry.roll)
  const pitch = toFiniteNumber(telemetry.pitch)
  const yaw = toFiniteNumber(telemetry.yaw)

  if (Number.isFinite(roll) || Number.isFinite(pitch) || Number.isFinite(yaw)) {
    parts.push(`r ${formatTelemetryNumber(roll)} / p ${formatTelemetryNumber(pitch)} / y ${formatTelemetryNumber(yaw)}`)
  }
  if (telemetry.source) {
    parts.push(String(telemetry.source))
  }
  if (telemetry.batteryStatus && telemetry.batteryStatus !== 'ok') {
    if (telemetry.batteryStatus === 'last-known') {
      const readStatus = telemetry.batteryReadStatus && telemetry.batteryReadStatus !== 'ok'
        ? `; ${String(telemetry.batteryReadStatus).replace(/-/g, ' ')}`
        : ''
      parts.push(`battery last known${readStatus}`)
    } else {
      parts.push(telemetry.batteryStatus === 'read-failed' ? 'battery read failed' : `battery ${telemetry.batteryStatus}`)
    }
  } else if (telemetry.batterySource) {
    parts.push(`battery ${telemetry.batterySource}`)
  }
  if (telemetry.poseStatus) {
    parts.push(`pose ${telemetry.poseStatus}`)
  }
  if (telemetry.dryRun === true) {
    parts.push('dry-run')
  }

  robotTelemetryMeta.textContent = parts.join(' | ')
}

function renderBatteryMeter(value) {
  if (!Number.isFinite(value)) {
    robotBatteryValue.textContent = '-'
    robotBatteryMeter.dataset.state = 'unknown'
    robotBatteryMeter.style.setProperty('--battery-fill', '0%')
    robotBatteryMeter.setAttribute('aria-label', 'Battery unavailable')
    return
  }

  const label = formatBatteryValue(value)
  robotBatteryValue.textContent = label
  robotBatteryMeter.setAttribute('aria-label', `Battery ${label}`)

  if (value < 0 || value > 100) {
    robotBatteryMeter.dataset.state = 'voltage'
    robotBatteryMeter.style.setProperty('--battery-fill', '55%')
    return
  }

  const percent = Math.max(0, Math.min(100, Math.round(value)))
  robotBatteryMeter.style.setProperty('--battery-fill', `${percent}%`)

  if (percent <= 20) {
    robotBatteryMeter.dataset.state = 'low'
  } else if (percent <= 50) {
    robotBatteryMeter.dataset.state = 'medium'
  } else {
    robotBatteryMeter.dataset.state = 'high'
  }
}

function formatBatteryValue(value) {
  if (!Number.isFinite(value)) {
    return '-'
  }

  if (value >= 0 && value <= 100) {
    return `${Math.round(value)}%`
  }

  return `${value.toFixed(2)}V`
}

function formatTelemetryNumber(value) {
  return Number.isFinite(value) ? value.toFixed(1) : '-'
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return Number.NaN
  }

  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : Number.NaN
}

function applyDogzillaCameraConfig() {
  const camera = runtimeConfig.dogzilla?.camera
  const streamUrl = camera?.proxyStreamPath ? toApiUrl(camera.proxyStreamPath) : camera?.streamUrl || ''
  const upstreamStreamUrl = camera?.streamUrl || ''

  if (!streamUrl) {
    clearDogzillaCameraTimers()
    robotCameraFrame.removeAttribute('src')
    robotCameraFrame.dataset.streamUrl = ''
    robotCameraFrame.dataset.statusPath = ''
    robotCameraFrame.dataset.snapshotPath = ''
    robotCameraFrame.dataset.viewerMode = ''
robotCameraRefreshButton.disabled = true
robotCameraRecoverButton.disabled = true
robotCameraSnapshotButton.disabled = true
    robotCameraChip.textContent = 'No stream'
    robotCameraMeta.textContent = 'Camera stream not configured.'
    return
  }

  robotCameraFrame.dataset.streamUrl = streamUrl
  robotCameraFrame.dataset.statusPath = camera?.proxyStatusPath || ''
  robotCameraFrame.dataset.snapshotPath = camera?.proxySnapshotPath ? toApiUrl(camera.proxySnapshotPath) : ''
  robotCameraFrame.dataset.viewerMode = 'stream'
robotCameraRefreshButton.disabled = false
robotCameraRecoverButton.disabled = false
robotCameraSnapshotButton.disabled = false
  robotCameraChip.textContent = robotCameraFrame.getAttribute('src') === streamUrl ? 'Live' : 'Starting'
  robotCameraMeta.textContent = formatDogzillaCameraSource(camera, upstreamStreamUrl)
}

function applyRobotView(view) {
  const showCamera = view === 'camera'

  robotCameraPanel.hidden = !showCamera
  robotMapPanel.hidden = showCamera

  if (showCamera) {
    startDogzillaCameraViewer()
    void refreshReconSnapshots()
  }
}

function startDogzillaCameraViewer({ forceRefresh = false } = {}) {
  const streamUrl = robotCameraFrame.dataset.streamUrl || ''
  if (!streamUrl) {
    return
  }

  if (!forceRefresh && robotCameraFrame.getAttribute('src') === streamUrl) {
    return
  }

  clearDogzillaCameraTimers()
  robotCameraChip.textContent = forceRefresh ? 'Refreshing' : 'Starting'
  robotCameraMeta.textContent = forceRefresh
    ? 'Refreshing DOGZILLA camera stream through the backend proxy.'
    : 'Starting DOGZILLA camera stream through the backend proxy.'
  robotCameraFrame.removeAttribute('src')
  setDogzillaCameraFrameSource(streamUrl, { cacheBust: forceRefresh })
  scheduleDogzillaCameraLoadTimeout()
}

function setDogzillaCameraFrameSource(streamUrl, { cacheBust = false } = {}) {
  robotCameraFrame.src = cacheBust ? withCameraRefreshParam(streamUrl) : streamUrl
}

function withCameraRefreshParam(streamUrl) {
  try {
    const url = new URL(streamUrl, window.location.href)
    url.searchParams.set('cameraRefresh', String(Date.now()))
    return /^https?:\/\//i.test(streamUrl)
      ? url.toString()
      : `${url.pathname}${url.search}${url.hash}`
  } catch {
    const separator = streamUrl.includes('?') ? '&' : '?'
    return `${streamUrl}${separator}cameraRefresh=${Date.now()}`
  }
}

function handleDogzillaCameraRefresh() {
  const streamUrl = robotCameraFrame.dataset.streamUrl || ''
  if (!streamUrl) {
    robotCameraChip.textContent = 'No stream'
    robotCameraMeta.textContent = 'Camera stream not configured.'
    return
  }

  robotCameraRefreshButton.disabled = true
  startDogzillaCameraViewer({ forceRefresh: true })
}

async function handleDogzillaCameraRecover() {
  const streamUrl = robotCameraFrame.dataset.streamUrl || ''
  if (!streamUrl) {
    robotCameraChip.textContent = 'No stream'
    robotCameraMeta.textContent = 'Camera stream not configured.'
    return
  }

  robotCameraRecoverButton.disabled = true
  robotCameraRefreshButton.disabled = true
  robotCameraChip.textContent = 'Restarting'
  robotCameraMeta.textContent = 'Restarting YOLO camera feed on the robot...'

  try {
    const response = await apiFetch('/api/dogzilla/connection/action', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'start-yolo' }),
    })
    const payload = await response.json()
    if (!response.ok || payload.status === 'error') {
      throw new Error(payload.error || payload.stderr || 'Could not restart YOLO camera feed.')
    }

    robotCameraChip.textContent = 'Restarted'
    robotCameraMeta.textContent = 'YOLO camera feed restarted. Reconnecting stream...'
    setStatus('DOGZILLA YOLO camera feed restarted.')
    startDogzillaCameraViewer({ forceRefresh: true })
  } catch (error) {
    robotCameraChip.textContent = 'Restart failed'
    robotCameraMeta.textContent = formatError(error)
    setStatus(formatError(error), 'error')
    robotCameraRefreshButton.disabled = false
  } finally {
    robotCameraRecoverButton.disabled = false
  }
}

function scheduleDogzillaCameraLoadTimeout() {
  clearDogzillaCameraLoadTimeout()
  robotCameraLoadTimerId = window.setTimeout(() => {
    if (!robotCameraFrame.dataset.streamUrl || robotCameraFrame.naturalWidth > 0) {
      return
    }

    clearDogzillaCameraTimers()
    robotCameraFrame.removeAttribute('src')
    robotCameraRefreshButton.disabled = false
    robotCameraChip.textContent = 'Camera unavailable'
    robotCameraMeta.textContent = 'Camera did not respond. Run Diagnostics to check the Pi camera and YOLO services.'
  }, DOGZILLA_CAMERA_LOAD_TIMEOUT_MS)
}

function clearDogzillaCameraTimers() {
  clearDogzillaCameraLoadTimeout()
}

function clearDogzillaCameraLoadTimeout() {
  if (robotCameraLoadTimerId) {
    window.clearTimeout(robotCameraLoadTimerId)
    robotCameraLoadTimerId = null
  }
}

async function refreshDogzillaCameraStatus() {
  const statusPath = robotCameraFrame.dataset.statusPath || '/api/dogzilla/camera/status'

  if (!robotCameraFrame.dataset.streamUrl) {
    return
  }

  try {
    const response = await apiFetch(statusPath)
    const payload = await response.json()

    if (!response.ok) {
      throw new Error(payload.error || 'Camera status unavailable.')
    }

    if (payload.status === 'ok') {
      robotCameraChip.textContent = robotCameraFrame.getAttribute('src') ? 'Live' : 'Ready'
      robotCameraMeta.textContent = `${payload.detail || 'Camera port is reachable.'} ${payload.streamUrl || ''}`.trim()
      return
    }

    robotCameraChip.textContent = payload.status === 'warn' ? 'Port ready' : 'Offline'
    robotCameraMeta.textContent = payload.detail || payload.error || 'Camera stream unavailable.'
  } catch (error) {
    robotCameraChip.textContent = 'Status error'
    robotCameraMeta.textContent = formatError(error)
  }
}

function handleDogzillaCameraFrameError() {
  if (!robotCameraFrame.dataset.streamUrl) {
    return
  }

  clearDogzillaCameraTimers()
  robotCameraFrame.removeAttribute('src')
  robotCameraRefreshButton.disabled = false
  robotCameraChip.textContent = 'Camera unavailable'
  robotCameraMeta.textContent = 'Camera failed to load through the backend proxy. Run Diagnostics to check the Pi camera and YOLO services.'
}

function handleDogzillaCameraFrameLoad() {
  if (!robotCameraFrame.dataset.streamUrl) {
    return
  }

  clearDogzillaCameraLoadTimeout()
  robotCameraRefreshButton.disabled = false
  robotCameraChip.textContent = 'Live'
  robotCameraMeta.textContent = 'Receiving DOGZILLA camera stream through the backend proxy.'
}

function formatDogzillaCameraSource(camera, upstreamStreamUrl) {
  if (camera?.processed && camera?.sourceStreamUrl) {
    return `YOLO camera stream from ${camera.sourceStreamUrl}.`
  }

  if (upstreamStreamUrl) {
    return `Camera source: ${upstreamStreamUrl}.`
  }

  return 'Camera stream starting.'
}

function renderReconSnapshots() {
  if (!reconSnapshotList) {
    return
  }

  reconGalleryCount.textContent = `${reconSnapshots.length} saved`

  if (!reconSnapshots.length) {
    reconSnapshotList.replaceChildren(buildReconSnapshotEmpty('No snapshots saved.'))
    return
  }

  reconSnapshotList.replaceChildren(...reconSnapshots.slice(0, 8).map(buildReconSnapshotItem))
}

function buildReconSnapshotEmpty(message) {
  const empty = document.createElement('div')
  empty.className = 'recon-snapshot-empty'
  empty.textContent = message
  return empty
}

function buildReconSnapshotItem(snapshot) {
  const item = document.createElement('article')
  item.className = 'recon-snapshot-item'
  item.dataset.snapshotId = snapshot.id

  const image = document.createElement('img')
  image.src = toApiUrl(snapshot.image?.url || '')
  image.alt = `Recon snapshot ${formatEventTimestamp(snapshot.capturedAt)}`
  image.loading = 'lazy'

  const body = document.createElement('div')
  body.className = 'recon-snapshot-body'

  const title = document.createElement('strong')
  title.textContent = `Inspection ${formatEventTimestamp(snapshot.capturedAt)}`

  const meta = document.createElement('span')
  meta.textContent = formatReconSnapshotItemMeta(snapshot)

  const note = document.createElement('textarea')
  note.className = 'recon-snapshot-note-editor'
  note.rows = 3
  note.maxLength = 500
  note.value = snapshot.note || ''
  note.placeholder = 'Add inspection note...'
  note.setAttribute('aria-label', `Note for snapshot ${formatEventTimestamp(snapshot.capturedAt)}`)

  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'recon-snapshot-save'
  save.dataset.snapshotNoteSave = snapshot.id
  save.textContent = 'Save note'

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'recon-snapshot-delete'
  remove.dataset.snapshotDelete = snapshot.id
  remove.textContent = 'Delete'

  const actions = document.createElement('div')
  actions.className = 'recon-snapshot-actions'
  actions.append(save, remove)

  body.append(title, meta, note, actions)
  item.append(image, body)
  return item
}

async function handleReconSnapshotListClick(event) {
  const deleteButton = event.target.closest?.('[data-snapshot-delete]')
  if (deleteButton) {
    await handleReconSnapshotDelete(deleteButton)
    return
  }

  const button = event.target.closest?.('[data-snapshot-note-save]')
  if (!button) {
    return
  }

  const item = button.closest('.recon-snapshot-item')
  const snapshotId = button.dataset.snapshotNoteSave
  const note = item?.querySelector('.recon-snapshot-note-editor')?.value || ''

  button.disabled = true
  button.textContent = 'Saving'
  setReconGalleryStatus('Saving inspection note...')

  try {
    const response = await apiFetch(`/api/recon/snapshots/${encodeURIComponent(snapshotId)}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ note }),
    })
    const payload = await response.json()

    if (!response.ok) {
      throw new Error(payload.error || 'Could not save inspection note.')
    }

    reconSnapshots = reconSnapshots.map((snapshot) => snapshot.id === payload.id ? payload : snapshot)
    renderReconSnapshots()
    setReconGalleryStatus('Inspection note saved.')
  } catch (error) {
    setReconGalleryStatus(`Note save failed: ${formatError(error)}`, true)
  } finally {
    button.disabled = false
    button.textContent = 'Save note'
  }
}

async function handleReconSnapshotDelete(button) {
  const snapshotId = button.dataset.snapshotDelete
  const snapshot = reconSnapshots.find((item) => item.id === snapshotId)
  const label = snapshot ? `Inspection ${formatEventTimestamp(snapshot.capturedAt)}` : 'this snapshot'

  if (!window.confirm(`Delete ${label}?`)) {
    return
  }

  button.disabled = true
  button.textContent = 'Deleting'
  setReconGalleryStatus('Deleting inspection snapshot...')

  try {
    const response = await apiFetch(`/api/recon/snapshots/${encodeURIComponent(snapshotId)}`, {
      method: 'DELETE',
    })
    const payload = await response.json()

    if (!response.ok || payload.deleted !== true) {
      throw new Error(payload.error || 'Could not delete inspection snapshot.')
    }

    reconSnapshots = reconSnapshots.filter((item) => item.id !== snapshotId)
    renderReconSnapshots()
    setReconGalleryStatus('Inspection snapshot deleted.')
    setStatus('Recon snapshot deleted.')
  } catch (error) {
    setReconGalleryStatus(`Delete failed: ${formatError(error)}`, true)
    button.disabled = false
    button.textContent = 'Delete'
  }
}

function setReconGalleryStatus(message, isError = false) {
  if (!reconGalleryStatus) {
    return
  }

  reconGalleryStatus.textContent = message
  reconGalleryStatus.dataset.state = isError ? 'error' : 'ok'
}

function formatReconSnapshotSavedMeta(snapshot) {
  const robot = snapshot.activeRobot
  const robotName = robot?.name || runtimeConfig.robotRuntime.robotName || 'robot'
  const stateText = robot ? `${robotName} ${robot.task || 'state'} seq ${robot.seq ?? '-'}` : `${robotName} state pending`
  const locationText = formatReconSnapshotLocation(snapshot)
  const lidarText = snapshot.map?.lidarStatus ? ` Lidar ${snapshot.map.lidarStatus}.` : ''
  return `Saved ${formatEventTimestamp(snapshot.capturedAt)}. ${stateText}.${locationText ? ` ${locationText}.` : ''}${lidarText}`
}

function formatReconSnapshotItemMeta(snapshot) {
  const parts = [formatEventTimestamp(snapshot.capturedAt)]
  const robot = snapshot.activeRobot

  if (robot) {
    parts.push(`${robot.name || 'Robot'} ${robot.task || 'state'} #${robot.seq ?? '-'}`)
  } else if (snapshot.map?.activeTarget?.label) {
    parts.push(snapshot.map.activeTarget.label)
  }

  const battery = toFiniteNumber(robot?.telemetry?.battery)
  if (Number.isFinite(battery)) {
    parts.push(formatBatteryValue(battery))
  }

  const locationText = formatReconSnapshotLocation(snapshot)
  if (locationText) {
    parts.push(locationText)
  }

  if (!snapshot.map?.pose && snapshot.map?.lidarStatus) {
    parts.push(`lidar ${snapshot.map.lidarStatus}`)
  }

  const lidarPointCount = toFiniteNumber(snapshot.lidarArtifacts?.csv?.pointCount ?? snapshot.map?.lidarPointCount)
  if (Number.isFinite(lidarPointCount) && lidarPointCount > 0) {
    parts.push(`${Math.round(lidarPointCount)} lidar pts`)
  }

  return parts.join(' | ')
}

function formatReconSnapshotLocation(snapshot) {
  const pose = snapshot.map?.pose
  if (pose) {
    return `x ${formatTelemetryNumber(toFiniteNumber(pose.x))}, y ${formatTelemetryNumber(toFiniteNumber(pose.y))}`
  }

  return snapshot.map?.status === 'pending-pose' ? 'location pending' : ''
}

function renderProfileOptions() {
  profileSelect.replaceChildren()

  for (const profile of runtimeConfig.availableProfiles) {
    const option = document.createElement('option')
    option.value = profile.id
    option.textContent = `${profile.label} (${profile.provider})`
    option.selected = profile.id === runtimeConfig.activeProfile.id
    profileSelect.append(option)
  }
}

function renderSpeechProfileOptions() {
  speechProfileSelect.replaceChildren()

  for (const profile of runtimeConfig.speech.availableProfiles) {
    const option = document.createElement('option')
    option.value = profile.id
    option.textContent = `${profile.label} (${profile.provider})`
    option.selected = profile.id === runtimeConfig.speech.activeProfile?.id
    speechProfileSelect.append(option)
  }
}

function renderRobotTargetOptions() {
  robotTargetSelect.replaceChildren()

  for (const target of runtimeConfig.robotRuntime.availableTargets) {
    const option = document.createElement('option')
    option.value = target.id
    option.textContent = `${target.label} (${target.kind})`
    option.selected = target.id === runtimeConfig.robotRuntime.activeTarget.id
    robotTargetSelect.append(option)
  }
}

function applyProfileSelectionState() {
  const locked = runtimeConfig.activeProfile.selectionLocked
  profileSelect.disabled = locked
  saveProfileButton.disabled = locked
  if (profileLockNote) {
    profileLockNote.textContent = locked ? 'Profile locked by environment.' : ''
  }
  settingsStatus.textContent = `Using ${runtimeConfig.activeProfile.label} (${runtimeConfig.activeProfile.model}).`
}

function applySpeechSelectionState() {
  const locked = runtimeConfig.speech.activeProfile?.selectionLocked
  speechProfileSelect.disabled = locked
  saveSpeechProfileButton.disabled = locked
  if (speechLockNote) {
    speechLockNote.textContent = locked ? 'Speech profile locked by environment.' : ''
  }
  if (runtimeConfig.speech.activeProfile) {
    speechSettingsStatus.textContent = `Using ${runtimeConfig.speech.activeProfile.label}.`
  }
}

function applyRobotTargetSelectionState() {
  const locked = runtimeConfig.robotRuntime.selectionLocked || runtimeConfig.robotRuntime.activeTarget.selectionLocked
  robotTargetSelect.disabled = locked
  saveRobotTargetButton.disabled = locked
  if (robotTargetLockNote) {
    robotTargetLockNote.textContent = locked ? 'Runtime target locked by environment.' : ''
  }
  robotTargetStatus.textContent = `Targeting ${runtimeConfig.robotRuntime.activeTarget.label}.`
  robotSitTestStatus.textContent = runtimeConfig.robotRuntime.dryRun ? 'Ready. Dry-run on.' : 'Ready. Live enabled.'
  manualControl.applyState()
}

function formatSource(source) {
  switch (source) {
    case 'override':
      return 'startup override'
    case 'runtime':
      return 'runtime config'
    default:
      return 'default'
  }
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function normalizeOpenAiCompatibleContent(content) {
  if (typeof content === 'string' && content.trim()) {
    return content.trim()
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === 'string') {
          return part
        }

        if (part && typeof part === 'object' && typeof part.text === 'string') {
          return part.text
        }

        return ''
      })
      .join('')
      .trim()

    return text || null
  }

  return null
}

async function safeReadText(response) {
  try {
    return (await response.text()).trim()
  } catch {
    return ''
  }
}

function trimTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function buildAssistantMeta(payload, startedAt) {
  const parts = [
    `Reply received in ${formatElapsed(Date.now() - startedAt)} via ${payload.profileLabel} (${payload.model}).`,
    `Target ${payload.runtimeTarget?.label || runtimeConfig.robotRuntime.activeTarget.label}.`,
  ]
  const activeSummary = formatActiveRuntimeSummary(payload)

  if (activeSummary) {
    parts.push(activeSummary)
  }

  return parts.join(' ')
}

function buildAssistantText(payload) {
  if (!payload?.parsed || typeof payload.parsed !== 'object') {
    return payload?.response || 'No structured command returned.'
  }

  const command = normalizeCommandName(payload.parsed.command)
  if (isRobotRuntimeTarget(payload) && payload.robotDispatch?.status === 'sent') {
    return formatParsedCommandJson(payload, 2) || summarizeParsedCommand(command, payload)
  }

  if (command === 'trick') {
    return buildTrickAssistantText(payload)
  }

  if (command === 'talk') {
    return normalizeOneLineText(payload.response) || 'Talk request handled locally.'
  }

  return formatActiveRuntimeSummary(payload) || summarizeParsedCommand(command, payload)
}

function buildTrickAssistantText(payload) {
  const targetLabel = payload.runtimeTarget?.label || runtimeConfig.robotRuntime.activeTarget.label || 'robot'
  const preview = isRobotRuntimeTarget(payload) ? payload.robotRuntime : payload.isaacSim
  const dispatch = isRobotRuntimeTarget(payload) ? payload.robotDispatch : payload.isaacDispatch
  const params = preview?.canonicalPlan?.params || preview?.payload?.canonicalPlan?.params || {}
  const trickName = formatTrickName(params.trick || payload.parsed?.trick || 'trick')
  const actionId = Number.isInteger(params.actionId) ? params.actionId : null
  const actionSuffix = actionId === null ? '' : ` Action ${actionId}.`
  const kind = preview?.canonicalPlan?.kind || preview?.payload?.canonicalPlan?.kind || ''

  if (dispatch?.status === 'sent') {
    if (kind === 'action.loop') {
      return params.enabled === false
        ? `Stopped ${trickName} mode on ${targetLabel}.`
        : `Started ${trickName} mode on ${targetLabel}.`
    }

    return `Sent ${trickName} to ${targetLabel}.${actionSuffix}`
  }

  if (dispatch?.status === 'dry-run') {
    return `Dry-run only: ${trickName} not sent to ${targetLabel}.${actionSuffix}`
  }

  if (isRobotRuntimeTarget(payload) && isRobotDispatchFailure(dispatch)) {
    return `Trick failed: ${dispatch.error || `HTTP ${dispatch.responseStatus || 'unknown'}`}.`
  }

  if (dispatch?.status === 'error') {
    return `Trick failed: ${dispatch.error || `HTTP ${dispatch.responseStatus || 'unknown'}`}.`
  }

  if (preview?.status === 'ready') {
    return `Trick ready for ${targetLabel}: ${trickName}.${actionSuffix}`
  }

  if (preview?.status && !['no-command', 'no-action'].includes(preview.status)) {
    const reason = firstWarning(preview) || formatActiveRuntimeSummary(payload)
    return `Trick not sent: ${reason || preview.status}.`
  }

  return `Trick not sent: ${firstWarning(preview) || 'No executable trick action was compiled.'}`
}

function buildCompletionStatus(payload) {
  const parts = [
    `Done via ${payload.profileLabel}.`,
    `Target ${payload.runtimeTarget?.label || runtimeConfig.robotRuntime.activeTarget.label}.`,
  ]
  const activeSummary = formatActiveRuntimeSummary(payload)

  if (activeSummary) {
    parts.push(activeSummary)
  }

  return parts.join(' ')
}

function formatParsedOutput(payload) {
  const sections = [
    payload.parsed ? JSON.stringify(payload.parsed, null, 2) : 'Not JSON.',
    `Active target:\n${JSON.stringify(payload.runtimeTarget || runtimeConfig.robotRuntime.activeTarget, null, 2)}`,
  ]

  if (isIsaacRuntimeTarget(payload) && payload.isaacSim) {
    sections.push(`Isaac preview:\n${JSON.stringify(payload.isaacSim, null, 2)}`)
  }

  if (isIsaacRuntimeTarget(payload) && payload.isaacDispatch) {
    sections.push(`Isaac dispatch:\n${JSON.stringify(payload.isaacDispatch, null, 2)}`)
  }

  if (isRobotRuntimeTarget(payload) && payload.robotRuntime) {
    sections.push(`Robot preview:\n${JSON.stringify(payload.robotRuntime, null, 2)}`)
  }

  if (isRobotRuntimeTarget(payload) && payload.robotDispatch) {
    sections.push(`Robot dispatch:\n${JSON.stringify(payload.robotDispatch, null, 2)}`)
  }

  return sections.join('\n\n')
}

function formatActiveRuntimeSummary(payload) {
  if (isIsaacRuntimeTarget(payload)) {
    return formatIsaacSummary(payload.isaacSim, payload.isaacDispatch)
  }

  if (isRobotRuntimeTarget(payload)) {
    return formatRobotSummary(payload.robotRuntime, payload.robotDispatch, payload)
  }

  return ''
}

function formatParsedCommandJson(payload, spaces = 0) {
  if (!payload?.parsed || typeof payload.parsed !== 'object') {
    return ''
  }

  try {
    return JSON.stringify(payload.parsed, null, spaces)
  } catch {
    return ''
  }
}

function summarizeParsedCommand(command, payload) {
  const targetLabel = payload?.runtimeTarget?.label || runtimeConfig.robotRuntime.activeTarget.label || 'target'
  if (command) {
    return `${formatCommandName(command)} handled for ${targetLabel}.`
  }

  return payload?.response || 'Command handled.'
}

function formatIsaacSummary(isaacSim, isaacDispatch) {
  if (isaacDispatch?.status === 'sent') {
    return 'Isaac command sent.'
  }

  if (isaacDispatch?.status === 'dry-run') {
    return 'Isaac dispatch dry-run.'
  }

  if (isaacDispatch?.status === 'preview-not-ready') {
    return 'Isaac not sent because preview not ready.'
  }

  if (isaacDispatch?.status === 'disabled') {
    return 'Isaac transport disabled.'
  }

  if (isaacDispatch?.status === 'error') {
    return `Isaac dispatch failed: ${isaacDispatch.error || `HTTP ${isaacDispatch.responseStatus || 'unknown'}`}.`
  }

  if (isaacSim?.status === 'ready') {
    return 'Isaac preview ready.'
  }

  if (isaacSim?.status && isaacSim.status !== 'no-command') {
    return `Isaac preview ${isaacSim.status}.`
  }

  return ''
}

function formatRobotSummary(robotRuntime, robotDispatch, payload) {
  if (robotDispatch?.status === 'sent') {
    const commandJson = formatParsedCommandJson(payload)
    return commandJson ? `Robot command JSON: ${commandJson}` : 'Robot dispatch completed.'
  }

  if (robotDispatch?.status === 'dry-run') {
    return 'Robot dispatch dry-run.'
  }

  if (robotDispatch?.status === 'preview-not-ready') {
    return 'Robot not sent because preview not ready.'
  }

  if (robotDispatch?.status === 'inactive-target') {
    return 'Robot target inactive.'
  }

  if (robotDispatch?.status === 'disabled') {
    return 'Robot transport disabled.'
  }

  if (robotDispatch?.status === 'navigation-unavailable' || robotDispatch?.status === 'waypoint-blocked') {
    if (robotDispatch.recovery) {
      return `Repairing navigation: ${robotDispatch.recovery}`
    }
    return robotDispatch.operatorMessage
      || 'Waypoint not sent: DOGZILLA map pose is available, but no waypoint navigation server is running. Manual controls and non-waypoint actions are still available.'
  }

  if (isRobotDispatchFailure(robotDispatch)) {
    return `Robot dispatch failed: ${robotDispatch.error || `HTTP ${robotDispatch.responseStatus || 'unknown'}`}.`
  }

  if (robotRuntime?.status === 'ready') {
    return 'Robot preview ready.'
  }

  if (robotRuntime?.status === 'no-op') {
    return 'Robot plan no-op.'
  }

  if (robotRuntime?.status && !['no-command', 'no-action'].includes(robotRuntime.status)) {
    return `Robot preview ${robotRuntime.status}.`
  }

  return ''
}

function isRobotDispatchFailure(robotDispatch) {
  if (!robotDispatch) return false
  const status = robotDispatch.status
  if (!status) return false
  if (status === 'navigation-unavailable' && robotDispatch.recovery) {
    return false
  }
  return ['error', 'navigation-unavailable', 'waypoint-blocked', 'preempt-failed'].includes(status)
}

function isActiveDispatchFailure(payload) {
  if (isIsaacRuntimeTarget(payload)) {
    return payload.isaacDispatch?.status === 'error'
  }

  if (isRobotRuntimeTarget(payload)) {
    return isRobotDispatchFailure(payload.robotDispatch)
  }

  return false
}

function isIsaacRuntimeTarget(payload) {
  return getRuntimeTargetKind(payload) === 'isaacsim'
}

function isRobotRuntimeTarget(payload) {
  return ['ros2-bridge', 'dogzilla-direct'].includes(getRuntimeTargetKind(payload))
}

function getRuntimeTargetKind(payload) {
  return payload?.runtimeTarget?.kind || runtimeConfig.robotRuntime.activeTarget?.kind || ''
}

function normalizeCommandName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function formatCommandName(value) {
  return normalizeCommandName(value).replace(/_/g, ' ') || 'command'
}

function formatTrickName(value) {
  const normalized = String(value || '').trim().replace(/_/g, ' ')
  return normalized || 'trick'
}

function normalizeOneLineText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

function firstWarning(preview) {
  return Array.isArray(preview?.warnings) ? normalizeOneLineText(preview.warnings[0]) : ''
}

function formatRobotSitTestSummary(health, preview, dispatch) {
  const targetLabel = preview?.targetLabel || runtimeConfig.robotRuntime.activeTarget?.label || 'robot'
  const healthStatus = health?.status || 'unknown'
  const healthPrefix = healthStatus === 'ok' ? 'Bridge ok.' : `Bridge ${healthStatus}.`

  if (dispatch?.status === 'sent') {
    return `${healthPrefix} Sit sent to ${targetLabel}.`
  }

  if (dispatch?.status === 'dry-run') {
    return `${healthPrefix} Sit compiled; dry-run blocked live send.`
  }

  if (dispatch?.status === 'preview-not-ready') {
    return `${healthPrefix} Sit not sent; preview ${dispatch.previewStatus || preview?.status || 'not ready'}.`
  }

  if (dispatch?.status === 'inactive-target') {
    return `${healthPrefix} Sit not sent; target inactive.`
  }

  if (dispatch?.status === 'disabled') {
    return `${healthPrefix} Sit not sent; transport disabled.`
  }

  if (dispatch?.status === 'error') {
    return `${healthPrefix} Sit failed: ${dispatch.error || `HTTP ${dispatch.responseStatus || 'unknown'}`}.`
  }

  return `${healthPrefix} Sit test ${dispatch?.status || preview?.status || 'complete'}.`
}

function formatEmergencyStopSummary(dispatch) {
  const targetLabel = dispatch?.envelope?.targetLabel || runtimeConfig.robotRuntime.activeTarget?.label || 'robot'

  if (dispatch?.status === 'sent') {
    return `Stop sent to ${targetLabel}.`
  }

  if (dispatch?.status === 'inactive-target') {
    return 'Stop not sent; target inactive.'
  }

  if (dispatch?.status === 'disabled') {
    return 'Stop not sent; transport disabled.'
  }

  if (dispatch?.status === 'unsupported-transport') {
    return 'Stop not sent; unsupported transport.'
  }

  if (dispatch?.status === 'error') {
    return `Stop failed: ${dispatch.error || `HTTP ${dispatch.responseStatus || 'unknown'}`}.`
  }

  return `Stop ${dispatch?.status || 'complete'}.`
}

function setSpeechStatus(message, isError = false) {
  speechPanel.dataset.state = isError ? 'error' : 'ready'
  speechStatus.textContent = message
}

function setRuntimeFeedbackStatus(message, isError = false) {
  runtimePanel.dataset.state = isError ? 'error' : 'ready'
  runtimeFeedbackStatus.textContent = message
}

function updateSpeechPreview(text, phase) {
  speechPreview.textContent = phase === 'commit' ? `Committed: ${text}` : `Live: ${text}`
}

function isValidCommandPayload(parsed) {
  return !!(
    parsed
    && typeof parsed === 'object'
    && typeof parsed.command === 'string'
    && parsed.command.trim()
  )
}

function playCommandCueIfNeeded(parsed) {
  if (!isValidCommandPayload(parsed)) {
    return
  }

  playRobotConfirmCue().catch((error) => {
    console.warn('Command cue failed:', error)
  })
}

function isRealRobotTargetActive() {
  return ['ros2-bridge', 'dogzilla-direct'].includes(runtimeConfig.robotRuntime.activeTarget?.kind)
}

function handleVoiceCommand(message, context) {
  if (!message) {
    return
  }

  if (sendButton.disabled) {
    setSpeechStatus(`Voice command heard but app is busy: ${message}`, true)
    return
  }

  input.value = message
  setSpeechStatus(`Activation phrase heard (${context.activationPhrase}). Sending voice command...`)

  if (typeof form.requestSubmit === 'function') {
    form.requestSubmit()
    return
  }

  form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
}

function appendMessage({ role, text, type, meta, pending = false, error = false }) {
  const article = document.createElement('article')
  article.className = `message message-${type}`

  if (pending) {
    article.classList.add('message-pending')
  }

  if (error) {
    article.classList.add('message-error')
  }

  const roleNode = document.createElement('div')
  roleNode.className = 'message-role'
  roleNode.textContent = role

  const bubbleNode = document.createElement('pre')
  bubbleNode.className = 'message-bubble'
  bubbleNode.textContent = text

  const metaNode = document.createElement('div')
  metaNode.className = 'message-meta'
  metaNode.textContent = meta

  article.append(roleNode, bubbleNode, metaNode)
  chatLog.prepend(article)
  trimChatHistory()
  scrollChatToTop()
  return article
}

function clearEmptyChat() {
  const empty = chatLog.querySelector(EMPTY_CHAT_SELECTOR)
  if (empty) {
    empty.remove()
  }
}

function startThinkingFeedback(messageNode) {
  const bubble = messageNode.querySelector('.message-bubble')
  const meta = messageNode.querySelector('.message-meta')
  const startedAt = Date.now()
  const phases = [
    'Thinking',
    'Reading prompt and schema',
    `Calling ${runtimeConfig.activeProfile.label}`,
    `Target ${runtimeConfig.robotRuntime.activeTarget.label}`,
  ]
  let frame = 0
  stopThinkingCue()
  const cueToken = ++thinkingCueToken
  playRobotThinkingCue().then((cue) => {
    if (cueToken !== thinkingCueToken) {
      cue?.stop?.()
      return
    }

    activeThinkingCue = cue || null
  }).catch((error) => {
    console.warn('Thinking cue failed:', error)
  })

  const tick = () => {
    const elapsedMs = Date.now() - startedAt
    const dots = '.'.repeat((frame % 3) + 1)
    const phaseIndex = Math.min(Math.floor(elapsedMs / 2500), phases.length - 1)
    bubble.textContent = `${phases[phaseIndex]}${dots}`
    meta.textContent = `${formatElapsed(elapsedMs)} elapsed.`
    setStatus(
      `${appConfig.thinkingStatus} via ${runtimeConfig.activeProfile.label}. Target ${runtimeConfig.robotRuntime.activeTarget.label}.`,
      'busy',
      elapsedMs,
    )
    scrollChatToTop()
    frame += 1
  }

  tick()

  return {
    startedAt,
    timerId: window.setInterval(tick, 350),
  }
}

async function playRobotConfirmCue() {
  if (dogzillaAudio.shouldUsePiAudio()) {
    await dogzillaAudio.playPiCue('confirm')
    return null
  }

  if (dogzillaAudio.shouldSuppressLocalAudio()) {
    return null
  }

  return commandCuePlayer.play()
}

async function playRobotThinkingCue() {
  if (dogzillaAudio.shouldUsePiAudio()) {
    await dogzillaAudio.playPiCue('thinking-start')
    return null
  }

  if (dogzillaAudio.shouldSuppressLocalAudio()) {
    return null
  }

  return thinkingCuePlayer.play()
}

function finishThinkingFeedback(messageNode, { text, meta, error = false }) {
  stopThinkingCue()

  if (thinkingState) {
    window.clearInterval(thinkingState.timerId)
  }

  messageNode.classList.remove('message-pending')
  messageNode.classList.toggle('message-error', error)
  messageNode.querySelector('.message-bubble').textContent = text
  messageNode.querySelector('.message-meta').textContent = meta
  scrollChatToTop()
}

function stopThinkingCue() {
  thinkingCueToken += 1
  if (dogzillaAudio.shouldUsePiAudio()) {
    dogzillaAudio.playPiCue('thinking-stop').catch(() => {})
  }

  if (activeThinkingCue) {
    activeThinkingCue.stop()
    activeThinkingCue = null
    return
  }

  thinkingCuePlayer.stopAll()
}

function setStatus(message, state = 'idle', elapsedMs = null) {
  status.dataset.state = state
  statusText.textContent = message
  statusTimer.textContent = typeof elapsedMs === 'number' ? formatElapsed(elapsedMs) : ''
}

function formatElapsed(elapsedMs) {
  return `${(elapsedMs / 1000).toFixed(1)}s`
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function formatWaypointName(value) {
  return String(value || 'the target').replaceAll('_', ' ')
}

function formatEventTimestamp(value) {
  const parsed = new Date(value)

  if (Number.isNaN(parsed.valueOf())) {
    return String(value)
  }

  return parsed.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
}

function stringifyForOneLine(value) {
  if (typeof value === 'string') {
    return value
  }

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function trimChatHistory() {
  const messages = Array.from(chatLog.querySelectorAll(MESSAGE_SELECTOR))
  const { overflow } = splitRecentChatHistory(messages)

  for (const staleMessage of overflow) {
    staleMessage.remove()
  }
}

function scrollChatToTop() {
  chatLog.scrollTop = 0
}

function applyAppConfig() {
  document.title = appConfig.pageTitle
  appEyebrow.textContent = appConfig.introEyebrow
  if (appTitleText) {
    appTitleText.textContent = appConfig.consoleTitle
    appTitle.setAttribute('aria-label', appConfig.consoleTitle)
  } else {
    appTitle.textContent = appConfig.consoleTitle
  }
  if (appDescription) {
    appDescription.textContent = appConfig.introDescription || ''
    appDescription.hidden = !appConfig.introDescription
  }
  sendButton.textContent = appConfig.sendButtonLabel
  emptyMessageRole.textContent = appConfig.assistantName
  emptyMessageBubble.textContent = appConfig.emptyChatMessage
  emptyMessageMeta.textContent = appConfig.emptyChatMeta
  parsedOutput.textContent = appConfig.waitingForJsonMessage
}

window.addEventListener('beforeunload', () => {
  speechController?.dispose?.()
  speechController?.stop()
  manualControl.dispose()

  if (robotFeedbackTimerId) {
    window.clearInterval(robotFeedbackTimerId)
  }

  if (robotStateTimerId) {
    window.clearInterval(robotStateTimerId)
  }

  if (robotLidarTimerId) {
    window.clearInterval(robotLidarTimerId)
  }
})
