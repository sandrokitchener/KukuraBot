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

export function createCommandCuePlayer(audioUrl) {
  let audioContext = null
  let decodedBuffer = null
  let bufferPromise = null

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

  async function ensureBuffer() {
    if (decodedBuffer) {
      return decodedBuffer
    }

    if (!bufferPromise) {
      bufferPromise = (async () => {
        const context = await ensureAudioContext()
        const response = await fetch(audioUrl)

        if (!response.ok) {
          throw new Error(`Command cue download failed: ${response.status}`)
        }

        const audioData = await response.arrayBuffer()
        decodedBuffer = await context.decodeAudioData(audioData.slice(0))
        return decodedBuffer
      })()
    }

    return bufferPromise
  }

  return {
    async play() {
      const context = await ensureAudioContext()
      const buffer = await ensureBuffer()

      const source = context.createBufferSource()
      source.buffer = buffer
      source.playbackRate.value = 0.92
      source.detune.value = -120

      const bandpass = context.createBiquadFilter()
      bandpass.type = 'bandpass'
      bandpass.frequency.value = 1400
      bandpass.Q.value = 0.8

      const highpass = context.createBiquadFilter()
      highpass.type = 'highpass'
      highpass.frequency.value = 260

      const distortion = context.createWaveShaper()
      distortion.curve = createDistortionCurve(55)
      distortion.oversample = '4x'

      const bitcrusher = createBitcrusherNode(context, { bits: 5, reduction: 0.16 })

      const compressor = context.createDynamicsCompressor()
      compressor.threshold.value = -22
      compressor.knee.value = 18
      compressor.ratio.value = 3
      compressor.attack.value = 0.002
      compressor.release.value = 0.1

      const gain = context.createGain()
      gain.gain.value = 0.42

      source.connect(highpass)
      highpass.connect(bandpass)
      bandpass.connect(distortion)
      distortion.connect(bitcrusher)
      bitcrusher.connect(compressor)
      compressor.connect(gain)
      gain.connect(context.destination)

      source.addEventListener('ended', () => {
        source.disconnect()
        highpass.disconnect()
        bandpass.disconnect()
        distortion.disconnect()
        bitcrusher.disconnect()
        compressor.disconnect()
        gain.disconnect()
      }, { once: true })

      source.start()
    },
  }
}
