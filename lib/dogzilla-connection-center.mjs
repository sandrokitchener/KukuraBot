import { execFile, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DOGZILLA_CAMERA_SNAPSHOT_PROXY_PATH,
  DOGZILLA_CAMERA_STATUS_PATH,
  DOGZILLA_CAMERA_STREAM_PROXY_PATH,
} from './dogzilla-camera-paths.mjs'
import { formatFetchError } from './http-error.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const CONFIG_PATH = path.join(ROOT_DIR, 'config', 'dogzilla-connection.json')
const ROBOT_RUNTIME_CONFIG_PATH = path.join(ROOT_DIR, 'config', 'robot-runtime.json')
const SSH_CONFIG_PATH = path.join(ROOT_DIR, 'output', 'pi-ssh', 'config')
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_ROBOT_NAME = 'Questing Beast'
const ROBOT_ID_FILE = 'robot_id.txt'
const ROBOT_NAME_FILE = 'robot_name.txt'
const SCRIPT_ACTIONS = new Set([
  'check-ssh',
  'sync-bridges',
  'start-direct',
  'start-ros2',
  'start-yolo',
  'start-audio',
  'start-lidar',
  'start-map-pose',
  'stop-vendor-app',
  'stop-bridges',
])

export async function getDogzillaConnectionCenter(options = {}) {
  const config = await loadDogzillaConnectionConfig(options)
  const localIdentity = await readRobotRuntimeIdentity()
  const identity = options.identity && typeof options.identity === 'object'
    ? { ...localIdentity, ...options.identity }
    : localIdentity
  const sshConfigExists = await pathExists(SSH_CONFIG_PATH)
  return {
    config: {
      ...config,
      robot_id: identity.robot_id,
      robot_name: identity.robot_name,
      identityFiles: buildRobotIdentityFilePaths(config),
    },
    identity,
    robot_id: identity.robot_id,
    robot_name: identity.robot_name,
    sshConfigExists,
    scripts: {
      installKey: 'scripts/install-dogzilla-ssh-key.ps1',
      smokeTest: 'scripts/smoke-test-dogzilla.bat',
      syncBridges: 'scripts/sync-dogzilla-bridges.ps1',
      startBridge: 'scripts/start-dogzilla-bridge-ssh.ps1',
      startVision: 'scripts/start-dogzilla-yolo-vision-ssh.ps1',
      startAudio: 'scripts/start-dogzilla-audio-cue-ssh.ps1',
      startLidar: 'scripts/start-dogzilla-lidar-ssh.ps1',
      startMapPose: 'scripts/start-dogzilla-map-pose-ssh.ps1',
      stopVendorApp: 'scripts/stop-dogzilla-vendor-app-ssh.ps1',
      stopBridge: 'scripts/stop-dogzilla-bridge-ssh.ps1',
    },
    status: summarizeConnection(config, sshConfigExists),
  }
}

export async function loadDogzillaConnectionConfig({ env = process.env } = {}) {
  const rawConfig = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'))
  return normalizeDogzillaConnectionConfig(rawConfig, env)
}

export async function saveDogzillaConnectionConfig(update = {}) {
  const rawConfig = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'))
  const sshUpdate = update.ssh && typeof update.ssh === 'object' ? update.ssh : {}
  const bridgeUpdate = update.bridges && typeof update.bridges === 'object' ? update.bridges : {}

  rawConfig.ssh = {
    ...(rawConfig.ssh || {}),
    host: normalizeString(sshUpdate.host ?? rawConfig.ssh?.host),
    user: normalizeString(sshUpdate.user ?? rawConfig.ssh?.user) || 'pi',
    port: normalizePort(sshUpdate.port ?? rawConfig.ssh?.port, 22),
    alias: normalizeString(sshUpdate.alias ?? rawConfig.ssh?.alias) || 'dogzilla',
    keyPath: normalizeString(sshUpdate.keyPath ?? rawConfig.ssh?.keyPath) || defaultKeyPath(),
  }
  rawConfig.remoteRoot = normalizeString(update.remoteRoot ?? rawConfig.remoteRoot) || '/home/pi/robodoge'
  rawConfig.bridges = {
    direct: {
      ...(rawConfig.bridges?.direct || {}),
      ...(bridgeUpdate.direct && typeof bridgeUpdate.direct === 'object' ? bridgeUpdate.direct : {}),
    },
    ros2: {
      ...(rawConfig.bridges?.ros2 || {}),
      ...(bridgeUpdate.ros2 && typeof bridgeUpdate.ros2 === 'object' ? bridgeUpdate.ros2 : {}),
    },
  }

  await writeFile(CONFIG_PATH, `${JSON.stringify(rawConfig, null, 2)}\n`, 'utf-8')
  return loadDogzillaConnectionConfig()
}

