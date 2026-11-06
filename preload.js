const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  loadPet: () => ipcRenderer.invoke('load-pet'),
  move: (dx) => ipcRenderer.invoke('move', dx),
  petReady: (auto) => ipcRenderer.send('pet-ready', auto),
  setInteractive: (interactive) => ipcRenderer.send('set-interactive', interactive),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  showMenu: (layerIndex) => ipcRenderer.send('show-menu', layerIndex),
  openWeChat: () => ipcRenderer.send('open-wechat'),
  onCursor: (listener) => ipcRenderer.on('cursor', (_event, position) => listener(position)),
  onMoveEnabled: (listener) => ipcRenderer.on('move-enabled', (_event, value) => listener(value)),
  onWholeAction: (listener) => ipcRenderer.on('whole-action', (_event, action) => listener(action)),
  onLayerAction: (listener) => ipcRenderer.on('layer-action', (_event, change) => listener(change)),
  onBadge: (listener) => ipcRenderer.on('badge', (_event, state) => listener(state)),
  onRemind: (listener) => ipcRenderer.on('remind', (_event, text) => listener(text)),
});
