import test from 'node:test'
import assert from 'node:assert/strict'

import {
  listProfileSummaries,
  normalizeModelProfilesConfig,
  resolveProfileSelection,
} from '../lib/model-profile-config.mjs'

test('resolveProfileSelection prefers startup override over runtime config', () => {
  const profilesConfig = normalizeModelProfilesConfig({
    defaultProfile: 'default_profile',
    profiles: {
      default_profile: { provider: 'ollama', baseUrl: 'http://a', model: 'one' },
      runtime_profile: { provider: 'ollama', baseUrl: 'http://b', model: 'two' },
      override_profile: { provider: 'ollama', baseUrl: 'http://c', model: 'three' },
    },
  })

  const result = resolveProfileSelection({
    profilesConfig,
    runtimeConfig: { activeProfile: 'runtime_profile' },
    env: { APP_MODEL_PROFILE: 'override_profile' },
  })

  assert.equal(result.activeProfileId, 'override_profile')
  assert.equal(result.source, 'override')
  assert.equal(result.selectionLocked, true)
})

test('resolveProfileSelection falls back to runtime config when no override', () => {
  const profilesConfig = normalizeModelProfilesConfig({
    defaultProfile: 'default_profile',
    profiles: {
      default_profile: { provider: 'ollama', baseUrl: 'http://a', model: 'one' },
      runtime_profile: { provider: 'ollama', baseUrl: 'http://b', model: 'two' },
    },
  })

  const result = resolveProfileSelection({
    profilesConfig,
    runtimeConfig: { activeProfile: 'runtime_profile' },
    env: {},
  })

  assert.equal(result.activeProfileId, 'runtime_profile')
  assert.equal(result.source, 'runtime')
  assert.equal(result.selectionLocked, false)
})

test('normalizeModelProfilesConfig preserves local llama.cpp metadata', () => {
  const profilesConfig = normalizeModelProfilesConfig({
    defaultProfile: 'android_llama_cpp',
    profiles: {
      android_llama_cpp: {
        label: 'Android llama.cpp',
        provider: 'llama-cpp-http',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'NVIDIA-Nemotron3-Nano-4B-Q4_K_M',
        modelPath: '/storage/emulated/0/Android/data/com.robodoge.console/files/models/NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf',
        modelFileName: 'NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf',
        modelRepo: 'nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF',
        modelDownloadUrl: 'https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF/resolve/main/NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf',
        temperature: 0.1,
        maxTokens: 96,
        contextTokens: 2048,
        threads: 4,
      },
    },
  })
  const profile = profilesConfig.profiles.android_llama_cpp
  const [summary] = listProfileSummaries(profilesConfig)

  assert.equal(profile.provider, 'llama-cpp-http')
  assert.equal(profile.modelPath, '/storage/emulated/0/Android/data/com.robodoge.console/files/models/NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf')
  assert.equal(profile.modelFileName, 'NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf')
  assert.equal(summary.modelRepo, 'nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF')
  assert.equal(summary.contextTokens, 2048)
  assert.equal(summary.threads, 4)
})