export async function runDogzillaConnectionAction(action, options = {}) {
  const normalizedAction = normalizeString(action)
  const config = await loadDogzillaConnectionConfig()

  if (normalizedAction === 'probe-bridges') {
    return probeConfiguredBridges(config)
  }

  if (normalizedAction === 'probe-support') {
    return probeConfiguredSupportServices(config)
  }

  if (!SCRIPT_ACTIONS.has(normalizedAction)) {
    return {
      status: 'error',
      error: `Unknown DOGZILLA action "${normalizedAction}".`,
    }
  }

  const plan = buildDogzillaActionPlan(normalizedAction, config, options)

  if (!config.ssh.host) {
    return {
      status: 'error',
      action: normalizedAction,
      error: 'Set DOGZILLA IP first.',
      plan,
    }
  }

  const identity = await ensureDogzillaRobotIdentity({
    config,
    robotName: options.robotName,
  })

  if (identity.status === 'error') {
    return {
      status: 'error',
      action: normalizedAction,
      error: identity.error || 'Could not read or create robot identity.',
      identity,
      plan,
    }
  }

  if (plan.background) {
    const child = spawn(plan.command, plan.args, {
      cwd: ROOT_DIR,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return {
      status: 'started',
      action: normalizedAction,
      pid: child.pid,
      identity,
      plan: redactPlan(plan),
    }
  }

  const result = await execFilePromise(plan.command, plan.args, {
    cwd: ROOT_DIR,
    timeout: plan.timeoutMs || DEFAULT_TIMEOUT_MS,
    windowsHide: true,
  })

  return {
    status: result.exitCode === 0 ? 'ok' : 'error',
    action: normalizedAction,
    identity,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    plan: redactPlan(plan),
  }
}

export async function ensureDogzillaRobotIdentity(options = {}) {
  const config = options.config ?? await loadDogzillaConnectionConfig()
  const localIdentity = await readRobotRuntimeIdentity()

  if (!config.ssh.host) {
    return {
      status: 'skipped',
      reason: 'DOGZILLA host is not configured.',
      ...localIdentity,
      files: buildRobotIdentityFilePaths(config),
      source: 'runtime',
    }
  }

  const robotId = normalizeString(options.generatedRobotId) || randomUUID()
  const robotName = normalizeRobotName(options.robotName) || localIdentity.robot_name || DEFAULT_ROBOT_NAME
  const command = buildEnsureRobotIdentityCommand(config, {
    robotId,
    robotName,
  })
  const plan = buildDogzillaSshCommandPlan(config, command, options.timeoutMs || DEFAULT_TIMEOUT_MS)
  const execImpl = options.execFilePromiseImpl || execFilePromise
  const result = await execImpl(plan.command, plan.args, {
    cwd: ROOT_DIR,
    timeout: plan.timeoutMs,
    windowsHide: true,
  })

  if (result.exitCode !== 0) {
    return {
      status: 'error',
      error: result.stderr || result.stdout || 'Robot identity SSH command failed.',
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      files: buildRobotIdentityFilePaths(config),
      source: 'pi',
    }
  }

  const identity = parseRobotIdentityOutput(result.stdout)
  const remoteRobotId = normalizeString(identity.robot_id)
  const remoteRobotName = normalizeRobotName(identity.robot_name) || DEFAULT_ROBOT_NAME

  if (!remoteRobotId) {
    return {
      status: 'error',
      error: 'Robot identity command did not return robot_id.',
      stdout: result.stdout,
      files: buildRobotIdentityFilePaths(config),
      source: 'pi',
    }
  }

  await (options.saveRobotRuntimeIdentityImpl || saveRobotRuntimeIdentity)({
    robotId: remoteRobotId,
    robotName: remoteRobotName,
  })

  return {
    status: 'ok',
    robotId: remoteRobotId,
    robotName: remoteRobotName,
    robot_id: remoteRobotId,
    robot_name: remoteRobotName,
    created: identity.robot_id_created === '1',
    nameCreated: identity.robot_name_created === '1',
    files: buildRobotIdentityFilePaths(config),
    source: 'pi',
  }
}

export async function saveDogzillaRobotName(robotName, options = {}) {
  const nextName = normalizeRobotName(robotName)

  if (!nextName) {
    throw new Error('Robot name cannot be empty.')
  }

  const config = options.config ?? await loadDogzillaConnectionConfig()
  const localIdentity = await readRobotRuntimeIdentity()

  if (!config.ssh.host) {
    await (options.saveRobotRuntimeIdentityImpl || saveRobotRuntimeIdentity)({
      robotId: localIdentity.robot_id,
      robotName: nextName,
    })
    return {
      status: 'local-only',
      reason: 'DOGZILLA host is not configured.',
      robotId: localIdentity.robot_id,
      robotName: nextName,
      robot_id: localIdentity.robot_id,
      robot_name: nextName,
      files: buildRobotIdentityFilePaths(config),
      source: 'runtime',
    }
  }

  const command = buildSaveRobotNameCommand(config, {
    robotId: normalizeString(options.generatedRobotId) || randomUUID(),
    robotName: nextName,
  })
  const plan = buildDogzillaSshCommandPlan(config, command, options.timeoutMs || DEFAULT_TIMEOUT_MS)
  const execImpl = options.execFilePromiseImpl || execFilePromise
  const result = await execImpl(plan.command, plan.args, {
    cwd: ROOT_DIR,
    timeout: plan.timeoutMs,
    windowsHide: true,
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'Could not update robot name on DOGZILLA.')
  }

  const identity = parseRobotIdentityOutput(result.stdout)
  const remoteRobotId = normalizeString(identity.robot_id) || localIdentity.robot_id
  const remoteRobotName = normalizeRobotName(identity.robot_name) || nextName

  await (options.saveRobotRuntimeIdentityImpl || saveRobotRuntimeIdentity)({
    robotId: remoteRobotId,
    robotName: remoteRobotName,
  })

  return {
    status: 'ok',
    robotId: remoteRobotId,
    robotName: remoteRobotName,
    robot_id: remoteRobotId,
    robot_name: remoteRobotName,
    files: buildRobotIdentityFilePaths(config),
    source: 'pi',
  }
}

export function normalizeDogzillaConnectionConfig(rawConfig = {}, env = process.env) {
  const rawSsh = rawConfig.ssh && typeof rawConfig.ssh === 'object' ? rawConfig.ssh : {}
  const rawBridges = rawConfig.bridges && typeof rawConfig.bridges === 'object' ? rawConfig.bridges : {}
  const rawCamera = rawConfig.camera && typeof rawConfig.camera === 'object' ? rawConfig.camera : {}
  const rawVision = rawConfig.vision && typeof rawConfig.vision === 'object' ? rawConfig.vision : {}
  const rawAudio = rawConfig.audio && typeof rawConfig.audio === 'object' ? rawConfig.audio : {}
  const rawLidar = rawConfig.lidar && typeof rawConfig.lidar === 'object' ? rawConfig.lidar : {}
  const envHost = normalizeString(env.DOGZILLA_HOST)
  const host = envHost || normalizeString(rawSsh.host)
  const direct = normalizeBridge(rawBridges.direct, 'Direct DOGZILLALib', host, 8893)
  const ros2 = normalizeBridge(rawBridges.ros2, 'ROS2 Sidecar', host, 8892)
  const sourceCamera = normalizeCamera(rawCamera, host)
  const vision = normalizeVision(rawVision, host, sourceCamera)
  const camera = vision.enabled ? normalizeVisionCamera(vision, sourceCamera) : sourceCamera
  const audio = normalizeAudio(rawAudio, host)
  const lidar = normalizeLidar(rawLidar, host)

  return {
    ssh: {
      host,
      user: normalizeString(env.DOGZILLA_USER) || normalizeString(rawSsh.user) || 'pi',
      port: normalizePort(env.DOGZILLA_SSH_PORT || rawSsh.port, 22),
      alias: normalizeString(rawSsh.alias) || 'dogzilla',
      keyPath: normalizeString(rawSsh.keyPath) || defaultKeyPath(),
      source: envHost ? 'override' : 'config',
      selectionLocked: !!envHost,
    },
    remoteRoot: normalizeString(rawConfig.remoteRoot) || '/home/pi/robodoge',
    bridges: {
      direct,
      ros2,
    },
    camera,
    vision,
    audio,
    lidar,
    notes: Array.isArray(rawConfig.notes) ? rawConfig.notes : [],
  }
}

export function buildDogzillaActionPlan(action, config, options = {}) {
  const scriptArgs = buildBaseScriptArgs(config)
  const sshPortScriptArgs = buildBaseScriptArgs(config, { portParam: '-SshPort' })
  const powershellArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']

  switch (action) {
    case 'check-ssh':
      return {
        action,
        command: resolvePowerShellCommand(),
        args: [
          ...powershellArgs,
          path.join(ROOT_DIR, 'scripts', 'dogzilla-ssh.ps1'),
          ...scriptArgs,
          '-Command',
          'echo ssh-ok && hostname',
        ],
        timeoutMs: 15_000,
        background: false,
      }
    case 'sync-bridges':
      return {
        action,
        command: resolvePowerShellCommand(),
        args: [
          ...powershellArgs,
          path.join(ROOT_DIR, 'scripts', 'sync-dogzilla-bridges.ps1'),
          ...scriptArgs,
          '-RemoteRoot',
          config.remoteRoot,
        ],
        timeoutMs: 90_000,
        background: false,
      }
    case 'start-direct':
    case 'start-ros2': {
      const bridge = action === 'start-direct' ? 'direct' : 'ros2'
      const bridgeConfig = config.bridges[bridge]
      const args = [
        ...powershellArgs,
        path.join(ROOT_DIR, 'scripts', 'start-dogzilla-bridge-ssh.ps1'),
        ...sshPortScriptArgs,
        '-Bridge',
        bridge,
        '-RemoteRoot',
        config.remoteRoot,
        '-BridgePort',
        String(bridgeConfig.port),
        '-Background',
      ]

      if (options.live === true && bridge === 'direct') {
        args.push('-Live')
      }

      return {
        action,
        command: resolvePowerShellCommand(),
        args,
        timeoutMs: 30_000,
        background: false,
      }
    }
    case 'start-audio':
    case 'start-yolo':
      return buildSupportServiceActionPlan(action, config, sshPortScriptArgs, powershellArgs)
    case 'start-lidar':
      return {
        action,
        command: resolvePowerShellCommand(),
        args: [
          ...powershellArgs,
          path.join(ROOT_DIR, 'scripts', 'start-dogzilla-lidar-ssh.ps1'),
          ...sshPortScriptArgs,
          '-RemoteRoot',
          config.remoteRoot,
          '-Port',
          String(config.lidar.port),
          '-SerialPort',
          config.lidar.serialPort,
          '-Background',
        ],
        timeoutMs: 45_000,
        background: false,
      }
    case 'start-map-pose':
      return {
        action,
        command: resolvePowerShellCommand(),
        args: [
          ...powershellArgs,
          path.join(ROOT_DIR, 'scripts', 'start-dogzilla-map-pose-ssh.ps1'),
          ...sshPortScriptArgs,
          '-RemoteRoot',
          config.remoteRoot,
          '-PosePort',
          String(config.lidar.port),
        ],
        timeoutMs: 180_000,
        background: false,
      }
    case 'stop-vendor-app':
      return {
        action,
        command: resolvePowerShellCommand(),
        args: [
          ...powershellArgs,
          path.join(ROOT_DIR, 'scripts', 'stop-dogzilla-vendor-app-ssh.ps1'),
          ...sshPortScriptArgs,
          '-RemoteRoot',
          config.remoteRoot,
        ],
        timeoutMs: 20_000,
        background: false,
      }
    case 'stop-bridges':
      return {
        action,
        command: resolvePowerShellCommand(),
        args: [
          ...powershellArgs,
          path.join(ROOT_DIR, 'scripts', 'stop-dogzilla-bridge-ssh.ps1'),
          ...scriptArgs,
          '-RemoteRoot',
          config.remoteRoot,
        ],
        timeoutMs: 20_000,
        background: false,
      }
    default:
      throw new Error(`Unknown DOGZILLA action "${action}".`)
  }
}

function buildSupportServiceActionPlan(action, config, sshPortScriptArgs, powershellArgs) {
  if (action === 'start-yolo') {
    const args = [
      ...powershellArgs,
      path.join(ROOT_DIR, 'scripts', 'start-dogzilla-yolo-vision-ssh.ps1'),
      ...sshPortScriptArgs,
      '-RemoteRoot',
      config.remoteRoot,
      '-Port',
      String(config.vision.port),
      '-CameraUrl',
      config.vision.sourceStreamUrl || config.camera?.streamUrl || '',
      '-Background',
    ]

    if (config.vision.modelPath) {
      args.push('-ModelPath', config.vision.modelPath)
    }

    if (config.vision.dataYamlPath) {
      args.push('-DataYamlPath', config.vision.dataYamlPath)
    }

    return {
      action,
      command: resolvePowerShellCommand(),
      args,
      timeoutMs: 75_000,
      background: false,
    }
  }

  return {
    action,
    command: resolvePowerShellCommand(),
    args: [
      ...powershellArgs,
      path.join(ROOT_DIR, 'scripts', 'start-dogzilla-audio-cue-ssh.ps1'),
      ...sshPortScriptArgs,
      '-RemoteRoot',
      config.remoteRoot,
      '-Port',
      String(config.audio.port),
      '-Background',
    ],
    timeoutMs: 35_000,
    background: false,
  }
}

async function probeConfiguredBridges(config) {
  const results = {}

  for (const [id, bridge] of Object.entries(config.bridges)) {
    results[id] = await probeBridgeHealth(bridge)
  }

  return {
    status: Object.values(results).some((result) => result.status === 'ok' || result.status === 'degraded') ? 'ok' : 'error',
    action: 'probe-bridges',
    results,
  }
}

async function probeConfiguredSupportServices(config) {
  const results = {
    audio: await probeConfiguredService('audio', config.audio?.healthUrl, config.audio?.enabled !== false),
    lidar: await probeConfiguredService('lidar', config.lidar?.healthUrl, config.lidar?.enabled !== false),
    camera: await probeConfiguredService('camera', config.camera?.statusUrl || config.camera?.indexUrl, !!(config.camera?.statusUrl || config.camera?.indexUrl)),
    vision: await probeConfiguredService('vision', config.vision?.statusUrl, config.vision?.enabled === true),
  }
  const values = Object.values(results)
  const anyReachable = values.some((result) => result.status === 'ok' || result.status === 'degraded')
  const anyRequiredError = values.some((result) => result.required && result.status === 'error')

  return {
    status: anyReachable && !anyRequiredError ? 'ok' : anyReachable ? 'degraded' : 'error',
    action: 'probe-support',
    results,
  }
}

async function probeConfiguredService(id, targetUrl, required) {
  if (!required || !targetUrl) {
    return {
      status: 'disabled',
      required: false,
      destination: targetUrl || '',
    }
  }

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(4000),
    })
    const body = await safeReadJson(response)
    const bodyOk = body && typeof body === 'object' && body.ok === false ? false : true

    return {
      status: response.ok && bodyOk ? 'ok' : response.ok ? 'degraded' : 'error',
      required: true,
      service: id,
      responseStatus: response.status,
      destination: targetUrl,
      body,
    }
  } catch (error) {
    return {
      status: 'error',
      required: true,
      service: id,
      destination: targetUrl,
      error: formatFetchError(error),
    }
  }
}

