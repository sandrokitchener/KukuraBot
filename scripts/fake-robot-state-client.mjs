import { randomBytes } from 'node:crypto'
import net from 'node:net'

const DEFAULT_URL = 'ws://127.0.0.1:3037/api/robot/state/stream'
const targetUrl = new URL(process.argv[2] || process.env.ROBOT_STATE_WS_URL || DEFAULT_URL)
const robotUuid = process.env.ROBOT_STATE_UUID || 'dogzilla-local-demo'
const robotName = process.env.ROBOT_STATE_NAME || 'Robo Doge'
const sendHz = normalizePositiveNumber(process.env.ROBOT_STATE_HZ, 20)
const reconnectMs = normalizePositiveNumber(process.env.ROBOT_STATE_RECONNECT_MS, 1000)
const moveDurationMs = normalizePositiveNumber(process.env.ROBOT_STATE_MOVE_MS, 12000)
const idleDurationMs = normalizePositiveNumber(process.env.ROBOT_STATE_IDLE_MS, 3000)
const routeStart = {
  x: normalizeFiniteNumber(process.env.ROBOT_STATE_START_X, 0),
  y: normalizeFiniteNumber(process.env.ROBOT_STATE_START_Y, 0),
}
const routeEnd = {
  x: normalizeFiniteNumber(process.env.ROBOT_STATE_END_X, 1.45),
  y: normalizeFiniteNumber(process.env.ROBOT_STATE_END_Y, 0.85),
}
const startedAt = Date.now()

let seq = 0
let sendTimer = null
let reconnectTimer = null

if (targetUrl.protocol !== 'ws:') {
  throw new Error(`Only ws:// URLs are supported. Got ${targetUrl.href}`)
}

connect()

function connect() {
  clearReconnectTimer()
  const socket = net.createConnection({
    host: targetUrl.hostname,
    port: Number(targetUrl.port || 80),
  })
  const websocketKey = randomBytes(16).toString('base64')
  let handshakeDone = false
  let inboundBuffer = Buffer.alloc(0)

  socket.setNoDelay(true)

  socket.on('connect', () => {
    const path = `${targetUrl.pathname || '/'}${targetUrl.search || ''}`
    socket.write([
      `GET ${path} HTTP/1.1`,
      `Host: ${targetUrl.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${websocketKey}`,
      '',
      '',
    ].join('\r\n'))
  })

  socket.on('data', (chunk) => {
    inboundBuffer = Buffer.concat([inboundBuffer, chunk])

    if (!handshakeDone) {
      const headerEnd = inboundBuffer.indexOf('\r\n\r\n')

      if (headerEnd === -1) {
        return
      }

      const headerText = inboundBuffer.subarray(0, headerEnd).toString('utf-8')
      inboundBuffer = inboundBuffer.subarray(headerEnd + 4)

      if (!headerText.startsWith('HTTP/1.1 101')) {
        console.error(`Server rejected robot state stream:\n${headerText}`)
        console.error('Run app in real mode first, for example: $env:ROBOT_RUNTIME_TARGET="ros2_real"; npm run dev')
        socket.end()
        return
      }

      handshakeDone = true
      console.log(`Streaming ${robotName} (${robotUuid}) to ${targetUrl.href} at ${sendHz} Hz.`)
      startSending(socket)
    }

    inboundBuffer = readServerFrames(inboundBuffer)
  })

  socket.on('close', () => {
    stopSending()
    scheduleReconnect()
  })

  socket.on('error', (error) => {
    stopSending()
    console.error(`Robot state client error: ${error.message}`)
  })
}

function startSending(socket) {
  stopSending()
  sendState(socket)
  sendTimer = setInterval(() => sendState(socket), Math.max(100, Math.round(1000 / sendHz)))
}

function stopSending() {
  if (sendTimer) {
    clearInterval(sendTimer)
    sendTimer = null
  }
}

function sendState(socket) {
  if (!socket.writable) {
    return
  }

  const state = buildStateMessage()
  sendClientTextFrame(socket, JSON.stringify(state))

  if (seq % Math.max(1, Math.round(sendHz * 2)) === 0) {
    console.log(`seq ${state.seq}: ${state.task} x=${state.pose.x} y=${state.pose.y} theta=${state.pose.theta}`)
  }

  seq += 1
}

