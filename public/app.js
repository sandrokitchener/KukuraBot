import { createSpeechInputController } from './speech-input.js'
import { createCommandCuePlayer } from './command-cue.js'
import { splitRecentChatHistory } from './chat-history.js'
import { createMobileNavigationController, isAndroidAppShell } from './mobile-navigation.js'
import { apiFetch, getApiBaseUrl, normalizeApiBaseUrl, setApiBaseUrl, toApiUrl } from './api-client.js'
import { createDogzillaAudioController } from './dogzilla-audio.js'
import { createManualControlController } from './manual-control.js'
import { parseExplicitVisionCommand } from './vision-command.js'
import {
  createRobotMapRenderer,
  formatMapStatusPayload,
  formatWaypointReadinessSummary,
} from './robot-map.js'
import {
  buildNavChainComponents,
  getConnectionActionConfirmation,
  isDangerousConnectionAction,
  summarizeNavChain,
} from './operator-status.js'

const appEyebrow = document.querySelector('#app-eyebrow')
const appTitle = document.querySelector('#app-title')
const appTitleText = document.querySelector('#app-title-text')
const appDescription = document.querySelector('#app-description')
const profileSelect = document.querySelector('#profile-select')
const saveProfileButton = document.querySelector('#save-profile-button')
const settingsStatus = document.querySelector('#settings-status')
const robotTargetSelect = document.querySelector('#robot-target-select')
const saveRobotTargetButton = document.querySelector('#save-robot-target-button')
const robotTargetStatus = document.querySelector('#robot-target-status')
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
const manualControlSpeedSlider = document.querySelector('#manual-control-speed-slider')
const manualControlSpeedValue = document.querySelector('#manual-control-speed-value')
const manualTouchControls = document.querySelector('#manual-touch-controls')
const manualTouchLeftStick = document.querySelector('#manual-touch-left-stick')
const manualTouchRightStick = document.querySelector('#manual-touch-right-stick')
const speechPanel = document.querySelector('.speech-panel')
const speechProfileName = document.querySelector('#speech-profile-name')
const speechProfileSelect = document.querySelector('#speech-profile-select')
const saveSpeechProfileButton = document.querySelector('#save-speech-profile-button')
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
  unknown: '',
}

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
const robotPoseReadout = document.querySelector('#robot-pose-readout')
const robotMapPanel = document.querySelector('.robot-map-panel')
const mapWorkflowPanel = document.querySelector('#map-workflow-panel')
const robotCameraPanel = document.querySelector('#robot-camera-panel')
const robotCameraFrame = document.querySelector('#robot-camera-frame')
const robotCameraChip = document.querySelector('#robot-camera-chip')
const robotCameraMeta = document.querySelector('#robot-camera-meta')
const robotCameraRefreshButton = document.querySelector('#robot-camera-refresh-button')
const robotCameraRecoverButton = document.querySelector('#robot-camera-recover-button')
const robotCameraYoloToggle = document.querySelector('#robot-camera-yolo-toggle')
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
const dogzillaAudioVolumeInput = document.querySelector('#dogzilla-audio-volume-input')
const dogzillaAudioVolumeValue = document.querySelector('#dogzilla-audio-volume-value')
const connectionOutput = document.querySelector('#connection-output')
const connectionActionButtons = document.querySelectorAll('[data-connection-action]')
const runDogzillaPreflightButton = document.querySelector('#run-dogzilla-preflight-button')
const checkPiPerformanceButton = document.querySelector('#check-pi-performance-button')
const dogzillaPreflightStatus = document.querySelector('#dogzilla-preflight-status')
const dogzillaPreflightSummary = document.querySelector('#dogzilla-preflight-summary')
const dogzillaPreflightChecks = document.querySelector('#dogzilla-preflight-checks')
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
const executionTimeline = document.querySelector('#execution-timeline')
const executionTimelineStatus = document.querySelector('#execution-timeline-status')
const executionTimelineSteps = document.querySelectorAll('.execution-step[data-execution-step]')
const executionTimelineDetails = {
  intent: document.querySelector('#execution-intent-detail'),
  planning: document.querySelector('#execution-planning-detail'),
  navigation: document.querySelector('#execution-navigation-detail'),
  completion: document.querySelector('#execution-completion-detail'),
}
const workflowTabs = document.querySelectorAll('[data-workflow-tab]')
const workflowPanels = document.querySelectorAll('[data-workflow-panel]')
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
  lidarPollMs: 750,
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
let slamMappingSessionActive = false
let slamMappingSessionStartedAt = 0
let connectionActionPending = false
let autonomousMappingActive = false
let autonomousMappingStarting = false
let autonomousMapCandidateAvailable = false
let emergencyStopActive = false
let emergencyStopStateKnown = false
let activeThinkingCue = null
let thinkingCueToken = 0
let reconSnapshots = []
let executionTimelinePayload = null
let executionTimelineNavigation = false
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
  sendButtonLabel: 'Send request',
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
let dogzillaStartupRepairAttempted = false
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
    speedSlider: manualControlSpeedSlider,
    speedValue: manualControlSpeedValue,
    touchControls: manualTouchControls,
    touchLeftStick: manualTouchLeftStick,
    touchRightStick: manualTouchRightStick,
  },
  apiFetch,
  toApiUrl,
  getRuntimeConfig: () => runtimeConfig,
  isRealRobotTargetActive,
  formatError,
  setStatus,
  playBarkCue: () => dogzillaAudio.playPiCue('bark'),
})
const mobileNavigation = createMobileNavigationController({
  documentRef: document,
  navigatorRef: navigator,
  windowRef: window,
  manualControl,
  manualTouchLeftStick,
  manualTouchRightStick,
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
  },
  defaultRobotRuntime: DEFAULT_ROBOT_RUNTIME,
  getRuntimeConfig: () => runtimeConfig,
  formatEventTimestamp,
})

mobileNavigation.init()
boot()

form.addEventListener('submit', handleChatSubmit)
saveProfileButton.addEventListener('click', handleProfileSave)
saveSpeechProfileButton.addEventListener('click', handleSpeechProfileSave)
saveRobotTargetButton.addEventListener('click', handleRobotTargetSave)
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
checkPiPerformanceButton?.addEventListener('click', handlePiPerformanceCheck)
dogzillaAudioVolumeInput?.addEventListener('input', dogzillaAudio.handleVolumeInput)
robotCameraSnapshotButton.addEventListener('click', handleReconSnapshot)
robotCameraRefreshButton.addEventListener('click', handleDogzillaCameraRefresh)
robotCameraRecoverButton.addEventListener('click', handleDogzillaCameraRecover)
robotCameraYoloToggle?.addEventListener('click', handleDogzillaYoloToggle)
reconGalleryToggle.addEventListener('click', handleReconGalleryToggle)
reconGalleryClose.addEventListener('click', closeReconGallery)
reconSnapshotList.addEventListener('click', handleReconSnapshotListClick)

document.addEventListener('click', (event) => {
  const button = event.target.closest?.('[data-connection-action]')
  if (button) {
    void handleDogzillaConnectionAction({ currentTarget: button })
  }
})

const waypointCaptureButton = document.getElementById('waypoint-capture-button')
const waypointCaptureInput = document.getElementById('waypoint-capture-name')
const waypointCaptureStatus = document.getElementById('waypoint-capture-status')
const waypointReadinessButton = document.getElementById('waypoint-readiness-button')
const mapWorkflowStatus = document.getElementById('map-workflow-status')
waypointCaptureButton?.addEventListener('click', handleWaypointCapture)
waypointReadinessButton?.addEventListener('click', handleWaypointReadinessCheck)

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

for (const tab of workflowTabs) {
  tab.addEventListener('click', () => setWorkflowTab(tab.dataset.workflowTab))
}

for (const railButton of document.querySelectorAll('[data-rail-target]')) {
  railButton.addEventListener('click', () => handleRailNavigation(railButton.dataset.railTarget))
}