async function probeBridgeHealth(bridge) {
  const targetUrl = new URL('/healthz', bridge.baseUrl).toString()

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(4000),
    })
    const body = await safeReadJson(response)
    const ok = body && typeof body === 'object' && body.ok === false ? false : true

    return {
      status: response.ok && ok ? 'ok' : response.ok ? 'degraded' : 'error',
      responseStatus: response.status,
      destination: targetUrl,
      body,
    }
  } catch (error) {
    return {
      status: 'error',
      destination: targetUrl,
      error: formatFetchError(error),
    }
  }
}

function buildBaseScriptArgs(config, options = {}) {
  const portParam = options.portParam || '-Port'
  return [
    '-Host',
    config.ssh.host,
    '-User',
    config.ssh.user,
    portParam,
    String(config.ssh.port),
    '-Alias',
    config.ssh.alias,
    '-KeyPath',
    config.ssh.keyPath,
  ]
}

function buildDogzillaSshCommandPlan(config, remoteCommand, timeoutMs) {
  return {
    action: 'robot-identity',
    command: resolvePowerShellCommand(),
    args: [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(ROOT_DIR, 'scripts', 'dogzilla-ssh.ps1'),
      ...buildBaseScriptArgs(config),
      '-Command',
      remoteCommand,
    ],
    timeoutMs,
    background: false,
  }
}

