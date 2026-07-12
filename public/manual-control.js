const MANUAL_CONTROL_DEADBAND = 0.08
const MANUAL_CONTROL_SEND_INTERVAL_MS = 180
const MANUAL_CONTROL_REPEAT_MS = 700
const MANUAL_CONTROL_ERROR_RETRY_MS = 1200
const MANUAL_CONTROL_CHANGE_EPSILON = 0.035
const MANUAL_CONTROL_GAIT = 'walk'
const MANUAL_CONTROL_PACE = 'normal'
const MANUAL_CONTROL_FORWARD_RAMP_MS = 1000
const MANUAL_CONTROL_FORWARD_WALK_FLOOR = 0.25
const MANUAL_CONTROL_FORWARD_SCALE_MIN = 0.2
const MANUAL_CONTROL_FORWARD_SCALE_MAX = 1
const MANUAL_CONTROL_FORWARD_SCALE_DEFAULT = 0.45
const MANUAL_CONTROL_BARK_BUTTON_INDEX = 7
const MANUAL_CONTROL_BARK_THRESHOLD = 0.55
const MANUAL_CONTROL_BARK_COOLDOWN_MS = 900

export function createManualControlController({
  elements,
  apiFetch,
  toApiUrl,
  getRuntimeConfig,
  isRealRobotTargetActive,
  formatError,
  setStatus,
  playBarkCue,
} = {}) {
  let frameId = null
  const state = {
    enabled: false,
    pending: false,
    gamepadIndex: null,
    lastVector: null,
    lastSentAt: 0,
    zeroSent: true,
    errorRetryAt: 0,
    forwardRampStartedAt: 0,
    lastGait: null,
    lastPace: null,
    forwardScale: readManualForwardScale(elements?.speedSlider?.value),
    barkTriggerPressed: false,
    lastBarkAt: 0,
    barkPending: false,
  }

  elements?.speedSlider?.addEventListener?.('input', handleForwardSpeedInput)
  renderForwardSpeedScale()

  function handleToggle() {
    if (state.enabled) {
      disable({ sendNeutral: true })
      return
    }

    enable()
  }

  function handleNeutral() {
    sendNeutral('manual-neutral').catch((error) => {
      setManualControlStatus(formatError(error), true)
    })
  }

  function handleGamepadConnected(event) {
    state.gamepadIndex = event.gamepad.index
    renderPad(event.gamepad)
    setManualControlStatus(`${formatGamepadName(event.gamepad)} connected.`)
  }

  function handleGamepadDisconnected(event) {
    if (state.gamepadIndex !== event.gamepad.index) {
      return
    }

    state.gamepadIndex = null
    renderVector(createNeutralManualVector())
    setManualControlStatus('Gamepad disconnected.')
    if (state.enabled) {
      sendNeutral('gamepad-disconnected').catch((error) => {
        setManualControlStatus(formatError(error), true)
      })
    }
  }

  function enable() {
    if (!isGamepadSupported()) {
      setManualControlStatus('Gamepad API unavailable in this browser.', true)
      applyState()
      return
    }

    if (!isRealRobotTargetActive()) {
      setManualControlStatus('Switch to DOGZILLA Direct or ROS2 Real Robot first.', true)
      applyState()
      return
    }

    const gamepad = findGamepad()
    state.enabled = true
    state.pending = false
    state.lastVector = null
    state.lastSentAt = 0
    state.zeroSent = true
    state.errorRetryAt = 0
    state.forwardRampStartedAt = 0
    state.lastGait = null
    state.lastPace = null
    state.barkTriggerPressed = false
    state.lastBarkAt = 0
    state.barkPending = false
    state.gamepadIndex = gamepad?.index ?? state.gamepadIndex
    renderPad(gamepad)
    renderVector(createNeutralManualVector())
    setManualControlStatus(gamepad ? `Manual control using ${formatGamepadName(gamepad)}.` : 'Manual control waiting for gamepad.')
    applyState()
    scheduleFrame()
  }

  function disable({ sendNeutral: shouldSendNeutral = false } = {}) {
    state.enabled = false
    applyState()

    if (frameId) {
      window.cancelAnimationFrame(frameId)
      frameId = null
    }

    renderVector(createNeutralManualVector())
    state.forwardRampStartedAt = 0
    state.barkTriggerPressed = false
    state.barkPending = false
    setManualControlStatus('Manual control off.')

    if (shouldSendNeutral && isRealRobotTargetActive()) {
      sendNeutral('manual-off').catch((error) => {
        setManualControlStatus(formatError(error), true)
      })
    }
  }

  function dispose() {
    elements?.speedSlider?.removeEventListener?.('input', handleForwardSpeedInput)
    if (state.enabled && isRealRobotTargetActive()) {
      navigator.sendBeacon?.(
        toApiUrl('/api/robot/manual-control'),
        new Blob([JSON.stringify({
          forward: 0,
          strafe: 0,
          turn: 0,
          source: 'page-unload',
          gait: MANUAL_CONTROL_GAIT,
          pace: MANUAL_CONTROL_PACE,
        })], { type: 'application/json' }),
      )
    }

    if (frameId) {
      window.cancelAnimationFrame(frameId)
      frameId = null
    }
  }

  function scheduleFrame() {
    if (!state.enabled || frameId) {
      return
    }

    frameId = window.requestAnimationFrame(tick)
  }

  function tick() {
    frameId = null

    if (!state.enabled) {
      return
    }

    if (!isRealRobotTargetActive()) {
      disable({ sendNeutral: true })
      setManualControlStatus('Manual control stopped because the active target changed.', true)
      return
    }

    const gamepad = findGamepad()

    if (!gamepad) {
      state.barkTriggerPressed = false
      renderPad(null)
      renderVector(createNeutralManualVector())
      if (!state.zeroSent) {
        sendNeutral('gamepad-missing').catch((error) => {
          setManualControlStatus(formatError(error), true)
        })
      } else {
        setManualControlStatus('Press a button on a connected gamepad.')
      }
      scheduleFrame()
      return
    }

    state.gamepadIndex = gamepad.index
    const now = Date.now()
      const rawVector = readManualGamepadVector(gamepad)
      const ramp = applyForwardRamp(rawVector, state, now, { forwardScale: state.forwardScale })
    const vector = ramp.vector
    renderPad(gamepad)
    renderVector(vector)
    const barkTriggered = handleBarkTrigger(gamepad, now)

    if (shouldSendManualCommand(vector, state, ramp, now)) {
      sendVector(vector, gamepad, { gait: ramp.gait, pace: ramp.pace }).catch((error) => {
        state.errorRetryAt = Date.now() + MANUAL_CONTROL_ERROR_RETRY_MS
        setManualControlStatus(formatError(error), true)
      })
    } else if (!state.pending && !barkTriggered) {
      setManualControlStatus(`Manual control active: ${formatManualVector(vector)}.`)
    }

    scheduleFrame()
  }

  async function sendNeutral(source) {
    if (!isRealRobotTargetActive()) {
      setManualControlStatus('Real robot target required for manual neutral.', true)
      return
    }

    await sendVector(createNeutralManualVector(), null, { source, force: true })
  }

  async function sendVector(vector, gamepad, options = {}) {
    if (state.pending && !options.force) {
      return
    }

    state.pending = true
    applyState()

    const source = options.source || 'gamepad'
    const gait = options.gait || MANUAL_CONTROL_GAIT
    const pace = options.pace || MANUAL_CONTROL_PACE
    try {
      const response = await apiFetch('/api/robot/manual-control', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          forward: vector.forward,
          strafe: vector.strafe,
          turn: vector.turn,
          source,
          gamepadId: gamepad?.id || '',
          gamepadIndex: gamepad?.index ?? state.gamepadIndex,
          gait,
          pace,
        }),
      })
      const payload = await response.json()

      state.lastVector = { ...vector }
      state.lastSentAt = Date.now()
      state.zeroSent = !hasManualVectorInput(vector)
      state.lastGait = gait
      state.lastPace = pace

      if (!response.ok || payload.dispatch?.status === 'error') {
        throw new Error(payload.dispatch?.error || payload.error || 'Manual control failed.')
      }

      const summary = formatManualControlSummary(payload, getRuntimeConfig())
      setManualControlStatus(summary)
      setStatus(summary, payload.dispatch?.status === 'error' ? 'error' : 'idle')

      return payload
    } finally {
      state.pending = false
      applyState()
    }
  }

  function handleBarkTrigger(gamepad, now = Date.now()) {
    if (typeof playBarkCue !== 'function' || state.barkPending) {
      updateManualBarkTriggerState(readManualBarkTriggerPressed(gamepad), state, now)
      return false
    }

    if (!updateManualBarkTriggerState(readManualBarkTriggerPressed(gamepad), state, now)) {
      return false
    }

  state.barkPending = true
  setManualControlStatus('Sending bark cue...')
  setStatus?.('Sending bark cue...')
  playBarkCue()
    .then(() => {
      setManualControlStatus('Bark cue sent.')
        setStatus?.('Bark cue sent.')
      })
      .catch((error) => {
        const message = formatError(error)
        setManualControlStatus(message, true)
        setStatus?.(message, 'error')
      })
      .finally(() => {
        state.barkPending = false
      })

    return true
  }

  function findGamepad() {
    if (!isGamepadSupported()) {
      return null
    }

    const gamepads = navigator.getGamepads()
    const preferred = Number.isInteger(state.gamepadIndex)
      ? gamepads[state.gamepadIndex]
      : null

    if (preferred?.connected) {
      return preferred
    }

    return Array.from(gamepads).find((gamepad) => gamepad?.connected) || null
  }

  function applyState() {
    const supported = isGamepadSupported()
    const realTarget = isRealRobotTargetActive()

    elements.panel.dataset.state = state.enabled ? 'active' : supported && realTarget ? 'ready' : 'disabled'
    elements.chip.textContent = state.enabled ? 'Gamepad' : 'Off'
    elements.toggleButton.textContent = state.enabled ? 'Disable gamepad' : 'Enable gamepad'
    elements.toggleButton.disabled = !supported || !realTarget
    elements.neutralButton.disabled = !realTarget || state.pending
    if (elements.speedSlider) {
      elements.speedSlider.disabled = !supported || !realTarget
    }

    if (!supported) {
      elements.status.textContent = 'Gamepad API unavailable in this browser.'
      return
    }

    if (!realTarget) {
      elements.status.textContent = 'Real robot target required.'
      return
    }

    const currentStatus = elements.status.textContent
    if (
      !state.enabled &&
      !state.pending &&
      (!currentStatus || currentStatus === 'Real robot target required.' || currentStatus === 'Gamepad idle.')
    ) {
      elements.status.textContent = 'Gamepad idle.'
    }
  }

  function renderPad(gamepad) {
    elements.padName.textContent = gamepad ? formatGamepadName(gamepad) : 'No gamepad'
  }

  function renderVector(vector) {
    elements.forwardValue.textContent = formatManualAxis(vector.forward)
    elements.strafeValue.textContent = formatManualAxis(vector.strafe)
    elements.turnValue.textContent = formatManualAxis(vector.turn)
    setManualMeter(elements.forwardMeter, vector.forward)
    setManualMeter(elements.strafeMeter, vector.strafe)
    setManualMeter(elements.turnMeter, vector.turn)
  }

  function handleForwardSpeedInput(event) {
    state.forwardScale = readManualForwardScale(event?.target?.value)
    renderForwardSpeedScale()
    if (state.enabled) {
      state.lastVector = null
      setManualControlStatus(`Forward gait ${formatManualForwardScale(state.forwardScale)}.`)
    }
  }

  function renderForwardSpeedScale() {
    if (elements.speedSlider) {
      const percent = Math.round(state.forwardScale * 100)
      elements.speedSlider.value = String(percent)
      elements.speedSlider.setAttribute?.('aria-valuetext', `${percent}% forward gait`)
    }
    if (elements.speedValue) {
      elements.speedValue.textContent = formatManualForwardScale(state.forwardScale)
    }
  }

  function setManualControlStatus(message, isError = false) {
    if (isError) {
      elements.panel.dataset.state = 'error'
    } else if (elements.panel.dataset.state === 'error') {
      elements.panel.dataset.state = state.enabled ? 'active' : 'ready'
    }
    elements.status.textContent = message
  }

  return {
    applyState,
    disable,
    dispose,
    enable,
    handleGamepadConnected,
    handleGamepadDisconnected,
    handleNeutral,
    handleToggle,
    isEnabled: () => state.enabled,
    readVector: readManualGamepadVector,
    sendNeutral,
  }
}

