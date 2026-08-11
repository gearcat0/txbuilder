const { app, BrowserWindow, ipcMain, Menu, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Run a binary and capture its FULL stdout/stderr. We redirect the child's
// stdout/stderr straight to temp files (OS-level, exactly like a shell
// `> file`) rather than reading them through Node pipes: on macOS, reading a
// child's stdout pipe from the packaged app's main process was capping at the
// ~8 KB pipe-buffer boundary. Writing to real fds bypasses the pipe entirely
// and matches the terminal behaviour the user confirmed works. Returns the
// complete output plus exit info for diagnostics.
let binSeq = 0;
function runBin(bin, args, { env, cwd, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const stamp = `${process.pid}-${binSeq++}`;
    const outPath = path.join(os.tmpdir(), `txb-ab-${stamp}.out`);
    const errPath = path.join(os.tmpdir(), `txb-ab-${stamp}.err`);
    const done = (result) => {
      let stdout = "", stderr = "";
      try { stdout = fs.readFileSync(outPath, "utf8"); } catch {}
      try { stderr = fs.readFileSync(errPath, "utf8"); } catch {}
      try { fs.unlinkSync(outPath); } catch {}
      try { fs.unlinkSync(errPath); } catch {}
      resolve({ stdout, stderr, ...result });
    };
    let outFd, errFd;
    try { outFd = fs.openSync(outPath, "w"); errFd = fs.openSync(errPath, "w"); }
    catch (e) { return done({ error: e, code: null, signal: null, timedOut: false }); }
    let child;
    try { child = spawn(bin, args, { env, cwd, stdio: ["ignore", outFd, errFd] }); }
    catch (e) {
      try { fs.closeSync(outFd); } catch {}
      try { fs.closeSync(errFd); } catch {}
      return done({ error: e, code: null, signal: null, timedOut: false });
    }
    // The child holds its own dup of the fds; close ours so only the child writes.
    try { fs.closeSync(outFd); } catch {}
    try { fs.closeSync(errFd); } catch {}
    let settled = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGTERM"); } catch {} }, timeoutMs);
    const finish = (result) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      done({ timedOut, ...result });
    };
    child.on("error", e => finish({ error: e, code: null, signal: null }));
    child.on("close", (code, signal) => finish({ error: null, code, signal }));
  });
}

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
  shellEnvPromise = (async () => {
    if (process.platform === "win32") return process.env;
    const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    const marker = "__TXB_ENV_MARKER__";
    // Interactive login shell so it sources both profile and rc files. Read via
    // runBin (fd redirect) so a large environment can't be truncated by the pipe.
    const r = await runBin(shell, ["-ilc", `echo ${marker}; command env; echo ${marker}`], { timeoutMs: 8000 });
    const stdout = r.stdout || "";
    if (!stdout.includes(marker)) return process.env;
    const body = stdout.split(marker)[1] || "";
    const env = { ...process.env };
    for (const line of body.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
    }
    return env;
  })();
  return shellEnvPromise;
}

// Extract the first complete top-level JSON array/object via string-aware
// bracket matching, ignoring any surrounding noise. Returns the slice or null.
function extractFirstJSON(s) {
  const a = s.indexOf("["), o = s.indexOf("{");
  const start = a === -1 ? o : (o === -1 ? a : Math.min(a, o));
  if (start === -1) return null;
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
    else if (c === close && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

// evmaddressbook can embed raw control characters (unescaped newlines/tabs in
// scan-error strings) which are invalid JSON. Escape control chars that occur
// *inside* string literals so the payload parses without altering its meaning.
function escapeRawControlChars(s) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], code = s.charCodeAt(i);
    if (inStr) {
      if (esc) { out += c; esc = false; continue; }
      if (c === "\\") { out += c; esc = true; continue; }
      if (c === '"') { out += c; inStr = false; continue; }
      if (code < 0x20) {
        out += code === 10 ? "\\n" : code === 9 ? "\\t" : code === 13 ? "\\r"
          : "\\u" + code.toString(16).padStart(4, "0");
        continue;
      }
      out += c;
    } else {
      out += c;
      if (c === '"') inStr = true;
    }
  }
  return out;
}

