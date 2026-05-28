export function formatFetchError(error) {
  if (!(error instanceof Error)) {
    return String(error)
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
