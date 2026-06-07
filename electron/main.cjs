const { app, BrowserWindow, ipcMain, shell } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const APP_HOST = '127.0.0.1'
const APP_PORT = 3037
const APP_URL = `http://${APP_HOST}:${APP_PORT}`
const MAX_OUTPUT_LINES = 160

let mainWindow = null
let serviceProcess = null
let serviceStartedAt = null
let serviceOutput = []
let backendReady = false

app.setName('Questing Beast Desktop')

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      return
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    registerIpc()
    createWindow()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  if (serviceProcess && !serviceProcess.killed) {
    stopServiceProcess()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    title: 'Questing Beast Desktop',
    icon: path.join(__dirname, '..', 'src-tauri', 'icons', 'icon.ico'),
    backgroundColor: '#0e1412',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  mainWindow.setMenuBarVisibility(false)
  mainWindow.loadFile(path.join(__dirname, 'launcher.html'))

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

function registerIpc() {
  ipcMain.handle('launcher:get-status', async () => {
    await updateBackendReady()
    return getStatus()
  })

  ipcMain.handle('launcher:probe-backend', async () => {
    await updateBackendReady()
    return getStatus()
  })

  ipcMain.handle('launcher:start-full-services', async () => {
    await startFullServices()
    return getStatus()
  })

  ipcMain.handle('launcher:open-app', async () => {
    await updateBackendReady()
    if (mainWindow && backendReady) {
      await mainWindow.loadURL(APP_URL)
    }
    return getStatus()
  })

  ipcMain.handle('launcher:open-app-external', async () => {
    await shell.openExternal(APP_URL)
    return getStatus()
  })

  ipcMain.handle('launcher:stop-services', async () => {
    await stopServiceProcess()
    return getStatus()
  })

  ipcMain.handle('launcher:show-service-root', async () => {
    await shell.openPath(resolveServiceRoot())
    return getStatus()
  })
}

async function startFullServices() {
  if (serviceProcess && !serviceProcess.killed) {
    appendServiceOutput('Questing Beast full service launcher is already running.')
    return
  }

  const serviceRoot = resolveServiceRoot()
  const startScript = path.join(serviceRoot, 'scripts', 'start-clean.mjs')
  const childEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ROBO_DOGE_ELECTRON_LAUNCHER: '1',
  }

  serviceStartedAt = new Date().toISOString()
  backendReady = false
  appendServiceOutput(`Starting full services from ${serviceRoot}`)

  serviceProcess = spawn(process.execPath, [startScript], {
    cwd: serviceRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  serviceProcess.stdout.on('data', (chunk) => appendServiceOutput(chunk))
  serviceProcess.stderr.on('data', (chunk) => appendServiceOutput(chunk))

  serviceProcess.once('error', (error) => {
    appendServiceOutput(`Launcher failed: ${error instanceof Error ? error.message : String(error)}`)
    serviceProcess = null
    serviceStartedAt = null
    emitStatus()
  })

  serviceProcess.once('exit', (code, signal) => {
    appendServiceOutput(`Full services exited with ${signal || (code ?? 0)}.`)
    serviceProcess = null
    serviceStartedAt = null
    backendReady = false
    emitStatus()
  })

  void waitForBackendReady()
}

async function waitForBackendReady() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await delay(1000)
    if (await probeBackend()) {
      backendReady = true
      appendServiceOutput(`Backend ready at ${APP_URL}`)
      emitStatus()
      return
    }
  }

  appendServiceOutput(`Backend did not answer within 120 seconds. Service launcher may still be starting.`)
  emitStatus()
}

async function stopServiceProcess() {
  if (!serviceProcess || serviceProcess.killed) {
    return
  }

  const pid = serviceProcess.pid
  appendServiceOutput(`Stopping full services process tree ${pid}.`)

  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const stopper = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      stopper.once('exit', resolve)
      stopper.once('error', resolve)
    })
    return
  }

  serviceProcess.kill('SIGTERM')
}

async function updateBackendReady() {
  backendReady = await probeBackend()
}

async function probeBackend() {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1200)
    const response = await fetch(`${APP_URL}/healthz`, { signal: controller.signal })
    clearTimeout(timer)
    return response.ok
  } catch {
    return false
  }
}

function getStatus() {
  return {
    appUrl: APP_URL,
    backendReady,
    serviceRoot: resolveServiceRoot(),
    serviceRunning: Boolean(serviceProcess && !serviceProcess.killed),
    servicePid: serviceProcess?.pid || null,
    serviceStartedAt,
    output: serviceOutput,
  }
}

function emitStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  mainWindow.webContents.send('launcher:status', getStatus())
}

function appendServiceOutput(chunk) {
  const text = String(chunk || '').replace(/\r/g, '\n')
  const lines = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)

  if (lines.length === 0) {
    return
  }

  serviceOutput = [...serviceOutput, ...lines].slice(-MAX_OUTPUT_LINES)

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('launcher:service-output', lines)
    emitStatus()
  }
}

function resolveServiceRoot() {
  const candidates = [
    process.env.ROBO_DOGE_ROOT,
    process.cwd(),
    app.getAppPath(),
    path.join(process.resourcesPath || '', 'app'),
    path.dirname(process.execPath),
  ].filter(Boolean)

  for (const candidate of candidates) {
    const root = findServiceRoot(candidate)
    if (root) {
      return root
    }
  }

  throw new Error('Cannot find Robo-Doge service root. Set ROBO_DOGE_ROOT to this repo path.')
}

function findServiceRoot(startPath) {
  let current = path.resolve(startPath)

  if (fs.existsSync(current) && fs.statSync(current).isFile()) {
    current = path.dirname(current)
  }

  while (current && current !== path.dirname(current)) {
    if (isServiceRoot(current)) {
      return current
    }
    current = path.dirname(current)
  }

  return null
}

function isServiceRoot(candidate) {
  return [
    'package.json',
    path.join('scripts', 'start-clean.mjs'),
    'run.mjs',
    'server.mjs',
  ].every((relativePath) => fs.existsSync(path.join(candidate, relativePath)))
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