// Parse evmaddressbook output as leniently as is safe. In order: strict parse,
// first-JSON-value extraction (ignore surrounding noise), then the same two on a
// control-char-repaired copy. `clean` is true only when the raw output parsed
// strictly as-is. On total failure, throw an error carrying the exact position.
function parseAddressbookJSON(stdout) {
  const s = (stdout || "").trim();
  try { return { data: JSON.parse(s), clean: true }; } catch {}
  const firstRaw = extractFirstJSON(s);
  if (firstRaw != null) { try { return { data: JSON.parse(firstRaw), clean: false }; } catch {} }
  const repaired = escapeRawControlChars(s);
  if (repaired !== s) {
    try { return { data: JSON.parse(repaired), clean: false }; } catch {}
    const firstRepaired = extractFirstJSON(repaired);
    if (firstRepaired != null) { try { return { data: JSON.parse(firstRepaired), clean: false }; } catch {} }
  }
  let msg = "output is not valid JSON";
  try { JSON.parse(s); } catch (e) { msg = e.message; }
  const err = new Error(msg);
  err.rawLen = s.length;
  const m = /(?:position|char) (\d+)/.exec(msg);
  if (m) err.at = parseInt(m[1], 10);
  throw err;
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
  const r = await runBin(bin, args, { env, cwd: os.homedir(), timeoutMs: 20000 });
  if (r.error) {
    console.error(`[addressbook] \`${bin} ${cmd}\` could not run:`, r.error.message);
    noteAddressbook(cmd, `could not run: ${r.error.message}`);
    throw r.error;
  }
  // Non-empty stdout is still worth parsing even on a non-zero exit; only treat
  // it as a hard failure when there is nothing usable to parse.
  if ((r.code !== 0 || r.timedOut) && !r.stdout.trim()) {
    const detail = (r.stderr || (r.timedOut ? "timed out" : `exit ${r.code}${r.signal ? ` (${r.signal})` : ""}`)).trim();
    console.error(`[addressbook] \`${bin} ${cmd}\` failed:`, detail);
    noteAddressbook(cmd, `command failed: ${detail.slice(0, 160)}`);
    throw new Error(detail);
  }
  try {
    const { data, clean } = parseAddressbookJSON(r.stdout);
    if (!clean) {
      console.warn(`[addressbook] \`${cmd}\` had extra non-JSON output; parsed the JSON portion only.`);
      noteAddressbook(cmd, "returned extra non-JSON output around the result");
    } else {
      noteAddressbook(cmd, null);
    }
    return data;
  } catch (e) {
    const s = r.stdout.trim();
    const near = Number.isInteger(e.at) ? s.slice(Math.max(0, e.at - 80), e.at + 80) : s.slice(0, 200);
    console.error(`[addressbook] \`${cmd}\` unparseable (${e.message}); ${s.length} bytes captured; near:`, near);
    noteAddressbook(cmd, e.message || "output could not be parsed as JSON");
    throw e;
  }
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
  const run = async (args) => {
    const r = await runBin(bin, args, { env, cwd: os.homedir(), timeoutMs: 20000 });
    // Always write the complete captured stdout/stderr so we can compare them
    // byte-for-byte against a terminal run (our own debug files, not
    // evmaddressbook's data).
    let dumpPath = null, stderrPath = null;
    try {
      const safe = args.join("_").replace(/[^\w.-]/g, "") || "cmd";
      dumpPath = path.join(getDataDir(), `addressbook-debug-${safe}.txt`);
      fs.mkdirSync(getDataDir(), { recursive: true });
      fs.writeFileSync(dumpPath, r.stdout || "");
      if (r.stderr) { stderrPath = path.join(getDataDir(), `addressbook-debug-${safe}.stderr.txt`); fs.writeFileSync(stderrPath, r.stderr); }
    } catch { dumpPath = null; }
    const exit = `exit ${r.code}${r.signal ? ` ${r.signal}` : ""}${r.timedOut ? " (timed out)" : ""}, ${r.stdout.length} bytes stdout`;
    if (r.error) return { ok: false, error: `could not run: ${r.error.message}`, dumpPath, stderrPath };
    try {
      const { data, clean } = parseAddressbookJSON(r.stdout);
      return { ok: true, count: Array.isArray(data) ? data.length : null, stripped: !clean, bytes: r.stdout.length };
    } catch (e) {
      const s = r.stdout.trim();
      let raw;
      if (Number.isInteger(e.at)) {
        const a = Math.max(0, e.at - 120), b = Math.min(s.length, e.at + 120);
        raw = (a > 0 ? "…" : "") + s.slice(a, b) + (b < s.length ? "…" : "");
      } else {
        raw = s.length > 900 ? s.slice(0, 600) + `\n… [${s.length} bytes total] …\n` + s.slice(-300) : s;
      }
      return {
        ok: false,
        error: e.message ? `Unparseable: ${e.message}` : "Unparseable output",
        at: `${exit}${Number.isInteger(e.at) ? `; break at byte ${e.at}` : ""}`,
        raw, stderr: (r.stderr || "").trim().slice(0, 400), dumpPath, stderrPath,
      };
    }
  };
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

// All ad-hoc JSON-RPC goes through here so every call gets a timeout — an
// unreachable RPC endpoint must never hang an invoke until the socket dies.
async function rpcFetch(rpcUrl, body) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return res.json();
}

