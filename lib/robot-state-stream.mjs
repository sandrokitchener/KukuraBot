import { createHash } from 'node:crypto'

export const ROBOT_STATE_STREAM_PATH = '/api/robot/state/stream'
export const ROBOT_STATE_TASKS = new Set([
  'MOVING',
  'IDLE',
  'SCANNING',
  'PATROLING',
  'PATROLLING',
  'TRICK',
  'TALKING',
  'THINKING',
])

const WEBSOCKET_ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const robotsByUuid = new Map()
const streamStats = {
  acceptedMessages: 0,
  rejectedMessages: 0,
  totalConnections: 0,
  activeConnections: 0,
  lastError: null,
  lastErrorAt: null,
}

export function getRobotStateSnapshot() {
  const robots = Array.from(robotsByUuid.values())
    .sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt))

  return {
    status: robots.length > 0 ? 'ok' : 'waiting',
    activeRobot: robots[0] ?? null,
    robots,
    stats: { ...streamStats },
  }
}

export function resetRobotStateForTests() {
  robotsByUuid.clear()
  streamStats.acceptedMessages = 0
  streamStats.rejectedMessages = 0
  streamStats.totalConnections = 0
  streamStats.activeConnections = 0
  streamStats.lastError = null
  streamStats.lastErrorAt = null
}

export function ingestRobotStateMessage(message, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date()
  const normalized = normalizeRobotStateMessage(message, now)
  const previous = robotsByUuid.get(normalized.uuid)
  const sequenceStatus = classifySequence(previous?.seq, normalized.seq)
  const record = {
    ...normalized,
    receivedAt: now.toISOString(),
    sequenceStatus,
  }

  robotsByUuid.set(record.uuid, record)
  streamStats.acceptedMessages += 1
  streamStats.lastError = null
  streamStats.lastErrorAt = null

  return record
}

export function normalizeRobotStateMessage(message, now = new Date()) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('robot.state message must be an object.')
  }

  requireField(message, 'type')
  requireField(message, 'uuid')
  requireField(message, 'name')
  requireField(message, 'pose')
  requireField(message, 'task')
  requireField(message, 'timestamp')
  requireField(message, 'seq')

  if (message.type !== 'robot.state') {
    throw new Error('robot.state message type must be "robot.state".')
  }

  const uuid = normalizeString(message.uuid)
  const name = normalizeString(message.name)
  const task = normalizeString(message.task).toUpperCase()
  const timestamp = normalizeString(message.timestamp)

  if (!uuid) {
    throw new Error('robot.state uuid must be a non-empty string.')
  }

  if (!name) {
    throw new Error('robot.state name must be a non-empty string.')
  }

  if (!ROBOT_STATE_TASKS.has(task)) {
    throw new Error(`robot.state task must be one of ${Array.from(ROBOT_STATE_TASKS).join(', ')}.`)
  }

  if (!timestamp || Number.isNaN(Date.parse(timestamp))) {
    throw new Error('robot.state timestamp must be an ISO 8601 string.')
  }

  if (!Number.isInteger(message.seq) || message.seq < 0) {
    throw new Error('robot.state seq must be a non-negative integer.')
  }

  return {
    type: 'robot.state',
    uuid,
    name,
    pose: normalizePose(message.pose),
    task,
    timestamp,
    seq: message.seq,
    receivedAt: now.toISOString(),
  }
}

export async function handleRobotStateStreamUpgrade(request, socket, head, options = {}) {
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)

  if (requestUrl.pathname !== ROBOT_STATE_STREAM_PATH) {
    rejectUpgrade(socket, 404, 'Not found')
    return false
  }

  const runtimeTargetKind = await resolveRuntimeTargetKind(options)

  if (runtimeTargetKind !== 'ros2-bridge') {
    rejectUpgrade(socket, 409, 'Robot state stream requires ROS2 real robot target')
    return true
  }

  const websocketKey = request.headers['sec-websocket-key']

  if (typeof websocketKey !== 'string' || !websocketKey.trim()) {
    rejectUpgrade(socket, 400, 'Missing Sec-WebSocket-Key')
    return true
  }

  streamStats.totalConnections += 1
  streamStats.activeConnections += 1
  socket.write(buildUpgradeResponse(websocketKey))

  const decoder = createWebSocketFrameDecoder({
    onText(text) {
      handleRobotStateTextMessage(socket, text)
    },
    onClose() {
      closeSocket(socket)
    },
    onPing(payload) {
      sendWebSocketFrame(socket, 0xA, payload)
    },
  })

  socket.on('data', (chunk) => {
    try {
      decoder.push(chunk)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      recordRejectedMessage(message)
      sendWebSocketJson(socket, {
        type: 'robot.state.error',
        status: 'error',
        error: message,
        receivedAt: new Date().toISOString(),
      })
      closeSocket(socket)
    }
  })
  socket.on('close', () => {
    streamStats.activeConnections = Math.max(0, streamStats.activeConnections - 1)
  })
  socket.on('error', (error) => {
    recordRejectedMessage(error instanceof Error ? error.message : String(error))
  })

  if (head?.length) {
    decoder.push(head)
  }

  sendWebSocketJson(socket, {
    type: 'robot.state.ready',
    path: ROBOT_STATE_STREAM_PATH,
    receivedAt: new Date().toISOString(),
  })
  return true
}