robotCameraFrame.addEventListener('error', handleDogzillaCameraFrameError)
robotCameraFrame.addEventListener('load', handleDogzillaCameraFrameLoad)
window.addEventListener('gamepadconnected', manualControl.handleGamepadConnected)
window.addEventListener('gamepaddisconnected', manualControl.handleGamepadDisconnected)
window.addEventListener('blur', manualControl.handleWindowBlur)
document.addEventListener('visibilitychange', () => manualControl.handleVisibilityChange(document.hidden))
manualControlPanel?.addEventListener('pointercancel', manualControl.handlePointerLoss)
manualControlPanel?.addEventListener('lostpointercapture', manualControl.handlePointerLoss)

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
  startExecutionTimeline(message)
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
    updateExecutionTimelineFromPayload(payload)
    applyVisionDispatchResult(payload)

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
    executionTimelinePayload = null
    executionTimelineNavigation = false
    setExecutionStep('intent', 'error', formatError(error))
    setExecutionStep('planning', 'idle', 'Not reached.')
    setExecutionStep('navigation', 'idle', 'Not applicable.')
    setExecutionStep('completion', 'error', 'Request failed.')
    if (executionTimelineStatus) executionTimelineStatus.textContent = 'Request failed.'
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
  let payload
  if (shouldUseAndroidLocalModel()) {
    payload = await submitAndroidLocalModelMessage(message)
  } else {
    const response = await apiFetch('/api/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ input: message }),
    })

    payload = await response.json()
    if (!response.ok) {
      throw new Error(payload.error || 'Request failed.')
    }
  }

  return enforceExplicitVisionCommand(message, payload)
}

async function enforceExplicitVisionCommand(message, payload) {
  const command = parseExplicitVisionCommand(message)
  if (!command || payload?.parsed?.command === 'vision') return payload

  const response = await apiFetch('/api/dogzilla/vision/toggle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: command.enabled }),
  })
  const toggle = await response.json()
  if (!response.ok || toggle.ok === false) {
    throw new Error(toggle.error || 'Vision command was not executed.')
  }

  return {
    ...payload,
    response: JSON.stringify(command),
    parsed: command,
    robotRuntime: {
      ...payload.robotRuntime,
      status: 'ready',
      command: 'vision',
      action: 'dogzilla.vision_toggle',
      canonicalPlan: { kind: 'vision.toggle', params: { enabled: command.enabled } },
    },
    robotDispatch: {
      ...toggle,
      status: 'sent',
      kind: 'vision.toggle',
      requestedEnabled: command.enabled,
      actualEnabled: toggle.actualEnabled ?? toggle.enabled,
    },
  }
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

async function handleEmergencyStop(event) {
  const triggerButton = event?.currentTarget
  if (!emergencyStopStateKnown) return
  const action = emergencyStopActive ? 'clear' : 'stop'
  if (triggerButton) {
    triggerButton.disabled = true
    triggerButton.textContent = action === 'clear' ? 'Clearing…' : 'Stopping…'
  }
  setStatus(action === 'clear' ? 'Clearing emergency stop.' : 'Sending emergency stop.', 'busy')

  try {
    const response = await apiFetch('/api/robot/stop', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action }),
    })
    const payload = await response.json()

    if (!response.ok || payload.dispatch?.status === 'error') {
      throw new Error(payload.dispatch?.error || payload.error || 'Emergency stop failed.')
    }

    await refreshEmergencyStopState()
    const summary = formatEmergencyStopSummary(payload.dispatch, action)
    setStatus(summary)
    await refreshDogzillaWaypointReadiness()
    await refreshRobotState()
  } catch (error) {
    await refreshEmergencyStopState()
    const message = formatError(error)
    setStatus(message, 'error')
  }
}

function applyVisionDispatchResult(payload) {
  const dispatch = payload?.robotDispatch
  if (dispatch?.kind !== 'vision.toggle' || typeof dispatch.actualEnabled !== 'boolean') return

  runtimeConfig.dogzilla = runtimeConfig.dogzilla || {}
  runtimeConfig.dogzilla.vision = dispatch.vision || {
    ...(runtimeConfig.dogzilla.vision || {}),
    detectionEnabled: dispatch.actualEnabled,
  }
  applyDogzillaCameraConfig()
  if (dispatch.status === 'sent') startDogzillaCameraViewer({ forceRefresh: true })
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
  const nextBaseUrl = normalizeApiBaseUrl(requestedBackendUrl)
  if (requestedBackendUrl && !nextBaseUrl) {
    throw new Error('Backend URL must start with http:// or https://.')
  }
  if (nextBaseUrl && window.location.protocol === 'https:' && nextBaseUrl.startsWith('http:')) {
    throw new Error('HTTPS app cannot connect to an HTTP backend. Use HTTPS or open the app shell.')
  }
  if (nextBaseUrl) {
    const response = await fetch(new URL('api/config', `${nextBaseUrl}/`))
    if (!response.ok) throw new Error(`Backend health check failed (${response.status}).`)
  }
  setApiBaseUrl(nextBaseUrl)
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
  if (runtimeConfig.robotRuntime.activeTarget.kind === 'isaacsim') {
    try {
      const feedbackResponse = await apiFetch('/api/isaac/feedback')
      const feedbackPayload = await feedbackResponse.json()
      announceIsaacCompletionIfNeeded(feedbackPayload)
    } catch {
      return
    }
    return
  }

  await Promise.all([
    refreshDogzillaWaypointReadiness(),
    refreshEmergencyStopState(),
  ])
}

async function refreshEmergencyStopState() {
  if (!isRealRobotTargetActive()) {
    applyEmergencyStopState(null)
    return false
  }
  try {
    const response = await apiFetch('/api/robot/health?lite=1')
    const payload = await response.json()
    if (response.ok) {
      applyAutonomousMappingState(payload?.body?.autonomousMapping)
      return applyEmergencyStopState(payload?.body)
    }
  } catch {
    // Unknown is safer than presenting stale latch state as current.
  }
  applyEmergencyStopState(null)
  return false
}

function applyEmergencyStopState(health) {
  if (typeof health?.gaitBlocked !== 'boolean') {
    emergencyStopStateKnown = false
    if (!persistentEmergencyStop) return false
    persistentEmergencyStop.dataset.state = 'unknown'
    persistentEmergencyStop.textContent = 'Unknown'
    persistentEmergencyStop.disabled = true
    persistentEmergencyStop.setAttribute('aria-label', 'Emergency stop state unavailable')
    persistentEmergencyStop.title = 'Waiting for live emergency stop state'
    return false
  }

  emergencyStopStateKnown = true
  emergencyStopActive = health?.gaitBlocked === true && health?.gaitBlockedReason === 'emergency_stop'
  if (!persistentEmergencyStop) return true
  persistentEmergencyStop.dataset.state = emergencyStopActive ? 'stopped' : 'ready'
  persistentEmergencyStop.textContent = emergencyStopActive ? 'Stopped' : 'Stop'
  persistentEmergencyStop.disabled = false
  persistentEmergencyStop.setAttribute(
    'aria-label',
    emergencyStopActive ? 'Clear emergency stop and resume robot control' : 'Emergency stop robot',
  )
  persistentEmergencyStop.title = emergencyStopActive ? 'Click to clear emergency stop' : 'Emergency stop robot'
  return true
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
  window._statePollBaseMs = pollMs
  window._statePollIntervalMs = pollMs
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
  const pollMs = runtimeConfig.robotRuntime.lidarPollMs || 750
  robotLidarTimerId = window.setInterval(() => {
    void refreshDogzillaLidarScan()
  }, pollMs)
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
  window._mapPollIntervalMs = 3000

  robotMap.setMapData(null)
  document.querySelector('.robot-map-head')?.classList.remove('has-map')
  renderMapStatus(null, null)

  if (!isRealRobotTargetActive()) {
    return
  }

  void refreshDogzillaMap()
  robotMapTimerId = window.setInterval(() => {
    void refreshDogzillaMap()
  }, 3000)
}

