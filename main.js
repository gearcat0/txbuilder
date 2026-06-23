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
ipcMain.handle("get-addresses", (_event, opts) => {
  const args = ["--addresses"];
  if (opts?.book) args.unshift("--book", opts.book);
  return runAddressbook(args).catch(() => []);
});
ipcMain.handle("list-books", () => runAddressbook(["--list-books"]).catch(() => ["Default"]));
ipcMain.handle("get-addresses-multi", async (_event, { books } = {}) => {
  const names = Array.isArray(books) && books.length > 0 ? books : ["Default"];
  const results = await Promise.all(names.map(async name => {
    try {
      const list = await runAddressbook(["--book", name, "--addresses"]);
      return (list || []).map(a => ({ ...a, _book: name }));
    } catch { return []; }
  }));
  return results.flat();
});
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

ipcMain.handle("eth-get-balance", async (_event, { rpcUrl, address }) => {
  if (!rpcUrl || !address) return { error: "Missing params" };
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
    });
    const json = await res.json();
    if (json.error) return { error: json.error.message };
    return { result: json.result };
  } catch (e) {
    return { error: e.message };
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

const SAFE_API_MIN_SPACING_MS = 220; // ~4.5/sec, comfortably under 5/sec
let safeApiLastCallAt = 0;
let safeApiQueue = Promise.resolve();

function safeApiThrottle() {
  const ticket = safeApiQueue.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, safeApiLastCallAt + SAFE_API_MIN_SPACING_MS - now);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    safeApiLastCallAt = Date.now();
  });
  safeApiQueue = ticket.catch(() => {});
  return ticket;
}

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

