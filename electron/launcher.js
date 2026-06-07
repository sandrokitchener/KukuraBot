const launcher = window.roboDogeLauncher

const backendState = document.querySelector('#backend-state')
const backendUrl = document.querySelector('#backend-url')
const serviceState = document.querySelector('#service-state')
const servicePid = document.querySelector('#service-pid')
const serviceRoot = document.querySelector('#service-root')
const serviceLog = document.querySelector('#service-log')
const startServicesButton = document.querySelector('#start-services-button')
const stopServicesButton = document.querySelector('#stop-services-button')
const openAppButton = document.querySelector('#open-app-button')
const openExternalButton = document.querySelector('#open-external-button')
const probeButton = document.querySelector('#probe-button')
const showRootButton = document.querySelector('#show-root-button')

const logLines = ['Launcher ready.']

startServicesButton.addEventListener('click', () => runAction(() => launcher.startFullServices()))
stopServicesButton.addEventListener('click', () => runAction(() => launcher.stopServices()))
openAppButton.addEventListener('click', () => runAction(() => launcher.openApp()))
openExternalButton.addEventListener('click', () => runAction(() => launcher.openAppExternal()))
probeButton.addEventListener('click', () => runAction(() => launcher.probeBackend()))
showRootButton.addEventListener('click', () => runAction(() => launcher.showServiceRoot()))

launcher.onStatus(renderStatus)
launcher.onServiceOutput((lines) => {
  appendLog(lines)
})

runAction(() => launcher.getStatus())
setInterval(() => runAction(() => launcher.getStatus(), { silent: true }), 5000)

async function runAction(action, { silent = false } = {}) {
  setBusy(true)
  try {
    const status = await action()
    renderStatus(status)
  } catch (error) {
    if (!silent) {
      appendLog([`Action failed: ${error instanceof Error ? error.message : String(error)}`])
    }
  } finally {
    setBusy(false)
  }
}

function renderStatus(status) {
  if (!status) {
    return
  }

  backendState.textContent = status.backendReady ? 'Ready' : 'Offline'
  backendUrl.textContent = status.appUrl
  serviceRoot.textContent = status.serviceRoot || 'Unknown'
  serviceState.textContent = status.serviceRunning ? 'Running' : 'Idle'
  servicePid.textContent = status.servicePid
    ? `PID ${status.servicePid}`
    : status.serviceStartedAt
      ? `Last started ${status.serviceStartedAt}`
      : 'No service pid'
  openAppButton.disabled = !status.backendReady
  stopServicesButton.disabled = !status.serviceRunning

  if (Array.isArray(status.output) && status.output.length > 0) {
    replaceLog(status.output)
  }
}

function setBusy(isBusy) {
  for (const button of [startServicesButton, openAppButton, openExternalButton, probeButton, showRootButton]) {
    button.disabled = isBusy || (button === openAppButton && backendState.textContent !== 'Ready')
  }
}

function appendLog(lines) {
  logLines.push(...lines)
  while (logLines.length > 160) {
    logLines.shift()
  }
  serviceLog.textContent = logLines.join('\n')
  serviceLog.scrollTop = serviceLog.scrollHeight
}

function replaceLog(lines) {
  logLines.splice(0, logLines.length, ...lines.slice(-160))
  serviceLog.textContent = logLines.join('\n')
  serviceLog.scrollTop = serviceLog.scrollHeight
}
