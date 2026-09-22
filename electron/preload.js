const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('printPresetAPI', {
  openFileDialog: () => ipcRenderer.invoke('files:open-dialog'),

  // For drag-and-drop: renderer gets a File object from the DOM drop event,
  // we resolve its real filesystem path (webUtils, Electron 32+) and ask
  // main to stat + parse it the same way as dialog-picked files.
  readDroppedFile: (file) => {
    const filePath = webUtils.getPathForFile(file);
    return ipcRenderer.invoke('files:read-meta', filePath);
  },

  listPrinters: () => ipcRenderer.invoke('printers:list'),

  submitPrintJob: (payload) => ipcRenderer.invoke('print:submit', payload),
});
