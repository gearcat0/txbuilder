const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getChains: () => ipcRenderer.invoke("get-chains"),
  getAddresses: () => ipcRenderer.invoke("get-addresses"),
});
