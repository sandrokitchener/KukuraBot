const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('roboDogeLauncher', {
  getStatus: () => ipcRenderer.invoke('launcher:get-status'),
  openApp: () => ipcRenderer.invoke('launcher:open-app'),
  openAppExternal: () => ipcRenderer.invoke('launcher:open-app-external'),
  probeBackend: () => ipcRenderer.invoke('launcher:probe-backend'),
  showServiceRoot: () => ipcRenderer.invoke('launcher:show-service-root'),
  startFullServices: () => ipcRenderer.invoke('launcher:start-full-services'),
  stopServices: () => ipcRenderer.invoke('launcher:stop-services'),
  onStatus(callback) {
    const handler = (_event, status) => callback(status)
    ipcRenderer.on('launcher:status', handler)
    return () => ipcRenderer.removeListener('launcher:status', handler)
  },
  onServiceOutput(callback) {
    const handler = (_event, lines) => callback(lines)
    ipcRenderer.on('launcher:service-output', handler)
    return () => ipcRenderer.removeListener('launcher:service-output', handler)
  },
})