ipcMain.handle("check-code", async (_event, { rpcUrl, address }) => {
  if (!rpcUrl || !address) return { hasCode: null };
  try {
    const json = await rpcFetch(rpcUrl, { jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] });
    if (json.error) return { hasCode: null };
    const code = json.result;
    return { hasCode: !!(code && code !== "0x" && code !== "0x0") };
  } catch (e) {
    return { hasCode: null };
  }
});

// Like check-code but returns the actual bytecode, with error kinds the
// renderer can distinguish: "rpc" (node rejected) vs "network" (unreachable).
ipcMain.handle("eth-get-code", async (_event, { rpcUrl, address }) => {
  if (!rpcUrl || !address) return { error: { kind: "no-rpc", message: "Missing rpcUrl or address" } };
  try {
    const json = await rpcFetch(rpcUrl, { jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] });
    if (json.error) return { error: { kind: "rpc", message: json.error.message } };
    return { code: json.result };
  } catch (e) {
    return { error: { kind: "network", message: e.message } };
  }
});

ipcMain.handle("eth-get-balance", async (_event, { rpcUrl, address }) => {
  if (!rpcUrl || !address) return { error: "Missing params" };
  try {
    const json = await rpcFetch(rpcUrl, { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] });
    if (json.error) return { error: json.error.message };
    return { result: json.result };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("eth-call", async (_event, { rpcUrl, to, data }) => {
  if (!rpcUrl || !to) return { error: "Missing params" };
  try {
    const json = await rpcFetch(rpcUrl, { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] });
    if (json.error) return { error: json.error.message };
    return { result: json.result };
  } catch (e) {
    return { error: e.message };
  }
});

// Batched JSON-RPC for capability detection (proxy slots, ERC-165 probes...):
// one POST instead of N round trips. Falls back to sequential single requests
// for endpoints that don't accept batch arrays.
const RPC_BATCH_METHODS = new Set(["eth_getCode", "eth_getStorageAt", "eth_call", "eth_getBalance"]);

ipcMain.handle("rpc-batch", async (_event, { rpcUrl, requests }) => {
  if (!rpcUrl || !Array.isArray(requests) || requests.length === 0) return { error: "Missing params" };
  if (requests.length > 20) return { error: "Too many requests in batch" };
  for (const r of requests) {
    if (!r || !RPC_BATCH_METHODS.has(r.method) || !Array.isArray(r.params)) {
      return { error: `Bad batch request: ${r && r.method}` };
    }
  }
  const toEntry = (json) =>
    json && json.error
      ? { error: { code: json.error.code, message: json.error.message } }
      : { result: json ? json.result : undefined };
  try {
    const body = requests.map((r, i) => ({ jsonrpc: "2.0", id: i, method: r.method, params: r.params }));
    const json = await rpcFetch(rpcUrl, body);
    if (Array.isArray(json)) {
      const results = requests.map(() => ({ error: { message: "No response for request" } }));
      for (const item of json) {
        if (item && Number.isInteger(item.id) && item.id >= 0 && item.id < results.length) {
          results[item.id] = toEntry(item);
        }
      }
      return { results };
    }
  } catch (e) {
    return { error: e.message };
  }
  // Non-array reply: endpoint rejected the batch form. Replay sequentially.
  try {
    const results = [];
    for (const r of requests) {
      const json = await rpcFetch(rpcUrl, { jsonrpc: "2.0", id: 1, method: r.method, params: r.params });
      results.push(toEntry(json));
    }
    return { results };
  } catch (e) {
    return { error: e.message };
  }
});

// Extract function selectors / argument types / mutability from raw bytecode.
// evmole runs here (not the renderer) because its browser build fetch()es its
// wasm, which file:// blocks in the packaged app; the Node build reads it via
// fs and works inside the asar.
let evmole = null;

ipcMain.handle("analyze-bytecode", (_event, { code }) => {
  if (!code || typeof code !== "string" || code.length < 4) return { error: "No bytecode" };
  if (code.length > 100000) return { error: "Bytecode too large" };
  try {
    evmole ??= require("evmole");
    const info = evmole.contractInfo(code, { selectors: true, arguments: true, stateMutability: true });
    return { functions: (info && info.functions) || [] };
  } catch (e) {
    return { error: e.message };
  }
});

// ── Selector-signature lookup ───────────────────────────────────────────────
// The bundled signature DB lives in the renderer; this is the online fallback
// (openchain.xyz) with a persistent disk cache. Only 4-byte selectors are ever
// sent — never addresses. Resolved names cache forever (a selector's preimage
// can't change); misses are remembered for this session only, so names added
// to openchain later get picked up.
const sigsPath = path.join(getDataDir(), "abi-cache", "sigs.json");
const SIGS_VERSION = 1;
const SIGS_MIGRATIONS = {};
let sigsMemo = null;
const sigMisses = new Set();

function loadSigs() {
  if (sigsMemo) return sigsMemo;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(sigsPath, "utf-8")); } catch { raw = null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = { signatures: {} };
  const { data } = applyMigrations(raw, SIGS_VERSION, SIGS_MIGRATIONS, "abi-cache/sigs.json");
  sigsMemo = data.signatures && typeof data.signatures === "object" ? data.signatures : {};
  return sigsMemo;
}

