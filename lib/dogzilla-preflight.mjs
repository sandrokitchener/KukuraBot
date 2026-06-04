import { execFile, spawnSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDogzillaConnectionConfig } from './dogzilla-connection-center.mjs'
import { formatFetchError } from './http-error.mjs'
import { loadRobotRos2Config, loadRobotRuntimeConfig } from './robot-runtime-config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const TCP_TIMEOUT_MS = 2500
const HTTP_TIMEOUT_MS = 6000
const SSH_TIMEOUT_MS = 20_000

export async function runDogzillaPreflight() {
  const startedAt = Date.now()
  const [connectionConfig, runtimeConfig, ros2Config] = await Promise.all([
    loadDogzillaConnectionConfig(),
    loadRobotRuntimeConfig(),
    loadRobotRos2Config(),
  ])
  const ssh = connectionConfig.ssh
  const directBaseUrl = connectionConfig.bridges.direct?.baseUrl || ''
  const ros2BaseUrl = connectionConfig.bridges.ros2?.baseUrl || ''
  const cameraProbeUrl = connectionConfig.camera?.sourceStreamUrl || connectionConfig.camera?.streamUrl || connectionConfig.camera?.baseUrl || ''
  const cameraTcpTarget = tcpTargetFromUrl(cameraProbeUrl)
  const visionStatusUrl = connectionConfig.vision?.enabled ? connectionConfig.vision.statusUrl : ''
  const audioHealthUrl = connectionConfig.audio?.enabled ? connectionConfig.audio.healthUrl : ''
  const lidarHealthUrl = connectionConfig.lidar?.enabled ? connectionConfig.lidar.healthUrl : ''
  const lidarPoseUrl = connectionConfig.lidar?.enabled ? connectionConfig.lidar.poseUrl : ''

  const [keyExists, sshTcp, directHealth, directState, ros2Health, cameraTcp, visionHealth, audioHealth, lidarHealth, lidarPose, sshDiagnostics] = await Promise.all([
    pathExists(ssh.keyPath),
    ssh.host ? probeTcp(ssh.host, ssh.port || 22) : missingProbe('DOGZILLA host not configured.'),
    directBaseUrl ? probeJson(new URL('/healthz', directBaseUrl).toString()) : missingProbe('Direct bridge URL not configured.'),
    directBaseUrl ? probeJson(new URL('/state', directBaseUrl).toString()) : missingProbe('Direct bridge state URL not configured.'),
    ros2BaseUrl ? probeJson(new URL('/healthz', ros2BaseUrl).toString(), 2500) : missingProbe('ROS2 bridge URL not configured.'),
    cameraTcpTarget ? probeTcp(cameraTcpTarget.host, cameraTcpTarget.port) : missingProbe('Camera TCP URL not configured.'),
    visionStatusUrl ? probeJson(visionStatusUrl, 8000) : missingProbe('YOLO vision sidecar not enabled.'),
    audioHealthUrl ? probeJson(audioHealthUrl, 3000) : missingProbe('Pi audio cue sidecar not enabled.'),
    lidarHealthUrl ? probeJson(lidarHealthUrl, 4000) : missingProbe('DOGZILLA lidar bridge not enabled.'),
    lidarPoseUrl ? probeJson(lidarPoseUrl, 4000) : missingProbe('DOGZILLA pose bridge not enabled.'),
    ssh.host ? runSshDiagnostics(connectionConfig) : missingProbe('DOGZILLA host not configured.'),
  ])

  const diagnostics = {
    local: {
      keyExists,
      sshTcp,
      directHealth,
      directState,
      ros2Health,
      cameraTcp,
      visionHealth,
      audioHealth,
      lidarHealth,
      lidarPose,
    },
    remote: sshDiagnostics,
  }
  const checks = buildPreflightChecks({
    connectionConfig,
    runtimeConfig,
    ros2Config,
    diagnostics,
  })
  const summary = summarizeDogzillaPreflight(checks)

  return {
    status: summary.criticalFailures > 0 ? 'blocked' : summary.warn > 0 ? 'attention' : 'ready',
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    config: {
      host: ssh.host,
      user: ssh.user,
      sshPort: ssh.port,
      directUrl: directBaseUrl,
      ros2Url: ros2BaseUrl,
      cameraUrl: cameraProbeUrl,
      visionUrl: connectionConfig.vision?.enabled ? connectionConfig.vision.baseUrl : '',
      audioUrl: connectionConfig.audio?.enabled ? connectionConfig.audio.baseUrl : '',
      runtimeTarget: runtimeConfig.activeTarget,
      dryRun: runtimeConfig.dryRun ?? ros2Config.transport?.dryRun ?? true,
    },
    summary,
    checks,
    diagnostics,
    notes: [
      'Preflight is read-only on the Pi.',
      'Camera diagnostics check the configured YOLO source; device cameras are owned by the YOLO sidecar when vision is enabled.',
      'Missing lidar blocks real waypoint navigation, but not dry-run action testing.',
    ],
  }
}

