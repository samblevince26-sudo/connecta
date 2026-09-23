const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('connecta', {
  saveCredentials: (payload) => ipcRenderer.invoke('cred:save', payload),
  loadCredentials: () => ipcRenderer.invoke('cred:load'),
  clearCredentials: () => ipcRenderer.invoke('cred:clear'),
  appInfo: () => ipcRenderer.invoke('app:info'),
});
