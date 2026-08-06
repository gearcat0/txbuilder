// Unit tests for the capability-detection pipeline. All RPC goes through a
// scripted window.electronAPI — no network.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { keccak256 } from "js-sha3";
import { detectContract, detectAbi, normalizeAbi, codehashOf, safeAbiFor } from "../src/lib/detect.js";

const SLOT_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SLOT_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const SLOT_ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";
const SAFE_130_SINGLETON = "0xd9db270c1b5e3bd161e8c8503c55ceabee709552";

const ZERO_WORD = "0x" + "0".repeat(64);
const addrWord = (a) => "0x" + a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const uintWord = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const boolWord = (b) => uintWord(b ? 1 : 0);
const strWord = (s) => {
  const hex = [...s].map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return "0x" + uintWord(32).slice(2) + uintWord(s.length).slice(2) + hex.padEnd(64, "0");
};

const A = (n) => "0x" + String(n).repeat(40).slice(0, 40); // deterministic addresses

// A scripted chain: state = { [addrLower]: { code, storage: {slot: word}, calls: {dataPrefix: word} } }
function installChain(state) {
  const account = (addr) => state[addr.toLowerCase()] || {};
  const route = (req) => {
    if (req.method === "eth_getCode") return { result: account(req.params[0]).code || "0x" };
    if (req.method === "eth_getStorageAt") {
      return { result: account(req.params[0]).storage?.[req.params[1]] || ZERO_WORD };
    }
    if (req.method === "eth_call") {
      const { to, data } = req.params[0];
      const calls = account(to).calls || {};
      const hit = Object.keys(calls).find(prefix => data.startsWith(prefix));
      return hit ? { result: calls[hit] } : { error: { message: "execution reverted" } };
    }
    return { error: { message: "unsupported" } };
  };
  const rpcBatch = vi.fn(async (_url, requests) => ({ results: requests.map(r => route(r)) }));
  globalThis.window = { electronAPI: { rpcBatch } };
  return rpcBatch;
}

const DETECT = (address, code, extra = {}) =>
  detectContract({ address, chainId: 1, rpcUrl: "http://rpc", code, ...extra });

afterEach(() => { delete globalThis.window; });

describe("classification", () => {
  it("empty code is an EOA and makes no RPC calls", async () => {
    const rpcBatch = installChain({});
    const det = await DETECT(A(1), "0x");
    expect(det.classification).toBe("eoa");
    expect(rpcBatch).not.toHaveBeenCalled();
  });

  it("0xef0100… is an EIP-7702 delegated EOA with the delegate's code as logic", async () => {
    const delegate = A(7);
    installChain({ [delegate]: { code: "0x6080604052" } });
    const det = await DETECT(A(1), "0xef0100" + delegate.slice(2));
    expect(det.classification).toBe("eip7702");
    expect(det.delegate).toBe(delegate);
    expect(det.logicAddress).toBe(delegate);
    expect(det.logicCode).toBe("0x6080604052");
  });

  it("plain bytecode is a contract with no proxy", async () => {
    const addr = A(2);
    installChain({ [addr]: { code: "0x6080604052" } });
    const det = await DETECT(addr, "0x6080604052");
    expect(det.classification).toBe("contract");
    expect(det.proxy).toEqual({ type: null, chain: [] });
    expect(det.logicAddress).toBe(null);
    expect(det.logicCode).toBe("0x6080604052");
    expect(det.codehash).toBe(codehashOf("0x6080604052"));
  });

  it("degrades to classification-only when rpcBatch is unavailable", async () => {
    globalThis.window = { electronAPI: {} };
    const det = await DETECT(A(2), "0x6080604052");
    expect(det.classification).toBe("contract");
    expect(det.capabilities).toBe(null);
    expect(det.proxy.type).toBe(null);
  });
});

describe("capabilities", () => {
  it("detects ERC-20 via decimals + totalSupply, with symbol", async () => {
    const addr = A(2);
    installChain({
      [addr]: {
        code: "0xabcdef",
        calls: {
          "0x313ce567": uintWord(18),        // decimals()
          "0x95d89b41": strWord("WETH"),     // symbol()
          "0x18160ddd": uintWord(1000000n),  // totalSupply()
        },
      },
    });
    const det = await DETECT(addr, "0xabcdef");
    expect(det.capabilities).toMatchObject({ erc20: true, decimals: 18, symbol: "WETH", erc165: false });
  });

  it("detects ERC-721 only through a valid ERC-165 responder", async () => {
    const si = (id) => "0x01ffc9a7" + id.padEnd(64, "0");
    const addr = A(2);
    installChain({
      [addr]: {
        code: "0xabcdef",
        calls: {
          [si("01ffc9a7")]: boolWord(true),
          [si("ffffffff")]: boolWord(false),
          [si("80ac58cd")]: boolWord(true),
          [si("d9b67a26")]: boolWord(false),
        },
      },
    });
    const det = await DETECT(addr, "0xabcdef");
    expect(det.capabilities).toMatchObject({ erc165: true, erc721: true, erc1155: false, erc20: false });
  });

  it("rejects a broken ERC-165 responder that answers true to 0xffffffff", async () => {
    const si = (id) => "0x01ffc9a7" + id.padEnd(64, "0");
    const addr = A(2);
    installChain({
      [addr]: {
        code: "0xabcdef",
        calls: { [si("01ffc9a7")]: boolWord(true), [si("ffffffff")]: boolWord(true), [si("80ac58cd")]: boolWord(true) },
      },
    });
    const det = await DETECT(addr, "0xabcdef");
    expect(det.capabilities.erc165).toBe(false);
    expect(det.capabilities.erc721).toBe(false);
  });
});