export function readManualGamepadVector(gamepad) {
  const axes = gamepad?.axes || []
  const leftX = normalizeManualAxis(axes[0])
  const leftY = normalizeManualAxis(axes[1])
  const rightX = normalizeManualAxis(axes[2] ?? axes[3])

  return {
    forward: normalizeManualAxis(-leftY),
    strafe: normalizeManualAxis(-leftX),
    turn: normalizeManualAxis(-rightX),
  }
}

export function readManualBarkTriggerPressed(gamepad) {
  const button = gamepad?.buttons?.[MANUAL_CONTROL_BARK_BUTTON_INDEX]
  if (!button) {
    return false
  }

  return button.pressed === true || Number(button.value) >= MANUAL_CONTROL_BARK_THRESHOLD
}

export function updateManualBarkTriggerState(
  pressed,
  state,
  now = Date.now(),
  cooldownMs = MANUAL_CONTROL_BARK_COOLDOWN_MS,
) {
  const wasPressed = state.barkTriggerPressed === true
  state.barkTriggerPressed = pressed === true

  if (!pressed || wasPressed) {
    return false
  }

  const lastBarkAt = Number(state.lastBarkAt) || 0
  if (lastBarkAt > 0 && now - lastBarkAt < cooldownMs) {
    return false
  }

  state.lastBarkAt = now
  return true
}

