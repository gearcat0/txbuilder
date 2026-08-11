// Pure helpers for Tenderly transaction simulation, used by the renderer and
// unit tests. The main process has its own inline copies of the encoding/parse
// helpers (it is unbundled and can't import this Vite-ESM module); the E2E
// suite asserts main's wire output, and this module's copies are unit-tested —
// keep the two in sync.
//
// Two simulation modes:
// - "exact": the collected real signatures are used and the call is simulated
//   as-is (the mode that reproduces GS013-style execution failures).
// - "override": pre-signature simulation, the technique the official Safe
//   webapp uses — override the Safe's threshold storage slot (slot 4 in every
//   Safe version's layout) to 1 and call execTransaction from a real owner
//   with a 65-byte approved-hash signature (r = owner, s = 0, v = 1), which
//   checkNSignatures accepts because msg.sender == owner.

const pad32 = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

export const THRESHOLD_SLOT = "0x" + "0".repeat(63) + "4";

// 65-byte approved-hash signature for `owner`: r = owner, s = 0, v = 1.
export function approvedHashSignature(owner) {
  return "0x" + pad32(owner) + "0".repeat(64) + "01";
}

// state_objects override setting the Safe's threshold (slot 4) to 1.
export function thresholdOverride(safeAddr) {
  return {
    [safeAddr]: {
      storage: {
        [THRESHOLD_SLOT]: "0x" + "0".repeat(63) + "1",
      },
    },
  };
}

// The Tenderly simulate POST body. `input` is the encoded execTransaction
// calldata; `override` toggles the threshold state override.
export function buildSimRequest({ chainId, safeAddr, from, input, override }) {
  const body = {
    network_id: String(chainId),
    from,
    to: safeAddr,
    input,
    gas: 8000000,
    value: 0,
    save: true,
    save_if_fails: true,
    simulation_type: "full",
  };
  if (override) body.state_objects = thresholdOverride(safeAddr);
  return body;
}

// Defensive extraction of what the UI needs from a simulate response.
export function parseSimResponse(json) {
  const tx = (json && json.transaction) || {};
  const sim = (json && json.simulation) || {};
  if (!sim.id) return null;
  return {
    id: sim.id,
    status: tx.status === true,
    gasUsed: typeof tx.gas_used === "number" ? tx.gas_used : null,
    errorMessage: tx.error_message || (tx.error_info && tx.error_info.error_message) || (tx.status === true ? null : "Reverted (no reason returned)"),
  };
}

export function dashboardUrl(account, project, id) {
  return `https://dashboard.tenderly.co/${account}/${project}/simulator/${id}`;
}

export function sharedUrl(id) {
  return `https://dashboard.tenderly.co/shared/simulation/${id}`;
}

export function tenderlyConfigured(settings) {
  return !!(settings && settings.tenderlyAccount && settings.tenderlyProject && settings.tenderlyKey);
}
