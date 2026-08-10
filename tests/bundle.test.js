import { describe, it, expect } from "vitest";
import { keccak256 } from "js-sha3";
import { signDigest } from "../src/lib/sign.js";
import {
  buildBundleObject, txsToTextual, parseImport, bundleInternallyConsistent,
  matchBuild, validateSignatures, mergeSignatures, toInternalTxs,
} from "../src/lib/bundle.js";

// hardhat test keys #0 and #1
const KEY_A = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDR_A = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const KEY_B = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ADDR_B = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

const SAFE = "0x1111111111111111111111111111111111111111";
const DIGEST = "0x" + "7a".repeat(32);

const hexToBytes = (h) => Uint8Array.from(h.replace(/^0x/, "").match(/../g).map(x => parseInt(x, 16)));
// A real consistent (domainHash, messageHash, safeTxHash) triple.
const DOMAIN_HASH = "0x" + "11".repeat(32);
const MESSAGE_HASH = "0x" + "22".repeat(32);
const SAFE_TX_HASH = "0x" + keccak256(new Uint8Array([0x19, 0x01, ...hexToBytes(DOMAIN_HASH), ...hexToBytes(MESSAGE_HASH)]));

const BUILT = { safeTxHash: SAFE_TX_HASH, domainHash: DOMAIN_HASH, messageHash: MESSAGE_HASH, safeVersion: "1.3.0" };

const INTERNAL_TXS = [
  { id: "1", to: "0x" + "22".repeat(20), method: "transfer", signature: "transfer(address,uint256)", selector: "0xa9059cbb",
    params: { to: "0x" + "33".repeat(20), amount: "1000" }, inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    ethValue: "0", data: "0xa9059cbb" + "00".repeat(64), stateMutability: "nonpayable" },
  { id: "2", to: "0x" + "44".repeat(20), method: "(custom)", signature: null, selector: null,
    params: {}, inputs: [], ethValue: "5", data: "0xdeadbeef", stateMutability: "nonpayable" },
];

const makeBundle = (over = {}) => buildBundleObject({
  safeAddr: SAFE, chainId: 1, nonce: 42, built: BUILT, txs: INTERNAL_TXS,
  signatures: [{ address: ADDR_A, sig: signDigest(KEY_A, SAFE_TX_HASH), source: "key", path: "m/44'/60'/0'/0/0" }],
  threshold: 2, ...over,
});

describe("buildBundleObject", () => {
  it("emits the v1 schema", () => {
    const b = makeBundle();
    expect(b.type).toBe("txbuilder-signing-bundle");
    expect(b.version).toBe(1);
    expect(b.chainId).toBe("1");
    expect(b.nonce).toBe(42);
    expect(b.sigCount).toBeUndefined();
    expect(b.safeTxHash).toBe(SAFE_TX_HASH);
    expect(b.messageHash).toBe(MESSAGE_HASH);
    expect(b.transactions[0].contractMethod).toEqual({ name: "transfer", inputs: INTERNAL_TXS[0].inputs });
    expect(b.transactions[0].contractInputsValues).toEqual(INTERNAL_TXS[0].params);
    expect(b.transactions[0].value).toBe("0");
    expect(b.transactions[1].contractMethod).toBe(null); // (custom)
    expect(b.transactions[1].value).toBe("5"); // ethValue carried verbatim
  });

  it("strips device paths from signatures and defaults source", () => {
    const b = makeBundle();
    expect(b.signatures[0].path).toBeUndefined();
    expect(b.signatures[0].source).toBe("key");
  });

  it("emits rejection bundles as a self-send", () => {
    const b = makeBundle({ rejection: true });
    expect(b.rejection).toBe(true);
    expect(b.description).toMatch(/nonce/);
    expect(b.transactions).toEqual([{ to: SAFE, value: "0", data: "0x", contractMethod: null, contractInputsValues: null }]);
  });
});