function buildEnsureRobotIdentityCommand(config, identity) {
  const root = remoteIdentityRoot(config)
  const idPath = remoteIdentityPath(config, ROBOT_ID_FILE)
  const namePath = remoteIdentityPath(config, ROBOT_NAME_FILE)

  return [
    'umask 077',
    `mkdir -p ${shellSingleQuote(root)}`,
    'robot_id_created=0',
    `if [ ! -s ${shellSingleQuote(idPath)} ]; then printf '%s\\n' ${shellSingleQuote(identity.robotId)} > ${shellSingleQuote(idPath)}; robot_id_created=1; fi`,
    'robot_name_created=0',
    `if [ ! -s ${shellSingleQuote(namePath)} ]; then printf '%s\\n' ${shellSingleQuote(identity.robotName)} > ${shellSingleQuote(namePath)}; robot_name_created=1; fi`,
    `robot_id="$(head -n 1 ${shellSingleQuote(idPath)} 2>/dev/null | tr -d '\\r\\n')"`,
    `robot_name="$(head -n 1 ${shellSingleQuote(namePath)} 2>/dev/null | tr -d '\\r\\n')"`,
    'printf "robot_id=%s\\nrobot_name=%s\\nrobot_id_created=%s\\nrobot_name_created=%s\\n" "$robot_id" "$robot_name" "$robot_id_created" "$robot_name_created"',
  ].join('; ')
}

