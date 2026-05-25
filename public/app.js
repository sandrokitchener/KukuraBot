import { createSpeechInputController } from './speech-input.js'
import { createCommandCuePlayer } from './command-cue.js'
import { splitRecentChatHistory } from './chat-history.js'
import { apiFetch, getApiBaseUrl, setApiBaseUrl, toApiUrl } from './api-client.js'

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
const runtimeTargetName = document.querySelector('#runtime-target-name')
const runtimeTargetSource = document.querySelector('#runtime-target-source')
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
const emergencyStopButton = document.querySelector('#emergency-stop-button')
const emergencyStopStatus = document.querySelector('#emergency-stop-status')
const backendUrlInput = document.querySelector('#backend-url-input')
const saveBackendButton = document.querySelector('#save-backend-button')
const backendStatus = document.querySelector('#backend-status')
const speechPanel = document.querySelector('.speech-panel')
const speechProfileName = document.querySelector('#speech-profile-name')
const speechProfileSelect = document.querySelector('#speech-profile-select')
const saveSpeechProfileButton = document.querySelector('#save-speech-profile-button')
const speechLockNote = document.querySelector('#speech-lock-note')
const speechSettingsStatus = document.querySelector('#speech-settings-status')
const speechStatus = document.querySelector('#speech-status')
const speechPreview = document.querySelector('#speech-preview')
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
const robotBatteryValue = document.querySelector('#robot-battery-value')
const robotTelemetryMeta = document.querySelector('#robot-telemetry-meta')
const robotMapDot = document.querySelector('#robot-map-dot')
const robotLidarScan = document.querySelector('#robot-lidar-scan')
const robotMapMeta = document.querySelector('#robot-map-meta')
const robotMapPanel = document.querySelector('.robot-map-panel')
const robotCameraPanel = document.querySelector('#robot-camera-panel')
const robotCameraFrame = document.querySelector('#robot-camera-frame')
const robotCameraChip = document.querySelector('#robot-camera-chip')
const robotCameraMeta = document.querySelector('#robot-camera-meta')
const settingsToggle = document.querySelector('#settings-toggle')
const settingsDrawer = document.querySelector('#settings-drawer')
const connectionToggle = document.querySelector('#connection-toggle')
const connectionDrawer = document.querySelector('#connection-drawer')
const connectionChip = document.querySelector('#connection-chip')
const dogzillaBackendUrlInput = document.querySelector('#dogzilla-backend-url-input')
const saveDogzillaBackendButton = document.querySelector('#save-dogzilla-backend-button')
const connectionBackendStatus = document.querySelector('#connection-backend-status')
const dogzillaHostInput = document.querySelector('#dogzilla-host-input')
const dogzillaUserInput = document.querySelector('#dogzilla-user-input')
const dogzillaRemoteRootInput = document.querySelector('#dogzilla-remote-root-input')
const saveDogzillaConnectionButton = document.querySelector('#save-dogzilla-connection-button')
const connectionStatus = document.querySelector('#connection-status')
const dogzillaDirectUrl = document.querySelector('#dogzilla-direct-url')
const dogzillaRos2Url = document.querySelector('#dogzilla-ros2-url')
const connectionOutput = document.querySelector('#connection-output')
const connectionActionButtons = document.querySelectorAll('[data-connection-action]')
const runDogzillaPreflightButton = document.querySelector('#run-dogzilla-preflight-button')
const dogzillaPreflightStatus = document.querySelector('#dogzilla-preflight-status')
const dogzillaPreflightSummary = document.querySelector('#dogzilla-preflight-summary')
const dogzillaPreflightChecks = document.querySelector('#dogzilla-preflight-checks')
const dogzillaPreflightOutput = document.querySelector('#dogzilla-preflight-output')
const robotTabs = document.querySelectorAll('.robot-tab')
const primaryRobotTab = document.querySelector('.robot-tab[data-robot-view="overview"]')
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
  robotName: 'DOGZILLA',
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
  selectionLocked: false,
  source: 'runtime',
}

let thinkingState = null
let robotFeedbackTimerId = null
let robotStateTimerId = null
let robotLidarTimerId = null
let activeThinkingCue = null
let thinkingCueToken = 0
let robotMapBaseMeta = ''
let robotLidarSummary = ''
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
  introEyebrow: 'Ollama robot-control test',
  introDescription:
    'Test a local robot-control wrapper for robot-chat vs robot-command behavior. Edit the prompt and response schema files directly whenever you want.',
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
const isaacCompletionState = {
  initialized: false,
  lastEventId: null,
}

