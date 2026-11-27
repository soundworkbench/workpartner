import { contextBridge, ipcRenderer } from 'electron';

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('localAccess', {
    read: () => ipcRenderer.invoke('local-access', 'read'),
    addDirectory: () => ipcRenderer.invoke('local-access', 'addDirectory'),
    removeDirectory: (root: string) => ipcRenderer.invoke('local-access', 'removeDirectory', root),
    setDeviceName: (name: string) => ipcRenderer.invoke('local-access', 'setDeviceName', name),
    setPreferred: (value: boolean) => ipcRenderer.invoke('local-access', 'setPreferred', value),
    setPaused: (value: boolean) => ipcRenderer.invoke('local-access', 'setPaused', value),
    logout: () => ipcRenderer.invoke('local-access', 'logout'),
    logoutAll: () => ipcRenderer.invoke('local-access', 'logoutAll'),
    onChanged: (update: () => void) => { ipcRenderer.on('local-access-changed', () => update()); }
  });
}
