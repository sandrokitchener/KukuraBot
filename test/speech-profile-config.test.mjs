import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeSpeechProfilesConfig,
  resolveSpeechProfileSelection,
} from '../lib/speech-profile-config.mjs'

test('resolveSpeechProfileSelection prefers startup override over runtime config', () => {
  const profilesConfig = normalizeSpeechProfilesConfig({
    defaultProfile: 'default_profile',
    profiles: {
      default_profile: { provider: 'moonshine-browser', modelUrl: 'model/default' },
      runtime_profile: { provider: 'moonshine-browser', modelUrl: 'model/runtime' },
      override_profile: { provider: 'moonshine-browser', modelUrl: 'model/override' },
    },
  })

  const result = resolveSpeechProfileSelection({
    profilesConfig,
    runtimeConfig: { activeProfile: 'runtime_profile' },
    env: { APP_SPEECH_PROFILE: 'override_profile' },
  })

  assert.equal(result.activeProfileId, 'override_profile')
  assert.equal(result.source, 'override')
  assert.equal(result.selectionLocked, true)
})

test('resolveSpeechProfileSelection falls back to runtime config when no override', () => {
  const profilesConfig = normalizeSpeechProfilesConfig({
    defaultProfile: 'default_profile',
    profiles: {
      default_profile: { provider: 'moonshine-browser', modelUrl: 'model/default' },
      runtime_profile: { provider: 'moonshine-browser', modelUrl: 'model/runtime' },
    },
  })

  const result = resolveSpeechProfileSelection({
    profilesConfig,
    runtimeConfig: { activeProfile: 'runtime_profile' },
    env: {},
  })

  assert.equal(result.activeProfileId, 'runtime_profile')
  assert.equal(result.source, 'runtime')
  assert.equal(result.selectionLocked, false)
})

test('normalizeSpeechProfilesConfig keeps parakeet profile metadata', () => {
  const config = normalizeSpeechProfilesConfig({
    profiles: {
      parakeet: {
        provider: 'parakeet-sidecar',
        modelId: 'nvidia/parakeet-tdt-0.6b-v3',
        timestamps: true,
        device: 'auto',
      },
    },
  })

  assert.equal(config.profiles.parakeet.provider, 'parakeet-sidecar')
  assert.equal(config.profiles.parakeet.modelId, 'nvidia/parakeet-tdt-0.6b-v3')
  assert.equal(config.profiles.parakeet.timestamps, true)
  assert.equal(config.profiles.parakeet.device, 'auto')
})
