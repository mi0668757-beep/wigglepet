const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('editor', {
  getImage: () => ipcRenderer.invoke('editor-image'),
  save: (result) => ipcRenderer.invoke('editor-save', result),
  importWhole: () => ipcRenderer.invoke('editor-import-whole'),
  recognize: (imageUrl) => ipcRenderer.invoke('editor-recognize', imageUrl),
});
