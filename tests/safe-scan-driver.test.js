// End-to-end-ish test of the safe-scan-start driver: a stubbed RPC feeds the
// main-process scan a fast-path AddedOwner log and confirms ownership via
// eth_call, and we assert the Safe is persisted to discovered-safes.json and
// surfaced by discovered-safes-list. Loads the real main.js through the same
// electron-stub + temp-HOME harness as main-handlers.test.js.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Module from "node:module";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import SS from "../src/lib/safe-scan.cjs";

const nativeRequire = createRequire(import.meta.url);
const electronMockPath = fileURLToPath(new URL("./mocks/electron.cjs", import.meta.url));
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "txb-scan-home-"));

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "electron") return electronMockPath;
  return origResolve.call(this, request, ...rest);
};
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.APPDATA = path.join(fakeHome, "AppData");

const { __handlers } = nativeRequire("./mocks/electron.cjs");
const invoke = (channel, args) => {
  const fn = __handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn(null, args);
};

const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const SAFE = "0x1111111111111111111111111111111111111111";
const CHAIN = 10; // in safe-start-blocks.json as 0 → no getCode bisect
const pad = (a) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const abiAddressArray = (addrs) => "0x" + word(0x20) + word(addrs.length) + addrs.map(pad).join("");
const abiString = (s) => {
  const hex = Buffer.from(s, "utf8").toString("hex");
  return "0x" + word(0x20) + word(s.length) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
};
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

// Route a JSON-RPC request to a crafted reply for our synthetic Safe.
function stubRpc() {
  return vi.fn(async (_url, opts) => {
    const req = JSON.parse(opts.body);
    const { method, params } = req;
    if (method === "eth_blockNumber") return ok({ result: "0x64" }); // head 100
    if (method === "eth_getCode") return ok({ result: "0x60" });
    if (method === "eth_getLogs") {
      // One 1.4.1-style AddedOwner log (owner indexed in topic1) for our Safe.
      return ok({ result: [{ address: SAFE, topics: [SS.TOPIC_ADDED_OWNER, "0x" + pad(OWNER)], data: "0x" }] });
    }
    if (method === "eth_call") {
      const data = params[0].data;
      if (data === "0xa0e67e2b") return ok({ result: abiAddressArray([OWNER]) }); // getOwners
      if (data === "0xe75235b8") return ok({ result: "0x" + word(1) });           // getThreshold
      if (data === "0xffa1ad74") return ok({ result: abiString("1.4.1") });       // VERSION
    }
    return ok({ result: "0x" });
  });
}

async function until(pred, ms = 5000) {
  const step = 25;
  for (let waited = 0; waited < ms; waited += step) {
    const v = await pred();
    if (v) return v;
    await new Promise(r => setTimeout(r, step));
  }
  return null;
}

