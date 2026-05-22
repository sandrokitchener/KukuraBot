export async function queryModel({ input, profile, systemPrompt, env = process.env }) {
  switch (profile.provider) {
    case 'ollama':
      return queryOllama({ input, profile, systemPrompt })
    case 'llama-cpp-http':
    case 'openai-compatible':
      return queryOpenAiCompatible({ input, profile, systemPrompt, env })
    default:
      throw new Error(`Unsupported model provider "${profile.provider}".`)
  }
}

export async function warmModel({ profile, signal } = {}) {
  if (!profile || profile.provider !== 'ollama') {
    return { warmed: false, reason: 'unsupported-provider' }
  }

  const endpoint = `${trimTrailingSlash(profile.baseUrl)}/api/generate`
  const response = await fetch(endpoint, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: profile.model,
      prompt: 'ok',
      stream: false,
      keep_alive: profile.keepAlive ?? '30m',
      options: {
        num_predict: 1,
        temperature: 0,
      },
    }),
  })

  if (!response.ok) {
    const detail = await safeReadText(response)
    throw new Error(`Model warm-up failed (${response.status}): ${detail || response.statusText}`)
  }

  return { warmed: true }
}

async function queryOllama({ input, profile, systemPrompt }) {
  const endpoint = `${trimTrailingSlash(profile.baseUrl)}/api/chat`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: profile.model,
      stream: false,
      think: profile.think ?? false,
      keep_alive: profile.keepAlive ?? '30m',
      options: {
        num_predict: profile.maxTokens ?? 120,
        temperature: profile.temperature ?? 0.15,
      },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: input },
      ],
    }),
  })

  if (!response.ok) {
    const detail = await safeReadText(response)
    throw new Error(`Model request failed (${response.status}): ${detail || response.statusText}`)
  }

  const payload = await response.json()
  const content = payload?.message?.content

  if (typeof content === 'string' && content.trim()) {
    return content.trim()
  }

  const fallback = extractFallbackMessage(payload)
  if (fallback) {
    return fallback
  }

  throw new Error('Model returned an empty response.')
}

async function queryOpenAiCompatible({ input, profile, systemPrompt, env }) {
  const endpoint = `${trimTrailingSlash(profile.baseUrl)}/chat/completions`
  const headers = {
    'content-type': 'application/json',
  }
  const apiKey = profile.apiKeyEnv ? env[profile.apiKeyEnv] : ''

  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: profile.model,
      temperature: profile.temperature ?? 0.15,
      max_tokens: profile.maxTokens ?? 120,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: input },
      ],
    }),
  })

  if (!response.ok) {
    const detail = await safeReadText(response)
    throw new Error(`Model request failed (${response.status}): ${detail || response.statusText}`)
  }

  const payload = await response.json()
  const content = normalizeOpenAiCompatibleContent(payload?.choices?.[0]?.message?.content)

  if (content) {
    return content
  }

  throw new Error('Model returned an empty response.')
}

function normalizeOpenAiCompatibleContent(content) {
  if (typeof content === 'string' && content.trim()) {
    return content.trim()
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === 'string') {
          return part
        }

        if (part && typeof part === 'object' && typeof part.text === 'string') {
          return part.text
        }

        return ''
      })
      .join('')
      .trim()

    return text || null
  }

  return null
}

async function safeReadText(response) {
  try {
    return (await response.text()).trim()
  } catch {
    return ''
  }
}

function extractFallbackMessage(payload) {
  const thinking = payload?.message?.thinking
  if (typeof thinking !== 'string') {
    return null
  }

  const suggestedOutput = thinking
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .find((line) => /^Let's output something like /i.test(line))

  if (suggestedOutput) {
    const rawCandidate = suggestedOutput.replace(/^Let's output something like /i, '').trim()
    const unwrappedCandidate = unwrapQuotedValue(rawCandidate)

    if (unwrappedCandidate) {
      return unwrappedCandidate
    }
  }

  const finalSentence = thinking
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .findLast((line) => /^[A-Z][^{}[\]]+[.!?]?$/.test(line) && line.split(/\s+/).length <= 10)

  return finalSentence ?? null
}

function trimTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function unwrapQuotedValue(value) {
  if (!value) {
    return null
  }

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\'", "'").trim()
  }

  return value.trim()
}
