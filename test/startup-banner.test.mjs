import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GREEN,
  RESET,
  buildStartupBanner,
  green,
  greenBright,
  printStartupBanner,
  shouldColorizeStartupBanner,
  shouldPrintStartupBanner,
} from '../lib/startup-banner.mjs'

test('startup banner renders a large Questing Beast wordmark without ANSI by default', () => {
  const banner = buildStartupBanner({
    mode: 'server',
    url: 'http://0.0.0.0:3037',
  })

  assert.match(banner, /░██████/)
  assert.match(banner, /QUESTING BEAST CONTROL STACK ONLINE/)
  assert.match(banner, /WAKE SEQUENCE: BRIDGE · MAP · NAV · SPEECH · VISION/)
  assert.match(banner, /mode: server  \/\/  url: http:\/\/0\.0\.0\.0:3037/)
  assert.match(banner, /Ctrl\+C to stand down/)
  assert.doesNotMatch(banner, /\x1b\[/)
})

test('startup banner colorizes only when requested by terminal policy', () => {
  const colorized = buildStartupBanner({ color: true })

  assert.match(colorized, /\x1b\[/)
  assert.equal(shouldColorizeStartupBanner({
    env: { NO_COLOR: '1' },
    stream: { isTTY: true },
  }), false)
  assert.equal(shouldColorizeStartupBanner({
    env: { QUESTING_BEAST_BANNER_COLOR: '1' },
    stream: { isTTY: false },
  }), true)
})

test('startup banner is interactive by default and supports env overrides', () => {
  assert.equal(shouldPrintStartupBanner({
    env: {},
    stream: { isTTY: true },
  }), true)
  assert.equal(shouldPrintStartupBanner({
    env: { CI: 'true' },
    stream: { isTTY: true },
  }), false)
  assert.equal(shouldPrintStartupBanner({
    env: { NODE_ENV: 'test' },
    stream: { isTTY: true },
  }), false)
  assert.equal(shouldPrintStartupBanner({
    env: { QUESTING_BEAST_BANNER: '1' },
    stream: { isTTY: false },
  }), true)
  assert.equal(shouldPrintStartupBanner({
    env: { QUESTING_BEAST_BANNER: '0' },
    stream: { isTTY: true },
  }), false)
  assert.equal(shouldPrintStartupBanner({
    env: { QUESTING_BEAST_BANNER_PRINTED: '1', QUESTING_BEAST_BANNER: '1' },
    stream: { isTTY: true },
  }), false)
})

test('green wraps text in ANSI green when TTY', () => {
  const savedIsTTY = process.stdout.isTTY
  const savedNoColor = process.env.NO_COLOR
  const savedTerm = process.env.TERM
  try {
    process.stdout.isTTY = true
    delete process.env.NO_COLOR
    process.env.TERM = 'xterm-256color'
    assert.equal(green('hello'), `${GREEN}hello${RESET}`)
    assert.equal(greenBright('hello'), `\x1b[1m${GREEN}hello${RESET}`)
    process.stdout.isTTY = false
    assert.equal(green('hello'), 'hello')
    assert.equal(greenBright('hello'), 'hello')
  } finally {
    process.stdout.isTTY = savedIsTTY
    if (savedNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = savedNoColor
    if (savedTerm === undefined) delete process.env.TERM
    else process.env.TERM = savedTerm
  }
})

test('printStartupBanner writes once through the provided logger', () => {
  const lines = []
  const printed = printStartupBanner({
    mode: 'managed launch',
    url: 'http://127.0.0.1:3037',
    env: { QUESTING_BEAST_BANNER: '1', NO_COLOR: '1' },
    stream: { isTTY: false },
    logger: {
      log(message) {
        lines.push(message)
      },
    },
  })

  assert.equal(printed, true)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /QUESTING BEAST CONTROL STACK ONLINE/)
  assert.doesNotMatch(lines[0], /\x1b\[/)
})
