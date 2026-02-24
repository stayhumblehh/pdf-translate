const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pdf2zh', {
  selectPdf: () => ipcRenderer.invoke('select-pdf'),
  start: (params) => ipcRenderer.invoke('start-translate', params),
  getResult: (jobId) => ipcRenderer.invoke('download-result', jobId),
  onProgress: (cb) => ipcRenderer.on('pdf2zh:progress', (_, data) => cb(data)),
  onDone: (cb) => ipcRenderer.on('pdf2zh:done', (_, data) => cb(data)),
  onError: (cb) => ipcRenderer.on('pdf2zh:error', (_, data) => cb(data)),
  onOpenFile: (cb) => ipcRenderer.on('pdf2zh:open-file', (_, filePath) => cb(filePath))
});