function handleRobotStateTextMessage(socket, text) {
  try {
    const payload = JSON.parse(text)
    const state = ingestRobotStateMessage(payload)

    sendWebSocketJson(socket, {
      type: 'robot.state.ack',
      uuid: state.uuid,
      seq: state.seq,
      status: 'ok',
      receivedAt: state.receivedAt,
      sequenceStatus: state.sequenceStatus,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    recordRejectedMessage(message)
    sendWebSocketJson(socket, {
      type: 'robot.state.error',
      status: 'error',
      error: message,
      receivedAt: new Date().toISOString(),
    })
  }
}

function requireField(message, fieldName) {
  if (!Object.hasOwn(message, fieldName)) {
    throw new Error(`robot.state missing required field "${fieldName}".`)
  }
}

function normalizePose(value) {
  if (value === null) {
    return null
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('robot.state pose must be null or an object.')
  }

  const pose = {
    x: Number(value.x),
    y: Number(value.y),
    theta: Number(value.theta),
  }

  for (const [axis, axisValue] of Object.entries(pose)) {
    if (!Number.isFinite(axisValue)) {
      throw new Error(`robot.state pose.${axis} must be a finite number.`)
    }
  }

  return pose
}

function classifySequence(previousSeq, nextSeq) {
  if (!Number.isInteger(previousSeq)) {
    return 'first'
  }

  if (nextSeq === previousSeq + 1) {
    return 'ok'
  }

  if (nextSeq > previousSeq + 1) {
    return 'gap'
  }

  return 'reset-or-out-of-order'
}

async function resolveRuntimeTargetKind(options) {
  if (typeof options.getRuntimeTargetKind === 'function') {
    return options.getRuntimeTargetKind()
  }

  return ''
}

function createWebSocketFrameDecoder({ onText, onClose, onPing }) {
  let buffer = Buffer.alloc(0)

  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk])

      while (buffer.length >= 2) {
        const firstByte = buffer[0]
        const secondByte = buffer[1]
        const opcode = firstByte & 0x0F
        const masked = (secondByte & 0x80) === 0x80
        let payloadLength = secondByte & 0x7F
        let offset = 2

        if (payloadLength === 126) {
          if (buffer.length < offset + 2) {
            return
          }

          payloadLength = buffer.readUInt16BE(offset)
          offset += 2
        } else if (payloadLength === 127) {
          if (buffer.length < offset + 8) {
            return
          }

          const extendedLength = buffer.readBigUInt64BE(offset)

          if (extendedLength > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error('WebSocket payload too large.')
          }

          payloadLength = Number(extendedLength)
          offset += 8
        }

        const maskOffset = masked ? 4 : 0
        const frameLength = offset + maskOffset + payloadLength

        if (buffer.length < frameLength) {
          return
        }

        const mask = masked ? buffer.subarray(offset, offset + 4) : null
        offset += maskOffset

        const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength))
        buffer = buffer.subarray(frameLength)

        if (mask) {
          for (let index = 0; index < payload.length; index += 1) {
            payload[index] ^= mask[index % 4]
          }
        }

        if (opcode === 0x1) {
          onText(payload.toString('utf-8'))
        } else if (opcode === 0x8) {
          onClose()
          return
        } else if (opcode === 0x9) {
          onPing(payload)
        }
      }
    },
  }
}

function buildUpgradeResponse(websocketKey) {
  const accept = createHash('sha1')
    .update(`${websocketKey.trim()}${WEBSOCKET_ACCEPT_GUID}`)
    .digest('base64')

  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n')
}

function sendWebSocketJson(socket, payload) {
  sendWebSocketFrame(socket, 0x1, Buffer.from(JSON.stringify(payload), 'utf-8'))
}

function sendWebSocketFrame(socket, opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '')
  let header

  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length])
  } else if (data.length <= 0xFFFF) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }

  socket.write(Buffer.concat([header, data]))
}

function rejectUpgrade(socket, statusCode, message) {
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(message)}\r\n` +
    '\r\n' +
    message,
  )
  socket.destroy()
}

function closeSocket(socket) {
  sendWebSocketFrame(socket, 0x8, Buffer.alloc(0))
  socket.end()
}

function recordRejectedMessage(message) {
  streamStats.rejectedMessages += 1
  streamStats.lastError = message
  streamStats.lastErrorAt = new Date().toISOString()
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}
