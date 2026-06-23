export const DEFAULT_NAV2_START_MAX_ATTEMPTS = 3
export const DEFAULT_NAV2_START_BACKOFF_MS = [3_000, 5_000, 10_000]

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export async function runDogzillaStartWithRetries({
  action,
  options = {},
  runDogzillaConnectionActionImpl,
  sleepImpl = defaultSleep,
  logger = console,
  maxAttempts = DEFAULT_NAV2_START_MAX_ATTEMPTS,
  backoffMs = DEFAULT_NAV2_START_BACKOFF_MS,
}) {
  const sleep = typeof sleepImpl === 'function' ? sleepImpl : defaultSleep
  const attempts = Math.max(1, Math.floor(Number(maxAttempts) || 1))
  const backoff = Array.isArray(backoffMs) && backoffMs.length > 0
    ? backoffMs
    : DEFAULT_NAV2_START_BACKOFF_MS
  let lastResult = null

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastResult = await runDogzillaConnectionActionImpl(action, options)

    if (lastResult?.status !== 'error') {
      if (attempt > 1) {
        logger.log?.(`DOGZILLA ${action} succeeded on attempt ${attempt}.`)
      }
      return lastResult
    }

    if (attempt < attempts) {
      const delay = backoff[Math.min(attempt - 1, backoff.length - 1)] ?? backoff[backoff.length - 1] ?? 2_000
      logger.warn?.(`DOGZILLA ${action} attempt ${attempt}/${attempts} failed: ${lastResult.error || lastResult.stderr || 'unknown error'}. Retrying in ${delay}ms.`)
      await sleep(delay)
    }
  }

  logger.warn?.(`DOGZILLA ${action} failed after ${attempts} attempts: ${lastResult?.error || 'unknown error'}.`)
  return lastResult
}
