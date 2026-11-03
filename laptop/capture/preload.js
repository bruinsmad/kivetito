const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kv', {
  sendFrame: (jpeg) => ipcRenderer.invoke('kv:frame', jpeg),
  captureError: (msg) => ipcRenderer.send('kv:capture-error', msg),
  onStart: (fn) => ipcRenderer.on('kv:start', (_e, s) => fn(s)),
  onStop: (fn) => ipcRenderer.on('kv:stop', () => fn()),
  onSettings: (fn) => ipcRenderer.on('kv:settings', (_e, s) => fn(s)),
  // prompt window
  submit: (value) => ipcRenderer.send('kv:prompt', value),
});
