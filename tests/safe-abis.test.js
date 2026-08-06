import { describe, it, expect } from "vitest";
import { matchSafe, safeAbiForVersion, abiForRoleVersion } from "../src/lib/safe-abis.js";

const SAFE_130 = "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552";
const SAFE_141_CODEHASH = "0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4";
const MULTISEND_CALL_ONLY_130 = "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D";

describe("matchSafe", () => {
  it("matches canonical singleton addresses case-insensitively", () => {
    for (const addr of [SAFE_130, SAFE_130.toLowerCase()]) {
      const hit = matchSafe({ address: addr });
      expect(hit).toMatchObject({ version: "1.3.0", role: "singleton" });
      expect(hit.abi.some(f => f.name === "execTransaction")).toBe(true);
    }
  });

  it("matches by codehash when the address is unknown", () => {
    const hit = matchSafe({ address: "0x" + "12".repeat(20), codehash: SAFE_141_CODEHASH });
    expect(hit).toMatchObject({ version: "1.4.1", role: "singleton" });
  });

  it("matches auxiliary contracts with their role", () => {
    expect(matchSafe({ address: MULTISEND_CALL_ONLY_130 })).toMatchObject({
      version: "1.3.0",
      role: "multisend-call-only",
    });
  });

  it("returns null for unknown addresses and hashes", () => {
    expect(matchSafe({ address: "0x" + "12".repeat(20), codehash: "0x" + "34".repeat(32) })).toBe(null);
    expect(matchSafe({})).toBe(null);
  });
});

describe("safeAbiForVersion", () => {
  it("returns the exact version when bundled", () => {
    expect(safeAbiForVersion("1.3.0")).toMatchObject({ version: "1.3.0", role: "singleton" });
    expect(safeAbiForVersion("1.4.1")).toMatchObject({ version: "1.4.1" });
  });

  it("falls back to the nearest major.minor match", () => {
    expect(safeAbiForVersion("1.4.0")).toMatchObject({ version: "1.4.1" });
  });

  it("gives up rather than guessing across minor versions", () => {
    expect(safeAbiForVersion("2.0.0")).toBe(null);
    expect(safeAbiForVersion(null)).toBe(null);
  });
});

describe("abiForRoleVersion", () => {
  it("resolves aux-contract ABIs by role, distinct from the singleton's", () => {
    const ms = abiForRoleVersion("multisend", "1.3.0");
    expect(ms.abi.some(f => f.name === "multiSend")).toBe(true);
    expect(ms.abi.some(f => f.name === "execTransaction")).toBe(false);
  });

  it("returns null for unknown combinations", () => {
    expect(abiForRoleVersion("singleton", "9.9.9")).toBe(null);
  });
});
