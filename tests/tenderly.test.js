import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { tenderlyConfigured, simulationTarget, simulationAvailable, simulationArgs } from "../src/lib/tenderly.js";

const require = createRequire(import.meta.url);
const {
  approvedHashSignature, stateOverrides, buildSimRequest, parseSimResponse,
  dashboardUrl, sharedUrl, THRESHOLD_SLOT, NONCE_SLOT, GUARD_SLOT,
} = require("../src/lib/tenderly-sim.cjs");

const SAFE = "0x1111111111111111111111111111111111111111";
const OWNER = "0xF39fd6e51aad88F6F4ce6aB8827279cffFb92266";
const word = (n) => "0x" + n.toString(16).padStart(64, "0");

describe("approvedHashSignature", () => {
  it("emits a 65-byte r=owner, s=0, v=1 signature", () => {
    const sig = approvedHashSignature(OWNER);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(sig.slice(2, 66)).toBe(OWNER.slice(2).toLowerCase().padStart(64, "0"));
    expect(sig.slice(66, 130)).toBe("0".repeat(64));
    expect(sig.slice(130)).toBe("01");
  });
});

describe("stateOverrides (as the Safe web app does)", () => {
  const base = { safeAddr: SAFE, threshold: 2, sigCount: 2, txNonce: 7, safeNonce: 7, guard: null };

  it("needs none when signatures meet the threshold at the current nonce", () => {
    expect(stateOverrides(base)).toBeUndefined();
  });

  it("lowers the threshold to 1 only while signatures fall short", () => {
    expect(THRESHOLD_SLOT).toBe(word(4));
    expect(stateOverrides({ ...base, sigCount: 1 })[SAFE].storage).toEqual({ [THRESHOLD_SLOT]: word(1) });
  });

  it("sets the nonce (slot 5) for a transaction queued behind others", () => {
    expect(NONCE_SLOT).toBe(word(5));
    expect(stateOverrides({ ...base, txNonce: 9 })[SAFE].storage).toEqual({ [NONCE_SLOT]: word(9) });
    expect(stateOverrides({ ...base, txNonce: 5 })).toBeUndefined(); // stale nonce: left to fail like on-chain
  });

  it("disables a transaction guard", () => {
    const guard = "0x000000000000000000000000" + "ab".repeat(20);
    expect(stateOverrides({ ...base, guard })[SAFE].storage).toEqual({ [GUARD_SLOT]: word(0) });
    expect(stateOverrides({ ...base, guard: word(0) })).toBeUndefined();
  });
});

describe("buildSimRequest", () => {
  const base = { chainId: 1, safeAddr: SAFE, from: OWNER, input: "0x6a761202" };

  it("builds a full-mode saved simulation with gas_price 0", () => {
    const b = buildSimRequest(base);
    expect(b).toMatchObject({
      network_id: "1", from: OWNER, to: SAFE, input: "0x6a761202",
      gas: 8000000, gas_price: "0", value: 0, save: true, save_if_fails: true, simulation_type: "full",
    });
    expect(b.state_objects).toBeUndefined();
  });

  it("attaches state overrides when given", () => {
    const so = { [SAFE]: { storage: { [THRESHOLD_SLOT]: word(1) } } };
    expect(buildSimRequest({ ...base, stateObjects: so }).state_objects).toBe(so);
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

describe("simulation target", () => {
  const own = { simulationTarget: "own", tenderlyAccount: "a", tenderlyProject: "p", tenderlyKey: "k" };
  it("defaults to Safe's public project, which needs no Tenderly settings", () => {
    expect(simulationTarget({})).toBe("safe");
    expect(simulationAvailable({})).toBe(true);
    expect(simulationArgs({ tenderlyAccount: "a", tenderlyProject: "p", tenderlyKey: "k" })).toEqual({ target: "safe" });
  });
  it("uses the user's project only when chosen, and only once configured", () => {
    expect(simulationArgs(own)).toEqual({ target: "own", account: "a", project: "p", accessKey: "k" });
    expect(simulationAvailable({ simulationTarget: "own", tenderlyAccount: "a" })).toBe(false);
  });
});
