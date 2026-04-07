const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getChains: () => ipcRenderer.invoke("get-chains"),
  getAddresses: () => ipcRenderer.invoke("get-addresses"),
  checkCode: (rpcUrl, address) => ipcRenderer.invoke("check-code", { rpcUrl, address }),
});