ipcMain.handle("lookup-signatures", async (_event, { selectors }) => {
  if (!Array.isArray(selectors) || selectors.length === 0) return { signatures: {} };
  const clean = [...new Set(selectors.filter(s => /^0x[0-9a-fA-F]{8}$/.test(s)).map(s => s.toLowerCase()))];
  const known = loadSigs();
  const out = {};
  const misses = [];
  for (const sel of clean) {
    if (known[sel]) out[sel] = known[sel];
    else if (sigMisses.has(sel)) out[sel] = null;
    else misses.push(sel);
  }
  if (misses.length) {
    try {
      const url = `https://api.openchain.xyz/signature-database/v1/lookup?function=${misses.join(",")}&filter=true`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const json = await res.json();
      const fns = (json && json.result && json.result.function) || {};
      let added = false;
      for (const sel of misses) {
        const hits = Array.isArray(fns[sel]) ? fns[sel].filter(h => h && h.name) : [];
        if (hits.length) { known[sel] = hits[0].name; out[sel] = hits[0].name; added = true; }
        else { sigMisses.add(sel); out[sel] = null; }
      }
      if (added) { try { writeJSON(sigsPath, { _schemaVersion: SIGS_VERSION, signatures: known }); } catch {} }
    } catch {
      for (const sel of misses) if (!(sel in out)) out[sel] = null;
    }
  }
  return { signatures: out };
});

// ── On-disk ABI cache ───────────────────────────────────────────────────────
// Layout under <dataDir>/abi-cache/:
//   addr/<chainId>-<address>.json  per-address detection record
//   code/<codehash>.json           detected ABIs, content-addressed by bytecode
//   impl/<chainId>-<address>.json  addressbook-sourced ABIs keyed by source addr
// Invalidation is by codehash comparison, no TTL: abi-cache-get takes the
// codehash of the freshly fetched bytecode and drops the record on mismatch.
// Safe built-in ABIs ship with the app and are never cached. This cache is
// OURS — evmaddressbook's data files stay CLI-managed (see note above).
const ABI_CACHE_VERSION = 1;
const ABI_CACHE_MIGRATIONS = {};
const abiCacheDir = path.join(getDataDir(), "abi-cache");
const ABI_CACHE_KINDS = new Set(["addr", "code", "impl"]);

function abiCachePath(kind, key) {
  if (!ABI_CACHE_KINDS.has(kind) || !/^[0-9a-z-]+$/i.test(String(key))) throw new Error(`Bad cache key: ${kind}/${key}`);
  return path.join(abiCacheDir, kind, `${key}.json`);
}

