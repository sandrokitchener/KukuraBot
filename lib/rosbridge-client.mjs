import { EventEmitter } from 'node:events'

const DEFAULT_URL = 'ws://10.0.4.32:9090'
const DEFAULT_TOPICS = [
  { topic: '/scan', type: 'sensor_msgs/LaserScan', throttle_rate: 250, queue_length: 1 },
  { topic: '/tf', type: 'tf2_msgs/TFMessage', throttle_rate: 100, queue_length: 1 },
  { topic: '/tf_static', type: 'tf2_msgs/TFMessage', queue_length: 1 },
  { topic: '/odom', type: 'nav_msgs/Odometry', throttle_rate: 250, queue_length: 1 },
]

export class RosbridgeClient extends EventEmitter {
  constructor(options = {}) {
    super()
    this.url = options.url || DEFAULT_URL
    this.topics = options.topics || DEFAULT_TOPICS
    this.reconnectIntervalMs = options.reconnectIntervalMs ?? 3000
    this.maxPoints = options.maxPoints ?? 720
    this.mapFrame = normalizeFrame(options.mapFrame || 'map')
    this.odomFrame = normalizeFrame(options.odomFrame || 'odom')
    this.baseFrames = new Set(
      (options.baseFrames || ['base_link', 'base_footprint']).map(normalizeFrame).filter(Boolean),
    )

    this.ws = null
    this.connected = false
    this.intentionalClose = false
    this.reconnectTimer = null
    this.subscriptions = new Map()

    this.latest = {
      scan: null,
      odom: null,
      map: null,
    }
    this.tfTree = new Map() // parent -> child -> transform
    this.staticTfTree = new Map()

    this.frames = 0
    this.mapFrames = 0
    this.odomFrames = 0
    this.tfFrames = 0
    this.connectionState = 'disconnected'
    this.lastError = ''
    this.connectedAt = null

    // Prevent unhandled 'error' events from crashing the process when no
    // external listener is attached.
    this.on('error', () => {})
  }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return
    }
    this.intentionalClose = false
    this.connectionState = 'connecting'
    this.lastError = ''
    try {
      this.ws = new WebSocket(this.url)
      this.ws.onopen = () => this.handleOpen()
      this.ws.onmessage = (event) => this.handleMessage(event)
      this.ws.onerror = (error) => this.handleError(error)
      this.ws.onclose = () => this.handleClose()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.scheduleReconnect()
    }
  }

  close() {
    this.intentionalClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.connected = false
    this.connectionState = 'disconnected'
  }

  handleOpen() {
    this.connected = true
    this.connectionState = 'connected'
    this.connectedAt = Date.now()
    this.lastError = ''
    this.emit('connected')
    for (const sub of (this.topics || [])) {
      this.sendSubscribe(sub)
    }
  }

  sendSubscribe(subscription, legacyType) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return
    }
    const sub = typeof subscription === 'string'
      ? { topic: subscription, type: legacyType }
      : { ...subscription }
    const topic = sub.topic
    if (!topic) {
      return
    }
    this.ws.send(JSON.stringify({ op: 'subscribe', ...sub }))
    this.subscriptions.set(topic, { ...sub, subscribed: true })
  }

  handleMessage(event) {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    if (data.op === 'publish') {
      this.handlePublish(data.topic, data.msg)
    }
  }

  handlePublish(topic, msg) {
    const now = Date.now()
    if (topic === '/scan') {
      this.latest.scan = { msg, receivedAt: now }
      this.frames += 1
      return
    }
    if (topic === '/odom') {
      this.latest.odom = { msg, receivedAt: now }
      this.odomFrames += 1
      return
    }
    if (topic === '/map_cartographer' || topic === '/map') {
      this.latest.map = { msg, receivedAt: now, topic }
      this.mapFrames += 1
      return
    }
    if (topic === '/tf' || topic === '/tf_static') {
      this.handleTfMessage(msg, topic === '/tf_static')
      this.tfFrames += 1
    }
  }

  handleTfMessage(msg, isStatic) {
    if (!Array.isArray(msg.transforms)) {
      return
    }
    const tree = isStatic ? this.staticTfTree : this.tfTree
    for (const t of msg.transforms) {
      const parent = normalizeFrame(t.header?.frame_id)
      const child = normalizeFrame(t.child_frame_id)
      if (!parent || !child) {
        continue
      }
      if (!tree.has(parent)) {
        tree.set(parent, new Map())
      }
      tree.get(parent).set(child, {
        translation: t.transform?.translation,
        rotation: t.transform?.rotation,
        stamp: t.header?.stamp,
        receivedAt: Date.now(),
      })
    }
  }

  lookupTransform(parentFrame, childFrame) {
    const parent = normalizeFrame(parentFrame)
    const child = normalizeFrame(childFrame)
    if (!parent || !child) {
      return null
    }

    const direct = this.getTransform(parent, child)
    if (direct) {
      return direct
    }

    // Try one-hop chain through a common intermediate frame.
    const intermediates = new Set([
      ...(this.tfTree.get(parent)?.keys() || []),
      ...(this.staticTfTree.get(parent)?.keys() || []),
    ])
    for (const mid of intermediates) {
      const toMid = this.getTransform(parent, mid)
      const toChild = this.getTransform(mid, child)
      if (toMid && toChild) {
        return composeTransforms(toMid, toChild)
      }
    }

    return null
  }

  getTransform(parent, child) {
    return this.staticTfTree.get(parent)?.get(child) || this.tfTree.get(parent)?.get(child) || null
  }

  resolvePose() {
    // Prefer map-frame pose for waypoint safety.
    for (const baseFrame of this.baseFrames) {
      const t = this.lookupTransform(this.mapFrame, baseFrame)
      if (t) {
        return transformToPose(t, this.mapFrame, baseFrame, `tf:${this.mapFrame}->${baseFrame}`)
      }
    }
    // Fallback to odom-frame pose.
    for (const baseFrame of this.baseFrames) {
      const t = this.lookupTransform(this.odomFrame, baseFrame)
      if (t) {
        return transformToPose(t, this.odomFrame, baseFrame, `tf:${this.odomFrame}->${baseFrame}`)
      }
    }
    // Final fallback: raw /odom topic.
    if (this.latest.odom) {
      return odomToPose(this.latest.odom.msg, this.odomFrame)
    }
    return null
  }

  getHealth() {
    const scan = this.latest.scan
    const age = scan ? (Date.now() - scan.receivedAt) / 1000 : null
    const ok = this.connected && scan !== null && age !== null && age <= 3
    return {
      ok,
      status: ok ? 'ok' : this.connected ? 'no-scan' : 'disconnected',
      connected: this.connected,
      connectionState: this.connectionState,
      frames: this.frames,
      latestScanAgeSec: age,
      topic: '/scan',
      frameId: scan?.msg?.header?.frame_id || '',
      error: ok ? '' : this.lastError || (this.connected ? 'No LaserScan received yet.' : 'Not connected to rosbridge.'),
      url: this.url,
    }
  }

  getScan() {
    const snapshot = this.latest.scan
    if (!snapshot) {
      return {
        ok: false,
        status: 'no-scan',
        error: 'No LaserScan received yet.',
        points: [],
      }
    }

    const msg = snapshot.msg
    const ranges = Array.isArray(msg.ranges) ? msg.ranges : []
    const angleMin = Number(msg.angle_min)
    const angleMax = Number(msg.angle_max)
    const angleIncrement = Number(msg.angle_increment)
    const rangeMin = Number(msg.range_min)
    const rangeMax = Number(msg.range_max)

    const points = []
    const stride = Math.max(1, Math.ceil(ranges.length / this.maxPoints))
    for (let i = 0; i < ranges.length; i += stride) {
      const distance = ranges[i]
      if (!Number.isFinite(distance) || distance < rangeMin || distance > rangeMax) {
        continue
      }
      const angle = angleMin + i * angleIncrement
      points.push({
        angle: round(angle, 5),
        range: round(distance, 4),
        x: round(Math.cos(angle) * distance, 4),
        y: round(Math.sin(angle) * distance, 4),
      })
    }

    return {
      ok: true,
      status: 'ok',
      seq: stampToSeq(msg.header?.stamp),
      frameAt: snapshot.receivedAt / 1000,
      frameId: msg.header?.frame_id || '',
      angleMin,
      angleMax,
      angleIncrement,
      rangeMin,
      rangeMax,
      rangeCount: ranges.length,
      points,
      stats: scanStats(msg),
    }
  }

  getPose() {
    const pose = this.resolvePose()
    if (!pose) {
      return {
        ok: false,
        status: 'no-pose',
        pose: null,
        mapPose: null,
        waypointSafe: false,
        frames: this.tfFrames + this.odomFrames,
        error: 'No usable map/odom pose has been resolved.',
        diagnostics: [
          `TF parent frames: ${this.mapFrame}, ${this.odomFrame}`,
          `Base frames: ${[...this.baseFrames].join(', ')}`,
          'Map-frame pose is required before saved waypoints are trustworthy.',
        ],
      }
    }

    const age = (Date.now() - pose.receivedAt) / 1000
    const stale = age > 2
    const waypointSafe = pose.frame === this.mapFrame && !stale
    const poseBody = {
      x: round(pose.x, 5),
      y: round(pose.y, 5),
      theta: round(pose.theta, 5),
      frame: pose.frame,
      childFrame: pose.childFrame,
      source: pose.source,
      receivedAt: pose.receivedAt / 1000,
      ageSec: age,
    }

    return {
      ok: !stale,
      status: stale ? 'stale' : waypointSafe ? 'ok' : 'local-odom',
      pose: poseBody,
      mapPose: waypointSafe ? poseBody : null,
      waypointSafe,
      frames: this.tfFrames + this.odomFrames,
      error: stale ? `Pose frame is stale; latest age ${age.toFixed(2)}s.` : '',
      diagnostics: stale ? [`Latest pose age ${age.toFixed(2)}s exceeds stale threshold.`] : [],
    }
  }

  getMap() {
    const snapshot = this.latest.map
    if (!snapshot) {
      return {
        ok: false,
        status: 'no-map',
        error: 'No occupancy grid available. Start Cartographer mapping first.',
      }
    }

    const msg = snapshot.msg
    try {
      const info = msg.info
      const width = Number(info.width)
      const height = Number(info.height)
      const resolution = Number(info.resolution)
      const originX = Number(info.origin?.position?.x)
      const originY = Number(info.origin?.position?.y)
      const originYaw = quaternionToYaw(info.origin?.orientation) || 0
      const widthMeters = round(width * resolution, 3)
      const heightMeters = round(height * resolution, 3)
      const frameId = msg.header?.frame_id || ''

      const data = msg.data
      let bytes
      if (Array.isArray(data)) {
        bytes = new Int8Array(data)
      } else if (typeof data === 'string') {
        bytes = new Int8Array(Buffer.from(data, 'base64'))
      } else {
        throw new Error('Unsupported occupancy grid data type')
      }

      const encoded = Buffer.from(bytes.buffer).toString('base64')
      const counts = countMapCells(bytes, width, height)
      const bbox = computeMapBbox(bytes, width, height, originX, originY, resolution)

      const now = Date.now() / 1000
      const receivedAt = snapshot.receivedAt / 1000

      const payload = {
        ok: true,
        status: 'ok',
        width,
        height,
        resolution,
        origin: { x: originX, y: originY, yaw: originYaw, theta: originYaw },
        cells: encoded,
        cellCount: bytes.length,
        widthMeters,
        heightMeters,
        receivedAtEpoch: receivedAt,
        receivedAtAgeSec: round(now - receivedAt, 3),
        frameId,
        topic: snapshot.topic,
        occupiedCount: counts.occupied,
        freeCount: counts.free,
        unknownCount: counts.unknown,
      }
      if (bbox) {
        payload.bbox = bbox
      }
      return payload
    } catch (error) {
      return {
        ok: false,
        status: 'error',
        error: `Failed to encode occupancy grid: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  handleError(error) {
    this.lastError = error.message || 'websocket error'
    this.emit('error', error)
  }

  handleClose() {
    this.connected = false
    this.connectionState = 'disconnected'
    this.ws = null
    this.emit('disconnected')
    if (!this.intentionalClose) {
      this.scheduleReconnect()
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) {
      return
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, this.reconnectIntervalMs)
  }
}

export const defaultClient = new RosbridgeClient()

export function createRosbridgeClient(options) {
  return new RosbridgeClient(options)
}

function normalizeFrame(frame) {
  const text = String(frame || '').trim()
  return text.startsWith('/') ? text.slice(1) : text
}

function stampToSeq(stamp) {
  if (!stamp) return 0
  return Number(stamp.sec || 0) * 1_000_000_000 + Number(stamp.nanosec || 0)
}

function round(value, decimals) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const factor = 10 ** decimals
  return Math.round(n * factor) / factor
}

function quaternionToYaw(q) {
  if (!q) return null
  const x = Number(q.x)
  const y = Number(q.y)
  const z = Number(q.z)
  const w = Number(q.w)
  if (![x, y, z, w].every(Number.isFinite)) {
    return null
  }
  const sinyCosp = 2 * (w * z + x * y)
  const cosyCosp = 1 - 2 * (y * y + z * z)
  return Math.atan2(sinyCosp, cosyCosp)
}

function transformToPose(t, parent, child, source) {
  const tx = t.translation?.x
  const ty = t.translation?.y
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
    return null
  }
  return {
    x: tx,
    y: ty,
    theta: quaternionToYaw(t.rotation) || 0,
    frame: parent,
    childFrame: child,
    source,
    receivedAt: t.receivedAt,
  }
}

function odomToPose(msg, frame) {
  const pose = msg.pose?.pose
  if (!pose) {
    return null
  }
  return {
    x: pose.position?.x,
    y: pose.position?.y,
    theta: quaternionToYaw(pose.orientation) || 0,
    frame,
    childFrame: msg.child_frame_id || 'base_link',
    source: `odom:/odom`,
    receivedAt: Date.now(),
  }
}

function composeTransforms(a, b) {
  const ax = a.translation?.x ?? 0
  const ay = a.translation?.y ?? 0
  const atheta = quaternionToYaw(a.rotation) || 0
  const bx = b.translation?.x ?? 0
  const by = b.translation?.y ?? 0
  const btheta = quaternionToYaw(b.rotation) || 0
  const c = Math.cos(atheta)
  const s = Math.sin(atheta)
  return {
    translation: { x: ax + c * bx - s * by, y: ay + s * bx + c * by },
    rotation: { x: 0, y: 0, z: Math.sin((atheta + btheta) / 2), w: Math.cos((atheta + btheta) / 2) },
    receivedAt: Math.min(a.receivedAt, b.receivedAt),
  }
}

function scanStats(msg) {
  const ranges = Array.isArray(msg.ranges) ? msg.ranges : []
  const rangeMin = Number(msg.range_min)
  const rangeMax = Number(msg.range_max)
  const valid = ranges.filter((v) => Number.isFinite(v) && v >= rangeMin && v <= rangeMax)
  return {
    validRanges: valid.length,
    minRange: valid.length ? round(Math.min(...valid), 4) : null,
    maxRange: valid.length ? round(Math.max(...valid), 4) : null,
    nearFront: countSector(ranges, msg, -Math.PI / 12, Math.PI / 12, 0.75),
    nearLeft: countSector(ranges, msg, Math.PI / 12, Math.PI / 4, 0.75),
    nearRight: countSector(ranges, msg, -Math.PI / 4, -Math.PI / 12, 0.75),
  }
}

function countSector(ranges, msg, startAngle, endAngle, maxRange) {
  const angleMin = Number(msg.angle_min)
  const angleIncrement = Number(msg.angle_increment)
  let count = 0
  for (let i = 0; i < ranges.length; i += 1) {
    const d = ranges[i]
    if (!Number.isFinite(d) || d > maxRange) {
      continue
    }
    const angle = angleMin + i * angleIncrement
    if (angle >= startAngle && angle <= endAngle) {
      count += 1
    }
  }
  return count
}

function countMapCells(bytes, width, height) {
  let occupied = 0
  let free = 0
  let unknown = 0
  for (let i = 0; i < bytes.length; i += 1) {
    const v = bytes[i]
    if (v === -1) {
      unknown += 1
    } else if (v <= 50) {
      free += 1
    } else {
      occupied += 1
    }
  }
  return { occupied, free, unknown }
}

function computeMapBbox(bytes, width, height, originX, originY, resolution) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let hasCell = false
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const v = bytes[row * width + col]
      if (v === -1) {
        continue
      }
      const cx = originX + (col + 0.5) * resolution
      const cy = originY + (row + 0.5) * resolution
      hasCell = true
      if (cx < minX) minX = cx
      if (cx > maxX) maxX = cx
      if (cy < minY) minY = cy
      if (cy > maxY) maxY = cy
    }
  }
  if (!hasCell) {
    return null
  }
  return {
    minX: round(minX - resolution * 0.5, 3),
    minY: round(minY - resolution * 0.5, 3),
    maxX: round(maxX + resolution * 0.5, 3),
    maxY: round(maxY + resolution * 0.5, 3),
  }
}