function buildSaveRobotNameCommand(config, identity) {
  const root = remoteIdentityRoot(config)
  const idPath = remoteIdentityPath(config, ROBOT_ID_FILE)
  const namePath = remoteIdentityPath(config, ROBOT_NAME_FILE)

  return [
    'umask 077',
    `mkdir -p ${shellSingleQuote(root)}`,
    `if [ ! -s ${shellSingleQuote(idPath)} ]; then printf '%s\\n' ${shellSingleQuote(identity.robotId)} > ${shellSingleQuote(idPath)}; fi`,
    `printf '%s\\n' ${shellSingleQuote(identity.robotName)} > ${shellSingleQuote(namePath)}`,
    `robot_id="$(head -n 1 ${shellSingleQuote(idPath)} 2>/dev/null | tr -d '\\r\\n')"`,
    `robot_name="$(head -n 1 ${shellSingleQuote(namePath)} 2>/dev/null | tr -d '\\r\\n')"`,
    'printf "robot_id=%s\\nrobot_name=%s\\n" "$robot_id" "$robot_name"',
  ].join('; ')
}

async function readRobotRuntimeIdentity() {
  try {
    const rawConfig = JSON.parse(await readFile(ROBOT_RUNTIME_CONFIG_PATH, 'utf-8'))
    const robotId = normalizeString(rawConfig.robot_id) || normalizeString(rawConfig.robotId) || 'dogzilla-local'
    const robotName = normalizeRobotName(rawConfig.robot_name) || normalizeRobotName(rawConfig.robotName) || DEFAULT_ROBOT_NAME
    return {
      status: 'local',
      robotId,
      robotName,
      robot_id: robotId,
      robot_name: robotName,
      source: 'runtime',
    }
  } catch {
    return {
      status: 'local',
      robotId: 'dogzilla-local',
      robotName: DEFAULT_ROBOT_NAME,
      robot_id: 'dogzilla-local',
      robot_name: DEFAULT_ROBOT_NAME,
      source: 'default',
    }
  }
}

