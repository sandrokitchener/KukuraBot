const DEFAULT_TTL_MS = 10_000

const leases = new Map()
let nextFencingToken = 0

function now() {
  return Date.now()
}

function ttlMs() {
  const value = Number(process.env.ROBO_DOGE_LEASE_TTL_MS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TTL_MS
}

function expire(robotId, at = now()) {
  const lease = leases.get(robotId)
  if (lease && lease.expiresAt <= at) {
    leases.delete(robotId)
    return null
  }
  return lease || null
}

function snapshot(robotId, at = now()) {
  const lease = expire(robotId, at)
  return lease
    ? { active: true, robotId, ...lease }
    : { active: false, robotId, holder: null, fencingToken: null, expiresAt: null }
}

function requireIdentity(identity) {
  const value = typeof identity === 'string' ? identity.trim() : ''
  if (!value) throw new Error('Lease holder identity is required.')
  return value.slice(0, 200)
}

export function getRobotLease(robotId = 'default') {
  return snapshot(String(robotId || 'default'))
}

export function acquireRobotLease({ robotId = 'default', holder, takeover = false, at = now() } = {}) {
  const id = String(robotId || 'default')
  const owner = requireIdentity(holder)
  const current = expire(id, at)
  if (current && current.holder !== owner && !takeover) {
    return { ok: false, status: 'conflict', lease: snapshot(id, at) }
  }

  const lease = {
    holder: owner,
    fencingToken: ++nextFencingToken,
    expiresAt: at + ttlMs(),
  }
  leases.set(id, lease)
  return { ok: true, status: current?.holder === owner ? 'renewed' : 'acquired', lease: snapshot(id, at) }
}

export function renewRobotLease({ robotId = 'default', holder, fencingToken, at = now() } = {}) {
  const id = String(robotId || 'default')
  const owner = requireIdentity(holder)
  const current = expire(id, at)
  if (!current || current.holder !== owner || Number(fencingToken) !== current.fencingToken) {
    return { ok: false, status: 'stale', lease: snapshot(id, at) }
  }
  current.expiresAt = at + ttlMs()
  return { ok: true, status: 'renewed', lease: snapshot(id, at) }
}

export function releaseRobotLease({ robotId = 'default', holder, fencingToken, at = now() } = {}) {
  const id = String(robotId || 'default')
  const owner = requireIdentity(holder)
  const current = expire(id, at)
  if (!current || current.holder !== owner || Number(fencingToken) !== current.fencingToken) {
    return { ok: false, status: 'stale', lease: snapshot(id, at) }
  }
  leases.delete(id)
  return { ok: true, status: 'released', lease: snapshot(id, at) }
}

export function resetRobotLeases() {
  leases.clear()
}

