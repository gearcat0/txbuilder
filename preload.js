const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getChains: () => ipcRenderer.invoke("get-chains"),
  getAddresses: () => ipcRenderer.invoke("get-addresses"),
  getAbi: (address, chainId) => ipcRenderer.invoke("get-abi", { address, chainId }),
  scanAddress: (address, chainId) => ipcRenderer.invoke("scan-address", { address, chainId }),
  checkCode: (rpcUrl, address) => ipcRenderer.invoke("check-code", { rpcUrl, address }),
  ethCall: (rpcUrl, to, data) => ipcRenderer.invoke("eth-call", { rpcUrl, to, data }),
});
