export function createDogzillaBatteryStateTracker(options = {}) {
  let lastKnown = normalizeLastKnownBattery(options.lastKnown)
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : null

  return {
    resolve(sample, timestamp = '') {
      const normalized = normalizeDogzillaBatterySample(sample)
      if (normalized.status === 'ok' && normalized.unit === 'percent') {
        lastKnown = {
          value: normalized.value,
          raw: normalized.raw,
          unit: normalized.unit,
          lastKnownAt: timestamp,
        }
        onUpdate?.({ ...lastKnown })
        return {
          value: normalized.value,
          status: normalized.status,
          unit: normalized.unit,
          lastKnownAt: timestamp,
        }
      }

      if (lastKnown && Number.isFinite(lastKnown.value)) {
        return {
          value: lastKnown.value,
          status: 'last-known',
          unit: lastKnown.unit,
          lastKnownAt: lastKnown.lastKnownAt,
          raw: normalized.raw,
          readStatus: normalized.status,
        }
      }

      return {
        value: normalized.value,
        status: normalized.status,
        unit: normalized.unit,
        lastKnownAt: '',
        raw: normalized.raw,
        readStatus: normalized.status,
      }
    },
  }
}

export function normalizeLastKnownBattery(value) {
  if (!value || typeof value !== 'object') return null

  const normalized = normalizeDogzillaBatterySample(value)
  if (normalized.status !== 'ok' || normalized.unit !== 'percent') return null

  return {
    value: normalized.value,
    raw: normalized.raw,
    unit: normalized.unit,
    lastKnownAt: typeof value.lastKnownAt === 'string' ? value.lastKnownAt : '',
  }
}

export function normalizeDogzillaBatterySample(value) {
  const sample = value && typeof value === 'object' ? value : { value }
  const raw = normalizeFiniteNumber(sample.raw ?? sample.value)
  const declaredUnit = normalizeBatteryUnit(sample.unit)
  const declaredStatus = typeof sample.status === 'string' ? sample.status.trim() : ''
  if (!Number.isFinite(raw)) {
    return {
      value: null,
      raw,
      status: declaredStatus && declaredStatus !== 'ok' ? declaredStatus : 'unavailable',
      unit: declaredUnit || 'unknown',
    }
  }

  if (raw <= 0) {
    return {
      value: null,
      raw,
      status: 'read-failed',
      unit: declaredUnit || 'unknown',
    }
  }

  if (declaredUnit !== 'percent') {
    return {
      value: raw,
      raw,
      status: declaredUnit ? 'unsupported-unit' : 'untyped',
      unit: declaredUnit || 'raw',
    }
  }

  if (declaredStatus && declaredStatus !== 'ok') {
    return {
      value: raw,
      raw,
      status: declaredStatus,
      unit: 'percent',
    }
  }

  return {
    value: raw,
    raw,
    status: raw <= 100 ? 'ok' : 'out-of-range',
    unit: raw <= 100 ? 'percent' : 'raw',
  }
}

function normalizeBatteryUnit(value) {
  if (typeof value !== 'string') return ''
  const unit = value.trim().toLowerCase()
  if (unit === 'percent' || unit === '%') return 'percent'
  if (unit === 'volt' || unit === 'volts' || unit === 'v') return 'volts'
  return unit
}

function normalizeFiniteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}