async function refreshDogzillaMap() {
  const mapPath = slamMappingSessionActive ? '/api/dogzilla/map?stream=slam' : '/api/dogzilla/map'
  const healthPath = '/api/dogzilla/lidar/health'

  try {
    const [mapResponse, healthResponse] = await Promise.all([
      apiFetch(mapPath),
      apiFetch('/api/dogzilla/lidar/health'),
    ])
    const [payload, healthPayload] = await Promise.all([
      mapResponse.json(),
      healthResponse.ok ? healthResponse.json() : Promise.resolve(null),
    ]).catch(() => [null, null])

    if (!mapResponse.ok || payload?.ok !== true) {
      robotMap.setMapData(null)
      document.querySelector('.robot-map-head')?.classList.remove('has-map')
      renderMapStatus(payload, healthPayload)
      adaptMapPollInterval(healthPayload)
      return
    }

    robotMap.setMapData(payload)
    document.querySelector('.robot-map-head')?.classList.add('has-map')
    renderMapStatus(payload, healthPayload)
    adaptMapPollInterval(healthPayload)
} catch {
    robotMap.setMapData(null)
    document.querySelector('.robot-map-head')?.classList.remove('has-map')
    renderMapStatus(null, null)
    adaptMapPollInterval(null)
  }
}

function renderMapStatus(mapPayload, healthPayload) {
  const status = formatMapStatusPayload(mapPayload, healthPayload)

  const saveMapButton = document.getElementById('save-map-button')
  const newMapButton = document.getElementById('new-map-button')
  const slamModeChip = document.getElementById('slam-mode-chip')
  const gridAfterSlamStart = slamMappingSessionActive
    && typeof status.receivedAtEpoch === 'number'
    && status.receivedAtEpoch >= slamMappingSessionStartedAt
  const mappingGridFresh = status.fresh && (status.mode === 'mapping' || gridAfterSlamStart)
  const mappingActive = slamMappingSessionActive || mappingGridFresh
  if (saveMapButton) {
    saveMapButton.disabled = !mappingActive
    saveMapButton.title = mappingGridFresh
      ? 'Save the live SLAM map and make it the default'
      : slamMappingSessionActive
        ? 'Save the active SLAM map. If the grid is not ready yet, the bridge will report why.'
        : 'Start New Map before saving'
  }
  if (newMapButton) {
    newMapButton.disabled = mappingActive
    newMapButton.title = mappingActive ? 'Mapping is already running' : 'Start a new live SLAM map'
  }
  if (slamModeChip) {
    slamModeChip.textContent = mappingGridFresh ? formatSlamChipLabel(status) : 'SLAM waiting for occupancy grid'
    slamModeChip.hidden = !mappingActive
  }
  if (mappingActive) {
    ensureTopDownMapView()
  }

  const workflowSummary = formatMapWorkflowSummary(status, healthPayload)
  if (workflowSummary) {
    setMapWorkflowStatus(workflowSummary.message, workflowSummary.state)
  }
}

async function stopDogzillaSlamMapStream() {
  try {
    await apiFetch('/api/dogzilla/map?stream=off')
  } catch {
    // Best effort only; the next app/server start will use the default topic list.
  }
}

function setRecenterVisualState(state) {
  const running = state === 'running'
  const success = state === 'success'
  const error = state === 'error'
  const label = running ? 'Relocalizing...' : 'Relocalize on Map'
  for (const button of document.querySelectorAll('[data-connection-action="start-map-pose"]')) {
    if (button.textContent === 'Relocalize on Map' || button.textContent === 'Relocalizing...') {
      button.textContent = label
    }
  }
  if (running) {
    setMapWorkflowStatus('Matching live LiDAR against the full saved map...', '')
  } else if (success) {
    setMapWorkflowStatus('Robot location matched against the saved map.', 'success')
  } else if (error) {
  }
}

function formatSlamChipLabel(status) {
  const detail = [status.freshnessLabel, status.cellCountsLabel].filter(Boolean).join(' · ')
  return detail ? `SLAM building · ${detail}` : 'SLAM building'
}

function formatMapWorkflowSummary(status, healthPayload) {
  if (connectionActionPending) return null
  if (autonomousMappingStarting) {
    return {
      state: '',
    message: 'Preparing robot for autonomous mapping...',
    }
  }
  if (autonomousMappingActive) {
    return {
      state: 'success',
      message: 'Mapping active. The robot will stop and save automatically when coverage is complete.',
    }
  }
  if (autonomousMapCandidateAvailable) {
    return {
      state: 'success',
      message: 'Map ready to review. Use New Map when the completed map looks right.',
    }
  }
  const lidarLive = healthPayload?.ok === true || healthPayload?.status === 'ok'
  const scanText = lidarLive ? 'LiDAR overlay live' : 'LiDAR overlay unavailable'
  const gridAfterSlamStart = slamMappingSessionActive
    && typeof status.receivedAtEpoch === 'number'
    && status.receivedAtEpoch >= slamMappingSessionStartedAt
  if (status.mode === 'mapping') {
    const gridFresh = status.fresh && (!slamMappingSessionActive || gridAfterSlamStart)
    const gridText = gridFresh ? 'occupancy grid updating' : 'waiting for a fresh grid update'
    return {
      state: gridFresh ? 'success' : 'error',
      message: `SLAM building: ${gridText}; ${scanText}.`,
    }
  }
  if (slamMappingSessionActive && status.mode !== 'no-map') {
    const gridFresh = status.fresh && gridAfterSlamStart
    const gridText = gridFresh ? 'occupancy grid updating' : 'waiting for fresh grid update'
    return {
      state: gridFresh ? 'success' : 'error',
      message: `SLAM stream active: ${gridText}; ${scanText}.`,
    }
  }
  if (slamMappingSessionActive && status.mode === 'no-map') {
    return {
      state: 'error',
      message: `SLAM stream requested: waiting for first occupancy grid from Pi; ${scanText}.`,
    }
  }
  if (status.mode === 'localization') {
    return {
      state: status.fresh ? 'success' : '',
      message: status.fresh ? `Map locked: ${scanText}; save map-native waypoints.` : 'Map locked: waiting for fresh localization grid.',
    }
  }
  if (status.mode === 'no-map') {
    return {
      state: '',
      message: 'No occupancy grid loaded. Start New Map to build SLAM.',
    }
  }
  if (status.mode && status.mode !== 'unknown') {
    return {
      state: status.fresh ? 'success' : '',
      message: `Map mode ${status.mode}: ${scanText}.`,
    }
  }
  return null
}

function ensureTopDownMapView() {
  if (robotMap.getViewMode() === 'map') return
  robotMap.setViewMode('map')
}