function addrCacheKey(chainId, address) {
  return `${chainId}-${String(address).toLowerCase()}`;
}

function readCacheFile(p) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    try { fs.unlinkSync(p); } catch {}
    return null;
  }
  const { data } = applyMigrations(raw, ABI_CACHE_VERSION, ABI_CACHE_MIGRATIONS, `abi-cache/${path.basename(p)}`);
  return data;
}

function readAbiRef(ref) {
  if (!ref || !ref.kind || !ref.key) return null;
  try {
    const file = readCacheFile(abiCachePath(ref.kind, ref.key));
    return Array.isArray(file && file.abi) ? file.abi : null;
  } catch {
    return null;
  }
}

ipcMain.handle("abi-cache-get", (_event, { chainId, address, codehash }) => {
  if (!chainId || !address || !codehash) return null;
  try {
    const p = abiCachePath("addr", addrCacheKey(chainId, address));
    const record = readCacheFile(p);
    if (!record) return null;
    if (record.codehash !== codehash) {
      try { fs.unlinkSync(p); } catch {}
      return null;
    }
    return { record, implAbi: readAbiRef(record.implAbiRef), proxyAbi: readAbiRef(record.proxyAbiRef) };
  } catch {
    return null;
  }
});

ipcMain.handle("abi-cache-put", (_event, { chainId, address, record, implAbi, proxyAbi }) => {
  if (!chainId || !address || !record) return false;
  try {
    const stamp = Date.now();
    const store = (ref, abi) => {
      if (!ref || !Array.isArray(abi)) return;
      writeJSON(abiCachePath(ref.kind, ref.key), {
        _schemaVersion: ABI_CACHE_VERSION, abi, source: ref.source || null, savedAt: stamp,
      });
    };
    store(record.implAbiRef, implAbi);
    store(record.proxyAbiRef, proxyAbi);
    writeJSON(abiCachePath("addr", addrCacheKey(chainId, address)), {
      ...record, _schemaVersion: ABI_CACHE_VERSION, chainId, address, savedAt: stamp,
    });
    return true;
  } catch (e) {
    console.warn("[abi-cache] put failed:", e.message);
    return false;
  }
});

