import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { keccak256, encodeAbiParameters, concat } from "viem";

const require = createRequire(import.meta.url);
const { buildSafeTypedData, hashSafeTypedData, domainHasChainId } = require("../src/lib/safe-typed-data.cjs");

// Typehashes hard-coded in the Safe contracts (GnosisSafe.sol / Safe.sol).
const DOMAIN_TYPEHASH_V13 = "0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218"; // chainId + verifyingContract
const DOMAIN_TYPEHASH_OLD = "0x035aff83d86937d35b32e04f0ddc6ff469290eef2f1b692d8a815c89404d4749"; // verifyingContract only
const SAFE_TX_TYPEHASH = "0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8";

const SAFE = "0x1234567890AbcdEF1234567890aBcdef12345678";
const TX = {
  to: "0x00000000000000000000000000000000000000aa", value: "1000", data: "0xdeadbeef", operation: 1,
  safeTxGas: 0, baseGas: "0", gasPrice: "0", gasToken: null, refundReceiver: null, nonce: 7,
};

// The contract's own getTransactionHash, re-implemented from its source.
function contractHash({ chainId, withChain }) {
  const zero = "0x0000000000000000000000000000000000000000";
  const structHash = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint8" },
     { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
    [SAFE_TX_TYPEHASH, TX.to, 1000n, keccak256(TX.data), 1, 0n, 0n, 0n, zero, zero, 7n],
  ));
  const domainSep = withChain
    ? keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }], [DOMAIN_TYPEHASH_V13, BigInt(chainId), SAFE]))
    : keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }], [DOMAIN_TYPEHASH_OLD, SAFE]));
  return { safeTxHash: keccak256(concat(["0x1901", domainSep, structHash])), domainSep, structHash };
}

describe("buildSafeTypedData", () => {
  it("matches the Safe >= 1.3.0 contract hash (chainId in domain)", () => {
    const b = buildSafeTypedData({ chainId: 100, safeAddr: SAFE, version: "1.3.0+L2", tx: TX });
    const want = contractHash({ chainId: 100, withChain: true });
    expect(b.safeTxHash).toBe(want.safeTxHash);
    expect(b.domainHash).toBe(want.domainSep);
    expect(b.messageHash).toBe(want.structHash);
    expect(b.typedData.domain).toEqual({ chainId: "100", verifyingContract: SAFE });
  });

  it("matches the pre-1.3.0 contract hash (no chainId in domain)", () => {
    const b = buildSafeTypedData({ chainId: 1, safeAddr: SAFE, version: "1.1.1", tx: TX });
    expect(b.safeTxHash).toBe(contractHash({ withChain: false }).safeTxHash);
    expect(b.typedData.types.EIP712Domain).toEqual([{ name: "verifyingContract", type: "address" }]);
  });

  it("normalizes API-style fields and re-hashes consistently", () => {
    const b = buildSafeTypedData({ chainId: 1, safeAddr: SAFE, version: "1.4.1", tx: { ...TX, data: null, operation: "0" } });
    expect(b.typedData.message.data).toBe("0x");
    expect(b.typedData.message.operation).toBe(0);
    expect(hashSafeTypedData(b.typedData).safeTxHash).toBe(b.safeTxHash);
  });
});

describe("domainHasChainId", () => {
  it.each([["1.0.0", false], ["1.2.0", false], ["1.3.0", true], ["1.4.1+L2", true], ["2.0.0", true], [undefined, true], ["junk", true]])(
    "%s → %s", (v, want) => expect(domainHasChainId(v)).toBe(want));
});