async function saveRobotRuntimeIdentity({ robotId, robotName }) {
  const rawConfig = JSON.parse(await readFile(ROBOT_RUNTIME_CONFIG_PATH, 'utf-8'))
  const nextRobotId = normalizeString(robotId)
  const nextRobotName = normalizeRobotName(robotName)

  if (nextRobotId) {
    rawConfig.robotId = nextRobotId
  }

  if (nextRobotName) {
    rawConfig.robotName = nextRobotName
  }

  await writeFile(ROBOT_RUNTIME_CONFIG_PATH, `${JSON.stringify(rawConfig, null, 2)}\n`, 'utf-8')
  return readRobotRuntimeIdentity()
}

function parseRobotIdentityOutput(stdout) {
  const identity = {}
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = /^(robot_id|robot_name|robot_id_created|robot_name_created)=(.*)$/.exec(line.trim())
    if (match) {
      identity[match[1]] = match[2].trim()
    }
  }
  return identity
}

function buildRobotIdentityFilePaths(config) {
  return {
    robot_id: remoteIdentityPath(config, ROBOT_ID_FILE),
    robot_name: remoteIdentityPath(config, ROBOT_NAME_FILE),
  }
}

function remoteIdentityRoot(config) {
  return normalizeString(config.remoteRoot) || '/home/pi/robodoge'
}

function remoteIdentityPath(config, fileName) {
  return `${remoteIdentityRoot(config).replace(/\/+$/, '')}/${fileName}`
}

