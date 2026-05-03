import { createSpeechInputController } from './speech-input.js'
import { createCommandCuePlayer } from './command-cue.js'
import { splitRecentChatHistory } from './chat-history.js'
import { apiFetch, getApiBaseUrl, setApiBaseUrl } from './api-client.js'

const appEyebrow = document.querySelector('#app-eyebrow')
const appTitle = document.querySelector('#app-title')
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
const robotMapDot = document.querySelector('#robot-map-dot')
const robotMapMeta = document.querySelector('#robot-map-meta')
const settingsToggle = document.querySelector('#settings-toggle')
const settingsDrawer = document.querySelector('#settings-drawer')
const robotTabs = document.querySelectorAll('.robot-tab')
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
  '/sounds/robot-bark.mp3',
  '/sounds/robot-bark-alt-1.wav',
]
const THINKING_CUE_URLS = [
  '/sounds/robot-think-whimper-1.wav',
  '/sounds/robot-think-whimper-2.wav',
  '/sounds/robot-think-pant-1.wav',
]
const MOBILE_VIEWS = ['robot', 'chat', 'audio']
const MOBILE_DEFAULT_VIEW = 'chat'
const DEFAULT_ACTIVATION_PHRASES = ['hey kukura', 'ok kukura', 'okay kukura', 'kukura']
const DEFAULT_SPEECH_ACTIVE_PROFILE = {
  silenceDurationMs: 500,
  activationCommandWindowMs: 8000,
  minimumSpeechMs: 300,
  speechThreshold: 0.015,
}
const DEFAULT_ROBOT_RUNTIME = {
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
let activeThinkingCue = null
let thinkingCueToken = 0
const commandCuePlayer = createCommandCuePlayer(COMMAND_CUE_URLS)
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
  pageTitle: 'Robot Test App',
  consoleTitle: 'Robot Console',
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
    source: 'default',
    selectionLocked: false,
  },
  availableProfiles: [],
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
}
let speechController = null
let mobileView = MOBILE_DEFAULT_VIEW
let touchStart = null
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
saveBackendButton.addEventListener('click', handleBackendSave)
settingsToggle.addEventListener('click', handleSettingsToggle)

for (const tab of robotTabs) {
  tab.addEventListener('click', handleRobotTabClick)
}

function initAndroidAppShell() {
  if (!isAndroidAppShell()) {
    return
  }

  document.documentElement.classList.add('android-app')
  setMobileView(MOBILE_DEFAULT_VIEW)
  document.addEventListener('touchstart', handleMobileTouchStart, { passive: true })
  document.addEventListener('touchend', handleMobileTouchEnd, { passive: true })
}

function isAndroidAppShell() {
  const userAgent = navigator.userAgent || ''
  return /Android/i.test(userAgent) && (/\bwv\b/i.test(userAgent) || !!window.__TAURI_INTERNALS__)
}

function handleMobileTouchStart(event) {
  if (!document.documentElement.classList.contains('android-app') || isInteractiveTarget(event.target)) {
    touchStart = null
    return
  }

  const touch = event.changedTouches?.[0]
  touchStart = touch
    ? {
      x: touch.clientX,
      y: touch.clientY,
      at: Date.now(),
    }
    : null
}

function handleMobileTouchEnd(event) {
  if (!touchStart) {
    return
  }

  const touch = event.changedTouches?.[0]
  const start = touchStart
  touchStart = null

  if (!touch) {
    return
  }

  const deltaX = touch.clientX - start.x
  const deltaY = touch.clientY - start.y
  const elapsedMs = Date.now() - start.at

  if (elapsedMs > 700 || Math.abs(deltaX) < 58 || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) {
    return
  }

  const currentIndex = MOBILE_VIEWS.indexOf(mobileView)
  const nextIndex = deltaX < 0
    ? Math.min(MOBILE_VIEWS.length - 1, currentIndex + 1)
    : Math.max(0, currentIndex - 1)
  setMobileView(MOBILE_VIEWS[nextIndex])
}

function setMobileView(view) {
  mobileView = MOBILE_VIEWS.includes(view) ? view : MOBILE_DEFAULT_VIEW
  document.documentElement.dataset.mobileView = mobileView
}

function isInteractiveTarget(target) {
  return !!target?.closest?.('textarea, input, select, button, a, [contenteditable="true"], .output-scroll, .settings-drawer')
}

