const DOGZILLA_AUDIO_VOLUME_KEY = 'robodoge.dogzillaAudioVolume'
const DEFAULT_DOGZILLA_AUDIO_VOLUME = 0.75

export function createDogzillaAudioController({
  input,
  value,
  apiFetch,
  getRuntimeConfig,
  isAndroidAppShell,
  storage = window.localStorage,
} = {}) {
  function handleVolumeInput() {
    const volume = getVolume()
    try {
      storage?.setItem(DOGZILLA_AUDIO_VOLUME_KEY, String(volume))
    } catch {}
    applyVolumeControl(volume)
    persistVolume(volume)
  }

  function applyVolumeControl(volume = loadVolume()) {
    const clamped = normalizeDogzillaAudioVolume(volume, DEFAULT_DOGZILLA_AUDIO_VOLUME)
    if (input) {
      input.value = String(Math.round(clamped * 100))
    }
    if (value) {
      value.textContent = `${Math.round(clamped * 100)}%`
    }
  }

  function getVolume() {
    if (input) {
      return normalizeDogzillaAudioVolume(Number(input.value) / 100, DEFAULT_DOGZILLA_AUDIO_VOLUME)
    }
    return loadVolume()
  }

  function loadVolume() {
    try {
      const stored = storage?.getItem(DOGZILLA_AUDIO_VOLUME_KEY)
      if (stored != null && stored !== '') {
        return normalizeDogzillaAudioVolume(Number(stored), DEFAULT_DOGZILLA_AUDIO_VOLUME)
      }
    } catch {
    }

    return normalizeDogzillaAudioVolume(
      getRuntimeConfig?.().dogzilla?.audio?.volume,
      DEFAULT_DOGZILLA_AUDIO_VOLUME,
    )
  }

  function shouldUsePiAudio() {
    return getRuntimeConfig?.().dogzilla?.audio?.enabled === true
  }

  function shouldSuppressLocalAudio() {
    return isAndroidAppShell?.() === true
  }

  async function playPiCue(cue) {
    const audioConfig = getRuntimeConfig?.().dogzilla?.audio
    if (!audioConfig?.enabled) {
      throw new Error('DOGZILLA Pi audio cues are not enabled.')
    }

    const response = await apiFetch('/api/dogzilla/audio/cue', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        cue,
        volume: getVolume(),
      }),
    })
    const payload = await response.json()
    if (!response.ok || payload.ok !== true) {
      throw new Error(payload.error || 'DOGZILLA Pi audio cue failed.')
    }
    return payload
  }

  function persistVolume(volume) {
    apiFetch?.('/api/dogzilla/audio/volume', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ volume }),
    }).catch(() => {})
  }

  return {
    applyVolumeControl,
    getVolume,
    handleVolumeInput,
    loadVolume,
    playPiCue,
    shouldSuppressLocalAudio,
    shouldUsePiAudio,
  }
}

export function normalizeDogzillaAudioVolume(value, fallback = DEFAULT_DOGZILLA_AUDIO_VOLUME) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return clamp(fallback, 0, 1)
  }
  return clamp(numeric, 0, 1)
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
