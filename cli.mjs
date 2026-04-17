import { processUserInput } from './lib/app-service.mjs'

const input = process.argv.slice(2).join(' ').trim()

if (!input) {
  console.error('Usage: node cli.mjs "check the kitchen"')
  process.exit(1)
}

try {
  const result = await processUserInput(input)
  console.log(result.response)
  if (result.parsed) {
    console.error(JSON.stringify(result.parsed))
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
