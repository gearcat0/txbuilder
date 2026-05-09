const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getChains: () => ipcRenderer.invoke("get-chains"),
  getAddresses: () => ipcRenderer.invoke("get-addresses"),
  getAbi: (address, chainId) => ipcRenderer.invoke("get-abi", { address, chainId }),
  scanAddress: (address, chainId) => ipcRenderer.invoke("scan-address", { address, chainId }),
  checkCode: (rpcUrl, address) => ipcRenderer.invoke("check-code", { rpcUrl, address }),
  ethCall: (rpcUrl, to, data) => ipcRenderer.invoke("eth-call", { rpcUrl, to, data }),
  safeApiPending: (chainId, safeAddr, currentNonce) => ipcRenderer.invoke("safe-api-pending", { chainId, safeAddr, currentNonce }),
  safeApiHistory: (chainId, safeAddr, opts) => ipcRenderer.invoke("safe-api-history", { chainId, safeAddr, ...(opts || {}) }),
  safeApiByNonce: (chainId, safeAddr, nonce) => ipcRenderer.invoke("safe-api-by-nonce", { chainId, safeAddr, nonce }),
  safeApiInfo: (chainId, safeAddr) => ipcRenderer.invoke("safe-api-info", { chainId, safeAddr }),
  safeApiPropose: (args) => ipcRenderer.invoke("safe-api-propose", args),
  loadSettings: () => ipcRenderer.invoke("load-settings"),
  saveSettings: (data) => ipcRenderer.invoke("save-settings", data),
  listBatches: () => ipcRenderer.invoke("list-batches"),
  saveBatch: (batch) => ipcRenderer.invoke("save-batch", batch),
  deleteBatch: (id) => ipcRenderer.invoke("delete-batch", id),
  onSafeRateLimit: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on("safe-rate-limit", handler);
    return () => ipcRenderer.removeListener("safe-rate-limit", handler);
  },
});
