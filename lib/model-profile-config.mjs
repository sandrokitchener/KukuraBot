import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const CONFIG_DIR = path.join(ROOT_DIR, 'config')
const MODEL_PROFILES_FILE = path.join(CONFIG_DIR, 'model-profiles.json')
const RUNTIME_FILE = path.join(CONFIG_DIR, 'runtime.json')

export async function loadModelProfilesConfig() {
  return normalizeModelProfilesConfig(JSON.parse(await readFile(MODEL_PROFILES_FILE, 'utf-8')))
}

export async function loadRuntimeConfig() {
  try {
    return normalizeRuntimeConfig(JSON.parse(await readFile(RUNTIME_FILE, 'utf-8')))
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return normalizeRuntimeConfig({})
    }

    throw error
  }
}

export async function saveRuntimeConfig(runtimeConfig) {
  const normalized = normalizeRuntimeConfig(runtimeConfig)
  await writeFile(RUNTIME_FILE, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8')
  return normalized
}

export async function resolveActiveModelProfile(env = process.env) {
  const [profilesConfig, runtimeConfig] = await Promise.all([
    loadModelProfilesConfig(),
    loadRuntimeConfig(),
  ])
  const selection = resolveProfileSelection({
    profilesConfig,
    runtimeConfig,
    env,
  })

  return {
    ...selection,
    activeProfile: profilesConfig.profiles[selection.activeProfileId],
    availableProfiles: listProfileSummaries(profilesConfig),
  }
}

export async function setActiveModelProfile(profileId, env = process.env) {
  const profilesConfig = await loadModelProfilesConfig()
  const runtimeConfig = await loadRuntimeConfig()
  const selection = resolveProfileSelection({
    profilesConfig,
    runtimeConfig,
    env,
  })

  if (selection.selectionLocked) {
    throw new Error('Profile selection is locked by APP_MODEL_PROFILE or --profile.')
  }

  if (!profilesConfig.profiles[profileId]) {
    throw new Error(`Unknown profile "${profileId}".`)
  }

  await saveRuntimeConfig({ activeProfile: profileId })
  return resolveActiveModelProfile(env)
}

export function resolveProfileSelection({ profilesConfig, runtimeConfig = {}, env = {} }) {
  const profileIds = Object.keys(profilesConfig.profiles)

  if (profileIds.length === 0) {
    throw new Error('No model profiles configured.')
  }

  const overrideProfileId = typeof env.APP_MODEL_PROFILE === 'string' ? env.APP_MODEL_PROFILE.trim() : ''
  const runtimeProfileId = typeof runtimeConfig.activeProfile === 'string' ? runtimeConfig.activeProfile.trim() : ''
  const defaultProfileId =
    profilesConfig.defaultProfile && profilesConfig.profiles[profilesConfig.defaultProfile]
      ? profilesConfig.defaultProfile
      : profileIds[0]

  if (overrideProfileId) {
    if (!profilesConfig.profiles[overrideProfileId]) {
      throw new Error(`Unknown APP_MODEL_PROFILE "${overrideProfileId}".`)
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

export function listProfileSummaries(profilesConfig) {
  return Object.entries(profilesConfig.profiles).map(([id, profile]) => ({
    id,
    label: profile.label,
    provider: profile.provider,
    model: profile.model,
    baseUrl: profile.baseUrl,
    modelPath: profile.modelPath,
    modelFileName: profile.modelFileName,
    modelRepo: profile.modelRepo,
    modelDownloadUrl: profile.modelDownloadUrl,
    temperature: profile.temperature,
    maxTokens: profile.maxTokens,
    contextTokens: profile.contextTokens,
    threads: profile.threads,
  }))
}

export function normalizeModelProfilesConfig(rawConfig = {}) {
  const normalizedProfiles = Object.fromEntries(
    Object.entries(rawConfig.profiles ?? {}).map(([id, profile]) => [id, normalizeModelProfile(id, profile)]),
  )

  return {
    defaultProfile: typeof rawConfig.defaultProfile === 'string' ? rawConfig.defaultProfile.trim() : '',
    profiles: normalizedProfiles,
  }
}

export function normalizeRuntimeConfig(rawConfig = {}) {
  return {
    activeProfile: typeof rawConfig.activeProfile === 'string' ? rawConfig.activeProfile.trim() : '',
  }
}

function normalizeModelProfile(id, rawProfile = {}) {
  const provider = typeof rawProfile.provider === 'string' ? rawProfile.provider.trim() : 'ollama'
  const baseUrl = typeof rawProfile.baseUrl === 'string' ? rawProfile.baseUrl.trim() : ''
  const model = typeof rawProfile.model === 'string' ? rawProfile.model.trim() : ''
  const modelPath = typeof rawProfile.modelPath === 'string' ? rawProfile.modelPath.trim() : ''
  const modelFileName = typeof rawProfile.modelFileName === 'string' ? rawProfile.modelFileName.trim() : ''
  const modelRepo = typeof rawProfile.modelRepo === 'string' ? rawProfile.modelRepo.trim() : ''
  const modelDownloadUrl = typeof rawProfile.modelDownloadUrl === 'string' ? rawProfile.modelDownloadUrl.trim() : ''

  return {
    label: typeof rawProfile.label === 'string' && rawProfile.label.trim() ? rawProfile.label.trim() : id,
    provider,
    baseUrl,
    model,
    modelPath,
    modelFileName,
    modelRepo,
    modelDownloadUrl,
    think: rawProfile.think ?? false,
    temperature: rawProfile.temperature ?? 0.15,
    maxTokens: rawProfile.maxTokens ?? 120,
    contextTokens: rawProfile.contextTokens ?? 2048,
    threads: rawProfile.threads ?? 4,
    keepAlive: rawProfile.keepAlive ?? '30m',
    apiKeyEnv: typeof rawProfile.apiKeyEnv === 'string' ? rawProfile.apiKeyEnv.trim() : '',
  }
}
