const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getChains: () => ipcRenderer.invoke("get-chains"),
  getAddresses: (opts) => ipcRenderer.invoke("get-addresses", opts || {}),
  listBooks: () => ipcRenderer.invoke("list-books"),
  getAddressesMulti: (books) => ipcRenderer.invoke("get-addresses-multi", { books }),
  getAbi: (address, chainId) => ipcRenderer.invoke("get-abi", { address, chainId }),
  scanAddress: (address, chainId) => ipcRenderer.invoke("scan-address", { address, chainId }),
  checkCode: (rpcUrl, address) => ipcRenderer.invoke("check-code", { rpcUrl, address }),
  ethCall: (rpcUrl, to, data) => ipcRenderer.invoke("eth-call", { rpcUrl, to, data }),
  ethGetBalance: (rpcUrl, address) => ipcRenderer.invoke("eth-get-balance", { rpcUrl, address }),
  safeApiPending: (chainId, safeAddr, currentNonce) => ipcRenderer.invoke("safe-api-pending", { chainId, safeAddr, currentNonce }),
  safeApiHistory: (chainId, safeAddr, opts) => ipcRenderer.invoke("safe-api-history", { chainId, safeAddr, ...(opts || {}) }),
  safeApiByNonce: (chainId, safeAddr, nonce) => ipcRenderer.invoke("safe-api-by-nonce", { chainId, safeAddr, nonce }),
  safeApiInfo: (chainId, safeAddr) => ipcRenderer.invoke("safe-api-info", { chainId, safeAddr }),
  safeApiPropose: (args) => ipcRenderer.invoke("safe-api-propose", args),
  safeBuildTypedData: (args) => ipcRenderer.invoke("safe-build-typed-data", args),
  trezorInit: () => ipcRenderer.invoke("trezor-init"),
  trezorListAccounts: (opts) => ipcRenderer.invoke("trezor-list-accounts", opts || {}),
  trezorSignTyped: (args) => ipcRenderer.invoke("trezor-sign-typed", args),
  trezorVerifyAddress: (args) => ipcRenderer.invoke("trezor-verify-address", args),
  trezorDispose: () => ipcRenderer.invoke("trezor-dispose"),
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
  onShowAbout: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on("show-about", handler);
    return () => ipcRenderer.removeListener("show-about", handler);
  },
});
