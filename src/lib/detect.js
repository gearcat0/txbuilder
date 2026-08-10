// Capability detection for addresses with no fetchable ABI.
//
// Layered, mostly offline: classify via bytecode (EOA / EIP-7702 / contract),
// resolve proxy chains on-chain (EIP-1967, EIP-1167, beacon, Safe), recognize
// Safe deployments exactly against the bundled safe-deployments data, probe
// ERC-165 / token interfaces, and as a last resort build a synthetic ABI from
// selectors extracted out of the bytecode (evmole in the main process) named
// via the bundled signature DB with an openchain.xyz online fallback.
//
// Everything RPC goes through window.electronAPI (rpcBatch etc.) and degrades
// to null results when the bridge or the endpoint is unavailable — callers
// fall back to the addressbook-only flow.
import { keccak256 } from "js-sha3";
import { matchSafe, safeAbiForVersion, abiForRoleVersion } from "./safe-abis.js";
import SIGNATURE_DB from "../data/signatures.json";

const SLOT_EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SLOT_EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const SLOT_ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

const SEL_IMPLEMENTATION = "0x5c60da1b"; // implementation()
const SEL_MASTERCOPY = "0xa619486e";     // masterCopy() — Safe proxies answer this themselves
const SEL_VERSION = "0xffa1ad74";        // VERSION()
const SEL_GET_OWNERS = "0xa0e67e2b";     // getOwners()
const SEL_GET_THRESHOLD = "0xe75235b8";  // getThreshold()
const SEL_DECIMALS = "0x313ce567";
const SEL_SYMBOL = "0x95d89b41";
const SEL_TOTAL_SUPPLY = "0x18160ddd";

const supportsInterfaceData = (id) => "0x01ffc9a7" + id.replace(/^0x/, "").padEnd(64, "0");
const IFACE_ERC165 = "0x01ffc9a7";
const IFACE_INVALID = "0xffffffff"; // a valid ERC-165 responder MUST return false for this
const IFACE_ERC721 = "0x80ac58cd";
const IFACE_ERC1155 = "0xd9b67a26";

const RE_EIP1167 = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i;
const RE_EIP7702 = /^0xef0100([0-9a-f]{40})$/i;

const PROXY_WALK_MAX_DEPTH = 3;

// ── hex / ABI-word helpers ──────────────────────────────────────────────────