function shellSingleQuote(value) {
  return `'${String(value ?? '').replaceAll("'", "'\\''")}'`
}

function normalizeBridge(rawBridge = {}, label, host, fallbackPort) {
  const port = normalizePort(rawBridge.port, fallbackPort)
  const rawBaseUrl = normalizeString(rawBridge.baseUrl)
  const baseUrl = normalizeUrl(rawBaseUrl) || (host ? `http://${host}:${port}` : `http://127.0.0.1:${port}`)

  return {
    label: normalizeString(rawBridge.label) || label,
    baseUrl,
    port,
  }
}

function normalizeCamera(rawCamera = {}, host) {
  const baseUrl = normalizeUrl(rawCamera.baseUrl) || (host ? `http://${host}:6500` : '')
  const streamPath = normalizePath(rawCamera.streamPath) || '/video_feed'
  const indexPath = normalizePath(rawCamera.indexPath) || '/'
  const controlPort = normalizePort(rawCamera.controlPort, 6000)
  const wakeCommand = normalizeString(rawCamera.wakeCommand) || '$010F040115#'

  return {
    label: normalizeString(rawCamera.label) || 'Yahboom DOGZILLA app camera',
    baseUrl,
    streamPath,
    indexPath,
    controlPort,
    wakeCommand,
    streamUrl: baseUrl ? new URL(streamPath, baseUrl).toString() : '',
    indexUrl: baseUrl ? new URL(indexPath, baseUrl).toString() : '',
    proxyStreamPath: DOGZILLA_CAMERA_STREAM_PROXY_PATH,
    proxySnapshotPath: DOGZILLA_CAMERA_SNAPSHOT_PROXY_PATH,
    proxyStatusPath: DOGZILLA_CAMERA_STATUS_PATH,
  }
}

function normalizeVision(rawVision = {}, host, sourceCamera) {
  const enabled = rawVision.enabled === true || normalizeString(rawVision.enabled).toLowerCase() === 'true'
  const port = normalizePort(rawVision.port, 8894)
  const rawBaseUrl = normalizeString(rawVision.baseUrl)
  const baseUrl = normalizeUrl(rawBaseUrl) || (host ? `http://${host}:${port}` : '')
  const streamPath = normalizePath(rawVision.streamPath) || '/stream.mjpg'
  const statusPath = normalizePath(rawVision.statusPath) || '/healthz'
  const detectionsPath = normalizePath(rawVision.detectionsPath) || '/detections'

  return {
    enabled,
    label: normalizeString(rawVision.label) || 'DOGZILLA YOLO annotated camera',
    baseUrl,
    port,
    streamPath,
    statusPath,
    detectionsPath,
    streamUrl: baseUrl ? new URL(streamPath, baseUrl).toString() : '',
    statusUrl: baseUrl ? new URL(statusPath, baseUrl).toString() : '',
    detectionsUrl: baseUrl ? new URL(detectionsPath, baseUrl).toString() : '',
    sourceStreamUrl: normalizeString(rawVision.sourceStreamUrl) || sourceCamera.streamUrl || '',
    modelPath: normalizeString(rawVision.modelPath),
    dataYamlPath: normalizeString(rawVision.dataYamlPath),
    modelRemotePath: normalizeString(rawVision.modelRemotePath) || '/home/pi/robodoge/models/dogzilla_yolo/best.onnx',
  }
}

function normalizeVisionCamera(vision, sourceCamera) {
  const indexUrl = vision.statusUrl || (vision.baseUrl ? new URL('/', vision.baseUrl).toString() : '')

  return {
    label: vision.label || 'DOGZILLA YOLO annotated camera',
    baseUrl: vision.baseUrl,
    streamPath: vision.streamPath,
    indexPath: vision.statusPath,
    streamUrl: vision.streamUrl,
    indexUrl,
    statusUrl: vision.statusUrl,
    proxyStreamPath: DOGZILLA_CAMERA_STREAM_PROXY_PATH,
    proxySnapshotPath: DOGZILLA_CAMERA_SNAPSHOT_PROXY_PATH,
    proxyStatusPath: DOGZILLA_CAMERA_STATUS_PATH,
    processed: true,
    sourceLabel: sourceCamera.label || 'Yahboom DOGZILLA app camera',
    sourceStreamUrl: vision.sourceStreamUrl || sourceCamera.streamUrl || '',
    visionStatusUrl: vision.statusUrl,
    detectionsUrl: vision.detectionsUrl,
  }
}