export function summarizeDogzillaPreflight(checks = []) {
  const summary = {
    ok: 0,
    warn: 0,
    fail: 0,
    info: 0,
    total: checks.length,
    criticalFailures: 0,
  }

  for (const check of checks) {
    if (check.status === 'ok') {
      summary.ok += 1
    } else if (check.status === 'warn') {
      summary.warn += 1
    } else if (check.status === 'fail') {
      summary.fail += 1
    } else {
      summary.info += 1
    }

    if (check.critical && check.status === 'fail') {
      summary.criticalFailures += 1
    }
  }

  return summary
}

export function buildPreflightChecks({ connectionConfig, runtimeConfig, ros2Config, diagnostics }) {
  const remote = diagnostics.remote?.parsed || {}
  const remoteOk = diagnostics.remote?.status === 'ok'
  const directHealthOk = diagnostics.local.directHealth.status === 'ok' && diagnostics.local.directHealth.body?.ok !== false
  const directStateOk = diagnostics.local.directState.status === 'ok' && diagnostics.local.directState.body?.executed === true
  const batterySample = directStateOk
    ? normalizeDogzillaBatterySample(diagnostics.local.directState.body?.battery)
    : { value: null, status: 'unavailable', detail: 'State read unavailable.' }
  const battery = batterySample.value
  const dockerImages = Array.isArray(remote.docker?.images) ? remote.docker.images : []
  const hasRosDockerImage = dockerImages.some((image) => image.name?.includes('yahboomtechnology/ros-humble'))
  const devices = remote.devices || {}
  const listening = Array.isArray(remote.listening) ? remote.listening.join('\n') : ''
  const processes = Array.isArray(remote.processes) ? remote.processes : []
  const vendorProcess = processes.some((line) => /^\d+\s+python\d*(?:\.\d+)?\s+.*app_dogzilla\.py/.test(line))
  const directBridgeProcess = processes.some((line) => /sidecars\/dogzilla_lib_bridge\/server\.py/.test(line))
  const visionProcess = processes.some((line) => /sidecars\/dogzilla_yolo_vision\/server\.py/.test(line))
  const audioProcess = processes.some((line) => /sidecars\/dogzilla_audio_cue\/server\.py/.test(line))
  const dogzillaPath = remote.paths?.vendorDogzilla === true
  const robodogePath = remote.paths?.robodoge === true
  const cameraPort = portFromUrl(connectionConfig.camera?.sourceStreamUrl) || portFromUrl(connectionConfig.camera?.baseUrl) || 6500
  const cameraSource = connectionConfig.camera?.sourceStreamUrl || connectionConfig.camera?.streamUrl || connectionConfig.camera?.baseUrl || ''
  const videoDevices = Array.isArray(devices.video) ? devices.video : []
  const videoByIdDevices = Array.isArray(devices.videoById) ? devices.videoById : []
  const cameraSourceIsDevice = /^\/dev\/(?:video\d+|v4l\/by-id\/[^/]+)$/i.test(cameraSource)
  const cameraSourceIsAuto = cameraSource === 'auto'
  const cameraDeviceVisible = cameraSourceIsDevice && (videoDevices.includes(cameraSource) || videoByIdDevices.includes(cameraSource))
  const visionEnabled = connectionConfig.vision?.enabled === true
  const visionHealthOk = diagnostics.local.visionHealth.status === 'ok' && diagnostics.local.visionHealth.body?.ok === true
  const visionUsesVendorCameraStream = visionEnabled && /^https?:\/\//i.test(connectionConfig.vision?.sourceStreamUrl || '')
  const audioEnabled = connectionConfig.audio?.enabled === true
  const audioHealthOk = diagnostics.local.audioHealth.status === 'ok' && diagnostics.local.audioHealth.body?.ok === true
  const lidarEnabled = connectionConfig.lidar?.enabled === true
  const lidarHealth = diagnostics.local.lidarHealth || {}
  const lidarPose = diagnostics.local.lidarPose || {}
  const lidarHealthBody = lidarHealth.body || {}
  const lidarPoseBody = lidarPose.body || {}
  const lidarHealthOk = lidarHealth.status === 'ok' && lidarHealthBody?.ok === true
  const mapPose = lidarPoseBody?.mapPose
  const waypointSafePose = (
    lidarPose.status === 'ok'
    && lidarPoseBody?.waypointSafe === true
    && normalizeFrameId(mapPose?.frame) === 'map'
  )
  const poseTopicSummary = summarizePoseTopicPublishers(lidarPoseBody?.rosGraph)

  const checks = [
    {
      id: 'host-config',
      label: 'DOGZILLA IP configured',
      category: 'config',
      status: connectionConfig.ssh.host ? 'ok' : 'fail',
      critical: true,
      detail: connectionConfig.ssh.host || 'Set DOGZILLA IP first.',
    },
    {
      id: 'ssh-key',
      label: 'SSH key present',
      category: 'config',
      status: diagnostics.local.keyExists ? 'ok' : 'warn',
      detail: diagnostics.local.keyExists ? connectionConfig.ssh.keyPath : `Missing ${connectionConfig.ssh.keyPath}`,
    },
    {
      id: 'ssh-port',
      label: 'SSH port reachable',
      category: 'network',
      status: diagnostics.local.sshTcp.status === 'ok' ? 'ok' : 'fail',
      critical: true,
      detail: diagnostics.local.sshTcp.detail || diagnostics.local.sshTcp.error || '',
    },
    {
      id: 'ssh-login',
      label: 'SSH diagnostics login',
      category: 'pi',
      status: remoteOk ? 'ok' : 'fail',
      critical: true,
      detail: remoteOk ? `${remote.identity?.hostname || 'Pi'} ${remote.identity?.uname || ''}`.trim() : diagnostics.remote?.error || diagnostics.remote?.stderr || 'SSH diagnostics failed.',
    },
    {
      id: 'dry-run',
      label: 'Live motion guarded',
      category: 'safety',
      status: (runtimeConfig.dryRun ?? ros2Config.transport?.dryRun ?? true) ? 'ok' : 'warn',
      detail: (runtimeConfig.dryRun ?? ros2Config.transport?.dryRun ?? true) ? 'Dry-run enabled.' : 'Live dispatch enabled.',
    },
    {
      id: 'direct-bridge',
      label: 'Direct bridge health',
      category: 'control',
      status: directHealthOk ? 'ok' : 'fail',
      critical: true,
      detail: directHealthOk ? connectionConfig.bridges.direct.baseUrl : diagnostics.local.directHealth.error || `HTTP ${diagnostics.local.directHealth.responseStatus || 'unknown'}`,
    },
    {
      id: 'direct-state',
      label: 'Battery/state read',
      category: 'control',
      status: directStateOk && batterySample.status === 'ok' ? 'ok' : 'warn',
      detail: directStateOk ? batterySample.detail : diagnostics.local.directState.error || 'State read unavailable.',
      value: battery,
    },
    {
      id: 'direct-process',
      label: 'Questing Beast bridge process',
      category: 'pi',
      status: directBridgeProcess ? 'ok' : remoteOk ? 'warn' : 'info',
      detail: directBridgeProcess ? 'dogzilla_lib_bridge running.' : 'Bridge process not seen in pgrep.',
    },
    {
      id: 'vendor-app',
      label: 'Vendor DOGZILLA app process',
      category: 'pi',
      status: vendorProcess ? 'ok' : visionUsesVendorCameraStream ? 'warn' : visionEnabled ? 'info' : remoteOk ? 'warn' : 'info',
      detail: vendorProcess
        ? 'app_dogzilla.py running.'
        : visionUsesVendorCameraStream
          ? 'Vendor camera app not seen; YOLO is configured to read its camera stream.'
          : visionEnabled ? 'Vendor app not required while YOLO reads the camera device directly.' : 'Vendor app process not seen.',
    },
    {
      id: cameraSourceIsDevice || cameraSourceIsAuto ? 'camera-source-device' : 'camera-port',
      label: cameraSourceIsDevice || cameraSourceIsAuto ? 'Camera source device' : connectionConfig.camera?.processed ? 'Camera source TCP' : 'Camera port TCP',
      category: 'camera',
      status: cameraSourceIsAuto
        ? videoByIdDevices.length > 0 || videoDevices.length > 0 ? 'ok' : 'warn'
        : cameraSourceIsDevice ? cameraDeviceVisible ? 'ok' : 'warn' : diagnostics.local.cameraTcp.status === 'ok' ? 'ok' : 'warn',
      detail: cameraSourceIsAuto
        ? videoByIdDevices.length > 0 || videoDevices.length > 0 ? `Auto camera source enabled. ${videoByIdDevices[0] || videoDevices[0]} visible.` : 'Auto camera source enabled, but no /dev/video* or /dev/v4l/by-id camera device is visible.'
        : cameraSourceIsDevice
          ? cameraDeviceVisible ? `${cameraSource} visible. YOLO owns this camera device.` : `${cameraSource} not visible in /dev/video* or /dev/v4l/by-id.`
        : diagnostics.local.cameraTcp.status === 'ok'
          ? connectionConfig.camera?.processed ? `Port ${cameraPort} reachable. YOLO uses this camera source.` : `Port ${cameraPort} reachable. Stream not opened.`
          : diagnostics.local.cameraTcp.error || 'Camera TCP not reachable.',
    },
    ...(visionEnabled ? [{
      id: 'vision-yolo',
      label: 'YOLO object recognition',
      category: 'camera',
      status: visionHealthOk ? 'ok' : 'warn',
      detail: visionHealthOk
        ? `YOLO stream ready. ${diagnostics.local.visionHealth.body?.detections || 0} detections, ${Math.round(diagnostics.local.visionHealth.body?.inferenceMs || 0)}ms inference.`
        : diagnostics.local.visionHealth.error || diagnostics.local.visionHealth.body?.error || 'YOLO object recognition is not running.',
    }, {
      id: 'vision-process',
      label: 'YOLO object recognition process',
      category: 'pi',
      status: visionProcess ? 'ok' : remoteOk ? 'warn' : 'info',
      detail: visionProcess ? 'dogzilla_yolo_vision running.' : 'YOLO object recognition process not seen in pgrep.',
    }] : []),
    ...(audioEnabled ? [{
      id: 'audio-cues',
      label: 'Pi speaker cues',
      category: 'audio',
      status: audioHealthOk ? 'ok' : 'warn',
      detail: audioHealthOk
        ? `Audio cues ready via ${diagnostics.local.audioHealth.body?.player || 'player'}.`
        : diagnostics.local.audioHealth.error || diagnostics.local.audioHealth.body?.error || 'Pi speaker cues are not running.',
    }, {
      id: 'audio-process',
      label: 'Pi speaker cue process',
      category: 'pi',
      status: audioProcess ? 'ok' : remoteOk ? 'warn' : 'info',
      detail: audioProcess ? 'dogzilla_audio_cue running.' : 'Pi speaker cue process not seen in pgrep.',
    }] : []),
    {
      id: 'ros2-sidecar',
      label: 'ROS2 sidecar HTTP',
      category: 'ros2',
      status: diagnostics.local.ros2Health.status === 'ok' ? 'ok' : 'info',
      detail: diagnostics.local.ros2Health.status === 'ok' ? connectionConfig.bridges.ros2.baseUrl : 'Not running; expected until Docker ROS2 work starts.',
    },
    {
      id: 'ros-docker',
      label: 'Yahboom ROS2 Docker image',
      category: 'ros2',
      status: hasRosDockerImage ? 'ok' : remoteOk ? 'warn' : 'info',
      detail: hasRosDockerImage ? dockerImages.filter((image) => image.name?.includes('yahboomtechnology/ros-humble')).map((image) => image.name).join(', ') : 'ROS Humble image not found.',
    },
    {
      id: 'host-ros2',
      label: 'Host ROS2 CLI',
      category: 'ros2',
      status: remote.commands?.ros2?.ok ? 'info' : 'info',
      detail: remote.commands?.ros2?.ok ? remote.commands.ros2.stdout : 'Host ros2 absent; Docker path expected.',
    },
    {
      id: 'lidar-device',
      label: 'Lidar HAT UART',
      category: 'navigation',
      status: Array.isArray(devices.ttyAma) && devices.ttyAma.includes('/dev/ttyAMA1') ? 'ok' : 'warn',
      detail: Array.isArray(devices.ttyAma) && devices.ttyAma.includes('/dev/ttyAMA1')
        ? '/dev/ttyAMA1 visible. DOGZILLA lidar must use the HAT UART path.'
        : 'Missing /dev/ttyAMA1. DOGZILLA lidar must use the HAT UART path.',
    },
    {
      id: 'lidar-bridge',
      label: 'Lidar scan bridge',
      category: 'navigation',
      status: lidarEnabled ? lidarHealthOk ? 'ok' : 'fail' : 'info',
      critical: lidarEnabled,
      detail: lidarEnabled
        ? lidarHealthOk
          ? `${connectionConfig.lidar.baseUrl} scan frames ${lidarHealthBody.frames ?? 'unknown'}, topic ${lidarHealthBody.topic || '/scan'}.`
          : lidarHealth.error || lidarHealthBody?.error || `HTTP ${lidarHealth.responseStatus || 'unknown'}`
        : 'DOGZILLA lidar bridge disabled.',
    },
    {
      id: 'map-pose',
      label: 'Verified map pose',
      category: 'navigation',
      status: lidarEnabled ? waypointSafePose ? 'ok' : 'fail' : 'info',
      critical: lidarEnabled,
      detail: lidarEnabled
        ? waypointSafePose
          ? `map -> ${mapPose.childFrame || 'base'} from ${mapPose.source || 'ROS TF'}.`
          : summarizePoseFailure(lidarPose, lidarPoseBody, poseTopicSummary)
        : 'DOGZILLA pose bridge disabled.',
      value: poseTopicSummary,
    },
    {
      id: 'video-device',
      label: 'Video devices',
      category: 'camera',
      status: Array.isArray(devices.video) && devices.video.length > 0 ? 'info' : 'warn',
      detail: Array.isArray(devices.video) && devices.video.length > 0 ? `${devices.video.length} /dev/video* nodes.` : 'No /dev/video* nodes visible.',
    },
    {
      id: 'paths',
      label: 'File ownership boundary',
      category: 'safety',
      status: dogzillaPath && robodogePath ? 'ok' : dogzillaPath ? 'warn' : 'fail',
      detail: `/home/pi/DOGZILLA ${dogzillaPath ? 'present' : 'missing'}, /home/pi/robodoge ${robodogePath ? 'present' : 'missing'}.`,
    },
    {
      id: 'ports',
      label: 'Expected ports listening',
      category: 'network',
      status: listening.includes(':8893') && listening.includes(`:${cameraPort}`) ? 'ok' : remoteOk ? 'warn' : 'info',
      detail: `8893 ${listening.includes(':8893') ? 'open' : 'missing'}, ${cameraPort} ${listening.includes(`:${cameraPort}`) ? 'open' : 'missing'}.`,
    },
  ]

  return checks
}