describe("parseImport", () => {
  it("round-trips a v1 bundle", () => {
    const { kind, data, error } = parseImport(JSON.stringify(makeBundle()));
    expect(error).toBe(null);
    expect(kind).toBe("bundle");
    expect(data.nonce).toBe(42);
    expect(data.chainId).toBe("1");
    expect(data.safeTxHash).toBe(SAFE_TX_HASH);
    expect(data.signatures).toHaveLength(1);
    expect(data.transactions[0].contractMethod.name).toBe("transfer");
  });

  it("detects the legacy outputBundle shape, tolerating `signature` and type:rejection", () => {
    const legacy = {
      safeAddr: SAFE, chainId: 1, nonce: 7, type: "rejection",
      safeTxHash: SAFE_TX_HASH,
      transactions: [{ to: SAFE, value: "0", data: "0x" }],
      signatures: [{ address: ADDR_A, signature: signDigest(KEY_A, SAFE_TX_HASH), source: "key" }],
      sigCount: 1, threshold: 2,
    };
    const { kind, data } = parseImport(JSON.stringify(legacy));
    expect(kind).toBe("legacy-bundle");
    expect(data.rejection).toBe(true);
    expect(data.messageHash).toBe(null);
    expect(data.signatures[0].sig).toMatch(/^0x[0-9a-f]{130}$/i);
  });

  it("detects a batch export", () => {
    const batch = {
      version: "1.0", chainId: "1", createdAt: 1, meta: { name: "My batch" },
      transactions: [{ to: "0x" + "22".repeat(20), value: "0", data: "0x",
        contractMethod: { name: "transfer", inputs: [] }, contractInputsValues: {} }],
    };
    const { kind, data } = parseImport(JSON.stringify(batch));
    expect(kind).toBe("batch");
    expect(data.name).toBe("My batch");
    expect(data.transactions).toHaveLength(1);
  });

  it("rejects empty, non-JSON, unrecognized, oversized, and unsupported-version input", () => {
    expect(parseImport("").kind).toBe(null);
    expect(parseImport("not json").error).toMatch(/JSON/);
    expect(parseImport(JSON.stringify({ foo: 1 })).error).toMatch(/Not a signing bundle/);
    expect(parseImport("x".repeat(2 * 1024 * 1024 + 1)).error).toMatch(/too large/);
    expect(parseImport(JSON.stringify({ type: "txbuilder-signing-bundle", version: 99 })).error).toMatch(/version/);
  });

  it("drops malformed signature entries and counts them", () => {
    const b = makeBundle();
    b.signatures.push({ address: ADDR_B, sig: "0x1234" }, { nothing: true });
    const { data } = parseImport(JSON.stringify(b));
    expect(data.signatures).toHaveLength(1);
    expect(data.malformedSigCount).toBe(2);
  });
});

describe("bundleInternallyConsistent", () => {
  it("true for a real triple, false when tampered, null when hashes missing", () => {
    expect(bundleInternallyConsistent({ safeTxHash: SAFE_TX_HASH, domainHash: DOMAIN_HASH, messageHash: MESSAGE_HASH })).toBe(true);
    expect(bundleInternallyConsistent({ safeTxHash: "0x" + "ff".repeat(32), domainHash: DOMAIN_HASH, messageHash: MESSAGE_HASH })).toBe(false);
    expect(bundleInternallyConsistent({ safeTxHash: SAFE_TX_HASH })).toBe(null);
  });
});

describe("matchBuild", () => {
  it("matches on safeTxHash, then messageHash, else null", () => {
    expect(matchBuild({ safeTxHash: SAFE_TX_HASH.toUpperCase().replace("0X", "0x") }, BUILT)).toBe("safeTxHash");
    expect(matchBuild({ safeTxHash: null, messageHash: MESSAGE_HASH }, BUILT)).toBe("messageHash");
    expect(matchBuild({ safeTxHash: "0x" + "ff".repeat(32) }, BUILT)).toBe(null);
    expect(matchBuild(null, BUILT)).toBe(null);
  });
});