initAndroidAppShell()
boot()

form.addEventListener('submit', handleChatSubmit)
saveProfileButton.addEventListener('click', handleProfileSave)
saveSpeechProfileButton.addEventListener('click', handleSpeechProfileSave)
saveRobotTargetButton.addEventListener('click', handleRobotTargetSave)
testRobotSitButton.addEventListener('click', handleRobotSitTest)
emergencyStopButton.addEventListener('click', handleEmergencyStop)
saveBackendButton.addEventListener('click', handleBackendSave)
settingsToggle.addEventListener('click', handleSettingsToggle)
connectionToggle.addEventListener('click', handleConnectionToggle)
saveDogzillaBackendButton.addEventListener('click', handleDogzillaBackendSave)
saveDogzillaConnectionButton.addEventListener('click', handleDogzillaConnectionSave)
runDogzillaPreflightButton.addEventListener('click', handleDogzillaPreflight)

for (const button of connectionActionButtons) {
  button.addEventListener('click', handleDogzillaConnectionAction)
}

for (const tab of robotTabs) {
  tab.addEventListener('click', handleRobotTabClick)
}

robotCameraFrame.addEventListener('error', handleDogzillaCameraFrameError)
robotCameraFrame.addEventListener('load', handleDogzillaCameraFrameLoad)

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
  return !!target?.closest?.('textarea, input, select, button, a, [contenteditable="true"], .settings-drawer, .connection-drawer')
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

  try {
    const payload = await fetchConfig()
    applyPayload(payload)
    await refreshDogzillaConnection()
    startRobotFeedbackPolling()
    startRobotStatePolling()
    startRobotLidarPolling()

    try {
      await initializeSpeechController()
    } catch (error) {
      setSpeechStatus(`Speech setup failed: ${formatError(error)}`, true)
    }

    await refreshRobotFeedback()
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

    const completionMeta = buildAssistantMeta(payload, thinkingState?.startedAt ?? Date.now())
    const completionState =
      payload.isaacDispatch?.status === 'error' || payload.robotDispatch?.status === 'error'
        ? 'error'
        : 'idle'

    finishThinkingFeedback(pendingMessage, {
      text: payload.response,
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
    await refreshRobotState()
  } catch (error) {
    const message = formatError(error)
    robotSitTestStatus.textContent = message
    setStatus(message, 'error')
  } finally {
    testRobotSitButton.disabled = false
  }
}

async function handleEmergencyStop() {
  emergencyStopButton.disabled = true
  emergencyStopStatus.textContent = 'Sending stop...'
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
    emergencyStopStatus.textContent = summary
    runtimeFeedbackOutput.textContent = JSON.stringify({
      emergencyStop: payload,
    }, null, 2)
    setRuntimeFeedbackStatus(summary, false)
    setStatus(summary)
    await refreshRobotFeedback()
    await refreshRobotState()
  } catch (error) {
    const message = formatError(error)
    emergencyStopStatus.textContent = message
    setStatus(message, 'error')
  } finally {
    emergencyStopButton.disabled = false
  }
}

async function handleBackendSave() {
  saveBackendButton.disabled = true
  backendUrlInput.disabled = true
  backendStatus.textContent = 'Checking backend...'

  try {
    const label = await saveBackendUrl(backendUrlInput.value)
    backendStatus.textContent = `Connected: ${label}`
    connectionBackendStatus.textContent = `Connected: ${label}`
  } catch (error) {
    backendStatus.textContent = formatError(error)
    setStatus(`Backend failed: ${formatError(error)}`, 'error')
  } finally {
    saveBackendButton.disabled = false
    backendUrlInput.disabled = false
  }
}

