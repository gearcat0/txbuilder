// Tenderly simulation request building for Safe execTransaction calls.
//
// Mirrors what the official Safe web app sends (safe-wallet-monorepo
// packages/utils/.../tenderly/utils.ts), because a simulation is only useful
// for verification if the call it runs hashes to the exact safeTxHash being
// signed:
// - execTransaction carries the Safe transaction's real safeTxGas, baseGas,
//   gasPrice, gasToken and refundReceiver (they are part of the hash);
// - the collected signatures are kept; if the executing owner hasn't signed
//   and the threshold isn't reached, a pre-validated (approved-hash)
//   signature for that owner is added (r = owner, s = 0, v = 1), which
//   checkNSignatures accepts because msg.sender == owner;
// - storage overrides, only where needed: threshold (slot 4) → 1 if the
//   signatures still fall short; nonce (slot 5) → the transaction's nonce
//   when it is queued behind others (the contract hashes with its current
//   nonce); a transaction guard → disabled.
//
// CommonJS (required directly by the unbundled main process; added to
// build.files). Never imported by the renderer.

const word = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");

const THRESHOLD_SLOT = word(4);
const NONCE_SLOT = word(5);
// keccak256("guard_manager.guard.address")
const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// 65-byte approved-hash signature for `owner`: r = owner, s = 0, v = 1.
function approvedHashSignature(owner) {
  return "0x" + owner.replace(/^0x/, "").toLowerCase().padStart(64, "0") + "0".repeat(64) + "01";
}

// Storage overrides for the Safe, or undefined when none are needed.
//   threshold, safeNonce: on-chain values; sigCount: signatures in the call
//   (after any pre-validated one was added); txNonce: the Safe tx's nonce;
//   guard: the guard address from GUARD_SLOT (or null/zero for none).
function stateOverrides({ safeAddr, threshold, sigCount, txNonce, safeNonce, guard }) {
  const storage = {};
  if (threshold != null && sigCount < Number(threshold)) storage[THRESHOLD_SLOT] = word(1);
  if (txNonce != null && safeNonce != null && BigInt(txNonce) > BigInt(safeNonce)) storage[NONCE_SLOT] = word(txNonce);
  if (guard && BigInt(guard) !== 0n) storage[GUARD_SLOT] = word(0);
  return Object.keys(storage).length ? { [safeAddr]: { storage } } : undefined;
}

// The Tenderly simulate POST body. `input` is the encoded execTransaction
// calldata. gas_price 0 so the sender needs no balance for gas (as the Safe
// app does).
function buildSimRequest({ chainId, safeAddr, from, input, stateObjects }) {
  const body = {
    network_id: String(chainId),
    from,
    to: safeAddr,
    input,
    gas: 8000000,
    gas_price: "0",
    value: 0,
    save: true,
    save_if_fails: true,
    simulation_type: "full",
  };
  if (stateObjects) body.state_objects = stateObjects;
  return body;
}

// Defensive extraction of what the UI needs from a simulate response.
function parseSimResponse(json) {
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

// Safe's public Tenderly project, reached through the proxy the safe.global web
// app posts to (no access key; the proxy holds Safe's). Tenderly's dashboard
// shows its Safe hash panel only for simulations in this project.
const SAFE_SIMULATE_URL = "https://simulation.safe.global";
const SAFE_TENDERLY_ORG = "safe";
const SAFE_TENDERLY_PROJECT = "safe-apps";
const safePublicUrl = (id) => `https://dashboard.tenderly.co/public/${SAFE_TENDERLY_ORG}/${SAFE_TENDERLY_PROJECT}/simulator/${id}`;

const dashboardUrl = (account, project, id) => `https://dashboard.tenderly.co/${account}/${project}/simulator/${id}`;
const sharedUrl = (id) => `https://dashboard.tenderly.co/shared/simulation/${id}`;

module.exports = {
  THRESHOLD_SLOT, NONCE_SLOT, GUARD_SLOT, ZERO_ADDRESS,
  approvedHashSignature, stateOverrides, buildSimRequest, parseSimResponse, dashboardUrl, sharedUrl,
  SAFE_SIMULATE_URL, safePublicUrl,
};