function hexToBytes(hex) {
  let h = String(hex).replace(/^0x/, "");
  if (h.length % 2) h = "0" + h;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function codehashOf(code) {
  return "0x" + keccak256(hexToBytes(code));
}

function hasCode(code) {
  return !!(code && code !== "0x" && code !== "0x0");
}

// A 32-byte storage word / return word → the address in its low 20 bytes,
// or null when empty/zero/malformed.
function wordToAddress(word) {
  if (!word || word === "0x") return null;
  const h = String(word).replace(/^0x/, "").toLowerCase();
  if (h.length < 40 || !/^[0-9a-f]+$/.test(h)) return null;
  const addr = h.slice(-40);
  if (/^0+$/.test(addr) || !/^0*$/.test(h.slice(0, -40))) return null;
  return "0x" + addr;
}

function decodeBool(hex) {
  if (!hex || hex === "0x") return null;
  try { return BigInt(hex) === 1n; } catch { return null; }
}

function decodeUint(hex) {
  if (!hex || hex === "0x") return null;
  try { return BigInt(hex); } catch { return null; }
}

// Decode a returned string — standard dynamic ABI string, or the legacy
// bytes32 form some old tokens use for symbol().
function decodeAbiString(hex) {
  if (!hex || hex === "0x") return null;
  const h = String(hex).replace(/^0x/, "");
  try {
    if (h.length >= 128) {
      const len = Number(BigInt("0x" + h.slice(64, 128)));
      if (len >= 0 && len <= 256) {
        const bytes = hexToBytes(h.slice(128, 128 + len * 2));
        const s = new TextDecoder().decode(bytes);
        if (/^[\x20-\x7e]*$/.test(s)) return s;
      }
    }
    if (h.length === 64) {
      const s = new TextDecoder().decode(hexToBytes(h)).replace(/\0+$/, "");
      if (s && /^[\x20-\x7e]*$/.test(s)) return s;
    }
  } catch {}
  return null;
}

// ── RPC plumbing ────────────────────────────────────────────────────────────

const reqGetCode = (addr) => ({ method: "eth_getCode", params: [addr, "latest"] });
const reqStorage = (addr, slot) => ({ method: "eth_getStorageAt", params: [addr, slot, "latest"] });
const reqCall = (to, data) => ({ method: "eth_call", params: [{ to, data }, "latest"] });

async function batch(rpcUrl, requests) {
  if (!rpcUrl || !window.electronAPI?.rpcBatch) return null;
  try {
    const res = await window.electronAPI.rpcBatch(rpcUrl, requests);
    if (!res || res.error || !Array.isArray(res.results)) return null;
    return res.results.map(r => (r && !r.error ? r.result : null));
  } catch {
    return null;
  }
}

// ── detection ───────────────────────────────────────────────────────────────

// One hop of proxy resolution for `addr` whose runtime code is `code`,
// given its three interesting storage slots. Returns {type, target} or null.
async function resolveProxyHop(rpcUrl, addr, code, slots, masterCopyEcho) {
  const m1167 = RE_EIP1167.exec(code || "");
  if (m1167) return { type: "eip1167", target: "0x" + m1167[1].toLowerCase() };
  if (!slots) return null;
  const implAddr = wordToAddress(slots.impl);
  if (implAddr) return { type: "eip1967", target: implAddr };
  const beaconAddr = wordToAddress(slots.beacon);
  if (beaconAddr) {
    const r = await batch(rpcUrl, [reqCall(beaconAddr, SEL_IMPLEMENTATION)]);
    const target = wordToAddress(r?.[0]);
    if (target) return { type: "beacon", target };
  }
  const slot0Addr = wordToAddress(slots.zero);
  if (slot0Addr) {
    // Slot 0 holding an address is not proof of a Safe proxy — require either
    // a known singleton deployment or the proxy echoing it via masterCopy().
    const echoed = wordToAddress(masterCopyEcho);
    if (matchSafe({ address: slot0Addr }) || (echoed && echoed === slot0Addr)) {
      return { type: "safe", target: slot0Addr };
    }
  }
  return null;
}

// Full detection for one address. `code` is the already-fetched eth_getCode
// result for it. Never throws; fields the environment can't answer stay null.
export async function detectContract({ address, chainId, rpcUrl, code }) {
  const det = {
    address, chainId,
    codehash: null,
    classification: "contract",
    delegate: null,
    proxy: { type: null, chain: [] },
    logicAddress: null,
    logicCodehash: null,
    logicCode: null, // not persisted in cache records; used for detectAbi
    safe: null,
    capabilities: null,
  };
  if (!hasCode(code)) {
    det.classification = "eoa";
    return det;
  }
  det.codehash = codehashOf(code);

  let runCode = code;
  const m7702 = RE_EIP7702.exec(code);
  if (m7702) {
    det.classification = "eip7702";
    det.delegate = "0x" + m7702[1].toLowerCase();
    // Storage and calls stay at the account address; the running code is the
    // delegate's.
    const r = await batch(rpcUrl, [reqGetCode(det.delegate)]);
    runCode = r?.[0] || null;
  }

  // One batch answers everything about the account address: proxy slots,
  // interface probes, VERSION() and masterCopy() (for Safe confirmation).
  const b1 = await batch(rpcUrl, [
    reqStorage(address, SLOT_EIP1967_IMPL),
    reqStorage(address, SLOT_EIP1967_BEACON),
    reqStorage(address, SLOT_ZERO),
    reqCall(address, supportsInterfaceData(IFACE_ERC165)),
    reqCall(address, supportsInterfaceData(IFACE_INVALID)),
    reqCall(address, supportsInterfaceData(IFACE_ERC721)),
    reqCall(address, supportsInterfaceData(IFACE_ERC1155)),
    reqCall(address, SEL_DECIMALS),
    reqCall(address, SEL_SYMBOL),
    reqCall(address, SEL_TOTAL_SUPPLY),
    reqCall(address, SEL_VERSION),
    reqCall(address, SEL_MASTERCOPY),
  ]);

  if (b1) {
    const erc165Valid = decodeBool(b1[3]) === true && decodeBool(b1[4]) === false;
    const decimals = decodeUint(b1[7]);
    const decimalsOk = decimals !== null && decimals >= 0n && decimals <= 77n;
    const erc20 = decimalsOk && decodeUint(b1[9]) !== null;
    det.capabilities = {
      erc165: erc165Valid,
      erc721: erc165Valid && decodeBool(b1[5]) === true,
      erc1155: erc165Valid && decodeBool(b1[6]) === true,
      erc20,
      decimals: erc20 ? Number(decimals) : null,
      symbol: erc20 ? decodeAbiString(b1[8]) : null,
    };
  }

  // Proxy walk from the account address outward.
  let slots = b1 ? { impl: b1[0], beacon: b1[1], zero: b1[2] } : null;
  let curCode = runCode;
  let curAddr = address;
  for (let depth = 0; depth < PROXY_WALK_MAX_DEPTH && hasCode(curCode); depth++) {
    const hop = await resolveProxyHop(rpcUrl, curAddr, curCode, slots, depth === 0 ? b1?.[11] : null);
    if (!hop || hop.target === curAddr.toLowerCase()) break;
    det.proxy.type = det.proxy.type || hop.type; // report the outermost kind
    det.proxy.chain.push(hop.target);
    const r = await batch(rpcUrl, [
      reqGetCode(hop.target),
      reqStorage(hop.target, SLOT_EIP1967_IMPL),
      reqStorage(hop.target, SLOT_EIP1967_BEACON),
      reqStorage(hop.target, SLOT_ZERO),
    ]);
    if (!r) break;
    curAddr = hop.target;
    curCode = r[0];
    slots = { impl: r[1], beacon: r[2], zero: r[3] };
  }

  const walked = det.proxy.chain.length > 0;
  det.logicAddress = walked ? curAddr : det.delegate;
  det.logicCode = hasCode(curCode) ? curCode : null;
  det.logicCodehash = det.logicCode ? codehashOf(det.logicCode) : null;

  // Safe recognition: the address itself first (singleton / MultiSend /
  // handler as a direct target), then the resolved logic contract.
  let hit = matchSafe({ address, codehash: det.codehash });
  let singleton = null;
  if (!hit && det.logicAddress) {
    hit = matchSafe({ address: det.logicAddress, codehash: det.logicCodehash });
    if (hit) singleton = det.logicAddress;
  }
  if (!hit && det.proxy.type === "safe") {
    // Confirmed Safe proxy but unknown singleton (fork / unlisted chain):
    // fall back to the VERSION() string.
    const version = decodeAbiString(b1?.[10]);
    const entry = safeAbiForVersion(version);
    if (entry) { hit = entry; singleton = det.logicAddress; }
  }
  if (hit) {
    det.safe = { version: hit.version, contractName: hit.contractName, role: hit.role, singleton };
  }
  return det;
}

// Decode an ABI-encoded `address[]` return value (offset + length + words),
// or null when the data doesn't parse as one. Zero addresses reject the whole
// array — a Safe owner set can never contain them.
export function decodeAddressArray(hex) {
  if (!hex || hex === "0x") return null;
  const h = String(hex).replace(/^0x/, "");
  try {
    if (h.length < 128) return null;
    if (Number(BigInt("0x" + h.slice(0, 64))) !== 32) return null;
    const len = Number(BigInt("0x" + h.slice(64, 128)));
    if (len < 0 || len > 1000 || h.length < 128 + len * 64) return null;
    const out = [];
    for (let i = 0; i < len; i++) {
      const a = wordToAddress("0x" + h.slice(128 + i * 64, 128 + (i + 1) * 64));
      if (!a) return null;
      out.push(a);
    }
    return out;
  } catch {
    return null;
  }
}

// Verify that an address is a usable Safe *account* (not merely bytecode that
// resembles one) and fetch its owner set — independent of the address book.
// One RPC batch. Returns one of:
//   {status:"safe", version, threshold, owners, singleton}
//   {status:"eoa"} | {status:"not-safe"} | {status:"unknown"}  (RPC unavailable)
export async function detectSafeAccount({ address, rpcUrl }) {
  const results = await batch(rpcUrl, [
    reqGetCode(address),
    reqStorage(address, SLOT_ZERO),
    reqCall(address, SEL_MASTERCOPY),
    reqCall(address, SEL_VERSION),
    reqCall(address, SEL_GET_OWNERS),
    reqCall(address, SEL_GET_THRESHOLD),
  ]);
  if (!results) return { status: "unknown" };
  const [code, slot0, mcEcho, verRaw, ownersRaw, thresholdRaw] = results;
  if (!hasCode(code)) return { status: "eoa" };

  const slot0Addr = wordToAddress(slot0);
  const known = slot0Addr ? matchSafe({ address: slot0Addr }) : null;
  const echoed = wordToAddress(mcEcho);
  const singleton = slot0Addr && (known || echoed === slot0Addr) ? slot0Addr : null;

  const owners = decodeAddressArray(ownersRaw);
  const threshold = decodeUint(thresholdRaw);
  const version = known?.version || decodeAbiString(verRaw) || null;
  // A usable Safe account always has a non-empty owner set and threshold ≥ 1;
  // this also excludes bare singletons (constructor sets threshold, owners
  // stay empty) which are real Safe bytecode but not anyone's account.
  const usable = Array.isArray(owners) && owners.length > 0 && threshold !== null && threshold >= 1n;

  if (usable && (singleton || version)) {
    // `singleton` proves the canonical proxy linkage; version-string-only is
    // the fallback for forks and deployments safe-deployments doesn't list.
    return { status: "safe", version, threshold: Number(threshold), owners, singleton };
  }
  return { status: "not-safe" };
}

// ── bundled Safe ABI for a detection/cache record ───────────────────────────

export function safeAbiFor(safe) {
  if (!safe) return null;
  const entry = abiForRoleVersion(safe.role, safe.version) || safeAbiForVersion(safe.version);
  return entry ? entry.abi : null;
}

// ── synthetic ABI from bytecode ─────────────────────────────────────────────

// Split "address,uint256,(address,bytes)[]" on top-level commas only.
function splitTypes(inner) {
  if (!inner) return [];
  const out = [];
  let depth = 0, cur = "";
  for (const ch of inner) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseSignature(sig) {
  const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\((.*)\)$/.exec(sig || "");
  if (!m) return null;
  return {
    name: m[1],
    inputs: splitTypes(m[2]).map((type, i) => ({ name: `arg${i}`, type })),
  };
}

const MUTABILITIES = new Set(["pure", "view", "payable", "nonpayable"]);

function makeFragment({ name, inputs, mutability, selector, known }) {
  return {
    type: "function",
    name,
    inputs: (inputs || []).map((inp, i) => ({ name: inp.name || `arg${i}`, type: inp.type })),
    outputs: [],
    stateMutability: MUTABILITIES.has(mutability) ? mutability : "nonpayable",
    _selector: "0x" + selector,
    _source: "detected",
    _known: known,
  };
}

// Build a synthetic ABI from raw runtime bytecode: evmole (main process)
// extracts selectors + inferred argument types + mutability; names come from
// the bundled signature DB, then openchain.xyz for the leftovers. Online
// answers are keccak-verified against the selector — a wrong name would
// encode a wrong selector downstream. Returns null when nothing usable.
export async function detectAbi(code) {
  if (!hasCode(code) || !window.electronAPI?.analyzeBytecode) return null;
  let res;
  try { res = await window.electronAPI.analyzeBytecode(code); } catch { return null; }
  if (!res || res.error || !Array.isArray(res.functions) || res.functions.length === 0) return null;

  const frags = [];
  const unknown = [];
  for (const fn of res.functions) {
    const sel = String(fn.selector || "").replace(/^0x/, "").toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(sel)) continue;
    const bundled = SIGNATURE_DB[sel];
    if (bundled) {
      frags.push(makeFragment({ name: bundled.name, inputs: bundled.inputs, mutability: fn.stateMutability, selector: sel, known: true }));
    } else {
      unknown.push({ sel, fn });
    }
  }

  if (unknown.length && window.electronAPI?.lookupSignatures) {
    try {
      const lookup = await window.electronAPI.lookupSignatures(unknown.map(u => "0x" + u.sel));
      const sigs = lookup?.signatures || {};
      for (const u of unknown) {
        const sigText = sigs["0x" + u.sel];
        const parsed = sigText ? parseSignature(sigText) : null;
        if (parsed && keccak256(sigText).slice(0, 8) === u.sel) {
          frags.push(makeFragment({ name: parsed.name, inputs: parsed.inputs, mutability: u.fn.stateMutability, selector: u.sel, known: true }));
          u.resolved = true;
        }
      }
    } catch {}
  }
  for (const u of unknown) {
    if (u.resolved) continue;
    const inputs = splitTypes(u.fn.arguments || "").filter(Boolean).map((type, i) => ({ name: `arg${i}`, type }));
    frags.push(makeFragment({ name: "unknown_0x" + u.sel, inputs, mutability: u.fn.stateMutability, selector: u.sel, known: false }));
  }

  frags.sort((a, b) => (a._known === b._known ? a.name.localeCompare(b.name) : a._known ? -1 : 1));
  return frags.length ? frags : null;
}

// ── ABI hygiene ─────────────────────────────────────────────────────────────

// The rest of the app assumes every fragment has an `inputs` array and every
// input a name (params are keyed by input name). Applied to ALL ABIs entering
// component state, whatever their source.
export function normalizeAbi(abi) {
  if (!Array.isArray(abi)) return abi;
  return abi.map(e => {
    if (!e || typeof e !== "object") return e;
    const inputs = Array.isArray(e.inputs)
      ? e.inputs.map((inp, i) => (inp && inp.name ? inp : { ...inp, name: `arg${i}` }))
      : [];
    return { ...e, inputs };
  });
}
