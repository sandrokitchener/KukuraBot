function createDistortionCurve(amount = 40) {
  const samples = 44100
  const curve = new Float32Array(samples)
  const deg = Math.PI / 180

  for (let index = 0; index < samples; index += 1) {
    const x = (index * 2) / samples - 1
    curve[index] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x))
  }

  return curve
}

function createBitcrusherNode(audioContext, { bits = 6, reduction = 0.18 } = {}) {
  const processor = audioContext.createScriptProcessor(4096, 1, 1)
  const step = 1 / (2 ** bits)
  let phase = 0
  let lastSample = 0

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0)
    const output = event.outputBuffer.getChannelData(0)

    for (let index = 0; index < input.length; index += 1) {
      phase += reduction

      if (phase >= 1) {
        phase -= 1
        lastSample = step * Math.floor(input[index] / step + 0.5)
      }

      output[index] = lastSample
    }
  }

  return processor
}

export function createCommandCuePlayer(audioUrls, options = {}) {
  const urls = Array.isArray(audioUrls) ? audioUrls : [audioUrls]
  const gainLevel = Number.isFinite(options.gain) ? options.gain : 0.42
  const playbackRate = Number.isFinite(options.playbackRate) ? options.playbackRate : 0.92
  const detune = Number.isFinite(options.detune) ? options.detune : -120
  const distortionAmount = Number.isFinite(options.distortion) ? options.distortion : 55
  const crusherBits = Number.isFinite(options.bits) ? options.bits : 5
  const crusherReduction = Number.isFinite(options.reduction) ? options.reduction : 0.16
  let audioContext = null
  const decodedBuffers = new Map()
  const bufferPromises = new Map()
  const activeSources = new Set()

  async function ensureAudioContext() {
    if (audioContext) {
      return audioContext
    }

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext

    if (!AudioContextCtor) {
      throw new Error('AudioContext is not available in this browser.')
    }

    audioContext = new AudioContextCtor()
    await audioContext.resume()
    return audioContext
  }

  async function ensureBuffer(audioUrl) {
    if (decodedBuffers.has(audioUrl)) {
      return decodedBuffers.get(audioUrl)
    }

    if (!bufferPromises.has(audioUrl)) {
      bufferPromises.set(audioUrl, (async () => {
        const context = await ensureAudioContext()
        const response = await fetch(audioUrl)

        if (!response.ok) {
          throw new Error(`Command cue download failed: ${response.status}`)
        }

        const audioData = await response.arrayBuffer()
        const decodedBuffer = await context.decodeAudioData(audioData.slice(0))
        decodedBuffers.set(audioUrl, decodedBuffer)
        return decodedBuffer
      })())
    }

    return bufferPromises.get(audioUrl)
  }

  function pickUrl() {
    const playableUrls = urls.filter(Boolean)
    return playableUrls[Math.floor(Math.random() * playableUrls.length)]
  }

  return {
    async play(playOptions = {}) {
      const audioUrl = pickUrl()
      if (!audioUrl) {
        return null
      }

      const context = await ensureAudioContext()
      const buffer = await ensureBuffer(audioUrl)

      const source = context.createBufferSource()
      source.buffer = buffer
      source.loop = !!playOptions.loop
      source.playbackRate.value = playbackRate
      source.detune.value = detune

      const bandpass = context.createBiquadFilter()
      bandpass.type = 'bandpass'
      bandpass.frequency.value = 1400
      bandpass.Q.value = 0.8

      const highpass = context.createBiquadFilter()
      highpass.type = 'highpass'
      highpass.frequency.value = 260

      const distortion = context.createWaveShaper()
      distortion.curve = createDistortionCurve(distortionAmount)
      distortion.oversample = '4x'

      const bitcrusher = createBitcrusherNode(context, { bits: crusherBits, reduction: crusherReduction })

      const compressor = context.createDynamicsCompressor()
      compressor.threshold.value = -22
      compressor.knee.value = 18
      compressor.ratio.value = 3
      compressor.attack.value = 0.002
      compressor.release.value = 0.1

      const gain = context.createGain()
      gain.gain.value = gainLevel

      source.connect(highpass)
      highpass.connect(bandpass)
      bandpass.connect(distortion)
      distortion.connect(bitcrusher)
      bitcrusher.connect(compressor)
      compressor.connect(gain)
      gain.connect(context.destination)
      activeSources.add(source)

      source.addEventListener('ended', () => {
        activeSources.delete(source)
        source.disconnect()
        highpass.disconnect()
        bandpass.disconnect()
        distortion.disconnect()
        bitcrusher.disconnect()
        compressor.disconnect()
        gain.disconnect()
      }, { once: true })

      source.start()
      return {
        stop() {
          try {
            source.stop()
          } catch {
            activeSources.delete(source)
          }
        },
      }
    },
    stopAll() {
      for (const source of Array.from(activeSources)) {
        try {
          source.stop()
        } catch {
          activeSources.delete(source)
        }
      }
    },
  }
}
