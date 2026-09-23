import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { parseTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const require = createRequire(import.meta.url);
const { feeFields, withGasBuffer, maxCost, toViemTx, serializeUnsigned, yParityOf, assembleSigned } = require("../src/lib/eth-tx.cjs");

const account = privateKeyToAccount("0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318");
const SAFE = "0x1234567890AbcdEF1234567890aBcdef12345678";
const tx1559 = { chainId: 1, nonce: "0x5", to: SAFE, value: "0x0", data: "0x6a761202", gas: "0x30d40", type: "eip1559", maxFeePerGas: "0x77359400", maxPriorityFeePerGas: "0x3b9aca00" };
const txLegacy = { chainId: 56, nonce: "0x0", to: SAFE, value: "0x0", data: "0x6a761202", gas: "0x30d40", type: "legacy", gasPrice: "0x12a05f200" };

// A device-style signature: split r/s/v out of a real signed transaction.
async function deviceSig(tx) {
  const signed = await account.signTransaction(toViemTx(tx));
  const p = parseTransaction(signed);
  return { signed, sig: { r: p.r, s: p.s, v: p.yParity ?? Number(p.v) } };
}

describe("feeFields / gas", () => {
  it("uses EIP-1559 when there's a base fee: maxFee = 2×base + tip", () => {
    expect(feeFields({ baseFeePerGas: "0x3b9aca00", maxPriorityFeePerGas: "0x5f5e100" }))
      .toEqual({ type: "eip1559", maxPriorityFeePerGas: "0x5f5e100", maxFeePerGas: "0x7d2b7500" });
  });
  it("defaults the tip to 1.5 gwei and falls back to legacy gasPrice", () => {
    expect(feeFields({ baseFeePerGas: "0x0" }).maxPriorityFeePerGas).toBe("0x59682f00");
    expect(feeFields({ gasPrice: "0x10" })).toEqual({ type: "legacy", gasPrice: "0x10" });
  });
  it("adds 20% gas headroom and computes worst-case cost", () => {
    expect(withGasBuffer("0x64")).toBe("0x78");
    expect(maxCost(tx1559)).toBe(200000n * 2000000000n);
    expect(maxCost(txLegacy)).toBe(200000n * 5000000000n);
  });
});

describe("yParityOf", () => {
  it.each([[0, 0], [1, 1], ["0x1", 1], ["1b", 0], [28, 1], [37, 0], [38, 1], ["0x94", 1]])("%s → %s", (v, want) => {
    expect(yParityOf(v)).toBe(want);
  });
});

describe("assembleSigned", () => {
  it("rebuilds a signed EIP-1559 tx byte-for-byte and checks the sender", async () => {
    const { signed, sig } = await deviceSig(tx1559);
    const { raw, txHash } = await assembleSigned(tx1559, sig, account.address);
    expect(raw).toBe(signed);
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("handles legacy EIP-155 v values (chainId×2+35/36) and 27/28", async () => {
    const { signed, sig } = await deviceSig(txLegacy);
    expect((await assembleSigned(txLegacy, sig, account.address)).raw).toBe(signed);
    const p = parseTransaction(signed);
    const v155 = 56 * 2 + 35 + (p.yParity ?? (Number(p.v) - 35) % 2);
    expect((await assembleSigned(txLegacy, { ...sig, v: v155 }, account.address)).raw).toBe(signed);
  });

  it("accepts r/s without 0x (Ledger style)", async () => {
    const { signed, sig } = await deviceSig(tx1559);
    const bare = { r: sig.r.slice(2), s: sig.s.slice(2), v: sig.v.toString(16).padStart(2, "0") };
    expect((await assembleSigned(tx1559, bare, account.address)).raw).toBe(signed);
  });

  it("refuses a signature from another account", async () => {
    const { sig } = await deviceSig(tx1559);
    await expect(assembleSigned(tx1559, sig, "0x000000000000000000000000000000000000dEaD")).rejects.toThrow(/not the selected account/);
  });

  it("serializes the unsigned tx for Ledger", () => {
    expect(serializeUnsigned(tx1559)).toMatch(/^0x02/);
  });
});
