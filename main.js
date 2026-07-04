const { app, BrowserWindow, ipcMain, Menu } = require("electron");
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

function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

// ── Schema versioning for OUR persisted files (settings.json, batches.json) ──
// Each file carries a `_schemaVersion`. On load we run any migration functions
// from the file's version up to the current one, in order, then persist the
// upgraded file. A version-less legacy file is treated as v1 (the shape at the
// time versioning was introduced), so existing installs migrate cleanly.
//
// To evolve a schema later: bump the *_VERSION constant and add a migration
// keyed by the new version, e.g.
//   const SETTINGS_MIGRATIONS = { 2: (d) => { d.foo = d.oldFoo; delete d.oldFoo; return d; } };
// Migrations must be pure-ish transforms that return the migrated object.
//
// NOTE: evmaddressbook's own data files are intentionally NOT managed here —
// that stays evmaddressbook's responsibility (CLI only). See drift detection.
function applyMigrations(data, currentVersion, migrations, label) {
  const from = Number.isInteger(data._schemaVersion) ? data._schemaVersion : 1;
  if (from > currentVersion) {
    console.warn(`[schema] ${label} is v${from}, newer than this app's v${currentVersion}; leaving as-is.`);
    return { data, changed: false };
  }
  let out = data, ran = false;
  for (let v = from + 1; v <= currentVersion; v++) {
    if (typeof migrations[v] === "function") {
      out = migrations[v](out) || out;
      ran = true;
      console.log(`[schema] migrated ${label} to v${v}`);
    }
  }
  const changed = ran || data._schemaVersion !== currentVersion;
  out._schemaVersion = currentVersion;
  return { data: out, changed };
}

const SETTINGS_VERSION = 1;
const SETTINGS_MIGRATIONS = {
  // 2: (d) => { ...transform v1 -> v2...; return d; },
};

function loadSettings() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); }
  catch { return { _schemaVersion: SETTINGS_VERSION }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
  const { data, changed } = applyMigrations(raw, SETTINGS_VERSION, SETTINGS_MIGRATIONS, "settings.json");
  if (changed) { try { writeJSON(settingsPath, data); } catch {} }
  return data;
}

function saveSettings(data) {
  writeJSON(settingsPath, { ...data, _schemaVersion: SETTINGS_VERSION });
}

ipcMain.handle("load-settings", () => loadSettings());
ipcMain.handle("save-settings", (_event, data) => { saveSettings(data); return true; });

const batchesPath = path.join(getDataDir(), "batches.json");

const BATCHES_VERSION = 1;
const BATCHES_MIGRATIONS = {
  // 2: (store) => { store.batches = store.batches.map(...); return store; },
};

// batches.json is stored as { _schemaVersion, batches: [...] }. The legacy
// format was a bare array; wrap it (as v0) so migrations can run.
function loadBatches() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(batchesPath, "utf-8")); }
  catch { return []; }
  let store = Array.isArray(raw) ? { _schemaVersion: 0, batches: raw }
    : (raw && typeof raw === "object" ? raw : { batches: [] });
  if (!Array.isArray(store.batches)) store.batches = [];
  const { data, changed } = applyMigrations(store, BATCHES_VERSION, BATCHES_MIGRATIONS, "batches.json");
  if (changed) { try { writeJSON(batchesPath, data); } catch {} }
  return Array.isArray(data.batches) ? data.batches : [];
}

