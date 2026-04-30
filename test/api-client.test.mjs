import assert from 'node:assert/strict'
import test from 'node:test'
import { getApiBaseUrl, setApiBaseUrl, toApiUrl } from '../public/api-client.js'

test('toApiUrl keeps same-origin paths when no backend override is set', () => {
  installMockWindow()

  assert.equal(getApiBaseUrl(), '')
  assert.equal(toApiUrl('/api/config'), '/api/config')
})

test('toApiUrl prefixes API paths with configured backend URL', () => {
  installMockWindow()

  const normalized = setApiBaseUrl('http://192.168.1.50:3037/')

  assert.equal(normalized, 'http://192.168.1.50:3037')
  assert.equal(toApiUrl('/api/config'), 'http://192.168.1.50:3037/api/config')
})

test('query apiBase overrides stored backend URL', () => {
  installMockWindow('?apiBase=http://10.0.0.2:3037')
  setApiBaseUrl('http://192.168.1.50:3037')

  assert.equal(getApiBaseUrl(), 'http://10.0.0.2:3037')
})

function installMockWindow(search = '') {
  const store = new Map()

  global.window = {
    location: { search },
    localStorage: {
      getItem(key) {
        return store.get(key) || null
      },
      removeItem(key) {
        store.delete(key)
      },
      setItem(key, value) {
        store.set(key, value)
      },
    },
  }
}
