// The universal signing-bundle format (v1) and all pure logic around it:
// building, parsing (incl. legacy shapes), validation, and signature merging.
// No window/React — unit-tested in tests/bundle.test.js.
//
// A bundle is self-contained: it carries the full transaction batch in the
// textual batch-export form (contractMethod + contractInputsValues) so a
// recipient can read what they're signing without having the ABI, plus the
// EIP-712 component hashes and the collected {address, sig} pairs.
//
// NOTE on `value`: carried verbatim as the form's ethValue string, exactly as
// the batch export does. protocol-kit currently interprets it as wei — the
// hash depends on it, so the bundle must never convert units.
import { keccak256 } from "js-sha3";
import { recoverAddress } from "./sign.js";

export const BUNDLE_TYPE = "txbuilder-signing-bundle";
export const BUNDLE_VERSION = 1;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

const REJECTION_DESCRIPTION = "Send 0 ETH to self (nonce consumption)";

const is32ByteHex = (s) => /^0x[0-9a-fA-F]{64}$/.test(String(s || ""));
const isSigHex = (s) => /^0x[0-9a-fA-F]{130}$/.test(String(s || ""));
const isAddressHex = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || ""));

// ── building ────────────────────────────────────────────────────────────────

// Internal tx shape ({to, method, inputs, params, ethValue, data, ...}) →
// the textual batch-export form.
export function txsToTextual(txs) {
  return (txs || []).map(tx => ({
    to: tx.to,
    value: tx.ethValue || "0",
    data: tx.data || "0x",
    contractMethod: tx.method && tx.method !== "(custom)" ? { name: tx.method, inputs: tx.inputs || [] } : null,
    contractInputsValues: tx.method && tx.method !== "(custom)" ? tx.params || {} : null,
  }));
}

export function rejectionTextualTxs(safeAddr) {
  return [{ to: safeAddr, value: "0", data: "0x", contractMethod: null, contractInputsValues: null }];
}

export function buildBundleObject({ safeAddr, chainId, nonce, built, txs, signatures, threshold, rejection = false }) {
  return {
    type: BUNDLE_TYPE,
    version: BUNDLE_VERSION,
    createdAt: Date.now(),
    chainId: String(chainId),
    safeAddr,
    safeVersion: built?.safeVersion || null,
    nonce,
    safeTxHash: built?.safeTxHash || null,
    domainHash: built?.domainHash || null,
    messageHash: built?.messageHash || null,
    threshold: threshold ?? null,
    rejection: !!rejection,
    description: rejection ? REJECTION_DESCRIPTION : null,
    transactions: rejection ? rejectionTextualTxs(safeAddr) : txsToTextual(txs),
    // Device derivation paths are dropped — other parties don't need them.
    signatures: (signatures || []).map(({ address, sig, signature, source }) => ({
      address, sig: sig || signature, source: source || "imported",
    })),
  };
}

// ── parsing ─────────────────────────────────────────────────────────────────

function normalizeSignatures(raw) {
  let malformed = 0;
  const out = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const sig = entry && (entry.sig || entry.signature); // legacy rows may use `signature`
    if (!isSigHex(sig)) { malformed++; continue; }
    const address = entry.address && isAddressHex(entry.address) ? String(entry.address) : null;
    out.push({ address, sig, source: entry.source || "imported" });
  }
  return { signatures: out, malformedSigCount: malformed };
}

function normalizeTextualTxs(raw) {
  return (Array.isArray(raw) ? raw : []).filter(t => t && typeof t.to === "string").map(t => ({
    to: t.to,
    value: t.value != null ? String(t.value) : "0",
    data: t.data || "0x",
    contractMethod: t.contractMethod && t.contractMethod.name
      ? { name: t.contractMethod.name, inputs: Array.isArray(t.contractMethod.inputs) ? t.contractMethod.inputs : [] }
      : null,
    contractInputsValues: t.contractInputsValues && typeof t.contractInputsValues === "object" ? t.contractInputsValues : null,
  }));
}

function normalizeBundle(d) {
  const { signatures, malformedSigCount } = normalizeSignatures(d.signatures);
  return {
    chainId: d.chainId != null ? String(d.chainId) : null,
    safeAddr: typeof d.safeAddr === "string" ? d.safeAddr : null,
    nonce: Number.isFinite(Number(d.nonce)) && d.nonce !== null && d.nonce !== "" ? Number(d.nonce) : null,
    safeTxHash: is32ByteHex(d.safeTxHash) ? d.safeTxHash : null,
    domainHash: is32ByteHex(d.domainHash) ? d.domainHash : null,
    messageHash: is32ByteHex(d.messageHash) ? d.messageHash : null,
    threshold: Number.isFinite(Number(d.threshold)) && d.threshold != null ? Number(d.threshold) : null,
    rejection: d.rejection === true || d.type === "rejection",
    description: typeof d.description === "string" ? d.description : null,
    transactions: normalizeTextualTxs(d.transactions),
    signatures,
    malformedSigCount,
  };
}

