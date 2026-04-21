export const MAX_VISIBLE_CHAT_MESSAGES = 2

export function splitRecentChatHistory(messages, maxVisibleMessages = MAX_VISIBLE_CHAT_MESSAGES) {
  return {
    visible: messages.slice(0, maxVisibleMessages),
    overflow: messages.slice(maxVisibleMessages),
  }
}
