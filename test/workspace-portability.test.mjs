import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const PROJECT_ROOT = process.cwd()
const SOURCE_PATHS = [
  'README.md',
  'cli.mjs',
  'run.mjs',
  'server.mjs',
  'package.json',
  'config',
  'lib',
  'public',
  'test',
]

test('source files do not hardcode current absolute workspace path', async () => {
  const files = await collectFiles(SOURCE_PATHS)

  for (const filePath of files) {
    const contents = await readFile(filePath, 'utf-8')
    assert.equal(
      contents.includes(PROJECT_ROOT),
      false,
      `Found hardcoded workspace path in ${path.relative(PROJECT_ROOT, filePath)}`,
    )
  }
})

async function collectFiles(relativePaths) {
  const files = []

  for (const relativePath of relativePaths) {
    const absolutePath = path.join(PROJECT_ROOT, relativePath)
    const stats = await readdirOrNull(absolutePath)

    if (!stats) {
      files.push(absolutePath)
      continue
    }

    for (const entry of stats) {
      const childPath = path.join(absolutePath, entry.name)

      if (entry.isDirectory()) {
        files.push(...await collectFiles([path.relative(PROJECT_ROOT, childPath)]))
        continue
      }

      if (entry.isFile()) {
        files.push(childPath)
      }
    }
  }

  return files
}

async function readdirOrNull(targetPath) {
  try {
    return await readdir(targetPath, { withFileTypes: true })
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOTDIR') {
      return null
    }

    throw error
  }
}