function adaptMapPollInterval(healthPayload) {
  const mode = healthPayload?.map?.mode || healthPayload?.body?.runtime?.map?.mode
  const navMode = healthPayload?.navMode || healthPayload?.body?.navMode || healthPayload?.body?.runtime?.navMode
  let mapPollMs = 3000
  if (mode === 'mapping') {
    mapPollMs = 1500
  }
  if (!robotMapTimerId) return
  if (window._mapPollIntervalMs === mapPollMs) return
  window._mapPollIntervalMs = mapPollMs
  window.clearInterval(robotMapTimerId)
  robotMapTimerId = window.setInterval(() => {
    void refreshDogzillaMap()
  }, mapPollMs)
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

  const staleByName = new Map((staleWaypoints || []).map((waypoint) => [waypoint.name, waypoint]))
  const names = Array.isArray(runtimeConfig.robotRuntime?.waypoints)
    ? runtimeConfig.robotRuntime.waypoints.map((waypoint) => waypoint.id)
    : [...staleByName.keys()]
  if (names.length === 0) {
    panel.hidden = true
    list.replaceChildren()
    return
  }

  panel.hidden = false
  const items = names.map((name) => {
    const waypoint = staleByName.get(name) || { name, reason: '' }
    const li = document.createElement('li')
    li.className = 'stale-waypoints-item'
    li.dataset.waypointName = name

    const nameSpan = document.createElement('span')
    nameSpan.className = 'stale-waypoints-name'
    nameSpan.textContent = name

    const reasonSpan = document.createElement('span')
    reasonSpan.className = 'stale-waypoints-reason'
    reasonSpan.textContent = waypoint.reason || 'Current map entry'

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'stale-waypoints-recapture'
    button.textContent = 'Re-save'
    button.dataset.waypointName = waypoint.name
    button.addEventListener('click', () => handleStaleWaypointRecapture(name))

    const rename = document.createElement('button')
    rename.type = 'button'
    rename.className = 'stale-waypoints-recapture'
    rename.textContent = 'Rename'
    rename.addEventListener('click', () => handleWaypointRename(name))

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'stale-waypoints-recapture'
    remove.textContent = 'Delete'
    remove.addEventListener('click', () => handleWaypointDelete(name))

    const revalidate = document.createElement('button')
    revalidate.type = 'button'
    revalidate.className = 'stale-waypoints-recapture'
    revalidate.textContent = 'Revalidate'
    revalidate.disabled = !staleByName.has(name)
    revalidate.addEventListener('click', () => handleWaypointRevalidate(name))

    li.append(nameSpan, reasonSpan, button, rename, remove, revalidate)
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

function handleRailNavigation(target) {
  const railButtons = document.querySelectorAll('[data-rail-target]')
  const activeTarget = target === 'snapshots' ? null : target
  for (const button of railButtons) {
    const isActive = activeTarget && button.dataset.railTarget === activeTarget
    button.classList.toggle('is-active', Boolean(isActive))
    if (isActive) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  }

  if (target === 'snapshots') return
  if (target === 'cpu') {
    if (connectionDrawer?.hidden) handleConnectionToggle()
    document.querySelector('#check-pi-performance-button')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    return
  }

  if (target === 'camera') {
    document.querySelector('.robot-tab[data-robot-view="camera"]')?.click()
  } else {
    document.querySelector('.robot-tab[data-robot-view="overview"]')?.click()
  }

  const destination = target === 'console'
    ? document.querySelector('#chat-form')
    : target === 'logs'
      ? document.querySelector('#chat-log')
      : target === 'waypoints'
        ? document.querySelector('#map-workflow-panel')
        : document.querySelector('#robot-map-panel, .robot-map-panel')

  if (target === 'waypoints') setWorkflowTab('waypoints')
  destination?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  if (target === 'console') input?.focus()
}

function setWorkflowTab(tabName = 'mapping') {
  const nextTab = ['mapping', 'navigation', 'waypoints'].includes(tabName) ? tabName : 'mapping'
  for (const tab of workflowTabs) {
    const isActive = tab.dataset.workflowTab === nextTab
    tab.classList.toggle('is-active', isActive)
    tab.setAttribute('aria-selected', String(isActive))
  }
  for (const panel of workflowPanels) {
    if (!panel.id?.startsWith('workflow-panel-')) continue
    panel.hidden = panel.dataset.workflowPanel !== nextTab
  }
}

function setExecutionStep(name, state, detail) {
  const step = document.querySelector(`.execution-step[data-execution-step="${name}"]`)
  if (!step) return
  step.dataset.state = state
  if (executionTimelineDetails[name]) executionTimelineDetails[name].textContent = detail
}

function resetExecutionTimeline() {
  setExecutionStep('intent', 'idle', 'Waiting for a command.')
  setExecutionStep('planning', 'idle', 'Not started.')
  setExecutionStep('navigation', 'idle', 'Not applicable.')
  setExecutionStep('completion', 'idle', 'Waiting for a command.')
  if (executionTimelineStatus) executionTimelineStatus.textContent = 'Ready.'
}

function startExecutionTimeline(message) {
  executionTimelinePayload = null
  executionTimelineNavigation = false
  setExecutionStep('intent', 'active', `Parsing “${message}”.`)
  setExecutionStep('planning', 'idle', 'Waiting for parsed intent.')
  setExecutionStep('navigation', 'idle', 'Not applicable.')
  setExecutionStep('completion', 'idle', 'Waiting for dispatch.')
  if (executionTimelineStatus) executionTimelineStatus.textContent = 'Working…'
}

function getCanonicalPlan(payload) {
  const preview = isRobotRuntimeTarget(payload) ? payload?.robotRuntime : payload?.isaacSim
  return preview?.canonicalPlan || preview?.payload?.canonicalPlan || null
}

function updateExecutionTimelineFromPayload(payload) {
  executionTimelinePayload = payload
  const plan = getCanonicalPlan(payload)
  const planKind = plan?.kind || ''
  const isNavigation = planKind === 'locomotion.goto'
  const dispatch = isRobotRuntimeTarget(payload) ? payload?.robotDispatch : payload?.isaacDispatch
  const failed = isActiveDispatchFailure(payload) || dispatch?.status === 'error' || dispatch?.status === 'rejected'
  executionTimelineNavigation = isNavigation

  setExecutionStep('intent', payload?.parsed ? 'done' : 'error', payload?.parsed ? `Parsed ${formatCommandName(payload.parsed.command || 'command')}.` : 'No structured intent returned.')
  setExecutionStep('planning', plan?.kind ? 'done' : failed ? 'error' : 'idle', plan?.kind ? `${plan.kind} ready.` : failed ? 'Plan unavailable.' : 'No plan required.')

  if (!isNavigation) {
    setExecutionStep('navigation', 'done', 'Not applicable for this command.')
  } else if (failed) {
    setExecutionStep('navigation', 'error', dispatch?.error || 'Navigation was not accepted.')
  } else if (dispatch?.status === 'accepted' || dispatch?.status === 'sent') {
    setExecutionStep('navigation', 'active', dispatch.status === 'accepted' ? 'Nav2 goal accepted; awaiting feedback.' : 'Navigation command sent.')
  } else {
    setExecutionStep('navigation', 'idle', 'Waiting for dispatch.')
  }

  setExecutionStep('completion', failed ? 'error' : isNavigation && (dispatch?.status === 'accepted' || dispatch?.status === 'sent') ? 'active' : 'done', failed ? 'Command blocked or failed.' : isNavigation ? 'Awaiting robot feedback.' : 'Command complete.')
  if (executionTimelineStatus) executionTimelineStatus.textContent = failed ? 'Action needs attention.' : isNavigation ? 'Awaiting robot.' : 'Complete.'
}

function updateExecutionTimelineFromNavigation(navStatus) {
  if (!executionTimelinePayload || !executionTimelineNavigation || !navStatus) return
  const status = navStatus.status || 'unknown'
  const text = navStatus.text || status
  if (['arrived', 'complete', 'completed'].includes(status)) {
    setExecutionStep('navigation', 'done', text)
    setExecutionStep('completion', 'done', 'Robot reached the target.')
    if (executionTimelineStatus) executionTimelineStatus.textContent = 'Complete.'
  } else if (['blocked', 'stuck', 'failed', 'cancelled'].includes(status)) {
    setExecutionStep('navigation', 'error', text)
    setExecutionStep('completion', 'error', 'Operator attention required.')
    if (executionTimelineStatus) executionTimelineStatus.textContent = 'Action needs attention.'
  } else {
    setExecutionStep('navigation', 'active', text)
    setExecutionStep('completion', 'active', 'Awaiting robot feedback.')
    if (executionTimelineStatus) executionTimelineStatus.textContent = 'Awaiting robot.'
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
  if (action === 'start-map-pose-mapping') {
    slamMappingSessionActive = false
    const slamChip = document.getElementById('slam-mode-chip')
    const newMapBtn = document.getElementById('new-map-button')
    const saveMapBtn = document.getElementById('save-map-button')
    if (slamChip) {
      slamChip.textContent = 'Starting SLAM...'
      slamChip.hidden = false
    }
    if (newMapBtn) newMapBtn.disabled = true
    if (saveMapBtn) saveMapBtn.disabled = true
    ensureTopDownMapView()
    setMapWorkflowStatus('Starting SLAM mapping...', '')
  } else if (action === 'save-map-pose') {
    setMapWorkflowStatus('Saving occupancy grid and locking map...', '')
  } else if (action === 'start-autonomous-mapping' || action === 'continue-autonomous-mapping') {
    autonomousMappingStarting = true
    autonomousMappingActive = false
    updateAutonomousMappingButtons()
    setMapWorkflowStatus('Preparing robot for autonomous mapping...', '')
  } else if (action === 'finish-autonomous-mapping') {
    setMapWorkflowStatus('Stopping robot and saving candidate map...', '')
  } else if (action === 'start-map-pose') {
    setRecenterVisualState('running')
  }

  try {
    const response = await apiFetch('/api/dogzilla/connection/action', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action }),
    })
    const payload = await response.json()

    if (!response.ok || payload.status === 'error') {
      const actionError = payload.error || payload.stderr || `DOGZILLA action failed: ${action}`
      if (action === 'start-autonomous-mapping' || action === 'continue-autonomous-mapping') {
        autonomousMappingStarting = false
        autonomousMappingActive = false
        slamMappingSessionActive = false
        slamMappingSessionStartedAt = 0
        updateAutonomousMappingButtons()
      }
      if (action === 'finish-autonomous-mapping' && /already stopped/i.test(actionError)) {
        autonomousMappingActive = false
        slamMappingSessionActive = false
        slamMappingSessionStartedAt = 0
        void stopDogzillaSlamMapStream()
      }
      throw new Error(actionError)
    }

    const isAutonomousMappingStart = action === 'start-autonomous-mapping' || action === 'continue-autonomous-mapping'
    connectionStatus.textContent = isAutonomousMappingStart
      ? 'Preparing robot for autonomous mapping...'
      : `${formatConnectionAction(action)}: ${payload.status}.`
    connectionOutput.textContent = isAutonomousMappingStart
      ? 'Safety and navigation checks are running. Mapping will begin automatically when the Pi is ready.'
      : formatDogzillaActionOutput(payload)
    setStatus(isAutonomousMappingStart
      ? 'Preparing robot for autonomous mapping...'
      : `DOGZILLA ${formatConnectionAction(action)} ${payload.status}.`)

    // Update SLAM mode indicators
    const slamChip = document.getElementById('slam-mode-chip')
    const newMapBtn = document.getElementById('new-map-button')
    const saveMapBtn = document.getElementById('save-map-button')
  if (action === 'start-map-pose-mapping') {
    slamMappingSessionActive = true
    slamMappingSessionStartedAt = Date.now() / 1000
    if (slamChip) {
      slamChip.textContent = 'SLAM waiting for occupancy grid'
      slamChip.hidden = false
      }
      if (newMapBtn) newMapBtn.disabled = true
      if (saveMapBtn) saveMapBtn.disabled = false
      ensureTopDownMapView()
      setMapWorkflowStatus('SLAM mapping started. Waiting for occupancy grid updates...', 'success')
      void refreshDogzillaMap()
    } else if (action === 'start-autonomous-mapping' || action === 'continue-autonomous-mapping') {
      setMapWorkflowStatus('Preparing robot for autonomous mapping...', '')
    } else if (action === 'finish-autonomous-mapping') {
      autonomousMappingActive = false
      autonomousMapCandidateAvailable = true
      slamMappingSessionStartedAt = 0
      slamMappingSessionActive = true
      const startButton = document.getElementById('autonomous-map-start-button')
      const continueButton = document.getElementById('autonomous-map-continue-button')
      const finishButton = document.getElementById('autonomous-map-finish-button')
      const promoteButton = document.getElementById('autonomous-map-promote-button')
      if (startButton) startButton.disabled = false
      if (continueButton) continueButton.disabled = false
      if (finishButton) finishButton.disabled = true
      if (promoteButton) promoteButton.disabled = false
      setMapWorkflowStatus('Map ready to review. Use New Map when the completed map looks right.', 'success')
    } else if (action === 'promote-map-candidate') {
      autonomousMapCandidateAvailable = false
      slamMappingSessionActive = false
      void stopDogzillaSlamMapStream()
      const promoteButton = document.getElementById('autonomous-map-promote-button')
      if (promoteButton) promoteButton.disabled = true
      setMapWorkflowStatus('Candidate promoted. Localization and navigation restarted.', 'success')
    } else if (action === 'save-map-pose' || action === 'start-map-pose') {
      slamMappingSessionActive = false
      slamMappingSessionStartedAt = 0
      void stopDogzillaSlamMapStream()
      if (slamChip) slamChip.hidden = true
      if (newMapBtn) newMapBtn.disabled = false
      if (saveMapBtn) saveMapBtn.disabled = true
      if (action === 'start-map-pose') {
        setRecenterVisualState(payload.status === 'ok' ? 'success' : 'error')
      }
    }
    if (action === 'start-map-pose-mapping' || action === 'save-map-pose') {
      setMapWorkflowStatus(`${formatConnectionAction(action)}: ${payload.status}.`, payload.status === 'ok' ? 'success' : '')
    }

    // After saving a new map, automatically restart localization against it.
    if (action === 'save-map-pose' && payload.status === 'ok') {
      const mapSaveProof = extractMapSaveProof(payload)
      const proofSummary = mapSaveProof
        ? `Saved default map ${mapSaveProof.id || mapSaveProof.yaml || mapSaveProof.pbstream}.`
        : 'Map saved.'
      const localizationMessage = payload.localization?.status === 'ok'
        ? 'Robot relocalized from a verified full-map LiDAR match.'
        : 'Robot location remains unverified.'
      connectionStatus.textContent = `${proofSummary} ${localizationMessage}`
      connectionOutput.textContent = [
        formatMapSaveProof(mapSaveProof),
        payload.mapOriginCleared ? 'legacy charger origin cleared' : '',
        payload.localization ? `localization\n${formatDogzillaActionOutput(payload.localization)}` : ''
      ].filter(Boolean).join('\n\n')
      setStatus(`DOGZILLA ${proofSummary} ${localizationMessage}`)
      if (slamChip) slamChip.hidden = true
      if (newMapBtn) newMapBtn.disabled = false
      if (saveMapBtn) saveMapBtn.disabled = true
      setMapWorkflowStatus(`${proofSummary} ${localizationMessage}`, payload.localization?.status === 'ok' ? 'success' : 'error')
    }
  } catch (error) {
    connectionStatus.textContent = formatError(error)
    connectionOutput.textContent = formatError(error)
    if (event.currentTarget.closest?.('.map-workflow-panel')) {
      setMapWorkflowStatus(formatError(error), 'error')
    }
    if (action === 'start-map-pose') {
      setRecenterVisualState('error')
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

async function ensureDogzillaRobotLinkReady() {
  if (dogzillaStartupRepairAttempted || runtimeConfig.robotRuntime.activeTarget?.kind !== 'dogzilla-direct') {
    return
  }

  dogzillaStartupRepairAttempted = true

  try {
    const healthResponse = await apiFetch('/api/robot/health')
    const healthPayload = await healthResponse.json()
    applyAutonomousMappingState(healthPayload?.body?.autonomousMapping)
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

    if (!response.ok || payload.status === 'error' || payload.health?.status !== 'ok') {
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
    setStatus(message, 'error')
  } finally {
    setConnectionActionsDisabled(false)
  }
}

function renderDogzillaConnection(payload) {
  dogzillaConnection = payload
  const config = payload.config || {}
  const ssh = config.ssh || {}
  const robotId = payload.robot_id || payload.identity?.robot_id || config.robot_id || runtimeConfig.robotRuntime.robotId || '-'
  const robotName = payload.robot_name || payload.identity?.robot_name || config.robot_name || runtimeConfig.robotRuntime.robotName || DEFAULT_ROBOT_RUNTIME.robotName

  dogzillaHostInput.value = ssh.host || ''
  dogzillaUserInput.value = ssh.user || 'pi'
  dogzillaRemoteRootInput.value = config.remoteRoot || '/home/pi/robodoge'
  connectionChip.textContent = ssh.host ? ssh.host : 'No IP'
  const identityStatus = payload.identity?.status === 'error'
    ? ` Robot ID failed: ${payload.identity.error || 'unknown error'}`
    : robotId && robotId !== '-' ? ` Robot ID ${robotId}.` : ''
  connectionStatus.textContent = ssh.host
    ? `${ssh.user}@${ssh.host}:${ssh.port}. SSH config ${payload.sshConfigExists ? 'ready' : 'not written'}.${identityStatus}`
    : 'Set DOGZILLA IP.'
}

async function handlePiPerformanceCheck() {
  const reportWindow = openPiPerformanceWindow()
  if (!reportWindow) {
    setStatus('Pi load window was blocked by the browser.', 'error')
    return
  }
  renderPiPerformanceWindow(reportWindow, { state: 'loading' })
  checkPiPerformanceButton.disabled = true

  try {
    const response = await apiFetch('/api/dogzilla/pi-performance', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    const payload = await response.json()

    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || 'Pi performance diagnostics failed.')
    }

    renderPiPerformanceWindow(reportWindow, { state: 'ready', payload })
    setStatus('Pi performance check complete.')
  } catch (error) {
    const message = formatError(error)
    renderPiPerformanceWindow(reportWindow, { state: 'error', message })
    setStatus(message, 'error')
  } finally {
    checkPiPerformanceButton.disabled = false
  }
}

function openPiPerformanceWindow() {
  const reportWindow = window.open('', 'dogzilla-pi-performance', 'width=520,height=620')
  return reportWindow || null
}

function renderPiPerformanceWindow(reportWindow, { state, payload, message }) {
  const doc = reportWindow.document
  const data = payload?.data || {}
  const cpu = data.cpu || {}
  const memory = data.memory || {}
  const temperature = data.temperature || {}
  const system = data.system || {}
  const loadAverage = Array.isArray(cpu.loadAverage)
    ? cpu.loadAverage.map((value) => formatMetricNumber(value)).join(' / ')
    : 'Unknown'
  const uptime = typeof system.uptimeSec === 'number'
    ? formatUptime(system.uptimeSec)
    : 'Unknown'
  const throttled = system.throttled || 'Unknown'
  const body = state === 'loading'
    ? '<p class="status">Checking Pi status...</p>'
    : state === 'error'
      ? `<p class="status error">${escapeHtml(message || 'Pi performance diagnostics failed.')}</p>`
      : `
        <dl class="metrics">
          <div><dt>Host</dt><dd>${escapeHtml(data.hostname || 'DOGZILLA Pi')}</dd></div>
          <div><dt>Load average</dt><dd>${escapeHtml(loadAverage)}</dd></div>
          <div><dt>CPU cores</dt><dd>${escapeHtml(formatMetricNumber(cpu.cores))}</dd></div>
          <div><dt>Memory used</dt><dd>${escapeHtml(formatMemoryUsage(memory))}</dd></div>
          <div><dt>Temperature</dt><dd>${escapeHtml(formatTemperature(temperature.celsius))}</dd></div>
          <div><dt>Uptime</dt><dd>${escapeHtml(uptime)}</dd></div>
          <div><dt>Throttle flags</dt><dd>${escapeHtml(throttled)}</dd></div>
        </dl>
        <p class="status">Collected ${escapeHtml(formatEventTimestamp(data.collectedAt))} in ${escapeHtml(formatMetricNumber(payload.durationMs))}ms.</p>
        <details>
          <summary>Raw JSON</summary>
          <pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
        </details>
      `

  doc.open()
  doc.write(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DOGZILLA Pi Load</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #101418; color: #f4f7f9; }
    main { padding: 24px; }
    h1 { margin: 0 0 18px; font-size: 22px; letter-spacing: 0; }
    .status { margin: 14px 0 0; color: #aab6bf; }
    .status.error { color: #ffb1a5; }
    .metrics { display: grid; gap: 10px; margin: 0; }
    .metrics div { display: grid; grid-template-columns: minmax(120px, 0.8fr) 1.2fr; gap: 14px; padding: 12px; border: 1px solid #2b343c; border-radius: 8px; background: #171d22; }
    dt { color: #9aa8b3; font-size: 13px; }
    dd { margin: 0; font-weight: 700; overflow-wrap: anywhere; }
    details { margin-top: 18px; }
    summary { cursor: pointer; color: #c7d2da; }
    pre { overflow: auto; padding: 12px; border-radius: 8px; background: #080b0d; color: #dce6ec; }
  </style>
</head>
<body>
  <main>
    <h1>DOGZILLA Pi Load</h1>
    ${body}
  </main>
</body>
</html>`)
  doc.close()
  reportWindow.focus?.()
}

function formatMemoryUsage(memory) {
  const used = formatMetricNumber(memory.usedMb)
  const total = formatMetricNumber(memory.totalMb)
  const percent = formatMetricNumber(memory.usedPercent)
  if (used === 'Unknown' || total === 'Unknown') return 'Unknown'
  return `${used} / ${total} MB (${percent}%)`
}

function formatTemperature(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'Unknown'
  return `${value.toFixed(1)} C`
}

function formatUptime(seconds) {
  if (typeof seconds !== 'number' || Number.isNaN(seconds)) return 'Unknown'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function formatMetricNumber(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'Unknown'
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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
}

async function refreshWaypointRegistry() {
  applyPayload(await fetchConfig())
  await refreshDogzillaWaypointReadiness()
}

async function handleWaypointRename(name) {
  const nextName = window.prompt(`Rename waypoint "${name}"`, name)
  if (!nextName || nextName.trim() === name) return
  const response = await apiFetch(`/api/dogzilla/waypoints/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: nextName }),
  })
  const payload = await response.json()
  if (!response.ok || payload.ok !== true) throw new Error(payload.error || 'Waypoint rename failed')
  await refreshWaypointRegistry()
  setStatus(`Waypoint renamed to "${payload.name}".`)
}

async function handleWaypointDelete(name) {
  if (!window.confirm(`Delete waypoint "${name}"? This removes its saved pose.`)) return
  const response = await apiFetch(`/api/dogzilla/waypoints/${encodeURIComponent(name)}`, { method: 'DELETE' })
  const payload = await response.json()
  if (!response.ok || payload.deleted !== true) throw new Error(payload.error || 'Waypoint delete failed')
  await refreshWaypointRegistry()
  setStatus(`Waypoint "${name}" deleted.`)
}

async function handleWaypointRevalidate(name) {
  const response = await apiFetch(`/api/dogzilla/waypoints/${encodeURIComponent(name)}/revalidate`, { method: 'POST' })
  const payload = await response.json()
  if (!response.ok || payload.revalidated !== true) throw new Error(payload.error || 'Waypoint revalidation failed')
  await refreshWaypointRegistry()
  setStatus(`Waypoint "${name}" revalidated against the active map.`)
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
  connectionActionPending = disabled
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
  if (!disabled) updateAutonomousMappingButtons()
}

function updateAutonomousMappingButtons() {
  if (connectionActionPending) return
  const startButton = document.getElementById('autonomous-map-start-button')
  const continueButton = document.getElementById('autonomous-map-continue-button')
  const finishButton = document.getElementById('autonomous-map-finish-button')
  const promoteButton = document.getElementById('autonomous-map-promote-button')
  if (startButton) startButton.disabled = autonomousMappingStarting || autonomousMappingActive
  if (continueButton) continueButton.disabled = autonomousMappingStarting || autonomousMappingActive
  if (finishButton) finishButton.disabled = !autonomousMappingActive
  if (promoteButton) promoteButton.disabled = autonomousMappingStarting || autonomousMappingActive || !autonomousMapCandidateAvailable
}

function applyAutonomousMappingState(mapping) {
  if (!mapping || typeof mapping !== 'object') return
  autonomousMappingActive = mapping.active === true
  const candidateAvailable = !autonomousMappingActive && mapping.candidateAvailable === true
  if (autonomousMappingActive || candidateAvailable || mapping.state === 'failed') {
    autonomousMappingStarting = false
  }
  autonomousMapCandidateAvailable = candidateAvailable
  slamMappingSessionActive = autonomousMappingActive || autonomousMapCandidateAvailable
  slamMappingSessionStartedAt = autonomousMappingActive && Number.isFinite(Number(mapping.startedAt))
    ? Number(mapping.startedAt)
    : 0
  updateAutonomousMappingButtons()
  if (autonomousMappingActive) {
    ensureTopDownMapView()
    void refreshDogzillaMap()
    setMapWorkflowStatus('Mapping active. The robot will stop and save automatically when coverage is complete.', 'success')
  } else if (mapping.state === 'failed') {
    void stopDogzillaSlamMapStream()
    setMapWorkflowStatus(mapping.detail || 'Autonomous mapping failed.', 'error')
  } else if (autonomousMapCandidateAvailable) {
    ensureTopDownMapView()
    void refreshDogzillaMap()
    setMapWorkflowStatus('Map ready to review. Use New Map when the completed map looks right.', 'success')
  }
}

function setMapWorkflowStatus(message, state = '') {
  if (!mapWorkflowStatus) {
    return
  }

  mapWorkflowStatus.textContent = message || 'Ready check not run.'
  mapWorkflowStatus.dataset.state = state
}

function formatConnectionAction(action) {
  switch (action) {
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
      return 'relocalize on map'
    case 'start-navigation':
      return 'waypoint navigator start'
    case 'start-map-pose-mapping':
      return 'new map'
    case 'start-autonomous-mapping':
      return 'map this floor'
    case 'continue-autonomous-mapping':
      return 'continue current map'
    case 'finish-autonomous-mapping':
      return 'stop early'
    case 'promote-map-candidate':
      return 'use new map'
    case 'save-map-pose':
      return 'save map'
    default:
      return action || 'connection action'
  }
}

function parseLastJsonLine(text) {
  if (!text) {
    return null
  }

  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (!line.startsWith('{') || !line.endsWith('}')) {
      continue
    }
    try {
      return JSON.parse(line)
    } catch {
      // Keep scanning earlier output lines.
    }
  }

  return null
}

function extractMapSaveProof(payload) {
  if (!payload || payload.action !== 'save-map-pose') {
    return null
  }

  const parsed = payload.mapSave || parseLastJsonLine(payload.stdout)
  if (!parsed || parsed.status !== 'ok') {
    return null
  }

  return {
    id: parsed.id || '',
    pbstream: parsed.pbstream || '',
    yaml: parsed.yaml || '',
    rosMapConversion: parsed.rosMapConversion || '',
  }
}

function formatMapSaveProof(proof) {
  if (!proof) {
    return ''
  }

  return [
    'map save proof',
    `id: ${proof.id || 'n/a'}`,
    `pbstream: ${proof.pbstream || 'n/a'}`,
    `yaml: ${proof.yaml || 'n/a'}`,
    `rosMapConversion: ${proof.rosMapConversion || 'n/a'}`,
  ].join('\n')
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

function applyBackendControls() {
  const apiBaseUrl = getApiBaseUrl()
  dogzillaBackendUrlInput.value = apiBaseUrl
  connectionBackendStatus.textContent = apiBaseUrl ? `Using ${apiBaseUrl}` : 'Using same-origin backend.'
  const setup = document.querySelector('#connection-setup')
  if (isAndroidAppShell() && !apiBaseUrl && setup) setup.open = true
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
  applyModelConfig()
  applySpeechConfig()
  applyRobotRuntimeConfig()
  robotMap.renderWaypoints()
  applyDogzillaCameraConfig()
}

function applyModelConfig() {
  renderProfileOptions()
  applyProfileSelectionState()
}

function applySpeechConfig() {
  const activeSpeechProfile = runtimeConfig.speech.activeProfile

  speechProfileName.textContent = activeSpeechProfile?.label || 'Speech unavailable'
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

  const robotName = robotRuntime.robotName || DEFAULT_ROBOT_RUNTIME.robotName
  if (primaryRobotTabName) {
    primaryRobotTabName.textContent = robotName
  } else if (primaryRobotTab) {
    primaryRobotTab.textContent = robotName
  }
  if (robotNameInput) {
    robotNameInput.value = robotName
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

function renderNavigationChainHealth(readinessPayload) {
  const chainRow = document.querySelector('#robot-nav-chain-row')
  const chainDots = document.querySelector('#robot-nav-chain-dots')
  const chainSummary = document.querySelector('#robot-nav-chain-summary')
  const chainDetail = document.querySelector('#robot-nav-chain-detail')
  const chainDetailContent = document.querySelector('#robot-nav-chain-detail-content')

  if (!chainRow || !chainDots || !chainSummary) return

  const components = buildNavChainComponents(readinessPayload)
  chainRow.hidden = false

  const statusIconFor = (status) => status === 'ok' ? '✓' : status === 'fail' ? '✗' : '?'

  for (const dot of chainDots.querySelectorAll('.robot-nav-chain-dot')) {
    const componentId = dot.dataset.component
    const component = components.find((c) => c.id === componentId)
    dot.hidden = component?.relevant === false
    if (component) {
      dot.dataset.status = component.status
      dot.title = `${component.label}: ${component.detail}`
    } else {
      dot.dataset.status = 'unknown'
    }
  }

  chainSummary.textContent = summarizeNavChain(components)

  if (chainDetail && chainDetailContent) {
    const rowsToShow = components.filter((c) => c.relevant !== false && c.status !== 'ok')
    const detailRows = rowsToShow
      .map((c) => {
        const statusIcon = statusIconFor(c.status)
        let actions = ''
        if (c.status !== 'ok') {
          if (c.action === 'promote-map-candidate') {
            actions = '<div class="robot-nav-chain-detail-actions"><button type="button" data-connection-action="promote-map-candidate">Use New Map</button></div>'
          } else if (c.id === 'localization') {
            actions = '<div class="robot-nav-chain-detail-actions"><button type="button" data-connection-action="start-map-pose">Relocalize on Map</button></div>'
          } else if (c.id === 'action') {
            actions = '<div class="robot-nav-chain-detail-actions"><button type="button" data-connection-action="start-navigation">Restart Nav</button></div>'
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
    } else {
      chainDetail.hidden = true
      chainDots.setAttribute('aria-expanded', 'false')
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
  const localizationTrusted = snapshot?.localizationStatus?.trusted === true
  const waypointSafe = poseState.waypointSafe === true
  const poseStatus = poseState.status || ''
  const poseAgeOk = !poseState.pose?.ageSec || poseState.pose.ageSec <= 2
  const poseTrusted = localizationTrusted && !isStale && waypointSafe && poseAgeOk && poseStatus !== 'error'

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
  } else {
    robotNavStatus.textContent = '-'
    delete robotNavStatusRow?.dataset?.severity
    robotNavTarget.textContent = ''
  }

  updateExecutionTimelineFromNavigation(navStatus)

  robotMap.setPoseTrust(poseTrusted)
  document.getElementById('robot-map')?.setAttribute('data-pose-trusted', String(poseTrusted))
  robotMap.renderWaypoints(robot)
  robotMap.renderPoseTrack(snapshot?.poseTrack || [], robot)
  robotMap.renderDot(robot)
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
  const batterySafety = telemetry.batterySafety && typeof telemetry.batterySafety === 'object'
    ? telemetry.batterySafety
    : null
  renderBatteryMeter({
    value: battery,
    status: telemetry.batteryStatus,
    unit: telemetry.batteryUnit,
    safety: batterySafety,
  })

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
  if (batterySafety?.status && batterySafety.status !== 'ok') {
    if (batterySafety.cause) {
      parts.push(String(batterySafety.cause))
    }
    if (batterySafety.recovery) {
      parts.push(String(batterySafety.recovery))
    }
  } else if (telemetry.batteryStatus && telemetry.batteryStatus !== 'ok') {
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

function renderBatteryMeter(input) {
  const reading = input && typeof input === 'object' ? input : { value: input }
  const value = toFiniteNumber(reading.value)
  const status = typeof reading.status === 'string' ? reading.status : ''
  const unit = typeof reading.unit === 'string' ? reading.unit : ''
  const safety = reading.safety && typeof reading.safety === 'object' ? reading.safety : null
  const freshPercent = Number.isFinite(value) && status === 'ok' && unit === 'percent'

  if (!freshPercent) {
    robotBatteryValue.textContent = '-'
    robotBatteryMeter.dataset.state = 'unknown'
    robotBatteryMeter.style.setProperty('--battery-fill', '0%')
    const lastKnown = Number.isFinite(value) && unit === 'percent'
      ? ` Last known value ${Math.round(value)}%.`
      : ''
    robotBatteryMeter.setAttribute(
      'aria-label',
      `Battery ${status ? status.replace(/-/g, ' ') : 'unavailable'}.${lastKnown}`,
    )
    return
  }

  const label = formatBatteryValue(value, unit)
  robotBatteryValue.textContent = label
  robotBatteryMeter.setAttribute('aria-label', `Battery ${label}`)

  const percent = Math.max(0, Math.min(100, Math.round(value)))
  robotBatteryMeter.style.setProperty('--battery-fill', `${percent}%`)

  const warningPercent = toFiniteNumber(safety?.warningPercent)
  if (safety?.motionAllowed === false || percent <= toFiniteNumber(safety?.cutoffPercent)) {
    robotBatteryMeter.dataset.state = 'low'
  } else if (percent <= (Number.isFinite(warningPercent) ? warningPercent : 20)) {
    robotBatteryMeter.dataset.state = 'low'
  } else if (percent <= 50) {
    robotBatteryMeter.dataset.state = 'medium'
  } else {
    robotBatteryMeter.dataset.state = 'high'
  }
}

function formatBatteryValue(value, unit = '') {
  if (!Number.isFinite(value)) {
    return '-'
  }

  if (unit === 'percent') {
    return `${Math.round(value)}%`
  }

  if (unit === 'volts') {
    return `${value.toFixed(2)}V`
  }

  return `${value.toFixed(2)} raw`
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
  const vision = runtimeConfig.dogzilla?.vision
  const streamConfig = camera
  const streamUrl = streamConfig?.proxyStreamPath ? toApiUrl(streamConfig.proxyStreamPath) : streamConfig?.streamUrl || ''
  const upstreamStreamUrl = streamConfig?.streamUrl || ''
  const yoloEnabled = vision?.detectionEnabled === true

  if (robotCameraYoloToggle) {
    robotCameraYoloToggle.dataset.yoloEnabled = String(yoloEnabled)
    robotCameraYoloToggle.textContent = yoloEnabled ? 'YOLO: On' : 'YOLO: Off'
    robotCameraYoloToggle.title = yoloEnabled
      ? 'Click to disable YOLO object detection (saves Pi CPU)'
      : 'Click to enable YOLO object detection (uses more Pi CPU)'
  }

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
  robotCameraFrame.dataset.statusPath = streamConfig?.proxyStatusPath || ''
  robotCameraFrame.dataset.snapshotPath = streamConfig?.proxySnapshotPath ? toApiUrl(streamConfig.proxySnapshotPath) : ''
  robotCameraFrame.dataset.viewerMode = 'stream'
robotCameraRefreshButton.disabled = false
robotCameraRecoverButton.disabled = false
robotCameraSnapshotButton.disabled = false
  robotCameraChip.textContent = robotCameraFrame.getAttribute('src') === streamUrl ? 'Live' : 'Starting'
  robotCameraMeta.textContent = formatDogzillaCameraSource(streamConfig, upstreamStreamUrl)
}

function applyRobotView(view) {
  const showCamera = view === 'camera'

  robotCameraPanel.hidden = !showCamera
  robotMapPanel.hidden = showCamera
  mapWorkflowPanel.hidden = showCamera

  if (showCamera) {
    startDogzillaCameraViewer()
    void refreshReconSnapshots()
  } else {
    stopDogzillaCameraViewer()
  }
}

function startDogzillaCameraViewer({ forceRefresh = false } = {}) {
  if (robotCameraPanel.hidden) {
    return
  }

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

function stopDogzillaCameraViewer() {
  clearDogzillaCameraTimers()
  robotCameraFrame.removeAttribute('src')
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

async function handleDogzillaYoloToggle() {
  if (!robotCameraYoloToggle) return

  robotCameraYoloToggle.disabled = true
  robotCameraRefreshButton.disabled = true
  robotCameraRecoverButton.disabled = true
  robotCameraChip.textContent = 'Toggling'

  const isCurrentlyOn = robotCameraYoloToggle.dataset.yoloEnabled === 'true'
  robotCameraMeta.textContent = isCurrentlyOn
    ? 'Disabling YOLO object detection...'
    : 'Enabling YOLO object detection...'

  try {
    const response = await apiFetch('/api/dogzilla/vision/toggle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !isCurrentlyOn }),
    })
    const payload = await response.json()
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || 'Could not toggle YOLO vision.')
    }

    robotCameraYoloToggle.dataset.yoloEnabled = String(payload.enabled)
    robotCameraYoloToggle.textContent = payload.enabled ? 'YOLO: On' : 'YOLO: Off'
    robotCameraYoloToggle.title = payload.enabled
      ? 'Click to disable YOLO object detection (saves Pi CPU)'
      : 'Click to enable YOLO object detection (uses more Pi CPU)'

    if (payload.camera) {
      runtimeConfig.dogzilla = runtimeConfig.dogzilla || {}
      runtimeConfig.dogzilla.camera = payload.camera
      runtimeConfig.dogzilla.vision = payload.vision
      applyDogzillaCameraConfig()
      startDogzillaCameraViewer({ forceRefresh: true })
    }

    robotCameraChip.textContent = payload.enabled ? 'YOLO On' : 'YOLO Off'
    robotCameraMeta.textContent = payload.message || (payload.enabled
      ? 'YOLO object detection enabled. Camera stream will show detections.'
      : 'YOLO disabled. Using raw camera feed.')
    setStatus(payload.message || `YOLO vision ${payload.enabled ? 'enabled' : 'disabled'}.`)
  } catch (error) {
    robotCameraChip.textContent = 'Toggle failed'
    robotCameraMeta.textContent = formatError(error)
    setStatus(formatError(error), 'error')
  } finally {
    robotCameraYoloToggle.disabled = false
    robotCameraRefreshButton.disabled = false
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
  settingsStatus.textContent = `Using ${runtimeConfig.activeProfile.label} (${runtimeConfig.activeProfile.model}).`
}

function applySpeechSelectionState() {
  const locked = runtimeConfig.speech.activeProfile?.selectionLocked
  speechProfileSelect.disabled = locked
  saveSpeechProfileButton.disabled = locked
  if (runtimeConfig.speech.activeProfile) {
    speechSettingsStatus.textContent = `Using ${runtimeConfig.speech.activeProfile.label}.`
  }
}

function applyRobotTargetSelectionState() {
  const locked = runtimeConfig.robotRuntime.selectionLocked || runtimeConfig.robotRuntime.activeTarget.selectionLocked
  robotTargetSelect.disabled = locked
  saveRobotTargetButton.disabled = locked
  robotTargetStatus.textContent = `Targeting ${runtimeConfig.robotRuntime.activeTarget.label}.`
  manualControl.applyState()
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
  if (isRobotRuntimeTarget(payload) && (payload.robotDispatch?.status === 'sent' || payload.robotDispatch?.status === 'accepted')) {
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
  if (robotDispatch?.status === 'accepted') {
    const commandJson = formatParsedCommandJson(payload)
    return commandJson ? `Robot command accepted, navigating\u2026 ${commandJson}` : 'Robot command accepted, navigating\u2026'
  }

  if (robotDispatch?.status === 'rejected') {
    const error = robotDispatch.error || robotDispatch.body?.result?.error || `HTTP ${robotDispatch.responseStatus || 'unknown'}`
    return `Robot command rejected: ${error}`
  }

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
      return `Navigation blocked: ${robotDispatch.recovery}`
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
  return ['error', 'rejected', 'navigation-unavailable', 'waypoint-blocked', 'preempt-failed'].includes(status)
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

function formatEmergencyStopSummary(dispatch, action = 'stop') {
  const targetLabel = dispatch?.envelope?.targetLabel || runtimeConfig.robotRuntime.activeTarget?.label || 'robot'
  const label = action === 'clear' ? 'Emergency stop reset' : 'Stop'

  if (dispatch?.status === 'sent') {
    return `${label} sent to ${targetLabel}.`
  }

  if (dispatch?.status === 'inactive-target') {
    return `${label} not sent; target inactive.`
  }

  if (dispatch?.status === 'disabled') {
    return `${label} not sent; transport disabled.`
  }

  if (dispatch?.status === 'unsupported-transport') {
    return `${label} not sent; unsupported transport.`
  }

  if (dispatch?.status === 'error') {
    return `${label} failed: ${dispatch.error || `HTTP ${dispatch.responseStatus || 'unknown'}`}.`
  }

  return `${label} ${dispatch?.status || 'complete'}.`
}

function setSpeechStatus(message, isError = false) {
  speechPanel.dataset.state = isError ? 'error' : 'ready'
  speechStatus.textContent = message
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

  if (dogzillaAudio.getVolume() <= 0) {
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

  if (dogzillaAudio.getVolume() <= 0) {
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