export function normalizeManualAxis(value) {
  const numeric = clamp(Number(value) || 0, -1, 1)
  return Math.abs(numeric) <= MANUAL_CONTROL_DEADBAND ? 0 : Number(numeric.toFixed(3))
}

export function createNeutralManualVector() {
  return {
    forward: 0,
    strafe: 0,
    turn: 0,
  }
}

export function readManualForwardScale(value) {
  const numeric = Number(value)
  const percentValue = Number.isFinite(numeric) && numeric > 1 ? numeric / 100 : numeric
  if (!Number.isFinite(percentValue)) {
    return MANUAL_CONTROL_FORWARD_SCALE_DEFAULT
  }
  return Number(clamp(percentValue, MANUAL_CONTROL_FORWARD_SCALE_MIN, MANUAL_CONTROL_FORWARD_SCALE_MAX).toFixed(2))
}

export function applyForwardRamp(vector, state, now = Date.now(), options = {}) {
  const forward = Number(vector?.forward) || 0
  const forwardScale = readManualForwardScale(options.forwardScale ?? 1)

  if (forward <= 0) {
    const movingWithoutForward = !!(Math.abs(Number(vector?.strafe) || 0) > 0 || Math.abs(Number(vector?.turn) || 0) > 0)
    state.forwardRampStartedAt = 0
    return {
      vector: { ...vector, forward },
      gait: movingWithoutForward || forward < 0 ? 'trot' : 'walk',
      pace: MANUAL_CONTROL_PACE,
      progress: 0,
    }
  }

  if (!state.forwardRampStartedAt) {
    state.forwardRampStartedAt = now
  }

  const elapsed = Math.max(0, now - state.forwardRampStartedAt)
  const progress = clamp(elapsed / MANUAL_CONTROL_FORWARD_RAMP_MS, 0, 1)
  const curve = easeOutCubic(progress)
  const multiplier = MANUAL_CONTROL_FORWARD_WALK_FLOOR + (1 - MANUAL_CONTROL_FORWARD_WALK_FLOOR) * curve
  const rampedForward = Number((forward * multiplier * forwardScale).toFixed(3))
  const stage = getForwardRampStage(progress)

  return {
    vector: {
      ...vector,
      forward: rampedForward,
    },
    gait: stage.gait,
    pace: stage.pace,
    progress,
  }
}