function buildStateMessage() {
  const motion = resolveRouteMotion(Date.now() - startedAt)

  return {
    type: 'robot.state',
    uuid: robotUuid,
    name: robotName,
    pose: {
      x: roundMeters(motion.x),
      y: roundMeters(motion.y),
      theta: roundMeters(motion.theta),
    },
    task: motion.task,
    timestamp: new Date().toISOString(),
    seq,
  }
}

function resolveRouteMotion(elapsedMs) {
  const cycleMs = (moveDurationMs * 2) + (idleDurationMs * 2)
  const cyclePosition = elapsedMs % cycleMs
  const outboundEnd = moveDurationMs
  const farIdleEnd = outboundEnd + idleDurationMs
  const inboundEnd = farIdleEnd + moveDurationMs
  const outboundTheta = Math.atan2(routeEnd.y - routeStart.y, routeEnd.x - routeStart.x)
  const inboundTheta = Math.atan2(routeStart.y - routeEnd.y, routeStart.x - routeEnd.x)

  if (cyclePosition < outboundEnd) {
    return buildLerpedPose(routeStart, routeEnd, cyclePosition / moveDurationMs, outboundTheta)
  }

  if (cyclePosition < farIdleEnd) {
    return {
      ...routeEnd,
      theta: outboundTheta,
      task: 'IDLE',
    }
  }

  if (cyclePosition < inboundEnd) {
    return buildLerpedPose(routeEnd, routeStart, (cyclePosition - farIdleEnd) / moveDurationMs, inboundTheta)
  }

  return {
    ...routeStart,
    theta: inboundTheta,
    task: 'IDLE',
  }
}

function buildLerpedPose(from, to, rawProgress, theta) {
  const progress = smoothStep(clamp(rawProgress, 0, 1))

  return {
    x: lerp(from.x, to.x, progress),
    y: lerp(from.y, to.y, progress),
    theta,
    task: 'MOVING',
  }
}

function lerp(from, to, progress) {
  return from + ((to - from) * progress)
}

function smoothStep(progress) {
  return progress * progress * (3 - (2 * progress))
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function readServerFrames(buffer) {
  let remaining = buffer

  while (remaining.length >= 2) {
    const firstByte = remaining[0]
    const secondByte = remaining[1]
    const opcode = firstByte & 0x0F
    let payloadLength = secondByte & 0x7F
    let offset = 2

    if (payloadLength === 126) {
      if (remaining.length < offset + 2) {
        return remaining
      }

      payloadLength = remaining.readUInt16BE(offset)
      offset += 2
    } else if (payloadLength === 127) {
      if (remaining.length < offset + 8) {
        return remaining
      }

      payloadLength = Number(remaining.readBigUInt64BE(offset))
      offset += 8
    }

    if (remaining.length < offset + payloadLength) {
      return remaining
    }

    const payload = remaining.subarray(offset, offset + payloadLength)
    remaining = remaining.subarray(offset + payloadLength)

    if (opcode === 0x1) {
      logServerMessage(payload.toString('utf-8'))
    }
  }

  return remaining
}

function logServerMessage(text) {
  try {
    const message = JSON.parse(text)

    if (message.type === 'robot.state.error') {
      console.error(`state error: ${message.error}`)
    }

    return
  } catch {
    console.log(text)
  }
}

function sendClientTextFrame(socket, text) {
  const payload = Buffer.from(text, 'utf-8')
  const mask = randomBytes(4)
  let header

  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length])
  } else if (payload.length <= 0xFFFF) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }

  const maskedPayload = Buffer.alloc(payload.length)

  for (let index = 0; index < payload.length; index += 1) {
    maskedPayload[index] = payload[index] ^ mask[index % 4]
  }

  socket.write(Buffer.concat([header, mask, maskedPayload]))
}

function scheduleReconnect() {
  clearReconnectTimer()
  reconnectTimer = setTimeout(connect, reconnectMs)
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeFiniteNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function roundMeters(value) {
  return Number(value.toFixed(3))
}
