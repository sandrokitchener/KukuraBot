import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_NAV2_START_BACKOFF_MS,
  DEFAULT_NAV2_START_MAX_ATTEMPTS,
  runDogzillaStartWithRetries,
} from '../lib/dogzilla-start-retry.mjs'

function quietLogger() {
  return { log: () => {}, warn: () => {}, error: () => {} }
}

test('runDogzillaStartWithRetries returns first non-error result without sleeping', async () => {
  const sleepCalls = []
  const result = await runDogzillaStartWithRetries({
    action: 'start-map-pose',
    runDogzillaConnectionActionImpl: async (action) => ({
      status: 'ok',
      action,
    }),
    sleepImpl: async (ms) => {
      sleepCalls.push(ms)
    },
    logger: quietLogger(),
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.action, 'start-map-pose')
  assert.deepEqual(sleepCalls, [])
})

test('runDogzillaStartWithRetries retries up to maxAttempts with backoff', async () => {
  const sleepCalls = []
  let attempt = 0
  const result = await runDogzillaStartWithRetries({
    action: 'start-navigation',
    runDogzillaConnectionActionImpl: async (action) => {
      attempt += 1
      if (attempt < 3) {
        return { status: 'error', action, error: `attempt ${attempt} failed` }
      }
      return { status: 'ok', action }
    },
    sleepImpl: async (ms) => {
      sleepCalls.push(ms)
    },
    logger: quietLogger(),
  })

  assert.equal(result.status, 'ok')
  assert.equal(attempt, 3)
  assert.deepEqual(sleepCalls, DEFAULT_NAV2_START_BACKOFF_MS.slice(0, 2))
})

test('runDogzillaStartWithRetries returns last error after exhausting attempts', async () => {
  const sleepCalls = []
  const result = await runDogzillaStartWithRetries({
    action: 'start-navigation',
    runDogzillaConnectionActionImpl: async (action) => ({
      status: 'error',
      action,
      error: 'always fails',
    }),
    sleepImpl: async (ms) => {
      sleepCalls.push(ms)
    },
    logger: quietLogger(),
  })

  assert.equal(result.status, 'error')
  assert.equal(result.error, 'always fails')
  assert.equal(sleepCalls.length, DEFAULT_NAV2_START_MAX_ATTEMPTS - 1)
})

test('runDogzillaStartWithRetries accepts missing sleepImpl via default', async () => {
  const result = await runDogzillaStartWithRetries({
    action: 'start-map-pose',
    runDogzillaConnectionActionImpl: async (action) => ({
      status: 'ok',
      action,
    }),
    logger: quietLogger(),
  })

  assert.equal(result.status, 'ok')
})
