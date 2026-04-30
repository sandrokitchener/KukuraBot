function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`
}

function formatSpeechError(error) {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function canReplaceInputValue(input, lastAppliedSpeechText) {
  const currentValue = input.value.trim()
  return !currentValue || currentValue === lastAppliedSpeechText
}

function concatFloat32Arrays(chunks, totalSamples) {
  const result = new Float32Array(totalSamples)
  let offset = 0

  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }

  return result
}

function computeRms(audio) {
  if (!audio.length) {
    return 0
  }

  let sum = 0

  for (const sample of audio) {
    sum += sample * sample
  }

  return Math.sqrt(sum / audio.length)
}

function normalizeSpeechText(value) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractActivatedCommand(transcript, activationPhrases) {
  const normalizedTranscript = normalizeSpeechText(transcript)

  if (!normalizedTranscript) {
    return null
  }

  const normalizedPhrases = activationPhrases
    .map((phrase) => normalizeSpeechText(phrase))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)

  for (const normalizedPhrase of normalizedPhrases) {
    if (
      normalizedTranscript === normalizedPhrase
      || normalizedTranscript.startsWith(`${normalizedPhrase} `)
    ) {
      const command = normalizedTranscript.slice(normalizedPhrase.length).trim()

      return {
        activationPhrase: normalizedPhrase,
        command,
        transcript: normalizedTranscript,
      }
    }
  }

  return null
}

function formatActivationPrompt(activationPhrases) {
  const phrases = activationPhrases
    .map((phrase) => normalizeSpeechText(phrase))
    .filter(Boolean)

  if (phrases.length === 0) {
    return 'Say a command.'
  }

  return `Say "${phrases[0]}" before a command.`
}

function resampleAudio(audio, fromSampleRate, toSampleRate) {
  if (fromSampleRate === toSampleRate) {
    return audio
  }

  const nextLength = Math.max(1, Math.round(audio.length * toSampleRate / fromSampleRate))
  const result = new Float32Array(nextLength)
  const ratio = (audio.length - 1) / Math.max(1, nextLength - 1)

  for (let index = 0; index < nextLength; index += 1) {
    const position = index * ratio
    const leftIndex = Math.floor(position)
    const rightIndex = Math.min(audio.length - 1, leftIndex + 1)
    const weight = position - leftIndex

    result[index] = audio[leftIndex] * (1 - weight) + audio[rightIndex] * weight
  }

  return result
}

function encodePcm16Wav(audio, sampleRate) {
  const pcm = new Int16Array(audio.length)

  for (let index = 0; index < audio.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, audio[index] || 0))
    pcm[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff)
  }

  const buffer = new ArrayBuffer(44 + pcm.byteLength)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  let offset = 0

  function writeString(value) {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset, value.charCodeAt(index))
      offset += 1
    }
  }

  writeString('RIFF')
  view.setUint32(offset, 36 + pcm.byteLength, true)
  offset += 4
  writeString('WAVE')
  writeString('fmt ')
  view.setUint32(offset, 16, true)
  offset += 4
  view.setUint16(offset, 1, true)
  offset += 2
  view.setUint16(offset, 1, true)
  offset += 2
  view.setUint32(offset, sampleRate, true)
  offset += 4
  view.setUint32(offset, sampleRate * 2, true)
  offset += 4
  view.setUint16(offset, 2, true)
  offset += 2
  view.setUint16(offset, 16, true)
  offset += 2
  writeString('data')
  view.setUint32(offset, pcm.byteLength, true)
  offset += 4
  bytes.set(new Uint8Array(pcm.buffer), offset)

  return bytes
}

function encodeBytesAsBase64(bytes) {
  const chunkSize = 0x8000
  let binary = ''

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }

  return btoa(binary)
}

async function readJsonResponse(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function createPcmRecorder({ maxBufferSeconds = 20, targetSampleRate = 16000, onChunk = null }) {
  let audioContext = null
  let mediaStream = null
  let sourceNode = null
  let processorNode = null
  let muteNode = null
  let chunks = []
  let totalSamples = 0
  let sampleRate = targetSampleRate

  function trimToWindow() {
    const maxSamples = Math.max(1, Math.round(maxBufferSeconds * sampleRate))

    while (totalSamples > maxSamples && chunks.length > 0) {
      const overflow = totalSamples - maxSamples
      const firstChunk = chunks[0]

      if (firstChunk.length <= overflow) {
        totalSamples -= firstChunk.length
        chunks.shift()
        continue
      }

      chunks[0] = firstChunk.slice(overflow)
      totalSamples -= overflow
    }
  }

  return {
    async start() {
      if (audioContext) {
        return
      }

      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true,
          sampleRate: targetSampleRate,
        },
      })

      const AudioContextCtor = window.AudioContext || window.webkitAudioContext

      if (!AudioContextCtor) {
        throw new Error('AudioContext is not available in this browser.')
      }

      audioContext = new AudioContextCtor({ sampleRate: targetSampleRate })
      await audioContext.resume()
      sampleRate = audioContext.sampleRate

      sourceNode = audioContext.createMediaStreamSource(mediaStream)
      processorNode = audioContext.createScriptProcessor(4096, 1, 1)
      muteNode = audioContext.createGain()
      muteNode.gain.value = 0

      processorNode.onaudioprocess = (event) => {
        const channelData = event.inputBuffer.getChannelData(0)
        const chunk = new Float32Array(channelData)

        chunks.push(chunk)
        totalSamples += chunk.length
        trimToWindow()
        onChunk?.(chunk, sampleRate)
      }

      sourceNode.connect(processorNode)
      processorNode.connect(muteNode)
      muteNode.connect(audioContext.destination)
    },

    snapshotAndClear() {
      const merged = concatFloat32Arrays(chunks, totalSamples)
      const durationSeconds = totalSamples / Math.max(sampleRate, 1)

      chunks = []
      totalSamples = 0

      return {
        audio: resampleAudio(merged, sampleRate, targetSampleRate),
        durationSeconds,
        sampleRate: targetSampleRate,
      }
    },

    stop() {
      processorNode?.disconnect()
      sourceNode?.disconnect()
      muteNode?.disconnect()
      mediaStream?.getTracks().forEach((track) => track.stop())
      audioContext?.close()

      audioContext = null
      mediaStream = null
      sourceNode = null
      processorNode = null
      muteNode = null
      chunks = []
      totalSamples = 0
      sampleRate = targetSampleRate
    },
  }
}

async function createMoonshineSpeechProvider(profile, handlers) {
  const Moonshine = await import(profile.libraryUrl)

  Moonshine.Settings.BASE_ASSET_PATH.MOONSHINE = ensureTrailingSlash(profile.moonshineAssetBaseUrl)
  Moonshine.Settings.BASE_ASSET_PATH.ONNX_RUNTIME = ensureTrailingSlash(profile.onnxRuntimeBaseUrl)
  Moonshine.Settings.BASE_ASSET_PATH.SILERO_VAD = ensureTrailingSlash(profile.vadAssetBaseUrl)

  const transcriber = new Moonshine.MicrophoneTranscriber(
    profile.modelUrl,
    {
      onPermissionsRequested() {
        handlers.onStatus('Requesting microphone permission...')
      },
      onModelLoadStarted() {
        handlers.onStatus(`Loading ${profile.label}...`)
      },
      onModelLoaded() {
        handlers.onStatus(`Listening with ${profile.label}.`)
      },
      onTranscribeStarted() {
        handlers.onStatus(`Microphone live via ${profile.label}.`)
      },
      onTranscribeStopped() {
        handlers.onStatus(`Microphone stopped for ${profile.label}.`)
      },
      onSpeechStart() {
        handlers.onStatus(`Hearing speech on ${profile.label}...`)
      },
      onSpeechEnd() {
        handlers.onStatus(`Processing speech on ${profile.label}...`)
      },
      onTranscriptionUpdated(text) {
        handlers.onTranscript(text, 'update')
      },
      onTranscriptionCommitted(text) {
        handlers.onTranscript(text, 'commit')
      },
      onError(error) {
        handlers.onError(error)
      },
    },
    profile.useVad,
    profile.precision,
  )

  return {
    async start() {
      await transcriber.start()
    },
    async prepareInputForSubmit() {
      return ''
    },
    async dispose() {},
    stop() {
      transcriber.stop()
    },
  }
}

async function createBufferedSpeechProvider({
  profile,
  handlers,
  submitLabel,
  transcribeAudio,
  warmup = null,
  dispose = null,
  startStatus = null,
}) {
  let utteranceChunks = []
  let utteranceSamples = 0
  let isSpeechActive = false
  let speechDurationMs = 0
  let silenceDurationMs = 0
  let armedActivation = null
  let transcriptionChain = Promise.resolve()

  async function processCompletedUtterance(audio, durationSeconds) {
    handlers.onStatus(`Transcribing ${durationSeconds.toFixed(1)}s with ${profile.label}...`)
    const result = await transcribeAudio(audio, durationSeconds)
    const text = typeof result?.text === 'string' ? result.text.trim() : ''

    if (!text) {
      handlers.onStatus(`No speech recognized by ${profile.label}.`, true)
      return ''
    }

    handlers.onTranscript(text, 'commit', { syncInput: false })

    const activationMatch = extractActivatedCommand(text, profile.activationPhrases || [])

    if (!activationMatch) {
      if (armedActivation && Date.now() <= armedActivation.expiresAt) {
        const command = normalizeSpeechText(text)

        if (!command) {
          handlers.onStatus('Voice trigger armed. Waiting for command.', false)
          return text
        }

        const activationContext = armedActivation
        armedActivation = null
        handlers.onStatus(`Sending voice command: ${command}`, false)
        await handlers.onVoiceCommand?.(command, {
          activationPhrase: activationContext.activationPhrase,
          transcript: text,
        })
        return text
      }

      armedActivation = null
      handlers.onStatus(`Ignored speech without activation phrase: ${text}`, false)
      return text
    }

    if (!activationMatch.command) {
      armedActivation = {
        activationPhrase: activationMatch.activationPhrase,
        expiresAt: Date.now() + (profile.activationCommandWindowMs || 8000),
      }
      handlers.onStatus('Voice trigger armed. Say the command now.', false)
      return text
    }

    armedActivation = null
    handlers.onStatus(`Sending voice command: ${activationMatch.command}`, false)
    await handlers.onVoiceCommand?.(activationMatch.command, {
      activationPhrase: activationMatch.activationPhrase,
      transcript: text,
    })

    return text
  }

  function finalizeUtterance() {
    if (utteranceSamples === 0) {
      return
    }

    const merged = concatFloat32Arrays(utteranceChunks, utteranceSamples)
    const durationSeconds = utteranceSamples / 16000

    utteranceChunks = []
    utteranceSamples = 0
    isSpeechActive = false
    speechDurationMs = 0
    silenceDurationMs = 0

    if (durationSeconds * 1000 < profile.minimumSpeechMs) {
      return
    }

    transcriptionChain = transcriptionChain
      .then(() => processCompletedUtterance(merged, durationSeconds))
      .catch((error) => {
        handlers.onError(error)
      })
  }

  function handleChunk(chunk, sampleRate) {
    const durationMs = (chunk.length / Math.max(sampleRate, 1)) * 1000
    const rms = computeRms(chunk)

    if (rms >= profile.speechThreshold) {
      if (!isSpeechActive) {
        isSpeechActive = true
        utteranceChunks = []
        utteranceSamples = 0
        speechDurationMs = 0
        silenceDurationMs = 0
        handlers.onStatus(`Heard speech. Waiting for pause...`)
      }

      utteranceChunks.push(chunk)
      utteranceSamples += chunk.length
      speechDurationMs += durationMs
      silenceDurationMs = 0
      return
    }

    if (!isSpeechActive) {
      return
    }

    utteranceChunks.push(chunk)
    utteranceSamples += chunk.length
    silenceDurationMs += durationMs

    if (silenceDurationMs >= profile.silenceDurationMs) {
      finalizeUtterance()
    }
  }

  const recorder = createPcmRecorder({
    maxBufferSeconds: profile.maxBufferSeconds || 20,
    targetSampleRate: 16000,
    onChunk: handleChunk,
  })

  return {
    async start() {
      handlers.onStatus(`Requesting microphone for ${profile.label}...`)
      await recorder.start()
      handlers.onStatus(startStatus || `Microphone live via ${profile.label}. ${formatActivationPrompt(profile.activationPhrases || [])}`)
      warmup?.().catch((error) => {
        handlers.onError(error)
      })
    },

    async prepareInputForSubmit() {
      const { audio, durationSeconds } = recorder.snapshotAndClear()

      if (!audio.length || durationSeconds < 0.25) {
        handlers.onStatus('No speech captured yet.', true)
        return ''
      }

      return processCompletedUtterance(audio, durationSeconds)
    },

    async dispose() {
      await dispose?.()
    },

    stop() {
      recorder.stop()
    },
  }
}

async function createWhisperSpeechProvider(profile, handlers, submitLabel) {
  const { env, pipeline } = await import(profile.libraryUrl)

  env.allowRemoteModels = true
  env.useBrowserCache = true
  env.backends.onnx.wasm.wasmPaths = ensureTrailingSlash(profile.onnxRuntimeBaseUrl)

  let transcriberPromise = null
  let transcriber = null

  async function loadTranscriberWith(options, label) {
    handlers.onStatus(`Loading ${profile.label} (${label})...`)

    return pipeline(
      'automatic-speech-recognition',
      profile.modelId,
      {
        ...(options.device && options.device !== 'wasm' ? { device: options.device } : {}),
        ...(options.dtype ? { dtype: options.dtype } : {}),
        progress_callback(progress) {
          if (progress.status === 'progress' && typeof progress.progress === 'number') {
            handlers.onStatus(`Loading ${profile.label}: ${progress.progress.toFixed(0)}%`)
          } else if (progress.status === 'ready') {
            handlers.onStatus(`${profile.label} ready. Recording locally.`)
          }
        },
      },
    )
  }

  async function ensureTranscriber() {
    if (transcriber) {
      return transcriber
    }

    if (!transcriberPromise) {
      transcriberPromise = (async () => {
        try {
          transcriber = await loadTranscriberWith(
            { device: profile.device, dtype: profile.dtype },
            profile.device || 'default',
          )
        } catch (error) {
          const canFallback = profile.fallbackDevice || profile.fallbackDtype

          if (!canFallback) {
            throw error
          }

          handlers.onStatus(
            `${profile.label} primary load failed, retrying with ${profile.fallbackDevice || 'wasm'}...`,
          )

          transcriber = await loadTranscriberWith(
            { device: profile.fallbackDevice, dtype: profile.fallbackDtype },
            profile.fallbackDevice || 'fallback',
          )
        }

        return transcriber
      })()
    }

    return transcriberPromise
  }

  function getTranscriptionOptions() {
    const isEnglishOnlyWhisperModel = typeof profile.modelId === 'string' && /\.en$/i.test(profile.modelId)

    return {
      ...(!isEnglishOnlyWhisperModel && profile.language ? { language: profile.language } : {}),
      ...(!isEnglishOnlyWhisperModel && profile.task ? { task: profile.task } : {}),
      ...(profile.chunkLengthSeconds ? { chunk_length_s: profile.chunkLengthSeconds } : {}),
      ...(profile.strideLengthSeconds ? { stride_length_s: profile.strideLengthSeconds } : {}),
    }
  }

  return createBufferedSpeechProvider({
    profile,
    handlers,
    submitLabel,
    async transcribeAudio(audio) {
      const asr = await ensureTranscriber()
      return asr(audio, getTranscriptionOptions())
    },
    warmup() {
      return ensureTranscriber()
    },
    async dispose() {
      await transcriber?.dispose?.()
    },
  })
}

async function createParakeetSpeechProvider(profile, handlers, submitLabel) {
  async function checkHealth() {
    const response = await fetch('/api/speech/health')
    const payload = await readJsonResponse(response)

    if (!response.ok || payload?.status !== 'ok') {
      throw new Error(payload?.error || payload?.body?.error || 'Parakeet sidecar unavailable.')
    }

    return payload
  }

  async function transcribeViaSidecar(audio, sampleRate) {
    const audioBase64 = encodeBytesAsBase64(encodePcm16Wav(audio, sampleRate))
    const response = await fetch('/api/speech/transcribe', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        audioBase64,
        mimeType: 'audio/wav',
        sampleRate,
      }),
    })
    const payload = await readJsonResponse(response)

    if (!response.ok || payload?.status !== 'ok') {
      throw new Error(
        payload?.error
        || payload?.body?.error
        || `Parakeet transcription failed${payload?.responseStatus ? ` (${payload.responseStatus})` : ''}.`,
      )
    }

    return payload.body || {}
  }

  return createBufferedSpeechProvider({
    profile,
    handlers,
    submitLabel,
    async transcribeAudio(audio) {
      return transcribeViaSidecar(audio, 16000)
    },
    async warmup() {
      const health = await checkHealth()
      const bridgeStatus = health?.body?.status || 'ready'
      handlers.onStatus(
        `Microphone live via ${profile.label}. Bridge ${bridgeStatus}. ${formatActivationPrompt(profile.activationPhrases || [])}`,
      )
    },
    startStatus: `Microphone live via ${profile.label}. Checking local speech bridge. ${formatActivationPrompt(profile.activationPhrases || [])}`,
  })
}

const SPEECH_PROVIDER_FACTORIES = {
  'moonshine-browser': ({ profile, handlers }) => createMoonshineSpeechProvider(profile, handlers),
  'whisper-browser': ({ profile, handlers, submitLabel }) => createWhisperSpeechProvider(profile, handlers, submitLabel),
  'parakeet-sidecar': ({ profile, handlers, submitLabel }) => createParakeetSpeechProvider(profile, handlers, submitLabel),
}

export async function createSpeechInputController({
  input,
  speechConfig,
  onStatus,
  onTranscript,
  onVoiceCommand,
  submitLabel = 'Send',
}) {
  let provider = null
  let lastAppliedSpeechText = ''

  const updateTranscript = (text, phase, options = {}) => {
    const nextText = typeof text === 'string' ? text.trim() : ''
    const shouldSyncInput = options.syncInput ?? true

    if (!nextText) {
      return
    }

    if (shouldSyncInput && canReplaceInputValue(input, lastAppliedSpeechText)) {
      input.value = nextText
      lastAppliedSpeechText = nextText
    }

    onTranscript(nextText, phase)
  }

  const activeProfile = speechConfig?.activeProfile

  if (!activeProfile) {
    onStatus('No speech profile configured.', true)
    return {
      async start() {},
      async prepareInputForSubmit() {
        return ''
      },
      async dispose() {},
      stop() {},
    }
  }

  const handlers = {
    onStatus(message, isError = false) {
      onStatus(message, isError)
    },
    onTranscript(text, phase, options) {
      updateTranscript(text, phase, options)
    },
    onVoiceCommand(message, context) {
      return onVoiceCommand?.(message, context)
    },
    onError(error) {
      onStatus(`Speech error: ${formatSpeechError(error)}`, true)
    },
  }
  const activationPhrases = speechConfig?.activationPhrases || []

  const factory = SPEECH_PROVIDER_FACTORIES[activeProfile.provider]

  if (!factory) {
    onStatus(`Unsupported speech provider "${activeProfile.provider}".`, true)
    return {
      async start() {},
      async prepareInputForSubmit() {
        return ''
      },
      async dispose() {},
      stop() {},
    }
  }

  provider = await factory({
    profile: { ...activeProfile, activationPhrases },
    handlers,
    submitLabel,
  })

  return {
    async start() {
      if (activeProfile.autoStart) {
        await provider.start()
      } else {
        onStatus(`${activeProfile.label} ready. Auto-start disabled.`, false)
      }
    },
    async prepareInputForSubmit() {
      return provider.prepareInputForSubmit ? provider.prepareInputForSubmit() : ''
    },
    async dispose() {
      await provider.dispose?.()
    },
    stop() {
      provider?.stop()
    },
  }
}