beforeAll(async () => {
  process.env.TXB_RPC_OVERRIDE_JSON = JSON.stringify({ [CHAIN]: ["http://scan.test/"] });
  process.env.TXB_WALK_RETRY_MS = "5";      // keep back-off retries fast under test
  process.env.TXB_ENDPOINT_SPACING_MS = "0"; // no inter-request pacing under test
  await import("../main.js");
});
afterAll(() => {
  delete process.env.TXB_RPC_OVERRIDE_JSON;
  delete process.env.TXB_WALK_RETRY_MS;
  delete process.env.TXB_ENDPOINT_SPACING_MS;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe("safe-scan-start driver", () => {
  it("discovers and persists a Safe the user currently owns", async () => {
    await invoke("discovered-safes-clear");
    vi.stubGlobal("fetch", stubRpc());

    const { scanId } = await invoke("safe-scan-start", {
      chains: [{ chainId: CHAIN, rpcUrl: "http://scan.test/" }],
      addresses: [OWNER],
      mode: "hybrid",
    });
    expect(scanId).toBeTruthy();

    const found = await until(async () => {
      const list = await invoke("discovered-safes-list");
      return list.length ? list : null;
    });
    expect(found).toBeTruthy();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      chainId: CHAIN,
      safeAddr: SAFE,
      threshold: 1,
      version: "1.4.1",
    });
    expect(found[0].ownedBy.map(a => a.toLowerCase())).toContain(OWNER);

    // Persisted to the dedicated data file (not settings.json).
    const p = path.join(
      process.platform === "win32" ? path.join(process.env.APPDATA, "txbuilder")
      : process.platform === "darwin" ? path.join(fakeHome, "Library", "Application Support", "txbuilder")
      : path.join(fakeHome, ".local", "txbuilder"),
      "discovered-safes.json",
    );
    expect(fs.existsSync(p)).toBe(true);
    vi.unstubAllGlobals();
  });

  it("ignores a Safe the user does not currently own", async () => {
    await invoke("discovered-safes-clear");
    // getOwners returns a different address → membership fails at confirm time.
    vi.stubGlobal("fetch", vi.fn(async (_url, opts) => {
      const { method, params } = JSON.parse(opts.body);
      if (method === "eth_blockNumber") return ok({ result: "0x64" });
      if (method === "eth_getLogs") return ok({ result: [{ address: SAFE, topics: [SS.TOPIC_ADDED_OWNER, "0x" + pad(OWNER)], data: "0x" }] });
      if (method === "eth_call" && params[0].data === "0xa0e67e2b")
        return ok({ result: abiAddressArray(["0x0000000000000000000000000000000000009999"]) });
      return ok({ result: "0x" });
    }));

    const { scanId } = await invoke("safe-scan-start", {
      chains: [{ chainId: CHAIN, rpcUrl: "http://scan.test/" }],
      addresses: [OWNER],
      mode: "hybrid",
    });
    expect(scanId).toBeTruthy();
    // Give the scan time to run to completion, then assert nothing was kept.
    await new Promise(r => setTimeout(r, 1200));
    expect(await invoke("discovered-safes-list")).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("adaptively shrinks the block range and still completes when a provider caps range", async () => {
    await invoke("discovered-safes-clear");
    process.env.TXB_RPC_OVERRIDE_JSON = JSON.stringify({ 8453: ["http://cap.test/"] });
    const LIMIT = 200000; // provider rejects any getLogs span wider than this
    let sawRangeError = false;
    vi.stubGlobal("fetch", vi.fn(async (_url, opts) => {
      const { method, params } = JSON.parse(opts.body);
      if (method === "eth_blockNumber") return ok({ result: "0x100000" }); // ~1.05M blocks so the span exceeds LIMIT
      if (method === "eth_getLogs") {
        const f = params[0];
        const span = Number(BigInt(f.toBlock)) - Number(BigInt(f.fromBlock)) + 1;
        if (span > LIMIT) { sawRangeError = true; return ok({ error: { message: "block range is too wide" } }); }
        return ok({ result: [{ address: SAFE, topics: [SS.TOPIC_ADDED_OWNER, "0x" + pad(OWNER)], data: "0x" }] });
      }
      if (method === "eth_call") {
        const d = params[0].data;
        if (d === "0xa0e67e2b") return ok({ result: abiAddressArray([OWNER]) });
        if (d === "0xe75235b8") return ok({ result: "0x" + word(1) });
        if (d === "0xffa1ad74") return ok({ result: abiString("1.4.1") });
      }
      return ok({ result: "0x" });
    }));

    const { scanId } = await invoke("safe-scan-start", {
      chains: [{ chainId: 8453, rpcUrl: "http://cap.test/" }], addresses: [OWNER], mode: "hybrid",
    });
    expect(scanId).toBeTruthy();
    const found = await until(async () => {
      const l = await invoke("discovered-safes-list");
      return l.length ? l : null;
    });
    expect(found).toBeTruthy();
    expect(found[0].safeAddr).toBe(SAFE);
    expect(sawRangeError).toBe(true); // it really did hit the cap and recovered from it
    vi.unstubAllGlobals();
    process.env.TXB_RPC_OVERRIDE_JSON = JSON.stringify({ [CHAIN]: ["http://scan.test/"] });
  });

  it("gives up on a persistently failing endpoint instead of spinning forever", async () => {
    await invoke("discovered-safes-clear");
    process.env.TXB_RPC_OVERRIDE_JSON = JSON.stringify({ 42161: ["http://dead.test/"] });
    let getLogsCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, opts) => {
      const { method } = JSON.parse(opts.body);
      if (method === "eth_blockNumber") return ok({ result: "0x64" });
      if (method === "eth_getLogs") { getLogsCalls++; return ok({ error: { message: "ECONNREFUSED" } }); }
      return ok({ result: "0x" });
    }));

    const { scanId } = await invoke("safe-scan-start", {
      chains: [{ chainId: 42161, rpcUrl: "http://dead.test/" }], addresses: [OWNER], mode: "hybrid",
    });
    expect(scanId).toBeTruthy();
    await new Promise(r => setTimeout(r, 400));
    const c1 = getLogsCalls;
    await new Promise(r => setTimeout(r, 400));
    const c2 = getLogsCalls;
    expect(c2).toBe(c1); // the walk terminated — call count is stable, not climbing
    expect(await invoke("discovered-safes-list")).toEqual([]);
    vi.unstubAllGlobals();
    process.env.TXB_RPC_OVERRIDE_JSON = JSON.stringify({ [CHAIN]: ["http://scan.test/"] });
  });
});
