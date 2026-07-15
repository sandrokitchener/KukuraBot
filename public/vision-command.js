export function parseExplicitVisionCommand(value) {
  const input = typeof value === 'string' ? value.trim().toLowerCase() : ''
  const target = '(?:yolo(?: object detection)?|object detection|vision)'

  if (new RegExp(`\\b(?:disable|deactivate|stop)\\s+(?:the\\s+)?${target}\\b|\\b(?:turn\\s+(?:the\\s+)?)?${target}(?:\\s+mode)?\\s+off\\b`).test(input)) {
    return { command: 'vision', waypoint: 'current_position', enabled: false }
  }
  if (new RegExp(`\\b(?:enable|activate|start)\\s+(?:the\\s+)?${target}\\b|\\b(?:turn\\s+(?:the\\s+)?)?${target}(?:\\s+mode)?\\s+on\\b`).test(input)) {
    return { command: 'vision', waypoint: 'current_position', enabled: true }
  }
  return null
}