async function handleDogzillaBackendSave() {
  saveDogzillaBackendButton.disabled = true
  dogzillaBackendUrlInput.disabled = true
  connectionBackendStatus.textContent = 'Checking backend...'

  try {
    const label = await saveBackendUrl(dogzillaBackendUrlInput.value)
    backendStatus.textContent = `Connected: ${label}`
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

  clearLidarScan()

  if (!isRealRobotTargetActive()) {
    robotLidarSummary = ''
    setRobotMapMeta(robotMapBaseMeta || 'Real robot target required for live map.')
    return
  }

  const lidar = runtimeConfig.dogzilla?.lidar
  if (!lidar?.enabled) {
    robotLidarSummary = 'Lidar: bridge disabled.'
    setRobotMapMeta(robotMapBaseMeta)
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
    robotBatteryValue.textContent = '-'
    robotTelemetryMeta.textContent = ''
    robotMapDot.style.opacity = '0'
    setRobotMapMeta(formatError(error))
  }
}

async function refreshDogzillaLidarScan() {
  const lidar = runtimeConfig.dogzilla?.lidar
  const scanPath = lidar?.proxyScanPath || '/api/dogzilla/lidar/scan'

  try {
    const response = await apiFetch(scanPath)
    const payload = await response.json()

    if (!response.ok || payload.ok !== true) {
      clearLidarScan()
      robotLidarSummary = formatLidarFailureSummary(payload)
      setRobotMapMeta(robotMapBaseMeta)
      return
    }

    renderLidarScan(payload)
    robotLidarSummary = formatLidarSummary(payload)
    setRobotMapMeta(robotMapBaseMeta)
  } catch (error) {
    clearLidarScan()
    robotLidarSummary = `Lidar: ${formatError(error)}`
    setRobotMapMeta(robotMapBaseMeta)
  }
}

function handleSettingsToggle() {
  const shouldOpen = settingsDrawer.hidden

  settingsDrawer.hidden = !shouldOpen
  settingsToggle.setAttribute('aria-expanded', String(shouldOpen))
  if (shouldOpen) {
    connectionDrawer.hidden = true
    connectionToggle.setAttribute('aria-expanded', 'false')
  }
}

function handleConnectionToggle() {
  const shouldOpen = connectionDrawer.hidden

  connectionDrawer.hidden = !shouldOpen
  connectionToggle.setAttribute('aria-expanded', String(shouldOpen))
  if (shouldOpen) {
    settingsDrawer.hidden = true
    settingsToggle.setAttribute('aria-expanded', 'false')
    void refreshDogzillaConnection()
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

  if (selectedRobot !== primaryRobotName) {
    setStatus(`${selectedRobot} selected. Telemetry stream still follows ${primaryRobotName}.`)
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
    connectionStatus.textContent = 'Connection saved.'
    setStatus('DOGZILLA connection saved.')
  } catch (error) {
    connectionStatus.textContent = formatError(error)
    setStatus(formatError(error), 'error')
  } finally {
    saveDogzillaConnectionButton.disabled = false
  }
}

async function handleDogzillaConnectionAction(event) {
  const action = event.currentTarget.dataset.connectionAction

  setConnectionActionsDisabled(true)
  connectionStatus.textContent = `Running ${formatConnectionAction(action)}...`
  connectionOutput.textContent = `Running ${formatConnectionAction(action)}...`

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
      throw new Error(payload.error || payload.stderr || `DOGZILLA action failed: ${action}`)
    }

    connectionStatus.textContent = `${formatConnectionAction(action)}: ${payload.status}.`
    connectionOutput.textContent = formatDogzillaActionOutput(payload)
    setStatus(`DOGZILLA ${formatConnectionAction(action)} ${payload.status}.`)

    if (action === 'probe-bridges' || action === 'probe-support') {
      renderServiceProbe(payload)
    }
  } catch (error) {
    connectionStatus.textContent = formatError(error)
    connectionOutput.textContent = formatError(error)
    setStatus(formatError(error), 'error')
  } finally {
    setConnectionActionsDisabled(false)
  }
}

async function handleDogzillaPreflight() {
  setConnectionActionsDisabled(true)
  dogzillaPreflightStatus.textContent = 'Running read-only preflight...'
  dogzillaPreflightOutput.textContent = 'Checking SSH, bridge, battery, camera TCP, Docker, lidar, and Pi processes...'
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
      throw new Error(payload.error || 'DOGZILLA preflight failed.')
    }

    renderDogzillaPreflight(payload)
    setStatus(`DOGZILLA preflight ${payload.status}.`)
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

  dogzillaHostInput.value = ssh.host || ''
  dogzillaUserInput.value = ssh.user || 'pi'
  dogzillaRemoteRootInput.value = config.remoteRoot || '/home/pi/robodoge'
  dogzillaDirectUrl.textContent = bridges.direct?.baseUrl || '-'
  dogzillaRos2Url.textContent = bridges.ros2?.baseUrl || '-'
  connectionChip.textContent = ssh.host ? ssh.host : 'No IP'
  connectionStatus.textContent = ssh.host
    ? `SSH ${ssh.user}@${ssh.host}:${ssh.port}. Config ${payload.sshConfigExists ? 'ready' : 'not written'}.`
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
  for (const button of connectionActionButtons) {
    button.disabled = disabled
  }
}

