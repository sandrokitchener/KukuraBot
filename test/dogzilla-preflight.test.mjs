import assert from 'node:assert/strict'
import test from 'node:test'

import { summarizeDogzillaPreflight } from '../lib/dogzilla-preflight.mjs'

test('summarizeDogzillaPreflight counts states and critical failures', () => {
  const summary = summarizeDogzillaPreflight([
    { status: 'ok' },
    { status: 'warn' },
    { status: 'fail', critical: true },
    { status: 'info' },
  ])

  assert.deepEqual(summary, {
    ok: 1,
    warn: 1,
    fail: 1,
    info: 1,
    total: 4,
    criticalFailures: 1,
  })
})
