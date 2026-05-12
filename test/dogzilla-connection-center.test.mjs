import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDogzillaActionPlan,
  normalizeDogzillaConnectionConfig,
} from '../lib/dogzilla-connection-center.mjs'

test('normalizeDogzillaConnectionConfig fills stock DOGZILLA SSH defaults', () => {
  const config = normalizeDogzillaConnectionConfig({
    ssh: {
      host: '192.168.8.88',
    },
  })

  assert.equal(config.ssh.host, '192.168.8.88')
  assert.equal(config.ssh.user, 'pi')
  assert.equal(config.ssh.port, 22)
  assert.equal(config.ssh.alias, 'dogzilla')
  assert.equal(config.bridges.direct.baseUrl, 'http://192.168.8.88:8893')
  assert.equal(config.bridges.ros2.baseUrl, 'http://192.168.8.88:8892')
})

test('buildDogzillaActionPlan allowlists start-direct background bridge script', () => {
  const config = normalizeDogzillaConnectionConfig({
    ssh: {
      host: '192.168.8.88',
      user: 'pi',
      alias: 'dogzilla',
    },
    remoteRoot: '/home/pi/robodoge',
  })
  const plan = buildDogzillaActionPlan('start-direct', config)

  assert.equal(plan.action, 'start-direct')
  assert.equal(plan.background, false)
  assert.ok(plan.args.includes('start-dogzilla-bridge-ssh.ps1') || plan.args.some((arg) => arg.endsWith('start-dogzilla-bridge-ssh.ps1')))
  assert.ok(plan.args.includes('-Background'))
  assert.ok(plan.args.includes('-Bridge'))
  assert.ok(plan.args.includes('direct'))
})