describe("proxy resolution", () => {
  it("resolves an EIP-1967 proxy to its implementation", async () => {
    const proxy = A(2), impl = A(3);
    installChain({
      [proxy]: { code: "0xproxycode", storage: { [SLOT_IMPL]: addrWord(impl) } },
      [impl]: { code: "0x60806040" },
    });
    const det = await DETECT(proxy, "0xproxycode");
    expect(det.proxy.type).toBe("eip1967");
    expect(det.proxy.chain).toEqual([impl]);
    expect(det.logicAddress).toBe(impl);
    expect(det.logicCode).toBe("0x60806040");
    expect(det.logicCodehash).toBe(codehashOf("0x60806040"));
  });

  it("matches EIP-1167 minimal proxies by bytecode", async () => {
    const target = A(4);
    const code = "0x363d3d373d3d3d363d73" + target.slice(2) + "5af43d82803e903d91602b57fd5bf3";
    installChain({ [target]: { code: "0x60806040" } });
    const det = await DETECT(A(2), code);
    expect(det.proxy.type).toBe("eip1167");
    expect(det.logicAddress).toBe(target);
  });

  it("resolves beacon proxies by calling implementation() on the beacon", async () => {
    const proxy = A(2), beacon = A(5), impl = A(6);
    installChain({
      [proxy]: { code: "0xproxycode", storage: { [SLOT_BEACON]: addrWord(beacon) } },
      [beacon]: { code: "0xbeacon", calls: { "0x5c60da1b": addrWord(impl) } },
      [impl]: { code: "0x60806040" },
    });
    const det = await DETECT(proxy, "0xproxycode");
    expect(det.proxy.type).toBe("beacon");
    expect(det.logicAddress).toBe(impl);
  });

  it("walks nested proxies and reports the outermost type", async () => {
    const outer = A(2), mid = A(3), impl = A(4);
    installChain({
      [outer]: { code: "0xouter", storage: { [SLOT_IMPL]: addrWord(mid) } },
      [mid]: { code: "0x363d3d373d3d3d363d73" + impl.slice(2) + "5af43d82803e903d91602b57fd5bf3" },
      [impl]: { code: "0x60806040" },
    });
    const det = await DETECT(outer, "0xouter");
    expect(det.proxy.type).toBe("eip1967");
    expect(det.proxy.chain).toEqual([mid, impl]);
    expect(det.logicAddress).toBe(impl);
  });

  it("caps circular proxy chains at depth 3", async () => {
    const a = A(2), b = A(3);
    installChain({
      [a]: { code: "0xaaaa", storage: { [SLOT_IMPL]: addrWord(b) } },
      [b]: { code: "0xbbbb", storage: { [SLOT_IMPL]: addrWord(a) } },
    });
    const det = await DETECT(a, "0xaaaa");
    expect(det.proxy.chain.length).toBeLessThanOrEqual(3);
  });

  it("does NOT treat a random slot-0 address as a Safe proxy", async () => {
    const addr = A(2), rand = A(9);
    installChain({
      [addr]: { code: "0xabcdef", storage: { [SLOT_ZERO]: addrWord(rand) } },
      [rand]: { code: "0x60806040" },
    });
    const det = await DETECT(addr, "0xabcdef");
    expect(det.proxy.type).toBe(null);
  });
});