function normalizeAudio(rawAudio = {}, host) {
  const enabled = rawAudio.enabled === true || normalizeString(rawAudio.enabled).toLowerCase() === 'true'
  const port = normalizePort(rawAudio.port, 8895)
  const rawBaseUrl = normalizeString(rawAudio.baseUrl)
  const baseUrl = normalizeUrl(rawBaseUrl) || (host ? `http://${host}:${port}` : '')
  const cuePath = normalizePath(rawAudio.cuePath) || '/cue'
  const healthPath = normalizePath(rawAudio.healthPath) || '/healthz'

  return {
    enabled,
    label: normalizeString(rawAudio.label) || 'DOGZILLA Pi speaker cues',
    baseUrl,
    port,
    cuePath,
    healthPath,
    cueUrl: baseUrl ? new URL(cuePath, baseUrl).toString() : '',
    healthUrl: baseUrl ? new URL(healthPath, baseUrl).toString() : '',
  }
}

function normalizeLidar(rawLidar = {}, host) {
  const enabled = rawLidar.enabled === true || normalizeString(rawLidar.enabled).toLowerCase() === 'true'
  const port = normalizePort(rawLidar.port, 8896)
  const rawBaseUrl = normalizeString(rawLidar.baseUrl)
  const baseUrl = normalizeUrl(rawBaseUrl) || (host ? `http://${host}:${port}` : '')
  const healthPath = normalizePath(rawLidar.healthPath) || '/healthz'
  const scanPath = normalizePath(rawLidar.scanPath) || '/scan'
  const posePath = normalizePath(rawLidar.posePath) || '/pose'
  const diagnosticsPath = normalizePath(rawLidar.diagnosticsPath) || '/diagnostics'
  const serialPort = normalizeString(rawLidar.serialPort) || '/dev/ttyAMA1'

  return {
    enabled,
    label: normalizeString(rawLidar.label) || 'DOGZILLA lidar bridge',
    baseUrl,
    port,
    serialPort,
    healthPath,
    scanPath,
    posePath,
    diagnosticsPath,
    healthUrl: baseUrl ? new URL(healthPath, baseUrl).toString() : '',
    scanUrl: baseUrl ? new URL(scanPath, baseUrl).toString() : '',
    poseUrl: baseUrl ? new URL(posePath, baseUrl).toString() : '',
    diagnosticsUrl: baseUrl ? new URL(diagnosticsPath, baseUrl).toString() : '',
    proxyHealthPath: '/api/dogzilla/lidar/health',
    proxyScanPath: '/api/dogzilla/lidar/scan',
    proxyPosePath: '/api/dogzilla/pose',
    proxyDiagnosticsPath: '/api/dogzilla/lidar/diagnostics',
  }
}

function summarizeConnection(config, sshConfigExists) {
  return {
    hasHost: !!config.ssh.host,
    sshConfigExists,
    activeHost: config.ssh.host || '',
    user: config.ssh.user,
    directUrl: config.bridges.direct.baseUrl,
    ros2Url: config.bridges.ros2.baseUrl,
  }
}

async function execFilePromise(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      resolve({
        exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || error?.message || '').trim(),
      })
    })
  })
}

async function safeReadJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

async function pathExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function redactPlan(plan) {
  return {
    action: plan.action,
    command: plan.command,
    args: plan.args,
    timeoutMs: plan.timeoutMs,
    background: plan.background,
  }
}

function resolvePowerShellCommand() {
  if (process.platform !== 'win32') {
    return 'pwsh'
  }

  const pwsh = spawnSync('pwsh.exe', [
    '-NoLogo',
    '-NoProfile',
    '-Command',
    '$PSVersionTable.PSVersion.ToString()',
  ], {
    stdio: 'ignore',
    windowsHide: true,
  })

  return pwsh.status === 0 ? 'pwsh.exe' : 'powershell.exe'
}

function normalizeUrl(value) {
  if (!value) {
    return ''
  }

  try {
    return new URL(value).toString().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function normalizePath(value) {
  const normalized = normalizeString(value)
  return normalized ? `/${normalized.replace(/^\/+/, '')}` : ''
}

function normalizePort(value, fallback) {
  const numeric = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(numeric) && numeric > 0 && numeric <= 65535 ? numeric : fallback
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeRobotName(value) {
  return normalizeString(value).replace(/\s+/g, ' ').slice(0, 64)
}

function defaultKeyPath() {
  return path.join(process.env.USERPROFILE || process.env.HOME || '', '.ssh', 'robodoge_pi_ed25519')
}