function formatConnectionAction(action) {
  switch (action) {
    case 'check-ssh':
      return 'SSH check'
    case 'probe-bridges':
      return 'bridge check'
    case 'probe-support':
      return 'support check'
    case 'sync-bridges':
      return 'bridge sync'
    case 'start-direct':
      return 'direct bridge start'
    case 'start-ros2':
      return 'ROS2 bridge start'
    case 'start-audio':
      return 'audio bridge start'
    case 'start-lidar':
      return 'lidar bridge start'
    case 'stop-bridges':
      return 'bridge stop'
    default:
      return action || 'connection action'
  }
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
      return 'Direct'
    case 'ros2':
      return 'ROS2'
    case 'audio':
      return 'Audio'
    case 'lidar':
      return 'Lidar'
    case 'camera':
      return 'Camera'
    case 'vision':
      return 'Vision'
    default:
      return id
  }
}

function applyBackendControls() {
  const apiBaseUrl = getApiBaseUrl()
  backendUrlInput.value = apiBaseUrl
  dogzillaBackendUrlInput.value = apiBaseUrl
  backendStatus.textContent = apiBaseUrl ? `Using ${apiBaseUrl}` : 'Using same-origin backend.'
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
  applyDogzillaCameraConfig()
}

function applyModelConfig(payload) {
  profileName.textContent = runtimeConfig.activeProfile.label
  profileSource.textContent = `Source: ${formatSource(runtimeConfig.activeProfile.source)}`
  providerName.textContent = runtimeConfig.activeProfile.provider
  modelName.textContent = payload.model || runtimeConfig.activeProfile.model
  promptFile.textContent = payload.systemPromptFile
  schemaFile.textContent = payload.commandFormatFile
  commandTypesFile.textContent = payload.commandTypesFile
  waypointsFile.textContent = payload.validWaypointsFile
  renderProfileOptions()
  applyProfileSelectionState()
}

function applySpeechConfig() {
  const activeSpeechProfile = runtimeConfig.speech.activeProfile

  speechProfileName.textContent = activeSpeechProfile?.label || 'Speech unavailable'
  speechFiles.textContent =
    `Speech config files: ${runtimeConfig.speech.profileFile}, ${runtimeConfig.speech.runtimeFile}, ${runtimeConfig.speech.sidecarConfigFile}, ${runtimeConfig.speech.activationPhrasesFile}`
  renderSpeechProfileOptions()
  applySpeechSelectionState()

  if (!activeSpeechProfile) {
    setSpeechStatus('No speech profile configured.', true)
    speechPreview.textContent = 'Speech input unavailable.'
    return
  }

  if (activeSpeechProfile.provider === 'whisper-browser') {
    const activationPhrases = runtimeConfig.speech.activationPhrases?.join(', ') || 'none'

    speechPreview.textContent =
      `Listening mode: buffered local recording\n` +
      `Model: ${activeSpeechProfile.modelId}\n` +
      `Device: ${activeSpeechProfile.device || 'wasm default'}\n` +
      `Activation phrases: ${activationPhrases}\n` +
      `Auto-send: after ${activeSpeechProfile.silenceDurationMs}ms of silence\n` +
      `Trigger window: ${(activeSpeechProfile.activationCommandWindowMs || 8000) / 1000}s after phrase-only wake\n` +
      `Live transcript: none while recording`
    return
  }

  if (activeSpeechProfile.provider === 'parakeet-sidecar') {
    const activationPhrases = runtimeConfig.speech.activationPhrases?.join(', ') || 'none'

    speechPreview.textContent =
      `Listening mode: buffered local recording\n` +
      `Model: ${activeSpeechProfile.modelId}\n` +
      `Sidecar model: ${activeSpeechProfile.sidecarModelId || activeSpeechProfile.modelId}\n` +
      `Runtime: local Parakeet sidecar\n` +
      `Device: ${activeSpeechProfile.device || 'auto'}\n` +
      `Activation phrases: ${activationPhrases}\n` +
      `Auto-send: after ${activeSpeechProfile.silenceDurationMs}ms of silence\n` +
      `Trigger window: ${(activeSpeechProfile.activationCommandWindowMs || 8000) / 1000}s after phrase-only wake\n` +
      `Timestamps: ${activeSpeechProfile.timestamps ? 'enabled' : 'disabled'}`
    return
  }

  speechPreview.textContent =
    `Listening mode: ${activeSpeechProfile.useVad ? 'VAD commits' : 'streaming updates'}\n` +
    `Model path: ${activeSpeechProfile.modelUrl}`
}