describe("Safe recognition", () => {
  it("recognizes a Safe proxy via slot-0 known singleton", async () => {
    const proxy = A(2);
    installChain({
      [proxy]: { code: "0xproxycode", storage: { [SLOT_ZERO]: addrWord(SAFE_130_SINGLETON) } },
      [SAFE_130_SINGLETON]: { code: "0xsingleton" },
    });
    const det = await DETECT(proxy, "0xproxycode");
    expect(det.proxy.type).toBe("safe");
    expect(det.safe).toMatchObject({ version: "1.3.0", role: "singleton", singleton: SAFE_130_SINGLETON });
    const abi = safeAbiFor(det.safe);
    expect(abi.some(f => f.name === "execTransaction")).toBe(true);
  });

  it("recognizes an unknown-singleton Safe via masterCopy() echo + VERSION()", async () => {
    const proxy = A(2), fork = A(8);
    installChain({
      [proxy]: {
        code: "0xproxycode",
        storage: { [SLOT_ZERO]: addrWord(fork) },
        calls: { "0xa619486e": addrWord(fork), "0xffa1ad74": strWord("1.3.0") },
      },
      [fork]: { code: "0xforksingleton" },
    });
    const det = await DETECT(proxy, "0xproxycode");
    expect(det.proxy.type).toBe("safe");
    expect(det.safe?.version).toBe("1.3.0");
  });

  it("matches a directly-entered singleton address", async () => {
    installChain({ [SAFE_130_SINGLETON]: { code: "0xsingleton" } });
    const det = await DETECT("0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552", "0xsingleton");
    expect(det.safe).toMatchObject({ version: "1.3.0", role: "singleton", singleton: null });
  });
});

describe("detectAbi", () => {
  const sel = (sig) => keccak256(sig).slice(0, 8);

  function installAnalyzer(functions, signatures = {}) {
    const analyzeBytecode = vi.fn(async () => ({ functions }));
    const lookupSignatures = vi.fn(async () => ({ signatures }));
    globalThis.window = { electronAPI: { analyzeBytecode, lookupSignatures } };
    return { analyzeBytecode, lookupSignatures };
  }

  it("names bundled selectors with typed, named inputs and the real selector", async () => {
    installAnalyzer([{ selector: sel("transfer(address,uint256)"), arguments: "address,uint256", stateMutability: "nonpayable" }]);
    const [frag] = await detectAbi("0x6080");
    expect(frag).toMatchObject({
      name: "transfer",
      _selector: "0x" + sel("transfer(address,uint256)"),
      _source: "detected",
      _known: true,
      stateMutability: "nonpayable",
    });
    expect(frag.inputs).toEqual([{ name: "to", type: "address" }, { name: "amount", type: "uint256" }]);
  });

  it("accepts openchain signatures only when they keccak-verify", async () => {
    const good = "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)";
    const goodSel = sel(good), badSel = "deadbeef";
    installAnalyzer(
      [
        { selector: goodSel, arguments: "uint256,uint256,address[],address,uint256", stateMutability: "nonpayable" },
        { selector: badSel, arguments: "uint256", stateMutability: "view" },
      ],
      { ["0x" + goodSel]: good, ["0x" + badSel]: "notTheRealSignature(address)" },
    );
    const frags = await detectAbi("0x6080");
    const named = frags.find(f => f._selector === "0x" + goodSel);
    expect(named).toMatchObject({ name: "swapExactTokensForTokens", _known: true });
    expect(named.inputs.map(i => i.type)).toEqual(["uint256", "uint256", "address[]", "address", "uint256"]);
    const unknown = frags.find(f => f._selector === "0x" + badSel);
    expect(unknown).toMatchObject({ name: "unknown_0x" + badSel, _known: false, stateMutability: "view" });
    expect(unknown.inputs).toEqual([{ name: "arg0", type: "uint256" }]);
  });

  it("falls back to unknown_0x fragments with inferred tuple-aware types", async () => {
    installAnalyzer([{ selector: "deadbeef", arguments: "(address,bytes)[],uint256", stateMutability: "weird" }]);
    const [frag] = await detectAbi("0x6080");
    expect(frag.name).toBe("unknown_0xdeadbeef");
    expect(frag.inputs.map(i => i.type)).toEqual(["(address,bytes)[]", "uint256"]);
    expect(frag.stateMutability).toBe("nonpayable"); // unrecognized mutability normalized
  });

  it("sorts known fragments before unknown ones", async () => {
    installAnalyzer([
      { selector: "deadbeef", arguments: "", stateMutability: "view" },
      { selector: sel("approve(address,uint256)"), arguments: "address,uint256", stateMutability: "nonpayable" },
    ]);
    const frags = await detectAbi("0x6080");
    expect(frags.map(f => f._known)).toEqual([true, false]);
  });

  it("returns null for empty code, missing bridge, or no selectors", async () => {
    installAnalyzer([]);
    expect(await detectAbi("0x6080")).toBe(null);
    expect(await detectAbi("0x")).toBe(null);
    globalThis.window = { electronAPI: {} };
    expect(await detectAbi("0x6080")).toBe(null);
  });
});

describe("normalizeAbi", () => {
  it("guarantees inputs arrays and synthesized param names", () => {
    const out = normalizeAbi([
      { type: "function", name: "f", inputs: [{ type: "uint256" }, { name: "b", type: "address" }] },
      { type: "fallback" },
    ]);
    expect(out[0].inputs.map(i => i.name)).toEqual(["arg0", "b"]);
    expect(out[1].inputs).toEqual([]);
  });

  it("passes non-arrays through untouched", () => {
    expect(normalizeAbi(null)).toBe(null);
  });
});