function summarizePoseFailure(lidarPose, body, topicSummary) {
  const error = normalizeString(body?.error) || normalizeString(lidarPose?.error)
  const diagnostics = Array.isArray(body?.diagnostics)
    ? body.diagnostics.map((item) => normalizeString(item)).filter(Boolean)
    : []
  const topicText = topicSummary ? ` Pose topic publishers: ${topicSummary}.` : ''

  if (error) {
    return `${error}${topicText}`
  }

  if (diagnostics.length > 0) {
    return `${diagnostics.slice(0, 3).join(' ')}${topicText}`
  }

  if (lidarPose?.responseStatus) {
    return `Pose bridge HTTP ${lidarPose.responseStatus}.${topicText}`
  }

  return `No verified map-frame pose from the Pi bridge.${topicText}`
}

function summarizePoseTopicPublishers(rosGraph) {
  const topics = rosGraph?.topics && typeof rosGraph.topics === 'object' ? rosGraph.topics : {}
  return ['/tf', '/tf_static', '/odom']
    .map((topic) => `${topic}:${Number(topics[topic]?.publisherCount ?? 0)}`)
    .join(', ')
}

async function runSshDiagnostics(config) {
  const plan = buildSshDiagnosticsPlan(config)
  const result = await execFilePromise(plan.command, plan.args, {
    cwd: ROOT_DIR,
    timeout: SSH_TIMEOUT_MS,
    windowsHide: true,
  })
  const parsed = parseRemoteJson(result.stdout)
  if (Array.isArray(parsed?.processes)) {
    parsed.processes = parsed.processes.filter((line) => (
      !line.includes('pgrep -af')
      && !line.includes('python3 - <<')
    ))
  }

  return {
    status: result.exitCode === 0 && parsed ? 'ok' : 'error',
    exitCode: result.exitCode,
    stdout: parsed ? '' : result.stdout.slice(0, 4000),
    stderr: result.stderr,
    parsed,
  }
}