export function shouldSendManualCommand(vector, state, ramp, now = Date.now()) {
  if (shouldSendVector(vector, state, now)) {
    return true
  }

  return !!(
    hasManualVectorInput(vector) &&
    !state.pending &&
    now >= state.errorRetryAt &&
    now - state.lastSentAt >= MANUAL_CONTROL_SEND_INTERVAL_MS &&
    (ramp.gait !== state.lastGait || ramp.pace !== state.lastPace)
  )
}

function getForwardRampStage(progress) {
  if (progress <= 0) {
    return { gait: 'walk', pace: 'slow' }
  }
  if (progress >= 1) {
    return { gait: 'trot', pace: 'high' }
  }
  return { gait: 'trot', pace: 'normal' }
}

function easeOutCubic(value) {
  const t = clamp(value, 0, 1)
  return 1 - ((1 - t) ** 3)
}

export function shouldSendVector(vector, state, now = Date.now()) {
  const moving = hasManualVectorInput(vector)

  if (state.pending || now < state.errorRetryAt) {
    return false
  }

  if (!moving) {
    return !state.zeroSent
  }

  if (now - state.lastSentAt < MANUAL_CONTROL_SEND_INTERVAL_MS) {
    return false
  }

  return (
    hasManualVectorChanged(vector, state.lastVector) ||
    now - state.lastSentAt >= MANUAL_CONTROL_REPEAT_MS
  )
}