async function boot() {
  applyBackendControls()

  try {
    const payload = await fetchConfig()
    applyPayload(payload)
    startRobotFeedbackPolling()
    startRobotStatePolling()

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

async function handleBackendSave() {
  saveBackendButton.disabled = true
  backendUrlInput.disabled = true
  backendStatus.textContent = 'Checking backend...'

  try {
    const requestedBackendUrl = backendUrlInput.value.trim()
    const nextBaseUrl = setApiBaseUrl(requestedBackendUrl)
    if (requestedBackendUrl && !nextBaseUrl) {
      throw new Error('Backend URL must start with http:// or https://.')
    }
    applyBackendControls()

    const payload = await fetchConfig()
    applyPayload(payload)
    startRobotFeedbackPolling()
    startRobotStatePolling()

    try {
      await initializeSpeechController()
    } catch (error) {
      setSpeechStatus(`Speech setup failed: ${formatError(error)}`, true)
    }

    await refreshRobotFeedback()
    const label = nextBaseUrl || 'same-origin backend'
    backendStatus.textContent = `Connected: ${label}`
    setStatus(`Backend connected: ${label}.`)
  } catch (error) {
    backendStatus.textContent = formatError(error)
    setStatus(`Backend failed: ${formatError(error)}`, 'error')
  } finally {
    saveBackendButton.disabled = false
    backendUrlInput.disabled = false
  }
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
    robotMapDot.style.opacity = '0'
    robotMapMeta.textContent = formatError(error)
  }
}

function handleSettingsToggle() {
  const shouldOpen = settingsDrawer.hidden

  settingsDrawer.hidden = !shouldOpen
  settingsToggle.setAttribute('aria-expanded', String(shouldOpen))
}

function handleRobotTabClick(event) {
  for (const tab of robotTabs) {
    const isActive = tab === event.currentTarget

    tab.classList.toggle('is-active', isActive)
    tab.setAttribute('aria-selected', String(isActive))
  }

  const selectedRobot = event.currentTarget.textContent.trim()

  if (selectedRobot !== 'Robo Doge') {
    setStatus(`${selectedRobot} selected. Telemetry stream still follows Robo Doge.`)
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

function applyBackendControls() {
  const apiBaseUrl = getApiBaseUrl()
  backendUrlInput.value = apiBaseUrl
  backendStatus.textContent = apiBaseUrl ? `Using ${apiBaseUrl}` : 'Using same-origin backend.'
}

function applyPayload(payload) {
  appConfig = payload.app || appConfig
  runtimeConfig = {
    activeProfile: payload.activeProfile || runtimeConfig.activeProfile,
    availableProfiles: payload.availableProfiles || [],
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
  }

  applyAppConfig()
  applyModelConfig(payload)
  applySpeechConfig()
  applyRobotRuntimeConfig()
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
      ? `ROS2 bridge error: ${healthPayload.error || `HTTP ${healthPayload.responseStatus || 'unknown'}`}.`
      : `ROS2 health ${healthStatus}. Feedback ${feedbackStatus}.`,
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
    robotMapDot.style.opacity = '0'
    robotMapMeta.textContent = `Stream: ${runtimeConfig.robotRuntime.stateStreamPath || DEFAULT_ROBOT_RUNTIME.stateStreamPath}`
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

  renderRobotMapDot(robot)
}

function renderRobotStateInactive() {
  robotStatePanel.hidden = false
  robotStatePanel.dataset.state = 'waiting'
  robotStateChip.textContent = 'Waiting'
  robotStateName.textContent = 'No robot'
  robotStateTask.textContent = 'Waiting'
  robotStateSeq.textContent = '-'
  robotMapDot.style.opacity = '0'
  robotMapMeta.textContent = 'Real robot target required for live map.'
}

function renderRobotMapDot(robot) {
  if (!robot.pose) {
    robotMapDot.style.opacity = '0'
    robotMapMeta.textContent = `Pose unavailable. Last update ${formatEventTimestamp(robot.receivedAt)}.`
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
  robotMapMeta.textContent =
    `x ${robot.pose.x.toFixed(2)}m, y ${robot.pose.y.toFixed(2)}m, theta ${robot.pose.theta.toFixed(2)}rad. ` +
    `Updated ${formatEventTimestamp(robot.receivedAt)}.`
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
    sections.push(`ROS2 preview:\n${JSON.stringify(payload.robotRuntime, null, 2)}`)
  }

  if (payload.robotDispatch) {
    sections.push(`ROS2 dispatch:\n${JSON.stringify(payload.robotDispatch, null, 2)}`)
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
    return 'ROS2 command sent.'
  }

  if (robotDispatch?.status === 'dry-run') {
    return 'ROS2 dispatch dry-run.'
  }

  if (robotDispatch?.status === 'preview-not-ready') {
    return 'ROS2 not sent because preview not ready.'
  }

  if (robotDispatch?.status === 'inactive-target') {
    return 'ROS2 target inactive.'
  }

  if (robotDispatch?.status === 'disabled') {
    return 'ROS2 transport disabled.'
  }

  if (robotDispatch?.status === 'error') {
    return `ROS2 dispatch failed: ${robotDispatch.error || `HTTP ${robotDispatch.responseStatus || 'unknown'}`}.`
  }

  if (robotRuntime?.status === 'ready') {
    return 'ROS2 preview ready.'
  }

  if (robotRuntime?.status === 'no-op') {
    return 'ROS2 plan no-op.'
  }

  if (robotRuntime?.status && !['no-command', 'no-action'].includes(robotRuntime.status)) {
    return `ROS2 preview ${robotRuntime.status}.`
  }

  return ''
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

  commandCuePlayer.play().catch((error) => {
    console.warn('Command cue failed:', error)
  })
}

function isRealRobotTargetActive() {
  return runtimeConfig.robotRuntime.activeTarget?.kind === 'ros2-bridge'
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
  thinkingCuePlayer.play().then((cue) => {
    if (cueToken !== thinkingCueToken) {
      cue?.stop?.()
      return
    }
    activeThinkingCue = cue
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
  appTitle.textContent = appConfig.consoleTitle
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
})
