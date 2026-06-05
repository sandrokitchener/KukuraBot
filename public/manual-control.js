const MANUAL_CONTROL_DEADBAND = 0.08
const MANUAL_CONTROL_SEND_INTERVAL_MS = 180
const MANUAL_CONTROL_REPEAT_MS = 700
const MANUAL_CONTROL_ERROR_RETRY_MS = 1200
const MANUAL_CONTROL_CHANGE_EPSILON = 0.035

export function createManualControlController({
  elements,
  apiFetch,
  toApiUrl,
  getRuntimeConfig,
  isRealRobotTargetActive,
  formatError,
  setStatus,
  runtimeFeedbackOutput,
} = {}) {
  let frameId = null
  const state = {
    enabled: false,
    pending: false,
    gamepadIndex: null,
    lastVector: null,
    lastSentAt: 0,
    lastOutputAt: 0,
    zeroSent: true,
    errorRetryAt: 0,
  }

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
    setManualControlStatus('Manual control off.')

    if (shouldSendNeutral && isRealRobotTargetActive()) {
      sendNeutral('manual-off').catch((error) => {
        setManualControlStatus(formatError(error), true)
      })
    }
  }

  function dispose() {
    if (state.enabled && isRealRobotTargetActive()) {
      navigator.sendBeacon?.(
        toApiUrl('/api/robot/manual-control'),
        new Blob([JSON.stringify({
          forward: 0,
          strafe: 0,
          turn: 0,
          source: 'page-unload',
          gait: 'walk',
          pace: 'normal',
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
    const vector = readManualGamepadVector(gamepad)
    renderPad(gamepad)
    renderVector(vector)

    if (shouldSendVector(vector, state)) {
      sendVector(vector, gamepad).catch((error) => {
        state.errorRetryAt = Date.now() + MANUAL_CONTROL_ERROR_RETRY_MS
        setManualControlStatus(formatError(error), true)
      })
    } else if (!state.pending) {
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
          gait: 'walk',
          pace: 'normal',
        }),
      })
      const payload = await response.json()

      state.lastVector = { ...vector }
      state.lastSentAt = Date.now()
      state.zeroSent = !hasManualVectorInput(vector)

      if (!response.ok || payload.dispatch?.status === 'error') {
        throw new Error(payload.dispatch?.error || payload.error || 'Manual control failed.')
      }

      const summary = formatManualControlSummary(payload, getRuntimeConfig())
      setManualControlStatus(summary)
      setStatus(summary, payload.dispatch?.status === 'error' ? 'error' : 'idle')

      if (Date.now() - state.lastOutputAt > 1000 || state.zeroSent) {
        runtimeFeedbackOutput.textContent = JSON.stringify({
          manualControl: payload,
        }, null, 2)
        state.lastOutputAt = Date.now()
      }

      return payload
    } finally {
      state.pending = false
      applyState()
    }
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

  return `Manual ${mode}: x ${formatStep(plan.x_step)}, y ${formatStep(plan.y_step)}, turn ${formatStep(plan.turn_rate)}.`
}

function formatManualVector(vector) {
  return `x ${formatManualAxis(vector.forward)}, y ${formatManualAxis(vector.strafe)}, turn ${formatManualAxis(vector.turn)}`
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
