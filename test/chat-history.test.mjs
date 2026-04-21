import test from 'node:test'
import assert from 'node:assert/strict'

import { MAX_VISIBLE_CHAT_MESSAGES, splitRecentChatHistory } from '../public/chat-history.js'

test('splitRecentChatHistory keeps newest two messages when history is newest-first', () => {
  const history = ['assistant-newest', 'user-second', 'assistant-third', 'user-oldest']
  const { visible, overflow } = splitRecentChatHistory(history)

  assert.equal(MAX_VISIBLE_CHAT_MESSAGES, 2)
  assert.deepEqual(visible, ['assistant-newest', 'user-second'])
  assert.deepEqual(overflow, ['assistant-third', 'user-oldest'])
})

test('splitRecentChatHistory leaves short history untouched', () => {
  const history = ['assistant-newest']
  const { visible, overflow } = splitRecentChatHistory(history)

  assert.deepEqual(visible, ['assistant-newest'])
  assert.deepEqual(overflow, [])
})