function saveBatchesFile(batches) {
  writeJSON(batchesPath, { _schemaVersion: BATCHES_VERSION, batches });
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

// Resolve which evmaddressbook executable to run. An explicit path in settings
// wins (with ~ expanded); otherwise fall back to "evmaddressbook" on PATH.
function resolveAddressbookPath(p) {
  p = typeof p === "string" ? p.trim() : "";
  if (!p) return "evmaddressbook";
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function getAddressbookBin() {
  try { return resolveAddressbookPath(loadSettings().addressbookPath); }
  catch { return "evmaddressbook"; }
}

// A macOS/Linux app launched from Finder/Dock inherits a stripped environment —
// not the user's shell PATH or exported vars (RPC URLs, API keys, config dirs).
// evmaddressbook can `--list-books` from a minimal env but needs the full one to
// fetch chains/addresses. Resolve the login-shell environment once and reuse it.
let shellEnvPromise = null;
function getShellEnv() {
  if (shellEnvPromise) return shellEnvPromise;
  shellEnvPromise = new Promise(resolve => {
    if (process.platform === "win32") return resolve(process.env);
    const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    const marker = "__TXB_ENV_MARKER__";
    // Interactive login shell so it sources both profile and rc files.
    execFile(shell, ["-ilc", `echo ${marker}; command env; echo ${marker}`],
      { timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout || !stdout.includes(marker)) return resolve(process.env);
        const body = stdout.split(marker)[1] || "";
        const env = { ...process.env };
        for (const line of body.split("\n")) {
          const i = line.indexOf("=");
          if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
        }
        resolve(env);
      });
  });
  return shellEnvPromise;
}

// evmaddressbook normally prints a single JSON value, but depending on the data
// state it can append diagnostics (scan warnings, etc.) to stdout after the
// JSON, which breaks a strict JSON.parse. Parse strictly first; if that fails,
// extract the first complete top-level JSON array/object via string-aware
// bracket matching and ignore any surrounding noise.
function parseAddressbookJSON(stdout) {
  const s = (stdout || "").trim();
  try { return { data: JSON.parse(s), clean: true }; } catch {}
  const a = s.indexOf("["), o = s.indexOf("{");
  const start = a === -1 ? o : (o === -1 ? a : Math.min(a, o));
  if (start === -1) throw new Error("no JSON value found in output");
  const open = s[start], close = open === "[" ? "]" : "}";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) {
      return { data: JSON.parse(s.slice(start, i + 1)), clean: false };
    }
  }
  throw new Error("unterminated JSON value in output");
}

// Read-only health signal for evmaddressbook. We never touch its files; we just
// notice when a command emits non-JSON noise (extra output around the result) or
// fails to parse — both of which usually mean its data is an older schema or it
// is mid-scan — and surface a non-blocking banner suggesting the user run
// evmaddressbook's own update/migrate. Keyed by command so a later clean run
// clears the issue.
const addressbookIssues = {}; // "chains" -> "message"
function noteAddressbook(cmd, issue) {
  if (issue) addressbookIssues[cmd] = issue;
  else delete addressbookIssues[cmd];
}

async function runAddressbook(args) {
  const bin = getAddressbookBin();
  const env = await getShellEnv();
  const cmd = args.join(" ");
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 10000, env, cwd: os.homedir(), maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[addressbook] \`${bin} ${cmd}\` failed:`, (stderr || err.message || "").trim());
        noteAddressbook(cmd, `command failed: ${(stderr || err.message || "").trim().slice(0, 160)}`);
        return reject(err);
      }
      try {
        const { data, clean } = parseAddressbookJSON(stdout);
        if (!clean) {
          console.warn(`[addressbook] \`${cmd}\` appended non-JSON output; parsed the JSON portion only.`);
          noteAddressbook(cmd, "returned extra non-JSON output around the result");
        } else {
          noteAddressbook(cmd, null);
        }
        resolve(data);
      } catch (e) {
        console.error(`[addressbook] \`${cmd}\` unparseable:`, (stdout || "").slice(0, 300));
        noteAddressbook(cmd, "output could not be parsed as JSON");
        reject(e);
      }
    });
  });
}

// Non-blocking drift/health report for the renderer banner.
ipcMain.handle("get-addressbook-status", () => {
  const cmds = Object.keys(addressbookIssues);
  return { healthy: cmds.length === 0, issues: cmds.map(c => ({ command: c, issue: addressbookIssues[c] })) };
});

