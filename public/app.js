const modelName = document.querySelector('#model-name')
const appEyebrow = document.querySelector('#app-eyebrow')
const appTitle = document.querySelector('#app-title')
const appDescription = document.querySelector('#app-description')
const promptFile = document.querySelector('#prompt-file')
const schemaFile = document.querySelector('#schema-file')
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

let thinkingState = null
let appConfig = {
  assistantName: 'Assistant',
  pageTitle: 'Robot Test App',
  consoleTitle: 'Robot Console',
  sendButtonLabel: 'Ask Assistant',
  thinkingStatus: 'Assistant is thinking...',
  introEyebrow: 'Ollama robot-control test',
  introDescription:
    'Test a local robot-control wrapper for robot-chat vs robot-command behavior. Edit the prompt and response schema files directly whenever you want.',
  emptyChatMessage: 'Waiting for first message.',
  emptyChatMeta: 'Prompt ready.',
  waitingForJsonMessage: 'Waiting for valid JSON.',
}

boot()

async function boot() {
  try {
    const response = await fetch('/api/config')
    const payload = await response.json()
    appConfig = payload.app || appConfig
    applyAppConfig()
    modelName.textContent = payload.model
    promptFile.textContent = payload.systemPromptFile
    schemaFile.textContent = payload.commandFormatFile
    setStatus('Ready.')
  } catch (error) {
    setStatus(`Config load failed: ${formatError(error)}`, 'error')
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()

  const message = input.value.trim()
  if (!message) {
    setStatus('Enter a message first.', 'error')
    return
  }

  clearEmptyChat()
  sendButton.disabled = true
  input.disabled = true
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
    meta: 'Starting request...',
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

    finishThinkingFeedback(pendingMessage, {
      text: payload.response,
      meta: `Reply received in ${formatElapsed(Date.now() - thinkingState.startedAt)} via ${payload.model}.`,
    })
    parsedOutput.textContent =
      payload.parsed ? JSON.stringify(payload.parsed, null, 2) : 'Not JSON.'
    setStatus(`Done via ${payload.model}.`, 'idle')
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
})

function formatError(error) {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
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
  chatLog.append(article)
  scrollChatToBottom()
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
    'Calling Ollama',
    'Still working',
  ]
  let frame = 0

  const tick = () => {
    const elapsedMs = Date.now() - startedAt
    const dots = '.'.repeat((frame % 3) + 1)
    const phaseIndex = Math.min(Math.floor(elapsedMs / 2500), phases.length - 1)
    bubble.textContent = `${phases[phaseIndex]}${dots}`
    meta.textContent = `${formatElapsed(elapsedMs)} elapsed.`
    setStatus(appConfig.thinkingStatus, 'busy', elapsedMs)
    scrollChatToBottom()
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
  scrollChatToBottom()
}

function setStatus(message, state = 'idle', elapsedMs = null) {
  status.dataset.state = state
  statusText.textContent = message
  statusTimer.textContent = typeof elapsedMs === 'number' ? formatElapsed(elapsedMs) : ''
}

function formatElapsed(elapsedMs) {
  return `${(elapsedMs / 1000).toFixed(1)}s`
}

function scrollChatToBottom() {
  chatLog.scrollTop = chatLog.scrollHeight
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
