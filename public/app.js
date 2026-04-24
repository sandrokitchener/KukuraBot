import { createSpeechInputController } from './speech-input.js'
import { createCommandCuePlayer } from './command-cue.js'
import { splitRecentChatHistory } from './chat-history.js'

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
const profileSelect = document.querySelector('#profile-select')
const saveProfileButton = document.querySelector('#save-profile-button')
const profileLockNote = document.querySelector('#profile-lock-note')
const settingsStatus = document.querySelector('#settings-status')
const speechPanel = document.querySelector('.speech-panel')
const speechProfileName = document.querySelector('#speech-profile-name')
const speechProfileSelect = document.querySelector('#speech-profile-select')
const saveSpeechProfileButton = document.querySelector('#save-speech-profile-button')
const speechLockNote = document.querySelector('#speech-lock-note')
const speechSettingsStatus = document.querySelector('#speech-settings-status')
const speechStatus = document.querySelector('#speech-status')
const speechPreview = document.querySelector('#speech-preview')
const speechFiles = document.querySelector('#speech-files')
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
const DEFAULT_ACTIVATION_PHRASES = ['hey kukura', 'ok kukura', 'okay kukura', 'kukura']
const DEFAULT_SPEECH_ACTIVE_PROFILE = {
  silenceDurationMs: 500,
  minimumSpeechMs: 300,
  speechThreshold: 0.015,
}

let thinkingState = null
const commandCuePlayer = createCommandCuePlayer('/sounds/robot-bark.mp3')
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
}
let speechController = null

boot()

form.addEventListener('submit', handleChatSubmit)
saveProfileButton.addEventListener('click', handleProfileSave)
saveSpeechProfileButton.addEventListener('click', handleSpeechProfileSave)

async function boot() {
  try {
    const payload = await fetchConfig()
    applyPayload(payload)

    try {
      await initializeSpeechController()
    } catch (error) {
      setSpeechStatus(`Speech setup failed: ${formatError(error)}`, true)
    }

    setStatus(`Ready on ${runtimeConfig.activeProfile.label}.`)
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
    meta: `Using ${runtimeConfig.activeProfile.label}.`,
  })

  input.value = ''
  thinkingState = startThinkingFeedback(pendingMessage)

  try {
    const response = await fetch('/api/chat', {
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
    const completionState = payload.isaacDispatch?.status === 'error' ? 'error' : 'idle'

    finishThinkingFeedback(pendingMessage, {
      text: payload.response,
      meta: completionMeta,
    })
    playCommandCueIfNeeded(payload.parsed)
    parsedOutput.textContent = formatParsedOutput(payload)
    setStatus(buildCompletionStatus(payload), completionState)
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
    const response = await fetch('/api/settings/profile', {
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
    const response = await fetch('/api/settings/speech-profile', {
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

async function fetchConfig() {
  const response = await fetch('/api/config')
  const payload = await response.json()

  if (!response.ok) {
    throw new Error(payload.error || 'Could not load app config.')
  }

  return payload
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
  }

  applyAppConfig()
  applyModelConfig(payload)
  applySpeechConfig()
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
      `Manual fallback: click ${appConfig.sendButtonLabel}\n` +
      `Live transcript: none while recording`
    return
  }

  if (activeSpeechProfile.provider === 'parakeet-sidecar') {
    const activationPhrases = runtimeConfig.speech.activationPhrases?.join(', ') || 'none'

    speechPreview.textContent =
      `Listening mode: buffered local recording\n` +
      `Model: ${activeSpeechProfile.modelId}\n` +
      `Runtime: local Parakeet sidecar\n` +
      `Device: ${activeSpeechProfile.device || 'auto'}\n` +
      `Activation phrases: ${activationPhrases}\n` +
      `Auto-send: after ${activeSpeechProfile.silenceDurationMs}ms of silence\n` +
      `Manual fallback: click ${appConfig.sendButtonLabel}\n` +
      `Timestamps: ${activeSpeechProfile.timestamps ? 'enabled' : 'disabled'}`
    return
  }

  speechPreview.textContent =
    `Listening mode: ${activeSpeechProfile.useVad ? 'VAD commits' : 'streaming updates'}\n` +
    `Model path: ${activeSpeechProfile.modelUrl}`
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
  ]
  const isaacSummary = formatIsaacSummary(payload.isaacSim, payload.isaacDispatch)

  if (isaacSummary) {
    parts.push(isaacSummary)
  }

  return parts.join(' ')
}

function buildCompletionStatus(payload) {
  const parts = [`Done via ${payload.profileLabel}.`]
  const isaacSummary = formatIsaacSummary(payload.isaacSim, payload.isaacDispatch)

  if (isaacSummary) {
    parts.push(isaacSummary)
  }

  return parts.join(' ')
}

function formatParsedOutput(payload) {
  const sections = [
    payload.parsed ? JSON.stringify(payload.parsed, null, 2) : 'Not JSON.',
  ]

  if (payload.isaacSim) {
    sections.push(`Isaac preview:\n${JSON.stringify(payload.isaacSim, null, 2)}`)
  }

  if (payload.isaacDispatch) {
    sections.push(`Isaac dispatch:\n${JSON.stringify(payload.isaacDispatch, null, 2)}`)
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

  commandCuePlayer.play().catch((error) => {
    console.warn('Command cue failed:', error)
  })
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
  setSpeechStatus(`Activation phrase heard (${context.activationPhrase}). Sending ${appConfig.sendButtonLabel}...`)

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
    'Still working',
  ]
  let frame = 0

  const tick = () => {
    const elapsedMs = Date.now() - startedAt
    const dots = '.'.repeat((frame % 3) + 1)
    const phaseIndex = Math.min(Math.floor(elapsedMs / 2500), phases.length - 1)
    bubble.textContent = `${phases[phaseIndex]}${dots}`
    meta.textContent = `${formatElapsed(elapsedMs)} elapsed.`
    setStatus(`${appConfig.thinkingStatus} via ${runtimeConfig.activeProfile.label}.`, 'busy', elapsedMs)
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
  if (thinkingState) {
    window.clearInterval(thinkingState.timerId)
  }

  messageNode.classList.remove('message-pending')
  messageNode.classList.toggle('message-error', error)
  messageNode.querySelector('.message-bubble').textContent = text
  messageNode.querySelector('.message-meta').textContent = meta
  scrollChatToTop()
}

function setStatus(message, state = 'idle', elapsedMs = null) {
  status.dataset.state = state
  statusText.textContent = message
  statusTimer.textContent = typeof elapsedMs === 'number' ? formatElapsed(elapsedMs) : ''
}

function formatElapsed(elapsedMs) {
  return `${(elapsedMs / 1000).toFixed(1)}s`
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
})