// Diagnose a candidate binary path by running the exact commands the app relies
// on (list-books, chains, addresses). Uses the path as typed (not the saved
// setting) so the user can test before committing, plus the shell env.
ipcMain.handle("test-addressbook", async (_event, { path: candidate } = {}) => {
  const bin = resolveAddressbookPath(candidate);
  const env = await getShellEnv();
  const run = (args) => new Promise(resolve => {
    execFile(bin, args, { timeout: 10000, env, cwd: os.homedir(), maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || "").trim().slice(0, 300) });
      try {
        const { data, clean } = parseAddressbookJSON(stdout);
        resolve({ ok: true, count: Array.isArray(data) ? data.length : null, stripped: !clean });
      } catch {
        const raw = (stdout || "").replace(/\s+$/, "");
        const shown = raw.length > 900
          ? raw.slice(0, 600) + `\n… [${raw.length} bytes total] …\n` + raw.slice(-300)
          : raw;
        resolve({ ok: false, error: "Unparseable output", raw: shown, stderr: (stderr || "").trim().slice(0, 400) });
      }
    });
  });
  const [books, chains, addresses] = await Promise.all([
    run(["--list-books"]),
    run(["--chains"]),
    run(["--book", "Default", "--addresses"]),
  ]);
  return { bin, ok: books.ok && chains.ok && addresses.ok, books, chains, addresses };
});

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

ipcMain.handle("trezor-sign-typed", async (_event, { path, typedData, domainHash, messageHash }) => {
  try {
    const TC = await ensureTrezor();
    const res = await TC.ethereumSignTypedData({
      path,
      data: typedData,
      metamask_v4_compat: true,
      ...(domainHash ? { domain_separator_hash: domainHash } : {}),
      ...(messageHash ? { message_hash: messageHash } : {}),
    });
    if (!res.success) return { error: res.payload?.error || "Trezor returned failure" };
    return { address: res.payload.address, signature: res.payload.signature };
  } catch (e) {
    return { error: e.message || String(e) };
  }
});

// Abort the current device operation (e.g. user hit Cancel in our UI while
// the Trezor / Trezor Suite was waiting). Resolves the in-flight method call
// with a Method_Cancel failure rather than leaving it hanging.
ipcMain.handle("trezor-cancel", async (_event, { reason } = {}) => {
  try {
    if (trezorConnect) {
      try { trezorConnect.cancel(reason || "Cancelled by user"); } catch {}
    }
    return { success: true };
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
    // Precompute the EIP-712 component hashes. Trezor's ethereumSignTypedData
    // requires `domain_separator_hash`/`message_hash` for Model One (it throws
    // a validation error without them) and uses `message_hash` to show the
    // signed digest on Model T for SafeTx confirmations. keccak256(0x1901 ++
    // domainHash ++ messageHash) === safeTxHash.
    const { hashDomain, hashStruct } = require("viem");
    const domainHash = hashDomain({ domain: typedData.domain, types: typedData.types });
    const messageHash = hashStruct({ data: typedData.message, primaryType: "SafeTx", types: typedData.types });
    return { safeTxHash, typedData, domainHash, messageHash, safeVersion: version };
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

function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const sendAbout = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("show-about", {
        name: "TX Builder",
        version: app.getVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
      });
    }
  };
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { label: "About TX Builder", click: sendAbout },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "About TX Builder", click: sendAbout },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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

  setupWebHID(mainWindow.webContents.session);
}

// Ledger signing uses WebHID from the renderer (@ledgerhq/hw-transport-webhid).
// Electron blocks HID until we handle these events: auto-select any connected
// Ledger (USB vendor id 0x2c97) when the renderer calls requestDevice, and
// grant it persistent permission. The permission check is opened up because
// this is a trusted local app that only ever loads its own bundle.
const LEDGER_VENDOR_ID = 0x2c97;
function setupWebHID(ses) {
  ses.on("select-hid-device", (event, details, callback) => {
    event.preventDefault();
    const ledger = details.deviceList.find(d => d.vendorId === LEDGER_VENDOR_ID);
    callback(ledger ? ledger.deviceId : undefined);
  });
  ses.setDevicePermissionHandler(details =>
    details.deviceType === "hid" && details.device?.vendorId === LEDGER_VENDOR_ID
  );
  ses.setPermissionCheckHandler(() => true);
}

app.whenReady().then(() => {
  buildAppMenu();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
