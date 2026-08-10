import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { signDigest, recoverAddress } from "../src/lib/sign.js";

// hardhat test key #0
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const DIGEST = "0x" + "7a".repeat(32);

describe("signDigest", () => {
  it("produces a 65-byte r‖s‖v signature that recovers to the signer", () => {
    const sig = signDigest(KEY, DIGEST);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    const v = parseInt(sig.slice(-2), 16);
    expect([27, 28]).toContain(v);
    expect(recoverAddress(DIGEST, sig)).toBe(ADDR);
  });

  it("matches viem's independent signature for the same key and digest", async () => {
    const account = privateKeyToAccount(KEY);
    const viemSig = await account.sign({ hash: DIGEST });
    expect(signDigest(KEY, DIGEST)).toBe(viemSig.toLowerCase());
  });

  it("is deterministic (RFC 6979 nonces)", () => {
    expect(signDigest(KEY, DIGEST)).toBe(signDigest(KEY, DIGEST));
  });

  it("returns null on malformed keys or digests instead of throwing", () => {
    expect(signDigest("0x1234", DIGEST)).toBe(null);
    expect(signDigest(KEY, "0xnothex")).toBe(null);
    expect(signDigest("0x" + "00".repeat(32), DIGEST)).toBe(null); // invalid scalar
    expect(signDigest(null, DIGEST)).toBe(null);
  });
});

describe("recoverAddress", () => {
  it("rejects wrong-length signatures and v outside 27/28", () => {
    const sig = signDigest(KEY, DIGEST);
    expect(recoverAddress(DIGEST, sig.slice(0, -2))).toBe(null);
    expect(recoverAddress(DIGEST, sig.slice(0, -2) + "20")).toBe(null); // v=32
    expect(recoverAddress(DIGEST, "0x" + "ab".repeat(65))).toBe(null);  // the old placeholder!
  });

  it("recovers a different address for a tampered digest", () => {
    const sig = signDigest(KEY, DIGEST);
    const other = recoverAddress("0x" + "7b".repeat(32), sig);
    expect(other).not.toBe(ADDR);
  });
});