function buildSshDiagnosticsPlan(config) {
  return {
    command: resolvePowerShellCommand(),
    args: [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(ROOT_DIR, 'scripts', 'dogzilla-ssh.ps1'),
      '-Host',
      config.ssh.host,
      '-User',
      config.ssh.user,
      '-Port',
      String(config.ssh.port),
      '-Alias',
      config.ssh.alias,
      '-KeyPath',
      config.ssh.keyPath,
      '-Command',
      buildRemoteDiagnosticsCommand(config.remoteRoot),
    ],
  }
}

function buildRemoteDiagnosticsCommand(remoteRoot) {
  const safeRemoteRoot = String(remoteRoot || '/home/pi/robodoge').replace(/'/g, '')
  return `python3 - <<'PY'
import glob
import json
import os
import subprocess

def run(args, timeout=3):
    try:
        proc = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
        return {
            'ok': proc.returncode == 0,
            'exitCode': proc.returncode,
            'stdout': proc.stdout.strip(),
            'stderr': proc.stderr.strip(),
        }
    except Exception as error:
        return {'ok': False, 'exitCode': None, 'stdout': '', 'stderr': str(error)}

def lines(result):
    return [line for line in result.get('stdout', '').splitlines() if line.strip()]

def docker_image_rows():
    result = run(['docker', 'images', '--format', '{{.Repository}}:{{.Tag}}\\t{{.ID}}\\t{{.Size}}'], timeout=5)
    rows = []
    for line in lines(result):
        parts = line.split('\\t')
        rows.append({
            'name': parts[0] if len(parts) > 0 else line,
            'id': parts[1] if len(parts) > 1 else '',
            'size': parts[2] if len(parts) > 2 else '',
        })
    return {'result': result, 'images': rows}

data = {
    'identity': {
        'whoami': run(['whoami']).get('stdout', ''),
        'hostname': run(['hostname']).get('stdout', ''),
        'uname': run(['uname', '-a']).get('stdout', ''),
        'date': run(['date', '--iso-8601=seconds']).get('stdout', ''),
    },
    'os': {
        'release': run(['cat', '/etc/os-release']).get('stdout', ''),
    },
    'network': {
        'hostnameI': run(['hostname', '-I']).get('stdout', ''),
        'activeConnections': lines(run(['nmcli', '-t', '-f', 'NAME,TYPE,DEVICE', 'con', 'show', '--active'])),
        'wlan0': run(['ip', '-4', 'addr', 'show', 'wlan0']).get('stdout', ''),
    },
    'devices': {
        'ttyAma': sorted(glob.glob('/dev/ttyAMA*')),
        'video': sorted(glob.glob('/dev/video*')),
        'videoById': sorted(glob.glob('/dev/v4l/by-id/*')),
    },
    'commands': {
        'ros2': run(['bash', '-lc', 'command -v ros2 && ros2 --help | head -1'], timeout=4),
    },
    'docker': docker_image_rows(),
    'dockerPs': lines(run(['docker', 'ps', '--format', '{{.Names}}\\t{{.Image}}\\t{{.Status}}'], timeout=5)),
    'services': {
        'docker': run(['systemctl', 'is-active', 'docker']).get('stdout', ''),
        'NetworkManager': run(['systemctl', 'is-active', 'NetworkManager']).get('stdout', ''),
        'hostapd': run(['systemctl', 'is-active', 'hostapd']).get('stdout', ''),
        'dnsmasq': run(['systemctl', 'is-active', 'dnsmasq']).get('stdout', ''),
        'yahboom_oled': run(['systemctl', 'is-active', 'yahboom_oled']).get('stdout', ''),
        'jupyter': run(['systemctl', 'is-active', 'jupyter']).get('stdout', ''),
        'wayvnc': run(['systemctl', 'is-active', 'wayvnc']).get('stdout', ''),
    },
    'processes': lines(run(['pgrep', '-af', 'DOGZILLA|dogzilla|robodoge|yahboom|jupyter|vnc|docker|ros|lidar|camera'], timeout=4)),
    'listening': lines(run(['ss', '-ltnp'], timeout=4)),
    'paths': {
        'vendorDogzilla': os.path.isdir('/home/pi/DOGZILLA'),
        'robodoge': os.path.isdir('${safeRemoteRoot}'),
    },
}
print(json.dumps(data))
PY`
}

async function probeTcp(host, port, timeoutMs = TCP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const done = (status, extra = {}) => {
      if (settled) {
        return
      }
      settled = true
      socket.destroy()
      resolve({
        status,
        host,
        port,
        detail: status === 'ok' ? `${host}:${port} reachable.` : `${host}:${port} unreachable.`,
        ...extra,
      })
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done('ok'))
    socket.once('timeout', () => done('error', { error: 'timeout' }))
    socket.once('error', (error) => done('error', { error: error.message }))
    socket.connect(port, host)
  })
}