function applyRobotRuntimeConfig() {
  const robotRuntime = runtimeConfig.robotRuntime
  const activeTarget = robotRuntime.activeTarget

  runtimeTargetName.textContent = activeTarget.label
  runtimeTargetSource.textContent = `Source: ${formatSource(activeTarget.source || robotRuntime.source)}`
  runtimeTargetChip.textContent = activeTarget.label
  if (primaryRobotTab) {
    primaryRobotTab.textContent = robotRuntime.robotName || DEFAULT_ROBOT_RUNTIME.robotName
  }
  robotRuntimeFile.textContent = robotRuntime.runtimeFile
  robotRos2File.textContent = robotRuntime.ros2ConfigFile
  runtimeFiles.textContent =
    `Runtime config files: ${robotRuntime.runtimeFile}, ${robotRuntime.ros2ConfigFile}, ${robotRuntime.waypointsFile}, ${robotRuntime.motionFile}`
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
    robotBatteryValue.textContent = '-'
    robotTelemetryMeta.textContent = ''
    robotMapDot.style.opacity = '0'
    setRobotMapMeta(`Stream: ${runtimeConfig.robotRuntime.stateStreamPath || DEFAULT_ROBOT_RUNTIME.stateStreamPath}`)
    return
  }

  const receivedAt = Date.parse(robot.receivedAt)
  const ageMs = Number.isFinite(receivedAt) ? Date.now() - receivedAt : Infinity
  const isStale = ageMs > 3000

  robotStatePanel.dataset.state = isStale ? 'stale' : 'ready'
  robotStateChip.textContent = isStale ? 'Stale' : 'Live'
  robotStateName.textContent = robot.name
  robotStateTask.textContent = robot.task
  robotStateSeq.textContent = String(robot.seq)
  renderRobotTelemetry(robot)

  renderRobotMapDot(robot)
}

function renderRobotStateInactive() {
  robotStatePanel.hidden = false
  robotStatePanel.dataset.state = 'waiting'
  robotStateChip.textContent = 'Waiting'
  robotStateName.textContent = 'No robot'
  robotStateTask.textContent = 'Waiting'
  robotStateSeq.textContent = '-'
  robotBatteryValue.textContent = '-'
  robotTelemetryMeta.textContent = ''
  robotMapDot.style.opacity = '0'
  setRobotMapMeta('Real robot target required for live map.')
}

function renderRobotMapDot(robot) {
  if (!robot.pose) {
    robotMapDot.style.opacity = '0'
    const yaw = toFiniteNumber(robot.telemetry?.yaw)
    const orientation = Number.isFinite(yaw) ? ` Heading ${yaw.toFixed(2)} deg.` : ''
    setRobotMapMeta(`Map pose unavailable from Pi bridge.${orientation} Last update ${formatEventTimestamp(robot.receivedAt)}.`)
    return
  }

  const rangeMeters = 3
  const xRatio = clamp(robot.pose.x / rangeMeters, -1, 1)
  const yRatio = clamp(robot.pose.y / rangeMeters, -1, 1)
  const xPercent = 50 + (xRatio * 50)
  const yPercent = 50 - (yRatio * 50)

  robotMapDot.style.left = `${xPercent}%`
  robotMapDot.style.top = `${yPercent}%`
  robotMapDot.style.opacity = '1'
  robotMapDot.style.setProperty('--robot-heading', `${robot.pose.theta}rad`)
  setRobotMapMeta(
    `x ${robot.pose.x.toFixed(2)}m, y ${robot.pose.y.toFixed(2)}m, theta ${robot.pose.theta.toFixed(2)}rad. ` +
    `Updated ${formatEventTimestamp(robot.receivedAt)}.`,
  )
}

