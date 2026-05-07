const { app, BrowserWindow, ipcMain } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const isDev = !app.isPackaged;

function getDataDir() {
  const platform = process.platform;
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "txbuilder");
  if (platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "txbuilder");
  return path.join(os.homedir(), ".local", "txbuilder");
}

const settingsPath = path.join(getDataDir(), "settings.json");

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath, "utf-8")); }
  catch { return {}; }
}

function saveSettings(data) {
  const dir = path.dirname(settingsPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));
}

ipcMain.handle("load-settings", () => loadSettings());
ipcMain.handle("save-settings", (_event, data) => { saveSettings(data); return true; });

const batchesPath = path.join(getDataDir(), "batches.json");

function loadBatches() {
  try { return JSON.parse(fs.readFileSync(batchesPath, "utf-8")); }
  catch { return []; }
}

function saveBatchesFile(batches) {
  const dir = path.dirname(batchesPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(batchesPath, JSON.stringify(batches, null, 2));
}

ipcMain.handle("list-batches", () => loadBatches());
ipcMain.handle("save-batch", (_event, batch) => {
  const batches = loadBatches();
  const idx = batches.findIndex(b => b.id === batch.id);
  if (idx >= 0) batches[idx] = batch;
  else batches.push(batch);
  saveBatchesFile(batches);
  return true;
});
ipcMain.handle("delete-batch", (_event, id) => {
  const batches = loadBatches().filter(b => b.id !== id);
  saveBatchesFile(batches);
  return true;
});

function runAddressbook(args) {
  return new Promise((resolve, reject) => {
    execFile("evmaddressbook", args, { timeout: 10000 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(e); }
    });
  });
}

ipcMain.handle("get-chains", () => runAddressbook(["--chains"]).catch(() => []));
ipcMain.handle("get-addresses", () => runAddressbook(["--addresses"]).catch(() => []));
ipcMain.handle("get-abi", (_event, { address, chainId }) =>
  runAddressbook(["--abi", address, String(chainId)]).catch(() => null)
);
ipcMain.handle("scan-address", (_event, { address, chainId }) =>
  runAddressbook(["--scan", address, String(chainId)]).catch(() => null)
);

ipcMain.handle("check-code", async (_event, { rpcUrl, address }) => {
  if (!rpcUrl || !address) return { hasCode: null };
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
    });
    const json = await res.json();
    if (json.error) return { hasCode: null };
    const code = json.result;
    return { hasCode: !!(code && code !== "0x" && code !== "0x0") };
  } catch (e) {
    return { hasCode: null };
  }
});

ipcMain.handle("eth-call", async (_event, { rpcUrl, to, data }) => {
  if (!rpcUrl || !to) return { error: "Missing params" };
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    });
    const json = await res.json();
    if (json.error) return { error: json.error.message };
    return { result: json.result };
  } catch (e) {
    return { error: e.message };
  }
});

let mainWindow = null;

function broadcastRateLimit(headers) {
  if (!headers) return;
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (!limit && !remaining) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("safe-rate-limit", {
      limit: limit ? Number(limit) : null,
      remaining: remaining ? Number(remaining) : null,
      reset: reset ? Number(reset) : null,
      at: Date.now(),
    });
  }
}

const SAFE_API_URLS = {
  1: "https://safe-transaction-mainnet.safe.global",
  10: "https://safe-transaction-optimism.safe.global",
  56: "https://safe-transaction-bsc.safe.global",
  100: "https://safe-transaction-gnosis-chain.safe.global",
  137: "https://safe-transaction-polygon.safe.global",
  324: "https://safe-transaction-zksync.safe.global",
  8453: "https://safe-transaction-base.safe.global",
  42161: "https://safe-transaction-arbitrum.safe.global",
  43114: "https://safe-transaction-avalanche.safe.global",
  84532: "https://safe-transaction-base-sepolia.safe.global",
  11155111: "https://safe-transaction-sepolia.safe.global",
};

ipcMain.handle("safe-api-pending", async (_event, { chainId, safeAddr }) => {
  const base = SAFE_API_URLS[chainId];
  if (!base) return { error: `No Safe API URL for chain ${chainId}` };
  try {
    const url = `${base}/api/v1/safes/${safeAddr}/multisig-transactions/?executed=false&ordering=-nonce&limit=20`;
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    broadcastRateLimit(res.headers);
    if (!res.ok) return { error: `HTTP ${res.status}: ${res.statusText}` };
    const json = await res.json();
    return { results: json.results || [] };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("safe-api-info", async (_event, { chainId, safeAddr }) => {
  const base = SAFE_API_URLS[chainId];
  if (!base) return { error: `No Safe API URL for chain ${chainId}` };
  try {
    const url = `${base}/api/v1/safes/${safeAddr}/`;
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    broadcastRateLimit(res.headers);
    if (!res.ok) return { error: `HTTP ${res.status}: ${res.statusText}` };
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("safe-api-history", async (_event, { chainId, safeAddr, limit = 50 }) => {
  const base = SAFE_API_URLS[chainId];
  if (!base) return { error: `No Safe API URL for chain ${chainId}` };
  try {
    const url = `${base}/api/v1/safes/${safeAddr}/multisig-transactions/?executed=true&ordering=-executionDate&limit=${limit}`;
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    broadcastRateLimit(res.headers);
    if (!res.ok) return { error: `HTTP ${res.status}: ${res.statusText}` };
    const json = await res.json();
    return { results: json.results || [] };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("safe-api-by-nonce", async (_event, { chainId, safeAddr, nonce }) => {
  const base = SAFE_API_URLS[chainId];
  if (!base) return { error: `No Safe API URL for chain ${chainId}` };
  try {
    const url = `${base}/api/v1/safes/${safeAddr}/multisig-transactions/?nonce=${nonce}&limit=10`;
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    broadcastRateLimit(res.headers);
    if (!res.ok) return { error: `HTTP ${res.status}: ${res.statusText}` };
    const json = await res.json();
    return { results: json.results || [] };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("safe-api-propose", async (_event, { chainId, safeAddr, rpcUrl, privateKey, transactions, nonce, safeApiKey }) => {
  try {
    const SafeApiKit = require("@safe-global/api-kit").default;
    const Safe = require("@safe-global/protocol-kit").default;

    const apiKit = new SafeApiKit({ chainId: BigInt(chainId), apiKey: safeApiKey });

    const protocolKit = await Safe.init({
      provider: rpcUrl,
      signer: privateKey,
      safeAddress: safeAddr,
    });

    // Build the Safe transaction
    const safeTransaction = await protocolKit.createTransaction({
      transactions: transactions.map(tx => ({
        to: tx.to,
        value: tx.ethValue || "0",
        data: tx.data || "0x",
        operation: 0,
      })),
      options: { nonce },
    });

    // Sign the transaction
    const signedTx = await protocolKit.signTransaction(safeTransaction);
    const txHash = await protocolKit.getTransactionHash(signedTx);
    const signerAddress = await protocolKit.getSafeProvider().getSignerAddress();

    // Propose to the Safe Transaction Service
    await apiKit.proposeTransaction({
      safeAddress: safeAddr,
      safeTransactionData: signedTx.data,
      safeTxHash: txHash,
      senderAddress: signerAddress,
      senderSignature: signedTx.encodedSignatures(),
    });

    return { success: true, safeTxHash: txHash, signer: signerAddress };
  } catch (e) {
    return { error: e.message || String(e) };
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 2560,
    height: 1640,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#08080A",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 14 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  const devServer = process.env.VITE_DEV_SERVER === "1";
  if (devServer) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "dist", "index.html"));
  }
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.setZoomFactor(2);
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