async function probeJson(url, timeoutMs = HTTP_TIMEOUT_MS) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await safeReadJson(response)
    return {
      status: response.ok ? 'ok' : 'error',
      responseStatus: response.status,
      destination: url,
      body,
    }
  } catch (error) {
    return {
      status: 'error',
      destination: url,
      error: formatFetchError(error),
    }
  }
}

function missingProbe(error) {
  return { status: 'missing', error }
}

async function safeReadJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function parseRemoteJson(stdout) {
  const trimmed = String(stdout || '').trim()
  if (!trimmed) {
    return null
  }

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) {
    return null
  }

  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
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

async function pathExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function normalizeFiniteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeFrameId(value) {
  return normalizeString(value).replace(/^\/+/, '')
}

function normalizeDogzillaBatterySample(value) {
  const raw = normalizeFiniteNumber(value)
  if (!Number.isFinite(raw)) {
    return {
      value: null,
      raw,
      status: 'unavailable',
      detail: 'Battery unavailable.',
    }
  }

  if (raw <= 0) {
    return {
      value: null,
      raw,
      status: 'read-failed',
      detail: 'Battery unavailable; DOGZILLA read_Battery returned failure sentinel 0.',
    }
  }

  if (raw > 100) {
    return {
      value: raw,
      raw,
      status: 'out-of-range',
      detail: `Battery raw ${raw} from DOGZILLALib read_Battery.`,
    }
  }

  return {
    value: raw,
    raw,
    status: 'ok',
    detail: `Battery ${Math.round(raw)}% from DOGZILLALib read_Battery.`,
  }
}

function portFromUrl(value) {
  if (!value) {
    return null
  }

  try {
    const url = new URL(value)
    return Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  } catch {
    return null
  }
}

function tcpTargetFromUrl(value) {
  if (!value) {
    return null
  }

  try {
    const url = new URL(value)
    return {
      host: url.hostname,
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    }
  } catch {
    return null
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
