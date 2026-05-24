import { loadDogzillaConnectionConfig } from './dogzilla-connection-center.mjs'

const DEFAULT_TIMEOUT_MS = 2500

export async function getDogzillaAudioCueHealth(options = {}) {
  const config = options.config || await loadDogzillaConnectionConfig()
  const audio = config?.audio || {}

  if (!audio.enabled || !audio.healthUrl) {
    return {
      status: 'disabled',
      ok: false,
      detail: 'DOGZILLA Pi audio cues are not configured.',
    }
  }

  try {
    const response = await fetch(audio.healthUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    const body = await safeReadJson(response)
    const ok = response.ok && body?.ok === true
    return {
      status: ok ? 'ok' : 'error',
      ok,
      destination: audio.healthUrl,
      responseStatus: response.status,
      body,
      detail: ok ? 'DOGZILLA Pi audio cues are ready.' : body?.error || `HTTP ${response.status}`,
    }
  } catch (error) {
    return {
      status: 'error',
      ok: false,
      destination: audio.healthUrl,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function sendDogzillaAudioCue(cue, options = {}) {
  const config = options.config || await loadDogzillaConnectionConfig()
  const audio = config?.audio || {}
  const normalizedCue = normalizeCue(cue)

  if (!normalizedCue) {
    return {
      status: 'invalid',
      ok: false,
      error: 'Missing DOGZILLA audio cue name.',
    }
  }

  if (!audio.enabled || !audio.cueUrl) {
    return {
      status: 'disabled',
      ok: false,
      cue: normalizedCue,
      error: 'DOGZILLA Pi audio cues are not configured.',
    }
  }

  try {
    const response = await fetch(audio.cueUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ cue: normalizedCue }),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    const body = await safeReadJson(response)
    const ok = response.ok && body?.ok === true
    return {
      status: ok ? 'ok' : 'error',
      ok,
      cue: normalizedCue,
      destination: audio.cueUrl,
      responseStatus: response.status,
      body,
      error: ok ? '' : body?.error || `HTTP ${response.status}`,
    }
  } catch (error) {
    return {
      status: 'error',
      ok: false,
      cue: normalizedCue,
      destination: audio.cueUrl,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function normalizeCue(value) {
  return typeof value === 'string' ? value.trim() : ''
}

async function safeReadJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}