describe("validateSignatures", () => {
  const sigA = signDigest(KEY_A, DIGEST);
  const sigB = signDigest(KEY_B, DIGEST);

  it("valid signature; adopts the recovered address when none is claimed", () => {
    const [v] = validateSignatures({ signatures: [{ address: null, sig: sigA }], safeTxHash: DIGEST });
    expect(v.status).toBe("valid");
    expect(v.address).toBe(ADDR_A);
  });

  it("rejects claimed-address mismatches and garbage", () => {
    const verdicts = validateSignatures({
      signatures: [{ address: ADDR_B, sig: sigA }, { address: ADDR_A, sig: "0x" + "ab".repeat(65) }],
      safeTxHash: DIGEST,
    });
    expect(verdicts.map(v => v.status)).toEqual(["invalid", "invalid"]);
  });

  it("flags non-owners without rejecting; empty owner set means plain valid", () => {
    const [flagged] = validateSignatures({ signatures: [{ address: null, sig: sigA }], safeTxHash: DIGEST, owners: [ADDR_B] });
    expect(flagged.status).toBe("valid-not-owner");
    const [plain] = validateSignatures({ signatures: [{ address: null, sig: sigA }], safeTxHash: DIGEST, owners: [] });
    expect(plain.status).toBe("valid");
  });

  it("dedupes against existing and within one import (first wins, even different hex)", () => {
    const sigA2 = signDigest(KEY_A, DIGEST); // deterministic → same; simulate different via existing
    const verdicts = validateSignatures({
      signatures: [{ address: null, sig: sigA }, { address: null, sig: sigA2 }, { address: null, sig: sigB }],
      safeTxHash: DIGEST,
      existing: [{ address: ADDR_B.toUpperCase(), sig: sigB }],
    });
    expect(verdicts.map(v => v.status)).toEqual(["valid", "duplicate", "duplicate"]);
  });
});

describe("mergeSignatures", () => {
  it("appends accepted verdicts with counts, keeping existing order", () => {
    const sigA = signDigest(KEY_A, DIGEST), sigB = signDigest(KEY_B, DIGEST);
    const existing = [{ address: ADDR_B, sig: sigB, source: "key" }];
    const verdicts = validateSignatures({
      signatures: [{ address: null, sig: sigA }, { address: null, sig: sigB }, { address: null, sig: "0x" + "cd".repeat(65) }],
      safeTxHash: DIGEST, owners: [ADDR_B], existing,
    });
    const res = mergeSignatures(existing, verdicts);
    expect(res).toMatchObject({ imported: 1, duplicates: 1, invalid: 1, notOwner: 1 });
    expect(res.merged.map(s => s.address)).toEqual([ADDR_B, ADDR_A]);
    expect(res.merged.every(s => typeof s.address === "string")).toBe(true);
  });
});

describe("toInternalTxs / txsToTextual round-trip", () => {
  it("reconstructs the internal tx shape from a bundle", () => {
    const parsed = parseImport(JSON.stringify(makeBundle())).data;
    const internal = toInternalTxs(parsed, { baseId: 1000 });
    expect(internal[0]).toMatchObject({
      id: "1000", to: INTERNAL_TXS[0].to, method: "transfer",
      params: INTERNAL_TXS[0].params, inputs: INTERNAL_TXS[0].inputs,
      ethValue: "0", data: INTERNAL_TXS[0].data, stateMutability: "nonpayable",
    });
    expect(internal[1]).toMatchObject({ id: "1001", method: "(custom)", ethValue: "5", data: "0xdeadbeef", params: {}, inputs: [] });
  });

  it("textual↔internal round-trip preserves to/value/data/method/params", () => {
    const textual = txsToTextual(INTERNAL_TXS);
    const back = txsToTextual(toInternalTxs({ transactions: textual }));
    expect(back).toEqual(textual);
  });

  it("works for batch-kind data too", () => {
    const batch = parseImport(JSON.stringify({ version: "1.0", transactions: txsToTextual(INTERNAL_TXS) }));
    expect(batch.kind).toBe("batch");
    expect(toInternalTxs(batch.data)).toHaveLength(2);
  });
});
