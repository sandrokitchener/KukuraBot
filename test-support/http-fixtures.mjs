export async function withMockedFetch(fetchImpl, callback) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchImpl

  try {
    return await callback()
  } finally {
    globalThis.fetch = originalFetch
  }
}

export function jsonResponse(body, { ok = true, status = ok ? 200 : 500 } = {}) {
  return {
    ok,
    status,
    async json() {
      return body
    },
  }
}

export function parseRequestBody(options = {}) {
  return options.body ? JSON.parse(options.body) : null
}
