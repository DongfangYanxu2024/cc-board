const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('board', {
  invoke: (action, payload) => ipcRenderer.invoke('board', action, payload),
  subscribe: callback => { const handler = (_event, data) => callback(data); ipcRenderer.on('board:event', handler); return () => ipcRenderer.removeListener('board:event', handler); }
});