ipcMain.handle("abi-cache-bust", (_event, { chainId, address }) => {
  try {
    const p = abiCachePath("addr", addrCacheKey(chainId, address));
    const record = readCacheFile(p);
    for (const ref of [record && record.implAbiRef, record && record.proxyAbiRef]) {
      // Only impl-keyed files can go stale; content-addressed code/ files can't.
      if (ref && ref.kind === "impl") {
        try { fs.unlinkSync(abiCachePath("impl", ref.key)); } catch {}
      }
    }
    try { fs.unlinkSync(p); } catch {}
  } catch {}
  return true;
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

// Common Safe contract revert codes, mapped to actionable messages.
const GS_ERRORS = {
  GS010: "Not enough gas to execute the Safe transaction",
  GS013: "Safe transaction failed (the inner transaction reverted)",
  GS020: "Signatures data too short — not enough signatures for the threshold",
  GS024: "Invalid contract signature",
  GS025: "Hash has not been approved by the required signer",
  GS026: "Invalid owner signature — a signature is not from a current owner",
};

// Execute the Safe transaction on-chain: execTransaction(to, value, data,
// operation, 0, 0, 0, 0x0, 0x0, signatures), with the executor EOA paying
// gas the regular way. protocol-kit selects the version-correct contract
// binding from the on-chain VERSION() and concatenates signatures in
// ascending-signer-address order, which every Safe version's checkNSignatures
// requires. Only the user's own RPC is touched — no Safe infrastructure.
ipcMain.handle("safe-exec-transaction", async (_event, { chainId, safeAddr, rpcUrl, transactions, nonce, signatures, executorKey }) => {
  try {
    const pk = require("@safe-global/protocol-kit");
    const Safe = pk.default;
    const key = String(executorKey).startsWith("0x") ? executorKey : `0x${executorKey}`;
    const protocolKit = await Safe.init({ provider: rpcUrl, signer: key, safeAddress: safeAddr });
    const safeTransaction = await protocolKit.createTransaction({
      transactions: transactions.map(tx => ({
        to: tx.to,
        value: tx.ethValue || "0",
        data: tx.data || "0x",
        operation: 0,
      })),
      options: { nonce },
    });
    for (const s of signatures || []) {
      safeTransaction.addSignature(new pk.EthSafeSignature(s.address, s.sig));
    }
    const result = await protocolKit.executeTransaction(safeTransaction);
    return { txHash: result.hash };
  } catch (e) {
    let msg = e?.message || String(e);
    const gs = msg.match(/GS0\d\d/);
    if (gs && GS_ERRORS[gs[0]]) msg = `${GS_ERRORS[gs[0]]} (${gs[0]})`;
    return { error: msg };
  }
});

ipcMain.handle("eth-get-receipt", async (_event, { rpcUrl, txHash }) => {
  if (!rpcUrl || !txHash) return { error: "Missing params" };
  try {
    const json = await rpcFetch(rpcUrl, { jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] });
    if (json.error) return { error: json.error.message };
    return { receipt: json.result }; // null while still pending
  } catch (e) {
    return { error: e.message };
  }
});

// ── Tenderly simulation ─────────────────────────────────────────────────────
// Opt-in (requires the user's own Tenderly account/project/access key). Only
// the encoded execTransaction call is sent to api.tenderly.co — no keys, no
// signatures beyond what the transaction itself carries.
const TENDERLY_API_BASE = process.env.TENDERLY_API_BASE || "https://api.tenderly.co";
// Kept in sync with src/lib/tenderly.js (which the renderer + unit tests use);
// duplicated here because main is unbundled and can't import the ESM module.
// The E2E suite asserts these against the actual wire request.
const TENDERLY_THRESHOLD_SLOT = "0x" + "0".repeat(63) + "4";
function approvedHashSignature(owner) {
  return "0x" + owner.replace(/^0x/, "").toLowerCase().padStart(64, "0") + "0".repeat(64) + "01";
}
function thresholdOverride(safeAddr) {
  return { [safeAddr]: { storage: { [TENDERLY_THRESHOLD_SLOT]: "0x" + "0".repeat(63) + "1" } } };
}
function buildSimRequest({ chainId, safeAddr, from, input, override }) {
  const body = {
    network_id: String(chainId), from, to: safeAddr, input,
    gas: 8000000, value: 0, save: true, save_if_fails: true, simulation_type: "full",
  };
  if (override) body.state_objects = thresholdOverride(safeAddr);
  return body;
}
function parseSimResponse(json) {
  const tx = (json && json.transaction) || {};
  const sim = (json && json.simulation) || {};
  if (!sim.id) return null;
  return {
    id: sim.id,
    status: tx.status === true,
    gasUsed: typeof tx.gas_used === "number" ? tx.gas_used : null,
    errorMessage: tx.error_message || (tx.error_info && tx.error_info.error_message) || (tx.status === true ? null : "Reverted (no reason returned)"),
  };
}
const tenderlyDashboardUrl = (account, project, id) => `https://dashboard.tenderly.co/${account}/${project}/simulator/${id}`;
const tenderlySharedUrl = (id) => `https://dashboard.tenderly.co/shared/simulation/${id}`;
const EXEC_TX_ABI = [{
  type: "function", name: "execTransaction", stateMutability: "payable",
  inputs: [
    { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" },
    { name: "signatures", type: "bytes" },
  ],
  outputs: [{ name: "success", type: "bool" }],
}];

ipcMain.handle("tenderly-simulate", async (_event, args) => {
  const { chainId, safeAddr, rpcUrl, from, transactions, safeTx, nonce, signatures, account, project, accessKey } = args;
  try {
    const pk = require("@safe-global/protocol-kit");
    const viem = require("viem");

    // Resolve the SafeTx core fields, either from a prebuilt tx (Safe API
    // pending) or by building one from the batch (same path as exec/build).
    let core = safeTx;
    if (!core) {
      const protocolKit = await pk.default.init({ provider: rpcUrl, safeAddress: safeAddr });
      const built = await protocolKit.createTransaction({
        transactions: transactions.map(tx => ({ to: tx.to, value: tx.ethValue || "0", data: tx.data || "0x", operation: 0 })),
        options: { nonce },
      });
      core = { to: built.data.to, value: built.data.value, data: built.data.data, operation: built.data.operation };
    }

    // Exact mode uses the real signatures (ascending order via buildSignatureBytes);
    // override mode fakes a single approved-hash signature + threshold override.
    const exact = Array.isArray(signatures) && signatures.length > 0;
    let sigBlob, override;
    if (exact) {
      sigBlob = pk.buildSignatureBytes(signatures.map(s => new pk.EthSafeSignature(s.address, s.sig)));
      override = false;
    } else {
      sigBlob = approvedHashSignature(from);
      override = true;
    }

    const input = viem.encodeFunctionData({
      abi: EXEC_TX_ABI, functionName: "execTransaction",
      args: [core.to, BigInt(core.value || 0), core.data || "0x", core.operation || 0, 0n, 0n, 0n,
        "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", sigBlob],
    });

    const body = buildSimRequest({ chainId, safeAddr, from, input, override });
    const res = await fetch(`${TENDERLY_API_BASE}/api/v1/account/${account}/project/${project}/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Access-Key": accessKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { error: `Tenderly ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const json = await res.json();
    const parsed = parseSimResponse(json);
    if (!parsed) return { error: "Unexpected Tenderly response" };
    return { ...parsed, dashboardUrl: tenderlyDashboardUrl(account, project, parsed.id) };
  } catch (e) {
    return { error: e.message || String(e) };
  }
});

ipcMain.handle("tenderly-share", async (_event, { account, project, accessKey, id }) => {
  try {
    const res = await fetch(`${TENDERLY_API_BASE}/api/v1/account/${account}/project/${project}/simulations/${id}/share`, {
      method: "POST",
      headers: { "X-Access-Key": accessKey },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { error: `Tenderly ${res.status}` };
    return { url: tenderlySharedUrl(id) };
  } catch (e) {
    return { error: e.message || String(e) };
  }
});

// Open a vetted external URL in the user's browser. Restricted to the Tenderly
// dashboard so a compromised renderer can't drive arbitrary navigation.
ipcMain.handle("open-external", async (_event, { url }) => {
  if (typeof url === "string" && url.startsWith("https://dashboard.tenderly.co/")) {
    await shell.openExternal(url);
    return { ok: true };
  }
  return { error: "Refused to open non-Tenderly URL" };
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

// Add a confirmation (signature) to an already-proposed transaction. signHash
// produces the eth_sign-style signature the Safe service expects for
// confirmations.
ipcMain.handle("safe-api-confirm", async (_event, { chainId, safeAddr, rpcUrl, privateKey, safeTxHash, safeApiKey }) => {
  try {
    const SafeApiKit = require("@safe-global/api-kit").default;
    const Safe = require("@safe-global/protocol-kit").default;
    const apiKit = new SafeApiKit({ chainId: BigInt(chainId), apiKey: safeApiKey });
    const protocolKit = await Safe.init({ provider: rpcUrl, signer: privateKey, safeAddress: safeAddr });
    const signature = await protocolKit.signHash(safeTxHash);
    const signerAddress = await protocolKit.getSafeProvider().getSignerAddress();
    await safeApiThrottle();
    await apiKit.confirmTransaction(safeTxHash, signature.data);
    return { success: true, safeTxHash, signer: signerAddress };
  } catch (e) {
    return { error: e.message || String(e) };
  }
});

// Execute an already-proposed transaction using the confirmations recorded by
// the service. protocol-kit accepts the api-kit transaction response directly
// and encodes its signatures in the ascending-owner order the contract
// requires; the executor EOA pays gas.
ipcMain.handle("safe-api-exec", async (_event, { chainId, safeAddr, rpcUrl, executorKey, safeTxHash, safeApiKey }) => {
  try {
    const SafeApiKit = require("@safe-global/api-kit").default;
    const Safe = require("@safe-global/protocol-kit").default;
    const apiKit = new SafeApiKit({ chainId: BigInt(chainId), apiKey: safeApiKey });
    const key = String(executorKey).startsWith("0x") ? executorKey : `0x${executorKey}`;
    const protocolKit = await Safe.init({ provider: rpcUrl, signer: key, safeAddress: safeAddr });
    await safeApiThrottle();
    const safeTransaction = await apiKit.getTransaction(safeTxHash);
    const result = await protocolKit.executeTransaction(safeTransaction);
    return { txHash: result.hash };
  } catch (e) {
    let msg = e?.message || String(e);
    const gs = msg.match(/GS0\d\d/);
    if (gs && GS_ERRORS[gs[0]]) msg = `${GS_ERRORS[gs[0]]} (${gs[0]})`;
    return { error: msg };
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
