// Tests for the real main.js IPC handlers. main.js is loaded as native CJS,
// so neither vi.mock nor vite aliases can intercept its require("electron") —
// instead Module._resolveFilename is patched to serve the stub, and HOME is
// pointed at a temp dir before import so getDataDir() (os.homedir-based)
// never touches real user data. fetch is scripted per test.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Module from "node:module";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const nativeRequire = createRequire(import.meta.url);
const electronMockPath = fileURLToPath(new URL("./mocks/electron.cjs", import.meta.url));
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "txb-test-home-"));

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "electron") return electronMockPath;
  return origResolve.call(this, request, ...rest);
};
process.env.HOME = fakeHome;                          // linux/darwin homedir()
process.env.USERPROFILE = fakeHome;                   // win32 homedir()
process.env.APPDATA = path.join(fakeHome, "AppData"); // win32 getDataDir()

// Same native require cache as main.js → same __handlers instance.
const { __handlers } = nativeRequire("./mocks/electron.cjs");

const invoke = (channel, args) => {
  const fn = __handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return fn(null, args);
};

const dataDir = () =>
  process.platform === "win32" ? path.join(process.env.APPDATA, "txbuilder")
  : process.platform === "darwin" ? path.join(fakeHome, "Library", "Application Support", "txbuilder")
  : path.join(fakeHome, ".local", "txbuilder");
const RPC = "http://rpc.test/";

const jsonResponse = (body) => ({ json: async () => body });

beforeAll(async () => {
  await import("../main.js");
});

afterAll(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("eth-get-code", () => {
  it("returns the bytecode", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ result: "0x6080" })));
    expect(await invoke("eth-get-code", { rpcUrl: RPC, address: "0x1" })).toEqual({ code: "0x6080" });
  });

  it("distinguishes no-rpc / rpc / network error kinds", async () => {
    expect((await invoke("eth-get-code", { rpcUrl: null, address: "0x1" })).error.kind).toBe("no-rpc");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { message: "nope" } })));
    expect((await invoke("eth-get-code", { rpcUrl: RPC, address: "0x1" })).error.kind).toBe("rpc");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect((await invoke("eth-get-code", { rpcUrl: RPC, address: "0x1" })).error.kind).toBe("network");
  });
});

