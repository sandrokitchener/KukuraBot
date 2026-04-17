import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAppConfig } from './app-config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const CONFIG_DIR = path.join(ROOT_DIR, 'config')

export async function loadPublicConfig() {
  const [appConfig, modelConfig, commandSpec, systemTemplate] = await Promise.all([
    loadAppConfig(),
    loadModelConfig(),
    loadCommandSpec(),
    loadSystemTemplate(),
  ])
  const renderedCommandSpec = renderCommandFormat(commandSpec)

  return {
    app: appConfig,
    model: modelConfig.model,
    ollamaBaseUrl: modelConfig.ollamaBaseUrl,
    systemPromptFile: relativeConfigPath('system-prompt.txt'),
    commandFormatFile: relativeConfigPath('command-response-format.json'),
    systemPromptPreview: renderTemplate(systemTemplate.trim(), {
      ASSISTANT_NAME: appConfig.assistantName,
      COMMAND_RESPONSE_FORMAT: renderedCommandSpec,
    }),
    commandFormatPreview: commandSpec,
  }
}

export async function processUserInput(input) {
  const trimmed = typeof input === 'string' ? input.trim() : ''
  if (!trimmed) {
    throw new Error('Enter a message first.')
  }

  const composed = await composeSystemPrompt()
  const modelConfig = await loadModelConfig()
  const result = await queryOllama({
    input: trimmed,
    modelConfig,
    systemPrompt: composed.systemPrompt,
  })

  return {
    input: trimmed,
    model: modelConfig.model,
    response: result,
    parsed: tryParseJson(result),
  }
}

export async function loadModelConfig() {
  return readJsonConfig('model.json')
}

export async function loadCommandSpec() {
  return readJsonConfig('command-response-format.json')
}

export async function loadSystemTemplate() {
  return readFile(path.join(CONFIG_DIR, 'system-prompt.txt'), 'utf-8')
}

export async function composeSystemPrompt() {
  const [appConfig, template, commandSpec] = await Promise.all([
    loadAppConfig(),
    loadSystemTemplate(),
    loadCommandSpec(),
  ])
  const renderedSpec = renderCommandFormat(commandSpec)

  return {
    commandSpec,
    systemPrompt: renderTemplate(template, {
      ASSISTANT_NAME: appConfig.assistantName,
      COMMAND_RESPONSE_FORMAT: renderedSpec,
    }),
  }
}

export function renderCommandFormat(commandSpec) {
  const fieldLines = commandSpec.fields
    .map((field) => `  "${field.name}": ${field.type}`)
    .join('\n')

  const commandRules = Object.entries(commandSpec.allowedCommands)
    .map(([command, description]) => `- "${command}" -> ${description}`)
    .join('\n')

  return `{
${fieldLines}
}

Rules:
${commandRules}
- Normalize waypoint names to ${commandSpec.waypointNormalization}
- If no clear location is given, default waypoint to "${commandSpec.defaultWaypoint}"`
}

export async function queryOllama({ input, modelConfig, systemPrompt }) {
  const endpoint = `${trimTrailingSlash(modelConfig.ollamaBaseUrl)}/api/chat`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: modelConfig.model,
      stream: false,
      think: modelConfig.think ?? false,
      keep_alive: modelConfig.keepAlive ?? '30m',
      options: {
        num_predict: modelConfig.numPredict ?? 120,
        temperature: modelConfig.temperature ?? 0.15,
      },
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: input,
        },
      ],
    }),
  })

  if (!response.ok) {
    const detail = await safeReadText(response)
    throw new Error(`Ollama request failed (${response.status}): ${detail || response.statusText}`)
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

  throw new Error('Ollama returned an empty response.')
}

export function tryParseJson(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function relativeConfigPath(fileName) {
  return `config/${fileName}`
}

export function renderTemplate(template, variables) {
  return Object.entries(variables).reduce((currentValue, [key, replacement]) => {
    return currentValue.replaceAll(`{{${key}}}`, replacement)
  }, template)
}

async function readJsonConfig(fileName) {
  const file = await readFile(path.join(CONFIG_DIR, fileName), 'utf-8')
  return JSON.parse(file)
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
