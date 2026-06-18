const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const BOLD = '\x1b[1m'

export { GREEN, RESET }

export function green(text) {
  const env = process.env
  if (!process.stdout?.isTTY || 'NO_COLOR' in env || env.TERM === 'dumb') {
    return text
  }
  return `${GREEN}${text}${RESET}`
}

export function greenBright(text) {
  const env = process.env
  if (!process.stdout?.isTTY || 'NO_COLOR' in env || env.TERM === 'dumb') {
    return text
  }
  return `${BOLD}${GREEN}${text}${RESET}`
}

const QUESTING_BEAST_WORDMARK = [
  '  ░██████                                       ░██    ░██                         ░██                                            ░██',
  ' ░██   ░██                                      ░██                                ░██                                            ░██',
  '░██     ░██ ░██    ░██  ░███████   ░███████  ░████████ ░██░████████   ░████████    ░████████   ░███████   ░██████    ░███████  ░████████',
  '░██     ░██ ░██    ░██ ░██    ░██ ░██           ░██    ░██░██    ░██ ░██    ░██    ░██    ░██ ░██    ░██       ░██  ░██           ░██',
  '░██     ░██ ░██    ░██ ░█████████  ░███████     ░██    ░██░██    ░██ ░██    ░██    ░██    ░██ ░█████████  ░███████   ░███████     ░██',
  ' ░██   ░██  ░██   ░███ ░██               ░██    ░██    ░██░██    ░██ ░██   ░███    ░███   ░██ ░██        ░██   ░██         ░██    ░██',
  '  ░██████    ░█████░██  ░███████   ░███████      ░████ ░██░██    ░██  ░█████░██    ░██░█████   ░███████   ░█████░██  ░███████      ░████',
  '       ░██                                                                  ░██',
  '        ░██                                                           ░███████',
]

const DIVIDER = '═'.repeat(142)

export function buildStartupBanner({
  appName = 'Questing Beast',
  mode = '',
  url = '',
  color = false,
} = {}) {
  const accent = color ? CYAN : ''
  const title = color ? `${BOLD}${GREEN}` : ''
  const warning = color ? `${BOLD}${YELLOW}` : ''
  const meta = color ? DIM : ''
  const reset = color ? RESET : ''
  const launchDetails = [
    mode ? `mode: ${mode}` : '',
    url ? `url: ${url}` : '',
  ].filter(Boolean)

  return [
    '',
    `${accent}${DIVIDER}${reset}`,
    '',
    ...QUESTING_BEAST_WORDMARK.map((line) => `${accent}${line}${reset}`),
    '',
    `${accent}${DIVIDER}${reset}`,
    '',
    `${title}  ${appName.toUpperCase()} CONTROL STACK ONLINE${reset}`,
    `${warning}  WAKE SEQUENCE: BRIDGE · MAP · NAV · SPEECH · VISION${reset}`,
    launchDetails.length ? `${meta}  ${launchDetails.join('  //  ')}${reset}` : '',
    `${meta}  Ctrl+C to stand down. Keep this terminal open while the robot is awake.${reset}`,
    '',
  ].join('\n')
}

export function printStartupBanner({
  appName,
  mode,
  url,
  env = process.env,
  stream = process.stdout,
  logger = console,
} = {}) {
  if (!shouldPrintStartupBanner({ env, stream })) {
    return false
  }

  logger.log(buildStartupBanner({
    appName,
    mode,
    url,
    color: shouldColorizeStartupBanner({ env, stream }),
  }))
  return true
}

export function shouldPrintStartupBanner({ env = process.env, stream = process.stdout } = {}) {
  if (env.QUESTING_BEAST_BANNER_PRINTED === '1') {
    return false
  }

  if (isFalseLike(env.QUESTING_BEAST_BANNER)) {
    return false
  }

  if (isTrueLike(env.QUESTING_BEAST_BANNER)) {
    return true
  }

  return stream?.isTTY === true && env.CI !== 'true' && env.NODE_ENV !== 'test'
}

export function shouldColorizeStartupBanner({ env = process.env, stream = process.stdout } = {}) {
  if (isFalseLike(env.QUESTING_BEAST_BANNER_COLOR) || 'NO_COLOR' in env || env.TERM === 'dumb') {
    return false
  }

  if (isTrueLike(env.QUESTING_BEAST_BANNER_COLOR)) {
    return true
  }

  return stream?.isTTY === true
}

function isTrueLike(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase())
}

function isFalseLike(value) {
  return ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase())
}
