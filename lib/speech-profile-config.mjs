import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const CONFIG_DIR = path.join(ROOT_DIR, 'config')
const SPEECH_PROFILES_FILE = path.join(CONFIG_DIR, 'speech-profiles.json')
const SPEECH_RUNTIME_FILE = path.join(CONFIG_DIR, 'speech-runtime.json')

export async function loadSpeechProfilesConfig() {
  return normalizeSpeechProfilesConfig(JSON.parse(await readFile(SPEECH_PROFILES_FILE, 'utf-8')))
}

export async function loadSpeechRuntimeConfig() {
  try {
    return normalizeSpeechRuntimeConfig(JSON.parse(await readFile(SPEECH_RUNTIME_FILE, 'utf-8')))
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return normalizeSpeechRuntimeConfig({})
    }

    throw error
  }
}

export async function saveSpeechRuntimeConfig(runtimeConfig) {
  const normalized = normalizeSpeechRuntimeConfig(runtimeConfig)
  await writeFile(SPEECH_RUNTIME_FILE, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8')
  return normalized
}

export async function resolveActiveSpeechProfile(env = process.env) {
  const [profilesConfig, runtimeConfig] = await Promise.all([
    loadSpeechProfilesConfig(),
    loadSpeechRuntimeConfig(),
  ])
  const selection = resolveSpeechProfileSelection({
    profilesConfig,
    runtimeConfig,
    env,
  })

  return {
    ...selection,
    activeProfile: profilesConfig.profiles[selection.activeProfileId],
    availableProfiles: listSpeechProfileSummaries(profilesConfig),
  }
}

export function resolveSpeechProfileSelection({ profilesConfig, runtimeConfig = {}, env = {} }) {
  const profileIds = Object.keys(profilesConfig.profiles)

  if (profileIds.length === 0) {
    throw new Error('No speech profiles configured.')
  }

  const overrideProfileId = typeof env.APP_SPEECH_PROFILE === 'string' ? env.APP_SPEECH_PROFILE.trim() : ''
  const runtimeProfileId = typeof runtimeConfig.activeProfile === 'string' ? runtimeConfig.activeProfile.trim() : ''
  const defaultProfileId =
    profilesConfig.defaultProfile && profilesConfig.profiles[profilesConfig.defaultProfile]
      ? profilesConfig.defaultProfile
      : profileIds[0]

  if (overrideProfileId) {
    if (!profilesConfig.profiles[overrideProfileId]) {
      throw new Error(`Unknown APP_SPEECH_PROFILE "${overrideProfileId}".`)
    }

    return {
      activeProfileId: overrideProfileId,
      source: 'override',
      selectionLocked: true,
    }
  }

  if (runtimeProfileId && profilesConfig.profiles[runtimeProfileId]) {
    return {
      activeProfileId: runtimeProfileId,
      source: 'runtime',
      selectionLocked: false,
    }
  }

  return {
    activeProfileId: defaultProfileId,
    source: 'default',
    selectionLocked: false,
  }
}

export function listSpeechProfileSummaries(profilesConfig) {
  return Object.entries(profilesConfig.profiles).map(([id, profile]) => ({
    id,
    label: profile.label,
    provider: profile.provider,
    modelId: profile.modelId,
    modelUrl: profile.modelUrl,
    device: profile.device,
    dtype: profile.dtype,
    precision: profile.precision,
    silenceDurationMs: profile.silenceDurationMs,
    minimumSpeechMs: profile.minimumSpeechMs,
    speechThreshold: profile.speechThreshold,
    autoStart: profile.autoStart,
  }))
}

export function normalizeSpeechProfilesConfig(rawConfig = {}) {
  const normalizedProfiles = Object.fromEntries(
    Object.entries(rawConfig.profiles ?? {}).map(([id, profile]) => [id, normalizeSpeechProfile(id, profile)]),
  )

  return {
    defaultProfile: typeof rawConfig.defaultProfile === 'string' ? rawConfig.defaultProfile.trim() : '',
    profiles: normalizedProfiles,
  }
}

export function normalizeSpeechRuntimeConfig(rawConfig = {}) {
  return {
    activeProfile: typeof rawConfig.activeProfile === 'string' ? rawConfig.activeProfile.trim() : '',
  }
}

function normalizeSpeechProfile(id, rawProfile = {}) {
  return {
    label: typeof rawProfile.label === 'string' && rawProfile.label.trim() ? rawProfile.label.trim() : id,
    provider: typeof rawProfile.provider === 'string' && rawProfile.provider.trim()
      ? rawProfile.provider.trim()
      : 'moonshine-browser',
    libraryUrl: typeof rawProfile.libraryUrl === 'string' && rawProfile.libraryUrl.trim()
      ? rawProfile.libraryUrl.trim()
      : '/vendor/moonshine/moonshine.min.js',
    modelId: typeof rawProfile.modelId === 'string' && rawProfile.modelId.trim()
      ? rawProfile.modelId.trim()
      : '',
    modelUrl: typeof rawProfile.modelUrl === 'string' && rawProfile.modelUrl.trim()
      ? rawProfile.modelUrl.trim()
      : 'model/tiny',
    device: typeof rawProfile.device === 'string' && rawProfile.device.trim()
      ? rawProfile.device.trim()
      : '',
    dtype: typeof rawProfile.dtype === 'string' && rawProfile.dtype.trim()
      ? rawProfile.dtype.trim()
      : '',
    fallbackDevice: typeof rawProfile.fallbackDevice === 'string' && rawProfile.fallbackDevice.trim()
      ? rawProfile.fallbackDevice.trim()
      : '',
    fallbackDtype: typeof rawProfile.fallbackDtype === 'string' && rawProfile.fallbackDtype.trim()
      ? rawProfile.fallbackDtype.trim()
      : '',
    language: typeof rawProfile.language === 'string' && rawProfile.language.trim()
      ? rawProfile.language.trim()
      : '',
    task: typeof rawProfile.task === 'string' && rawProfile.task.trim()
      ? rawProfile.task.trim()
      : '',
    chunkLengthSeconds: Number.isFinite(rawProfile.chunkLengthSeconds)
      ? rawProfile.chunkLengthSeconds
      : 0,
    strideLengthSeconds: Number.isFinite(rawProfile.strideLengthSeconds)
      ? rawProfile.strideLengthSeconds
      : 0,
    maxBufferSeconds: Number.isFinite(rawProfile.maxBufferSeconds)
      ? rawProfile.maxBufferSeconds
      : 20,
    silenceDurationMs: Number.isFinite(rawProfile.silenceDurationMs)
      ? rawProfile.silenceDurationMs
      : 500,
    minimumSpeechMs: Number.isFinite(rawProfile.minimumSpeechMs)
      ? rawProfile.minimumSpeechMs
      : 300,
    speechThreshold: Number.isFinite(rawProfile.speechThreshold)
      ? rawProfile.speechThreshold
      : 0.015,
    precision: typeof rawProfile.precision === 'string' && rawProfile.precision.trim()
      ? rawProfile.precision.trim()
      : 'quantized',
    useVad: rawProfile.useVad ?? false,
    autoStart: rawProfile.autoStart ?? true,
    moonshineAssetBaseUrl:
      typeof rawProfile.moonshineAssetBaseUrl === 'string' && rawProfile.moonshineAssetBaseUrl.trim()
        ? rawProfile.moonshineAssetBaseUrl.trim()
        : '/vendor/moonshine/',
    onnxRuntimeBaseUrl:
      typeof rawProfile.onnxRuntimeBaseUrl === 'string' && rawProfile.onnxRuntimeBaseUrl.trim()
        ? rawProfile.onnxRuntimeBaseUrl.trim()
        : '/vendor/onnxruntime/',
    vadAssetBaseUrl:
      typeof rawProfile.vadAssetBaseUrl === 'string' && rawProfile.vadAssetBaseUrl.trim()
        ? rawProfile.vadAssetBaseUrl.trim()
        : '/vendor/vad/',
  }
}
