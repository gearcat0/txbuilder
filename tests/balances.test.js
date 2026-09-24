import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { decodeFunctionData, encodeFunctionResult, encodeAbiParameters } from "viem";

const require = createRequire(import.meta.url);
const { MULTICALL3, ABI, encodeBalancesCall, decodeBalancesResult } = require("../src/lib/balances.cjs");

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

// What Multicall3 would return for the given per-address results.
export function aggregate3Result(entries) {
  return encodeFunctionResult({ abi: ABI, functionName: "aggregate3", result: entries.map(v => v == null
    ? { success: false, returnData: "0x" }
    : { success: true, returnData: encodeAbiParameters([{ type: "uint256" }], [v]) }) });
}

describe("Multicall3 balances", () => {
  it("encodes one aggregate3 call with a getEthBalance per address", () => {
    const { functionName, args } = decodeFunctionData({ abi: ABI, data: encodeBalancesCall([A, B]) });
    expect(functionName).toBe("aggregate3");
    expect(args[0]).toHaveLength(2);
    for (const [i, call] of args[0].entries()) {
      expect(call.target).toBe(MULTICALL3);
      expect(call.allowFailure).toBe(true);
      const inner = decodeFunctionData({ abi: ABI, data: call.callData });
      expect(inner).toEqual({ functionName: "getEthBalance", args: [[A, B][i]] });
    }
  });

  it("decodes balances, with null for a failed sub-call", () => {
    expect(decodeBalancesResult([A, B], aggregate3Result([10n ** 18n, null])))
      .toEqual({ [A]: "0xde0b6b3a7640000", [B]: null });
  });

  it("throws when Multicall3 isn't deployed (empty return)", () => {
    expect(() => decodeBalancesResult([A], "0x")).toThrow(/no data/);
  });
});

describe("native-currencies.json", () => {
  const n = require("../src/data/native-currencies.json");
  it("has the right gas token for common chains", () => {
    expect(n["1"].symbol).toBe("ETH");
    expect(n["56"].symbol).toBe("BNB");
    expect(n["137"].symbol).toBe("POL");
    expect(n["43114"].symbol).toBe("AVAX");
    expect(n["999"].symbol).toBe("HYPE"); // override: registry maps 999 to Wanchain Testnet
  });
});
