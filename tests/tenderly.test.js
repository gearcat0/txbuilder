import { describe, it, expect } from "vitest";
import {
  approvedHashSignature, thresholdOverride, buildSimRequest, parseSimResponse,
  dashboardUrl, sharedUrl, tenderlyConfigured, THRESHOLD_SLOT,
} from "../src/lib/tenderly.js";

const SAFE = "0x1111111111111111111111111111111111111111";
const OWNER = "0xF39fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("approvedHashSignature", () => {
  it("emits a 65-byte r=owner, s=0, v=1 signature", () => {
    const sig = approvedHashSignature(OWNER);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(sig.slice(2, 66)).toBe(OWNER.slice(2).toLowerCase().padStart(64, "0"));
    expect(sig.slice(66, 130)).toBe("0".repeat(64));
    expect(sig.slice(130)).toBe("01");
  });
});

describe("thresholdOverride", () => {
  it("overrides storage slot 4 of the Safe to 1", () => {
    const o = thresholdOverride(SAFE);
    expect(Object.keys(o)).toEqual([SAFE]);
    expect(THRESHOLD_SLOT).toBe("0x" + "0".repeat(63) + "4");
    expect(o[SAFE].storage[THRESHOLD_SLOT]).toBe("0x" + "0".repeat(63) + "1");
  });
});

describe("buildSimRequest", () => {
  const base = { chainId: 1, safeAddr: SAFE, from: OWNER, input: "0x6a761202" };

  it("builds a full-mode saved simulation request", () => {
    const b = buildSimRequest({ ...base, override: false });
    expect(b).toMatchObject({
      network_id: "1", from: OWNER, to: SAFE, input: "0x6a761202",
      gas: 8000000, value: 0, save: true, save_if_fails: true, simulation_type: "full",
    });
    expect(b.state_objects).toBeUndefined();
  });

  it("attaches the threshold override only in override mode", () => {
    const b = buildSimRequest({ ...base, override: true });
    expect(b.state_objects[SAFE].storage[THRESHOLD_SLOT]).toMatch(/1$/);
  });
});

describe("parseSimResponse", () => {
  it("extracts success results", () => {
    const r = parseSimResponse({ simulation: { id: "abc" }, transaction: { status: true, gas_used: 12345 } });
    expect(r).toEqual({ id: "abc", status: true, gasUsed: 12345, errorMessage: null });
  });

  it("extracts revert reasons, with a fallback message", () => {
    expect(parseSimResponse({
      simulation: { id: "abc" },
      transaction: { status: false, gas_used: 999, error_message: "GS013" },
    }).errorMessage).toBe("GS013");
    expect(parseSimResponse({
      simulation: { id: "abc" },
      transaction: { status: false },
    }).errorMessage).toMatch(/Reverted/);
  });

  it("returns null for malformed responses", () => {
    expect(parseSimResponse(null)).toBe(null);
    expect(parseSimResponse({ transaction: {} })).toBe(null);
  });
});

describe("urls + config gate", () => {
  it("builds dashboard and shared URLs", () => {
    expect(dashboardUrl("me", "proj", "abc")).toBe("https://dashboard.tenderly.co/me/proj/simulator/abc");
    expect(sharedUrl("abc")).toBe("https://dashboard.tenderly.co/shared/simulation/abc");
  });

  it("requires all three settings", () => {
    expect(tenderlyConfigured({ tenderlyAccount: "a", tenderlyProject: "p", tenderlyKey: "k" })).toBe(true);
    expect(tenderlyConfigured({ tenderlyAccount: "a", tenderlyProject: "p" })).toBe(false);
    expect(tenderlyConfigured(null)).toBe(false);
  });
});
