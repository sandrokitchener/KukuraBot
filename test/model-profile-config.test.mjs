import test from 'node:test'
import assert from 'node:assert/strict'

import {
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