function renderLidarScan(scan) {
  if (!robotLidarScan) {
    return
  }

  const rect = robotLidarScan.getBoundingClientRect()
  const width = Math.max(1, Math.round(rect.width || robotLidarScan.width))
  const height = Math.max(1, Math.round(rect.height || robotLidarScan.height))
  if (robotLidarScan.width !== width || robotLidarScan.height !== height) {
    robotLidarScan.width = width
    robotLidarScan.height = height
  }

  const context = robotLidarScan.getContext('2d')
  if (!context) {
    return
  }

  context.clearRect(0, 0, width, height)
  const points = Array.isArray(scan.points) ? scan.points : []
  if (!points.length) {
    return
  }

  const radius = Math.min(width, height) * 0.42
  const centerX = width / 2
  const centerY = height / 2
  const maxSeen = Math.max(...points.map((point) => toFiniteNumber(point.range)).filter(Number.isFinite), 1)
  const displayRange = clamp(Math.max(1.5, maxSeen), 1.5, 6)
  const scale = radius / displayRange

  context.save()
  context.lineWidth = 1
  context.strokeStyle = 'rgba(48, 43, 37, 0.22)'
  for (const ring of [0.25, 0.5, 0.75, 1]) {
    context.beginPath()
    context.arc(centerX, centerY, radius * ring, 0, Math.PI * 2)
    context.stroke()
  }

  context.fillStyle = 'rgba(0, 123, 132, 0.78)'
  for (const point of points) {
    const x = toFiniteNumber(point.x)
    const y = toFiniteNumber(point.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue
    }
    const px = centerX + x * scale
    const py = centerY - y * scale
    if (px < 0 || px > width || py < 0 || py > height) {
      continue
    }
    context.beginPath()
    context.arc(px, py, 2.2, 0, Math.PI * 2)
    context.fill()
  }

  context.fillStyle = 'rgba(255, 114, 79, 0.95)'
  context.beginPath()
  context.arc(centerX, centerY, 4, 0, Math.PI * 2)
  context.fill()
  context.restore()
}

function clearLidarScan() {
  if (!robotLidarScan) {
    return
  }

  const context = robotLidarScan.getContext('2d')
  context?.clearRect(0, 0, robotLidarScan.width, robotLidarScan.height)
}

function formatLidarSummary(scan) {
  const stats = scan.stats || {}
  const minRange = toFiniteNumber(stats.minRange)
  const points = Array.isArray(scan.points) ? scan.points.length : 0
  const rangeCount = Number.isFinite(Number(scan.rangeCount)) ? Number(scan.rangeCount) : 0
  const nearFront = Number.isFinite(Number(stats.nearFront)) ? Number(stats.nearFront) : 0
  const nearLeft = Number.isFinite(Number(stats.nearLeft)) ? Number(stats.nearLeft) : 0
  const nearRight = Number.isFinite(Number(stats.nearRight)) ? Number(stats.nearRight) : 0
  const minText = Number.isFinite(minRange) ? `min ${minRange.toFixed(2)}m` : 'min n/a'
  return `Lidar: ${points}/${rangeCount} pts, ${minText}, near F/L/R ${nearFront}/${nearLeft}/${nearRight}.`
}

function formatLidarFailureSummary(payload) {
  const statusText = payload?.status ? String(payload.status) : 'unavailable'
  const errorText = payload?.error ? String(payload.error) : 'scan unavailable'
  const driverText = payload?.driver ? ` Driver ${payload.driver}.` : ''
  const serialText = formatLidarSerialDetail(payload)
  const rosGraph = payload?.rosGraph && typeof payload.rosGraph === 'object' ? payload.rosGraph : {}
  const publisherCount = Number.isFinite(Number(rosGraph.publisherCount)) ? Number(rosGraph.publisherCount) : 0
  const frameCount = Number.isFinite(Number(payload?.frames)) ? Number(payload.frames) : 0
  const graphText = publisherCount > 0
    ? ` ROS publishers ${publisherCount}, frames ${frameCount}.`
    : ''
  const driverTail = Array.isArray(payload?.driverLog) && payload.driverLog.length
    ? ` Driver: ${payload.driverLog[payload.driverLog.length - 1]}.`
    : ''

  return `Lidar ${statusText}: ${errorText}${driverText}${serialText}${graphText}${driverTail}`
}

function formatLidarSerialDetail(payload) {
  const serialPath = payload?.serialPort || payload?.serialDiagnostics?.path
  if (!serialPath) {
    return ''
  }

  const diagnostics = payload?.serialDiagnostics && typeof payload.serialDiagnostics === 'object'
    ? payload.serialDiagnostics
    : {}
  const baudText = payload?.baudrate ? ` @ ${payload.baudrate}` : ''
  const existsText = diagnostics.exists === false ? 'missing' : diagnostics.exists === true ? 'present' : ''
  const byIdPaths = Array.isArray(diagnostics.byIdPaths) ? diagnostics.byIdPaths : []
  const byIdName = byIdPaths.length ? byIdPaths[0].split('/').pop() : ''
  const accessText = diagnostics.readable === true && diagnostics.writable === true
    ? 'rw'
    : diagnostics.readable === true
      ? 'read-only'
      : diagnostics.exists === true
        ? 'no-access'
        : ''
  const usb = diagnostics.usb && typeof diagnostics.usb === 'object' ? diagnostics.usb : {}
  const usbId = usb.idVendor && usb.idProduct ? `${usb.idVendor}:${usb.idProduct}` : ''
  const detail = [existsText, byIdName, usbId, accessText].filter(Boolean).join(', ')

  return ` Serial ${serialPath}${baudText}${detail ? ` (${detail})` : ''}.`
}