// Parse pasted/loaded text into one of the accepted kinds. Never throws.
export function parseImport(text) {
  const none = (error) => ({ kind: null, data: null, error });
  if (!text || !String(text).trim()) return none("Nothing to import");
  if (String(text).length > MAX_IMPORT_BYTES) return none("File too large to be a signing bundle");
  let d;
  try { d = JSON.parse(text); } catch { return none("Not valid JSON"); }
  if (!d || typeof d !== "object" || Array.isArray(d)) return none("Not a signing bundle or batch");

  if (d.type === BUNDLE_TYPE) {
    if (d.version !== BUNDLE_VERSION) return none(`Unsupported bundle version ${d.version}`);
    const data = normalizeBundle(d);
    if (!data.safeTxHash) return none("Bundle is missing a valid safeTxHash");
    return { kind: "bundle", data, error: null };
  }
  // Legacy outputBundle: no type/version, but safeTxHash + safeAddr present.
  if (is32ByteHex(d.safeTxHash) && typeof d.safeAddr === "string") {
    return { kind: "legacy-bundle", data: normalizeBundle(d), error: null };
  }
  // Batch export: transactions but no safeTxHash (Safe tx-builder-style JSON).
  if (Array.isArray(d.transactions) && d.transactions.every(t => t && typeof t.to === "string")) {
    return {
      kind: "batch",
      data: {
        chainId: d.chainId != null ? String(d.chainId) : null,
        name: d.meta?.name || null,
        transactions: normalizeTextualTxs(d.transactions),
      },
      error: null,
    };
  }
  return none("Not a signing bundle or batch");
}

// ── validation ──────────────────────────────────────────────────────────────

function hexToBytes(hex) {
  const h = String(hex).replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// keccak256(0x1901 ‖ domainHash ‖ messageHash) === safeTxHash — lets a signer
// without an RPC detect a tampered bundle. null when the hashes are absent.
export function bundleInternallyConsistent(bundle) {
  if (!is32ByteHex(bundle?.safeTxHash) || !is32ByteHex(bundle?.domainHash) || !is32ByteHex(bundle?.messageHash)) return null;
  const payload = new Uint8Array([
    0x19, 0x01,
    ...hexToBytes(bundle.domainHash),
    ...hexToBytes(bundle.messageHash),
  ]);
  return "0x" + keccak256(payload) === bundle.safeTxHash.toLowerCase();
}

// Which of the freshly built hashes does the bundle match?
export function matchBuild(bundle, built) {
  if (!bundle || !built) return null;
  const eq = (a, b) => a && b && String(a).toLowerCase() === String(b).toLowerCase();
  if (eq(bundle.safeTxHash, built.safeTxHash)) return "safeTxHash";
  if (eq(bundle.messageHash, built.messageHash)) return "messageHash";
  return null;
}

// Per-signature verdicts against a known digest, the (possibly stale) owner
// set, and already-collected signatures.
export function validateSignatures({ signatures, safeTxHash, owners = [], existing = [] }) {
  const ownerSet = new Set(owners.map(o => String(o).toLowerCase()));
  const seen = new Set(existing.map(s => String(s.address).toLowerCase()));
  const verdicts = [];
  for (const entry of signatures || []) {
    const recovered = recoverAddress(safeTxHash, entry.sig);
    if (!recovered) { verdicts.push({ ...entry, status: "invalid" }); continue; }
    // A bundle claiming an address its signature doesn't recover to is worse
    // than one claiming nothing — reject rather than silently reassign.
    if (entry.address && entry.address.toLowerCase() !== recovered) {
      verdicts.push({ ...entry, status: "invalid" });
      continue;
    }
    const address = recovered; // lowercase, always a string
    if (seen.has(address)) { verdicts.push({ ...entry, address, status: "duplicate" }); continue; }
    seen.add(address);
    // Import unknown-owner signatures but flag them — the local owner list may
    // be stale; the chain is the final arbiter at execution time.
    const status = ownerSet.size > 0 && !ownerSet.has(address) ? "valid-not-owner" : "valid";
    verdicts.push({ ...entry, address, status });
  }
  return verdicts;
}

export function mergeSignatures(existing, verdicts) {
  const counts = { imported: 0, duplicates: 0, invalid: 0, notOwner: 0 };
  const merged = [...existing];
  for (const v of verdicts) {
    if (v.status === "duplicate") { counts.duplicates++; continue; }
    if (v.status === "invalid") { counts.invalid++; continue; }
    if (v.status === "valid-not-owner") counts.notOwner++;
    counts.imported++;
    merged.push({ address: v.address, sig: v.sig, source: v.source || "imported" });
  }
  return { merged, ...counts };
}

// ── loading a bundle/batch into the editor ──────────────────────────────────

// Textual transactions → the internal tx shape TransactionForm produces.
export function toInternalTxs(data, { baseId = Date.now() } = {}) {
  return (data?.transactions || []).map((t, i) => ({
    id: String(baseId + i),
    to: t.to,
    method: t.contractMethod?.name || "(custom)",
    signature: null,
    selector: null,
    params: t.contractInputsValues || {},
    inputs: t.contractMethod?.inputs || [],
    ethValue: t.value || "0",
    data: t.data || "0x",
    stateMutability: "nonpayable",
  }));
}
