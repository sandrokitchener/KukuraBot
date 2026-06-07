import { spawn } from 'node:child_process'
import { cp, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

await repairMoonshineVadFileDependency()
await runElectronBuilder(process.argv.slice(2))

async function repairMoonshineVadFileDependency() {
  const source = path.join(repoRoot, 'node_modules', '@ricky0123', 'vad-web')
  const target = path.join(repoRoot, 'node_modules', '@moonshine-ai', 'vad-moonshine', 'packages', 'web')

  if (await exists(path.join(target, 'package.json'))) {
    return
  }

  if (!await exists(path.join(source, 'package.json'))) {
    throw new Error('Cannot repair Moonshine VAD dependency because top-level @ricky0123/vad-web is missing. Run npm install first.')
  }

  await mkdir(path.dirname(target), { recursive: true })
  await cp(source, target, {
    recursive: true,
    force: true,
    dereference: true,
  })
  console.log('Prepared Moonshine VAD package copy for Electron dependency packaging.')
}

async function runElectronBuilder(extraArgs) {
  const bin = path.join(repoRoot, 'node_modules', 'electron-builder', 'cli.js')
  const args = extraArgs.length > 0 ? extraArgs : ['--win', 'portable']
  const child = spawn(process.execPath, [bin, ...args], {
    cwd: repoRoot,
    stdio: 'inherit',
    windowsHide: true,
  })

  const code = await new Promise((resolve) => {
    child.once('exit', (exitCode) => resolve(exitCode ?? 0))
    child.once('error', (error) => {
      console.error(error)
      resolve(1)
    })
  })

  if (code !== 0) {
    process.exit(code)
  }
}

async function exists(targetPath) {
  try {
    await stat(targetPath)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}