function setRobotMapMeta(baseMessage) {
  robotMapBaseMeta = baseMessage || ''
  robotMapMeta.textContent = [robotMapBaseMeta, robotLidarSummary].filter(Boolean).join(' ')
}

function renderRobotTelemetry(robot) {
  const telemetry = robot.telemetry || {}
  const battery = toFiniteNumber(telemetry.battery)
  robotBatteryValue.textContent = Number.isFinite(battery) ? formatBatteryValue(battery) : '-'

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
  if (telemetry.dryRun === true) {
    parts.push('dry-run')
  }

  robotTelemetryMeta.textContent = parts.join(' | ')
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
  const indexUrl = camera?.indexUrl || camera?.baseUrl || ''

  if (!streamUrl) {
    robotCameraFrame.removeAttribute('src')
    robotCameraFrame.dataset.streamUrl = ''
    robotCameraFrame.dataset.statusPath = ''
    robotCameraChip.textContent = 'No stream'
    robotCameraMeta.textContent = 'Camera stream not configured.'
    return
  }

  robotCameraFrame.dataset.streamUrl = streamUrl
  robotCameraFrame.dataset.statusPath = camera?.proxyStatusPath || ''
  robotCameraChip.textContent = 'Camera proxy'
  robotCameraMeta.textContent = upstreamStreamUrl
    ? `${streamUrl} | source ${upstreamStreamUrl}${indexUrl ? ` | app ${indexUrl}` : ''}`
    : streamUrl
}

