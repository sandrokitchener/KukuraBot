export function createDogzillaBatteryStateTracker() {
  let lastKnown = null

  return {
    resolve(sample, timestamp = '') {
      const normalized = normalizeDogzillaBatterySample(sample?.raw ?? sample?.value ?? sample)
      if (Number.isFinite(normalized.value)) {
        lastKnown = {
          value: normalized.value,
          raw: normalized.raw,
          unit: normalized.unit,
          lastKnownAt: timestamp,
        }
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
        }
      }

      return {
        value: null,
        status: normalized.status,
        unit: normalized.unit,
        lastKnownAt: '',
      }
    },
  }
}

export function normalizeDogzillaBatterySample(value) {
  const raw = normalizeFiniteNumber(value)
  if (!Number.isFinite(raw)) {
    return {
      value: null,
      raw,
      status: 'unavailable',
      unit: 'percent',
    }
  }

  if (raw <= 0) {
    return {
      value: null,
      raw,
      status: 'read-failed',
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

function normalizeFiniteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}