describe("rpc-batch", () => {
  const reqs = [
    { method: "eth_call", params: [{ to: "0xa", data: "0x1" }, "latest"] },
    { method: "eth_getStorageAt", params: ["0xa", "0x0", "latest"] },
  ];

  it("maps batch replies by id, tolerating out-of-order responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([
      { id: 1, result: "0xsecond" },
      { id: 0, result: "0xfirst" },
    ])));
    const res = await invoke("rpc-batch", { rpcUrl: RPC, requests: reqs });
    expect(res.results).toEqual([{ result: "0xfirst" }, { result: "0xsecond" }]);
  });

  it("carries per-request errors without failing the batch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([
      { id: 0, result: "0xok" },
      { id: 1, error: { code: -32000, message: "reverted" } },
    ])));
    const res = await invoke("rpc-batch", { rpcUrl: RPC, requests: reqs });
    expect(res.results[0]).toEqual({ result: "0xok" });
    expect(res.results[1].error.message).toBe("reverted");
  });

  it("replays sequentially when the endpoint rejects the batch form", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "batch not supported" } }))
      .mockResolvedValueOnce(jsonResponse({ result: "0xone" }))
      .mockResolvedValueOnce(jsonResponse({ result: "0xtwo" }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await invoke("rpc-batch", { rpcUrl: RPC, requests: reqs });
    expect(res.results).toEqual([{ result: "0xone" }, { result: "0xtwo" }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects disallowed methods and oversized batches without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const bad = await invoke("rpc-batch", { rpcUrl: RPC, requests: [{ method: "eth_sendRawTransaction", params: [] }] });
    expect(bad.error).toMatch(/eth_sendRawTransaction/);
    const big = await invoke("rpc-batch", { rpcUrl: RPC, requests: Array(21).fill(reqs[0]) });
    expect(big.error).toMatch(/Too many/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("analyze-bytecode", () => {
  // Solidity-style dispatcher for selector a9059cbb.
  const CODE = "0x6080604052348015600e575f5ffd5b50600436106030575f3560e01c8063a9059cbb146034575b5f5ffd5b603c565b005b5f5ffd";

  it("extracts selectors with real evmole", async () => {
    const res = await invoke("analyze-bytecode", { code: CODE });
    expect(res.functions.map(f => f.selector)).toContain("a9059cbb");
  });

  it("guards empty and oversized input", async () => {
    expect((await invoke("analyze-bytecode", { code: "0x" })).error).toBeTruthy();
    expect((await invoke("analyze-bytecode", { code: "0x" + "00".repeat(60000) })).error).toBeTruthy();
  });
});

describe("abi-cache", () => {
  const ADDR = "0xAbCd000000000000000000000000000000000001";
  const record = {
    codehash: "0xc0de",
    classification: "contract",
    implAbiRef: { kind: "code", key: "0xc0de", source: "detected" },
    proxyAbiRef: { kind: "impl", key: "1-0xproxysource", source: "addressbook" },
  };
  const implAbi = [{ type: "function", name: "f", inputs: [], outputs: [], stateMutability: "view" }];
  const proxyAbi = [{ type: "function", name: "p", inputs: [], outputs: [], stateMutability: "view" }];

  it("round-trips a record with both ABI refs", async () => {
    expect(await invoke("abi-cache-put", { chainId: 1, address: ADDR, record, implAbi, proxyAbi })).toBe(true);
    const hit = await invoke("abi-cache-get", { chainId: 1, address: ADDR, codehash: "0xc0de" });
    expect(hit.record).toMatchObject({ classification: "contract", chainId: 1, _schemaVersion: 1 });
    expect(hit.implAbi).toEqual(implAbi);
    expect(hit.proxyAbi).toEqual(proxyAbi);
    // files land in OUR data dir, addr key lowercased
    expect(fs.existsSync(path.join(dataDir(), "abi-cache", "addr", `1-${ADDR.toLowerCase()}.json`))).toBe(true);
  });

  it("treats a codehash mismatch as a miss AND deletes the stale record", async () => {
    await invoke("abi-cache-put", { chainId: 1, address: ADDR, record, implAbi, proxyAbi });
    expect(await invoke("abi-cache-get", { chainId: 1, address: ADDR, codehash: "0xother" })).toBe(null);
    expect(await invoke("abi-cache-get", { chainId: 1, address: ADDR, codehash: "0xc0de" })).toBe(null);
  });

  it("bust removes the record and impl-keyed files but keeps content-addressed ones", async () => {
    await invoke("abi-cache-put", { chainId: 1, address: ADDR, record, implAbi, proxyAbi });
    await invoke("abi-cache-bust", { chainId: 1, address: ADDR });
    expect(await invoke("abi-cache-get", { chainId: 1, address: ADDR, codehash: "0xc0de" })).toBe(null);
    expect(fs.existsSync(path.join(dataDir(), "abi-cache", "impl", "1-0xproxysource.json"))).toBe(false);
    expect(fs.existsSync(path.join(dataDir(), "abi-cache", "code", "0xc0de.json"))).toBe(true);
  });

  it("rejects path-traversal cache keys", async () => {
    const evil = { ...record, implAbiRef: { kind: "code", key: "../../evil", source: "detected" } };
    expect(await invoke("abi-cache-put", { chainId: 1, address: ADDR, record: evil, implAbi, proxyAbi: null })).toBe(false);
    expect(fs.existsSync(path.join(dataDir(), "abi-cache", "evil.json"))).toBe(false);
  });

  it("treats a corrupt cache file as a miss", async () => {
    await invoke("abi-cache-put", { chainId: 1, address: ADDR, record, implAbi, proxyAbi });
    const p = path.join(dataDir(), "abi-cache", "addr", `1-${ADDR.toLowerCase()}.json`);
    fs.writeFileSync(p, "{not json");
    expect(await invoke("abi-cache-get", { chainId: 1, address: ADDR, codehash: "0xc0de" })).toBe(null);
  });
});

describe("lookup-signatures", () => {
  const openchain = (map) => jsonResponse({ ok: true, result: { function: map } });

  it("resolves via openchain and persists to sigs.json", async () => {
    const fetchMock = vi.fn(async () => openchain({ "0x11111111": [{ name: "foo(address)" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await invoke("lookup-signatures", { selectors: ["0x11111111"] });
    expect(res.signatures["0x11111111"]).toBe("foo(address)");
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir(), "abi-cache", "sigs.json"), "utf8"));
    expect(saved.signatures["0x11111111"]).toBe("foo(address)");
    // second call: served from cache, no network
    fetchMock.mockClear();
    const again = await invoke("lookup-signatures", { selectors: ["0x11111111"] });
    expect(again.signatures["0x11111111"]).toBe("foo(address)");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("remembers misses for the session without persisting them", async () => {
    const fetchMock = vi.fn(async () => openchain({}));
    vi.stubGlobal("fetch", fetchMock);
    expect((await invoke("lookup-signatures", { selectors: ["0x22222222"] })).signatures["0x22222222"]).toBe(null);
    fetchMock.mockClear();
    expect((await invoke("lookup-signatures", { selectors: ["0x22222222"] })).signatures["0x22222222"]).toBe(null);
    expect(fetchMock).not.toHaveBeenCalled();
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir(), "abi-cache", "sigs.json"), "utf8"));
    expect(saved.signatures["0x22222222"]).toBeUndefined();
  });

  it("survives openchain being down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const res = await invoke("lookup-signatures", { selectors: ["0x33333333"] });
    expect(res.signatures["0x33333333"]).toBe(null);
  });

  it("ignores malformed selectors", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await invoke("lookup-signatures", { selectors: ["nonsense", "0x123"] });
    expect(res.signatures).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("rpc-get-logs + endpoint health", () => {
  const CHAIN = 424242; // isolated chain id, no bundled endpoints
  const okLogs = (body) => ({ ok: true, status: 200, json: async () => body });
  const filter = { fromBlock: "0x0", toBlock: "0x10", topics: ["0xabc"] };

  beforeEach(() => {
    process.env.TXB_RPC_OVERRIDE_JSON = JSON.stringify({ [CHAIN]: ["http://a.test/", "http://b.test/"] });
  });
  afterAll(() => { delete process.env.TXB_RPC_OVERRIDE_JSON; });

  it("returns logs and marks the endpoint healthy on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okLogs({ result: [{ address: "0xdead", topics: ["0xabc"], data: "0x" }] })));
    const res = await invoke("rpc-get-logs", { chainId: CHAIN, filter });
    expect(res.logs).toHaveLength(1);
    const eps = await invoke("rpc-endpoints-get", { chainId: CHAIN });
    expect(eps.endpoints.some(e => e.available && e.lastSuccessAt)).toBe(true);
  });

  it("classifies a provider result-cap error and reports its kind", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okLogs({ error: { code: -32005, message: "too many results" } })));
    const res = await invoke("rpc-get-logs", { chainId: CHAIN, filter });
    expect(res.error).toBeTruthy();
    expect(res.kind).toBe("too-many-results");
  });

  it("classifies an HTTP 429 as rate-limited", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })));
    const res = await invoke("rpc-get-logs", { chainId: CHAIN, filter });
    expect(res.kind).toBe("rate-limited");
  });

  it("does NOT disable an endpoint that merely caps its block range", async () => {
    // A fresh chain so health starts clean; the endpoint answers every call
    // with range-too-large — a healthy response, not a failure.
    const C2 = 424243;
    process.env.TXB_RPC_OVERRIDE_JSON = JSON.stringify({ [C2]: ["http://cap.test/"] });
    vi.stubGlobal("fetch", vi.fn(async () => okLogs({ error: { message: "block range is too wide" } })));
    for (let i = 0; i < 5; i++) await invoke("rpc-get-logs", { chainId: C2, filter });
    const eps = await invoke("rpc-endpoints-get", { chainId: C2 });
    expect(eps.endpoints[0].available).toBe(true);  // still usable
    expect(eps.endpoints[0].disabled).toBe(false);  // never disabled
    expect(eps.endpoints[0].lastSuccessAt).toBeTruthy(); // counted as a live contact
  });

  it("returns an error when no endpoints are configured for the chain", async () => {
    delete process.env.TXB_RPC_OVERRIDE_JSON;
    const res = await invoke("rpc-get-logs", { chainId: 987654321, filter });
    expect(res.error).toBeTruthy();
  });

  it("rpc-state-reset clears learned endpoint health", async () => {
    const C3 = 424244;
    process.env.TXB_RPC_OVERRIDE_JSON = JSON.stringify({ [C3]: ["http://down.test/"] });
    // Drive it into backoff with real connection failures.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    for (let i = 0; i < 3; i++) await invoke("rpc-get-logs", { chainId: C3, filter });
    let eps = await invoke("rpc-endpoints-get", { chainId: C3 });
    expect(eps.endpoints[0].available).toBe(false); // backed off

    const r = await invoke("rpc-state-reset");
    expect(r.ok).toBe(true);
    eps = await invoke("rpc-endpoints-get", { chainId: C3 });
    expect(eps.endpoints[0].available).toBe(true);  // clean slate
    expect(eps.endpoints[0].lastSuccessAt).toBeFalsy();
  });
});