function applyRobotView(view) {
  const showCamera = view === 'camera'

  robotCameraPanel.hidden = !showCamera
  robotMapPanel.hidden = showCamera

  if (showCamera) {
    applyDogzillaCameraConfig()
    const streamUrl = robotCameraFrame.dataset.streamUrl || ''
    if (streamUrl && robotCameraFrame.src !== streamUrl) {
      robotCameraChip.textContent = 'Opening stream'
      robotCameraMeta.textContent = 'Opening DOGZILLA camera stream through the backend proxy.'
      robotCameraFrame.src = streamUrl
    }
  } else {
    robotCameraFrame.removeAttribute('src')
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
      robotCameraChip.textContent = 'Live ready'
      robotCameraMeta.textContent = `${payload.detail || 'Camera stream is responding.'} ${payload.streamUrl || ''}`.trim()
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
  if (robotCameraPanel.hidden || !robotCameraFrame.dataset.streamUrl) {
    return
  }

  robotCameraChip.textContent = 'Stream error'
  if (!robotCameraMeta.textContent || /responding/i.test(robotCameraMeta.textContent)) {
    robotCameraMeta.textContent = 'Camera stream failed to load through the backend proxy.'
  }
}

function handleDogzillaCameraFrameLoad() {
  if (robotCameraPanel.hidden || !robotCameraFrame.dataset.streamUrl) {
    return
  }

  robotCameraChip.textContent = 'Live'
  robotCameraMeta.textContent = 'Receiving DOGZILLA camera stream through the backend proxy.'
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
  profileLockNote.textContent = locked
    ? 'Profile locked by APP_MODEL_PROFILE or --profile.'
    : 'Selection saves to config/runtime.json.'
  settingsStatus.textContent = `Using ${runtimeConfig.activeProfile.label} (${runtimeConfig.activeProfile.model}).`
}

function applySpeechSelectionState() {
  const locked = runtimeConfig.speech.activeProfile?.selectionLocked
  speechProfileSelect.disabled = locked
  saveSpeechProfileButton.disabled = locked
  speechLockNote.textContent = locked
    ? 'Speech profile locked by APP_SPEECH_PROFILE.'
    : 'Selection saves to config/speech-runtime.json.'
  if (runtimeConfig.speech.activeProfile) {
    speechSettingsStatus.textContent = `Using ${runtimeConfig.speech.activeProfile.label}.`
  }
}

function applyRobotTargetSelectionState() {
  const locked = runtimeConfig.robotRuntime.selectionLocked || runtimeConfig.robotRuntime.activeTarget.selectionLocked
  robotTargetSelect.disabled = locked
  saveRobotTargetButton.disabled = locked
  robotTargetLockNote.textContent = locked
    ? 'Runtime target locked by ROBOT_RUNTIME_TARGET.'
    : 'Selection saves to config/robot-runtime.json.'
  robotTargetStatus.textContent = `Targeting ${runtimeConfig.robotRuntime.activeTarget.label}.`
  robotSitTestStatus.textContent = runtimeConfig.robotRuntime.dryRun ? 'Ready. Dry-run on.' : 'Ready. Live enabled.'
  emergencyStopStatus.textContent = isRealRobotTargetActive()
    ? 'Ready.'
    : 'Switch to a real robot target before stop can reach DOGZILLA.'
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
  const isaacSummary = formatIsaacSummary(payload.isaacSim, payload.isaacDispatch)
  const robotSummary = formatRobotSummary(payload.robotRuntime, payload.robotDispatch)

  if (isaacSummary) {
    parts.push(isaacSummary)
  }

  if (robotSummary) {
    parts.push(robotSummary)
  }

  return parts.join(' ')
}

function buildCompletionStatus(payload) {
  const parts = [
    `Done via ${payload.profileLabel}.`,
    `Target ${payload.runtimeTarget?.label || runtimeConfig.robotRuntime.activeTarget.label}.`,
  ]
  const isaacSummary = formatIsaacSummary(payload.isaacSim, payload.isaacDispatch)
  const robotSummary = formatRobotSummary(payload.robotRuntime, payload.robotDispatch)

  if (isaacSummary) {
    parts.push(isaacSummary)
  }

  if (robotSummary) {
    parts.push(robotSummary)
  }

  return parts.join(' ')
}

function formatParsedOutput(payload) {
  const sections = [
    payload.parsed ? JSON.stringify(payload.parsed, null, 2) : 'Not JSON.',
    `Active target:\n${JSON.stringify(payload.runtimeTarget || runtimeConfig.robotRuntime.activeTarget, null, 2)}`,
  ]

  if (payload.isaacSim) {
    sections.push(`Isaac preview:\n${JSON.stringify(payload.isaacSim, null, 2)}`)
  }

  if (payload.isaacDispatch) {
    sections.push(`Isaac dispatch:\n${JSON.stringify(payload.isaacDispatch, null, 2)}`)
  }

  if (payload.robotRuntime) {
    sections.push(`Robot preview:\n${JSON.stringify(payload.robotRuntime, null, 2)}`)
  }

  if (payload.robotDispatch) {
    sections.push(`Robot dispatch:\n${JSON.stringify(payload.robotDispatch, null, 2)}`)
  }

  return sections.join('\n\n')
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

function formatRobotSummary(robotRuntime, robotDispatch) {
  if (robotDispatch?.status === 'sent') {
    return 'Robot command sent.'
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

  if (robotDispatch?.status === 'error') {
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
  if (shouldUseDogzillaPiAudio()) {
    await playDogzillaPiCue('confirm')
    return null
  }

  return commandCuePlayer.play()
}

async function playRobotThinkingCue() {
  if (shouldUseDogzillaPiAudio()) {
    await playDogzillaPiCue('thinking-start')
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
  if (shouldUseDogzillaPiAudio()) {
    playDogzillaPiCue('thinking-stop').catch(() => {})
  }

  if (activeThinkingCue) {
    activeThinkingCue.stop()
    activeThinkingCue = null
    return
  }

  thinkingCuePlayer.stopAll()
}

function shouldUseDogzillaPiAudio() {
  return runtimeConfig.dogzilla?.audio?.enabled === true
}

async function playDogzillaPiCue(cue) {
  const audioConfig = runtimeConfig.dogzilla?.audio
  if (!audioConfig?.enabled) {
    throw new Error('DOGZILLA Pi audio cues are not enabled.')
  }

  const response = await apiFetch('/api/dogzilla/audio/cue', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ cue }),
  })
  const payload = await response.json()
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.error || 'DOGZILLA Pi audio cue failed.')
  }
  return payload
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
  appDescription.textContent = appConfig.introDescription
  sendButton.textContent = appConfig.sendButtonLabel
  emptyMessageRole.textContent = appConfig.assistantName
  emptyMessageBubble.textContent = appConfig.emptyChatMessage
  emptyMessageMeta.textContent = appConfig.emptyChatMeta
  parsedOutput.textContent = appConfig.waitingForJsonMessage
}

window.addEventListener('beforeunload', () => {
  speechController?.dispose?.()
  speechController?.stop()

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