export function hasManualVectorChanged(nextVector, previousVector) {
  if (!previousVector) {
    return true
  }

  return (
    Math.abs(nextVector.forward - previousVector.forward) >= MANUAL_CONTROL_CHANGE_EPSILON ||
    Math.abs(nextVector.strafe - previousVector.strafe) >= MANUAL_CONTROL_CHANGE_EPSILON ||
    Math.abs(nextVector.turn - previousVector.turn) >= MANUAL_CONTROL_CHANGE_EPSILON
  )
}

export function hasManualVectorInput(vector) {
  return !!(
    Math.abs(vector.forward) > 0 ||
    Math.abs(vector.strafe) > 0 ||
    Math.abs(vector.turn) > 0
  )
}

function setManualMeter(meter, value) {
  meter.style.setProperty('--manual-meter-value', `${50 + clamp(value, -1, 1) * 50}%`)
  meter.dataset.direction = value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral'
}

function formatManualControlSummary(payload, runtimeConfig) {
  const dispatchStatus = payload.dispatch?.status || 'unknown'
  const plan = payload.preview?.canonicalPlan?.params || {}
  const mode = runtimeConfig?.robotRuntime?.dryRun || dispatchStatus === 'dry-run' ? 'dry-run' : dispatchStatus
  const gait = plan.gait || 'walk'
  const pace = plan.pace || 'normal'

  return `Manual ${mode}: ${gait}/${pace}, x ${formatStep(plan.x_step)}, y ${formatStep(plan.y_step)}, turn ${formatStep(plan.turn_rate)}.`
}

function formatManualVector(vector) {
  return `x ${formatManualAxis(vector.forward)}, y ${formatManualAxis(vector.strafe)}, turn ${formatManualAxis(vector.turn)}`
}

function formatManualForwardScale(value) {
  return `${Math.round(readManualForwardScale(value) * 100)}%`
}

function formatManualAxis(value) {
  return value.toFixed(2)
}

function formatStep(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric.toFixed(1) : '0.0'
}

function formatGamepadName(gamepad) {
  const rawName = String(gamepad?.id || '').trim()
  return rawName ? rawName.replace(/\s+\(.*?\)/g, '').slice(0, 42) : 'Gamepad'
}

function isGamepadSupported() {
  return typeof navigator.getGamepads === 'function'
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