describe("discovered-safes store", () => {
  it("lists, removes, and clears persisted safes", async () => {
    await invoke("discovered-safes-clear");
    expect(await invoke("discovered-safes-list")).toEqual([]);
    const p = path.join(dataDir(), "discovered-safes.json");
    fs.writeFileSync(p, JSON.stringify({ _schemaVersion: 1, safes: [
      { chainId: 1, safeAddr: "0xaaa", ownedBy: ["0x1"] },
      { chainId: 10, safeAddr: "0xbbb", ownedBy: ["0x2"] },
    ] }));
    expect(await invoke("discovered-safes-list")).toHaveLength(2);
    await invoke("discovered-safes-remove", { chainId: 1, safeAddr: "0xaaa" });
    const left = await invoke("discovered-safes-list");
    expect(left).toHaveLength(1);
    expect(left[0].safeAddr).toBe("0xbbb");
    await invoke("discovered-safes-clear");
    expect(await invoke("discovered-safes-list")).toEqual([]);
  });
});

describe("safe API with device signatures", () => {
  const SAFE = "0x1234567890AbcdEF1234567890aBcdef12345678";
  const KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
  const tx = {
    to: "0x00000000000000000000000000000000000000aa", value: "0", data: null, operation: 0,
    safeTxGas: 0, baseGas: 0, gasPrice: "0", gasToken: null, refundReceiver: null, nonce: 3,
  };
  let signDigest, recoverAddress, buildSafeTypedData;
  // api-kit does its own HTTP via node-fetch (not the global fetch), so a
  // stubbed fetch can't intercept it. Swap the module in the require cache for
  // a recorder that never touches the network; main.js requires it lazily.
  const kitCalls = [];
  const kitPath = nativeRequire.resolve("@safe-global/api-kit");
  let realKit;
  class FakeKit {
    constructor(opts) { kitCalls.push(["new", opts]); }
    async confirmTransaction(...args) { kitCalls.push(["confirmTransaction", ...args]); return { signature: args[1] }; }
    async proposeTransaction(arg) { kitCalls.push(["proposeTransaction", arg]); }
  }
  beforeAll(async () => {
    ({ signDigest, recoverAddress } = await import("../src/lib/sign.js"));
    ({ buildSafeTypedData } = nativeRequire("../src/lib/safe-typed-data.cjs"));
    realKit = Module._cache[kitPath];
    const fake = new Module(kitPath);
    fake.filename = kitPath; fake.loaded = true; fake.exports = { default: FakeKit };
    Module._cache[kitPath] = fake;
  });
  afterAll(() => {
    if (realKit) Module._cache[kitPath] = realKit; else delete Module._cache[kitPath];
  });
  beforeEach(() => { kitCalls.length = 0; });
  const built = () => buildSafeTypedData({ chainId: 1, safeAddr: SAFE, version: "1.3.0", tx });

  it("safe-tx-typed-data rebuilds a pending tx and returns device hashes", async () => {
    const b = built();
    const res = await invoke("safe-tx-typed-data", { chainId: 1, safeAddr: SAFE, version: "1.3.0", tx: { ...tx, safeTxHash: b.safeTxHash } });
    expect(res.error).toBeUndefined();
    expect(res.safeTxHash).toBe(b.safeTxHash);
    expect(res.domainHash).toBe(b.domainHash);
    expect(res.messageHash).toBe(b.messageHash);
  });

  it("safe-tx-typed-data refuses when the service's hash doesn't match the fields", async () => {
    const res = await invoke("safe-tx-typed-data", { chainId: 1, safeAddr: SAFE, version: "1.3.0", tx: { ...tx, safeTxHash: "0x" + "11".repeat(32) } });
    expect(res.error).toMatch(/does not match/);
  });

  it("safe-api-confirm-signature rejects a signature from another account without calling the service", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { safeTxHash } = built();
    const signature = signDigest(KEY, safeTxHash);
    const res = await invoke("safe-api-confirm-signature", {
      chainId: 1, safeTxHash, signer: "0x000000000000000000000000000000000000dEaD", signature, safeApiKey: "k",
    });
    expect(res.error).toMatch(/not the selected account/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("safe-api-confirm-signature posts a verified signature to the service", async () => {
    const { safeTxHash } = built();
    const signature = signDigest(KEY, safeTxHash);
    const signer = recoverAddress(safeTxHash, signature);
    const res = await invoke("safe-api-confirm-signature", { chainId: 1, safeTxHash, signer, signature, safeApiKey: "k" });
    expect(res).toMatchObject({ success: true, safeTxHash });
    expect(kitCalls).toContainEqual(["confirmTransaction", safeTxHash, signature]);
  });

  it("safe-api-propose-signed refuses typed data that doesn't hash to the given safeTxHash", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const b = built();
    const res = await invoke("safe-api-propose-signed", {
      chainId: 1, safeAddr: SAFE, typedData: b.typedData, safeTxHash: "0x" + "22".repeat(32),
      signer: "0x0", signature: "0x", safeApiKey: "k",
    });
    expect(res.error).toMatch(/hashes to/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("safe-api-propose-signed proposes with the device signature as sender signature", async () => {
    const b = built();
    const signature = signDigest(KEY, b.safeTxHash);
    const signer = recoverAddress(b.safeTxHash, signature);
    const res = await invoke("safe-api-propose-signed", {
      chainId: 1, safeAddr: SAFE, typedData: b.typedData, safeTxHash: b.safeTxHash, signer, signature, safeApiKey: "k",
    });
    expect(res).toMatchObject({ success: true, safeTxHash: b.safeTxHash });
    const call = kitCalls.find(c => c[0] === "proposeTransaction");
    expect(call[1]).toMatchObject({
      safeAddress: SAFE, safeTxHash: b.safeTxHash, senderAddress: signer, senderSignature: signature,
      safeTransactionData: { to: tx.to, value: "0", data: "0x", operation: 0, nonce: 3 },
    });
  });
});

describe("hardware executor: safe-exec-prepare / eth-broadcast-signed", () => {
  const SAFE = "0x1234567890AbcdEF1234567890aBcdef12345678";
  const FROM = "0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2";
  const HASH = "0x" + "ab".repeat(32);
  // Both Safe SDKs are replaced in the require cache (api-kit would reach the
  // real Safe service via node-fetch; protocol-kit would need a live Safe).
  const fakes = {};
  const state = {};
  const install = (name, exports) => {
    const p = nativeRequire.resolve(name);
    fakes[p] = Module._cache[p];
    const m = new Module(p); m.filename = p; m.loaded = true; m.exports = exports;
    Module._cache[p] = m;
  };
  beforeAll(() => {
    install("@safe-global/api-kit", { default: class { async getTransaction(h) { return { safeTxHash: h }; } } });
    install("@safe-global/protocol-kit", { default: { init: async () => ({
      toSafeTransactionType: async () => ({ signatures: new Map(Array.from({ length: state.sigs }, (_, i) => [i, {}])) }),
      getTransactionHash: async () => state.hash,
      getThreshold: async () => 3,
      getEncodedTransaction: async () => "0x6a761202",
    }) } });
  });
  afterAll(() => {
    for (const [p, m] of Object.entries(fakes)) { if (m) Module._cache[p] = m; else delete Module._cache[p]; }
  });
  beforeEach(() => { state.hash = HASH; state.sigs = 3; });

  const rpc = (overrides = {}) => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const { method } = JSON.parse(init.body);
      calls.push(method);
      const results = {
        eth_getTransactionCount: "0x7", eth_getBlockByNumber: { baseFeePerGas: "0x3b9aca00" },
        eth_getBalance: "0xde0b6b3a7640000", eth_estimateGas: "0x186a0", eth_maxPriorityFeePerGas: "0x3b9aca00",
        ...overrides,
      };
      const r = results[method];
      return jsonResponse(r instanceof Error ? { error: { message: r.message } } : { result: r });
    }));
    return calls;
  };
  const prepare = () => invoke("safe-exec-prepare", { chainId: 1, safeAddr: SAFE, rpcUrl: RPC, safeTxHash: HASH, safeApiKey: "k", from: FROM });

  it("builds an EIP-1559 execTransaction from the executor", async () => {
    rpc();
    const res = await prepare();
    expect(res.error).toBeUndefined();
    expect(res.tx).toMatchObject({
      chainId: 1, nonce: "0x7", to: SAFE, data: "0x6a761202", type: "eip1559",
      gas: "0x1d4c0", maxPriorityFeePerGas: "0x3b9aca00", maxFeePerGas: "0xb2d05e00",
    });
    expect(res.unsignedSerialized).toMatch(/^0x02/);
  });

  it("refuses when the rebuilt hash differs, or signatures are short", async () => {
    rpc();
    state.hash = "0x" + "cd".repeat(32);
    expect((await prepare()).error).toMatch(/does not match/);
    state.hash = HASH; state.sigs = 2;
    expect((await prepare()).error).toMatch(/Only 2 of 3/);
  });

  it("maps a GS revert during estimation and checks the executor's balance", async () => {
    rpc({ eth_estimateGas: new Error("execution reverted: GS013") });
    expect((await prepare()).error).toMatch(/inner transaction reverted/);
    rpc({ eth_getBalance: "0x1" });
    expect((await prepare()).error).toMatch(/can't cover gas/);
  });

  it("falls back to legacy gasPrice without a base fee", async () => {
    rpc({ eth_getBlockByNumber: {}, eth_gasPrice: "0x3b9aca00" });
    expect((await prepare()).tx).toMatchObject({ type: "legacy", gasPrice: "0x3b9aca00" });
  });

  it("broadcasts only a transaction signed by the executor", async () => {
    const { privateKeyToAccount } = await import("viem/accounts");
    const { parseTransaction } = await import("viem");
    const { toViemTx } = nativeRequire("../src/lib/eth-tx.cjs");
    const acct = privateKeyToAccount("0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318");
    const tx = { chainId: 1, nonce: "0x7", to: SAFE, value: "0x0", data: "0x6a761202", gas: "0x1d4c0", type: "eip1559", maxFeePerGas: "0xb2d05e00", maxPriorityFeePerGas: "0x3b9aca00" };
    const signed = await acct.signTransaction(toViemTx(tx));
    const p = parseTransaction(signed);
    const signature = { r: p.r, s: p.s, v: p.yParity };

    let calls = rpc();
    const bad = await invoke("eth-broadcast-signed", { rpcUrl: RPC, tx, signature, from: FROM });
    expect(bad.error).toMatch(/not the selected account/);
    expect(calls).toEqual([]);

    const sent = [];
    vi.stubGlobal("fetch", vi.fn(async (_u, init) => { const b = JSON.parse(init.body); sent.push(b); return jsonResponse({ result: "0xhash" }); }));
    const ok = await invoke("eth-broadcast-signed", { rpcUrl: RPC, tx, signature, from: acct.address });
    expect(ok).toEqual({ txHash: "0xhash" });
    expect(sent[0]).toMatchObject({ method: "eth_sendRawTransaction", params: [signed] });
  });
});