ipcMain.handle("safe-api-pending", async (_event, { chainId, safeAddr, currentNonce }) => {
  const base = SAFE_API_URLS[chainId];
  if (!base) return { error: `No Safe API URL for chain ${chainId}` };
  try {
    let url = `${base}/api/v1/safes/${safeAddr}/multisig-transactions/?executed=false&ordering=-nonce&limit=20`;
    if (Number.isFinite(currentNonce)) url += `&nonce__gte=${currentNonce}`;
    await safeApiThrottle();
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
    await safeApiThrottle();
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    broadcastRateLimit(res.headers);
    if (!res.ok) return { error: `HTTP ${res.status}: ${res.statusText}` };
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("safe-api-history", async (_event, { chainId, safeAddr, limit = 10, offset = 0, executedAfter, executedBefore, blockAfter, blockBefore }) => {
  const base = SAFE_API_URLS[chainId];
  if (!base) return { error: `No Safe API URL for chain ${chainId}` };
  try {
    const params = new URLSearchParams();
    params.set("executed", "true");
    params.set("ordering", "-executionDate");
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    if (executedAfter) params.set("executionDate__gte", executedAfter);
    if (executedBefore) params.set("executionDate__lte", executedBefore);
    if (blockAfter != null && blockAfter !== "") params.set("blockNumber__gte", String(blockAfter));
    if (blockBefore != null && blockBefore !== "") params.set("blockNumber__lte", String(blockBefore));
    const url = `${base}/api/v1/safes/${safeAddr}/multisig-transactions/?${params.toString()}`;
    await safeApiThrottle();
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    broadcastRateLimit(res.headers);
    if (!res.ok) return { error: `HTTP ${res.status}: ${res.statusText}` };
    const json = await res.json();
    return { results: json.results || [], count: json.count ?? null, next: json.next, previous: json.previous };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("safe-api-by-nonce", async (_event, { chainId, safeAddr, nonce }) => {
  const base = SAFE_API_URLS[chainId];
  if (!base) return { error: `No Safe API URL for chain ${chainId}` };
  try {
    const url = `${base}/api/v1/safes/${safeAddr}/multisig-transactions/?nonce=${nonce}&limit=10`;
    await safeApiThrottle();
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    broadcastRateLimit(res.headers);
    if (!res.ok) return { error: `HTTP ${res.status}: ${res.statusText}` };
    const json = await res.json();
    return { results: json.results || [] };
  } catch (e) {
    return { error: e.message };
  }
});

// ── Trezor (USB / Node mode) ─────────────────────────────────────────────
// Lazily loaded — only required when the user actually invokes a Trezor IPC.
let trezorConnect = null;
let trezorInitPromise = null;

async function ensureTrezor() {
  if (trezorConnect) return trezorConnect;
  if (trezorInitPromise) return trezorInitPromise;
  trezorInitPromise = (async () => {
    const mod = require("@trezor/connect");
    const TC = mod.default || mod;
    await TC.init({
      manifest: {
        appName: "TX Builder",
        email: "txbuilder@users.noreply.github.com",
        appUrl: "https://github.com/gearcat0/txbuilder",
      },
      lazyLoad: false,
      debug: false,
    });
    trezorConnect = TC;
    return TC;
  })();
  try {
    return await trezorInitPromise;
  } catch (e) {
    trezorInitPromise = null;
    throw e;
  }
}

ipcMain.handle("trezor-init", async () => {
  try {
    await ensureTrezor();
    return { success: true };
  } catch (e) {
    return { error: e.message || String(e) };
  }
});

ipcMain.handle("trezor-list-accounts", async (_event, { count = 5, startIndex = 0 } = {}) => {
  try {
    const TC = await ensureTrezor();
    const bundle = [];
    for (let i = 0; i < count; i++) {
      bundle.push({ path: `m/44'/60'/0'/0/${startIndex + i}`, showOnTrezor: false });
    }
    const res = await TC.ethereumGetAddress({ bundle });
    if (!res.success) return { error: res.payload?.error || "Trezor returned failure" };
    return { accounts: res.payload.map(p => ({ address: p.address, path: p.serializedPath })) };
  } catch (e) {
    return { error: e.message || String(e) };
  }
});

// Display the address derived at `path` on the device screen so the user can
// physically confirm it matches what TX Builder shows. Pure user verification —
// the device returns the same address it always derives at that path.
ipcMain.handle("trezor-verify-address", async (_event, { path }) => {
  try {
    const TC = await ensureTrezor();
    const res = await TC.ethereumGetAddress({ path, showOnTrezor: true });
    if (!res.success) return { error: res.payload?.error || "Trezor returned failure" };
    return { address: res.payload.address };
  } catch (e) {
    return { error: e.message || String(e) };
  }
});

ipcMain.handle("trezor-sign-typed", async (_event, { path, typedData }) => {
  try {
    const TC = await ensureTrezor();
    const res = await TC.ethereumSignTypedData({
      path,
      data: typedData,
      metamask_v4_compat: true,
    });
    if (!res.success) return { error: res.payload?.error || "Trezor returned failure" };
    return { address: res.payload.address, signature: res.payload.signature };
  } catch (e) {
    return { error: e.message || String(e) };
  }
});

ipcMain.handle("trezor-dispose", async () => {
  try {
    if (trezorConnect) {
      try { trezorConnect.dispose(); } catch {}
      trezorConnect = null;
      trezorInitPromise = null;
    }
    return { success: true };
  } catch (e) {
    return { error: e.message || String(e) };
  }
});

// Build a Safe transaction (with MultiSend if batched) and return the EIP-712
// typed data + safeTxHash. Does not sign, does not contact the Safe API —
// only on-chain RPC (for Safe version/threshold/owners) is touched.
ipcMain.handle("safe-build-typed-data", async (_event, { chainId, safeAddr, rpcUrl, transactions, nonce }) => {
  try {
    const Safe = require("@safe-global/protocol-kit").default;
    const protocolKit = await Safe.init({
      provider: rpcUrl,
      safeAddress: safeAddr,
    });
    const safeTransaction = await protocolKit.createTransaction({
      transactions: transactions.map(tx => ({
        to: tx.to,
        value: tx.ethValue || "0",
        data: tx.data || "0x",
        operation: 0,
      })),
      options: { nonce },
    });
    const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);
    const version = await protocolKit.getContractVersion();
    const d = safeTransaction.data;
    const typedData = {
      types: {
        EIP712Domain: [
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        SafeTx: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
          { name: "operation", type: "uint8" },
          { name: "safeTxGas", type: "uint256" },
          { name: "baseGas", type: "uint256" },
          { name: "gasPrice", type: "uint256" },
          { name: "gasToken", type: "address" },
          { name: "refundReceiver", type: "address" },
          { name: "nonce", type: "uint256" },
        ],
      },
      primaryType: "SafeTx",
      domain: {
        chainId: String(chainId),
        verifyingContract: safeAddr,
      },
      message: {
        to: d.to,
        value: String(d.value || "0"),
        data: d.data || "0x",
        operation: d.operation ?? 0,
        safeTxGas: String(d.safeTxGas || "0"),
        baseGas: String(d.baseGas || "0"),
        gasPrice: String(d.gasPrice || "0"),
        gasToken: d.gasToken || "0x0000000000000000000000000000000000000000",
        refundReceiver: d.refundReceiver || "0x0000000000000000000000000000000000000000",
        nonce: String(d.nonce ?? nonce ?? 0),
      },
    };
    return { safeTxHash, typedData, safeVersion: version };
  } catch (e) {
    return { error: e.message || String(e) };
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
    await safeApiThrottle();
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
