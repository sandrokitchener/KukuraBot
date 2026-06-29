const SOCKET_ERROR_CODES = new Map([
  ['UND_ERR_SOCKET', 'bridge socket closed during command; check Nav2/scan readiness. The bridge or ROS may have gone down while waiting for a response.'],
])

export function formatFetchError(error) {
  if (!(error instanceof Error)) {
    return String(error)
  }

  const code = error.cause?.code || error.code
  const mapped = typeof code === 'string' ? SOCKET_ERROR_CODES.get(code) : ''
  if (mapped) {
    return error.message ? `${error.message} (${mapped})` : mapped
  }

  const causeMessage = formatFetchErrorCause(error.cause)
  if (!causeMessage) {
    return error.message || error.name
  }

  if (error.message.includes(causeMessage)) {
    return error.message
  }

  return `${error.message} (${causeMessage})`
}

function formatFetchErrorCause(cause) {
  if (!cause || typeof cause !== 'object') {
    return ''
  }

  const code = typeof cause.code === 'string' ? cause.code : ''
  const address = typeof cause.address === 'string' ? cause.address : ''
  const port = Number.isFinite(cause.port) ? String(cause.port) : ''

  if (code && address && port) {
    return `${code} ${address}:${port}`
  }

  if (code && address) {
    return `${code} ${address}`
  }

  if (code) {
    return code
  }

  return cause instanceof Error ? cause.message : ''
}
