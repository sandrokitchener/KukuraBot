import { existsSync, mkdirSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const androidRoot = path.join(repoRoot, 'src-tauri', 'gen', 'android')
const sourceLib = path.join(repoRoot, 'src-tauri', 'target', 'aarch64-linux-android', 'release', 'libapp_lib.so')
const jniDir = path.join(androidRoot, 'app', 'src', 'main', 'jniLibs', 'arm64-v8a')
const jniLib = path.join(jniDir, 'libapp_lib.so')
const apkPath = path.join(androidRoot, 'app', 'build', 'outputs', 'apk', 'arm64', 'debug', 'app-arm64-debug.apk')
const isWindows = process.platform === 'win32'

const tauriResult = run('bun', ['run', 'tauri', 'android', 'build', '--apk', '--target', 'aarch64'], {
  allowFailure: true,
  capture: true,
})

if (tauriResult.status === 0) {
  writeCapturedOutput(tauriResult)
  console.log('Tauri Android build finished without fallback.')
  process.exit(0)
}

if (!existsSync(sourceLib)) {
  writeCapturedOutput(tauriResult)
  console.error('Tauri build failed before creating arm64 libapp_lib.so.')
  process.exit(tauriResult.status || 1)
}

if (!/symbolic link/i.test(`${tauriResult.stdout || ''}\n${tauriResult.stderr || ''}`)) {
  writeCapturedOutput(tauriResult)
}
console.log('Tauri Android build hit Windows symlink limit; using Gradle APK fallback.')
mkdirSync(jniDir, { recursive: true })
copyFileSync(sourceLib, jniLib)

run(isWindows ? 'gradlew.bat' : './gradlew', [
  ':app:assembleArm64Debug',
  '-x',
  'rustBuildArm64Debug',
  '-x',
  'rustBuildUniversalDebug',
], {
  cwd: androidRoot,
})

console.log(`APK ready: ${apkPath}`)

function run(command, args, options = {}) {
  const spawnOptions = {
    cwd: options.cwd || repoRoot,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
  }
  const result = isWindows
    ? spawnSync([command, ...args].map(quoteWindowsArg).join(' '), {
      ...spawnOptions,
      shell: true,
    })
    : spawnSync(command, args, spawnOptions)

  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }

  if (result.status !== 0 && !options.allowFailure) {
    process.exit(result.status || 1)
  }

  return result
}

function writeCapturedOutput(result) {
  if (result.stdout) {
    process.stdout.write(result.stdout)
  }
  if (result.stderr) {
    process.stderr.write(result.stderr)
  }
}

function quoteWindowsArg(value) {
  const rawValue = String(value)
  if (!/[\s"]/u.test(rawValue)) {
    return rawValue
  }
  return `"${rawValue.replace(/"/g, '\\"')}"`
}
