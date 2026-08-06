// Bundled Safe contract ABIs + canonical deployment addresses/codehashes,
// sourced from @safe-global/safe-deployments. Vite inlines the JSON into the
// renderer bundle, so Safe detection works fully offline with no build.files
// changes. Keep the import list in step with the versions users actually hit;
// singleton-only coverage for pre-1.3.0 (their aux contracts are rare targets).
import safe100 from "@safe-global/safe-deployments/dist/assets/v1.0.0/gnosis_safe.json";
import safe111 from "@safe-global/safe-deployments/dist/assets/v1.1.1/gnosis_safe.json";
import multiSend111 from "@safe-global/safe-deployments/dist/assets/v1.1.1/multi_send.json";
import safe120 from "@safe-global/safe-deployments/dist/assets/v1.2.0/gnosis_safe.json";
import safe130 from "@safe-global/safe-deployments/dist/assets/v1.3.0/gnosis_safe.json";
import safeL2130 from "@safe-global/safe-deployments/dist/assets/v1.3.0/gnosis_safe_l2.json";
import multiSend130 from "@safe-global/safe-deployments/dist/assets/v1.3.0/multi_send.json";
import multiSendCallOnly130 from "@safe-global/safe-deployments/dist/assets/v1.3.0/multi_send_call_only.json";
import fallbackHandler130 from "@safe-global/safe-deployments/dist/assets/v1.3.0/compatibility_fallback_handler.json";
import safe141 from "@safe-global/safe-deployments/dist/assets/v1.4.1/safe.json";
import safeL2141 from "@safe-global/safe-deployments/dist/assets/v1.4.1/safe_l2.json";
import multiSend141 from "@safe-global/safe-deployments/dist/assets/v1.4.1/multi_send.json";
import multiSendCallOnly141 from "@safe-global/safe-deployments/dist/assets/v1.4.1/multi_send_call_only.json";
import fallbackHandler141 from "@safe-global/safe-deployments/dist/assets/v1.4.1/compatibility_fallback_handler.json";
import safe150 from "@safe-global/safe-deployments/dist/assets/v1.5.0/safe.json";
import safeL2150 from "@safe-global/safe-deployments/dist/assets/v1.5.0/safe_l2.json";
import multiSend150 from "@safe-global/safe-deployments/dist/assets/v1.5.0/multi_send.json";
import multiSendCallOnly150 from "@safe-global/safe-deployments/dist/assets/v1.5.0/multi_send_call_only.json";
import fallbackHandler150 from "@safe-global/safe-deployments/dist/assets/v1.5.0/compatibility_fallback_handler.json";

const ASSETS = [
  { asset: safe100, role: "singleton" },
  { asset: safe111, role: "singleton" },
  { asset: multiSend111, role: "multisend" },
  { asset: safe120, role: "singleton" },
  { asset: safe130, role: "singleton" },
  { asset: safeL2130, role: "singleton" },
  { asset: multiSend130, role: "multisend" },
  { asset: multiSendCallOnly130, role: "multisend-call-only" },
  { asset: fallbackHandler130, role: "fallback-handler" },
  { asset: safe141, role: "singleton" },
  { asset: safeL2141, role: "singleton" },
  { asset: multiSend141, role: "multisend" },
  { asset: multiSendCallOnly141, role: "multisend-call-only" },
  { asset: fallbackHandler141, role: "fallback-handler" },
  { asset: safe150, role: "singleton" },
  { asset: safeL2150, role: "singleton" },
  { asset: multiSend150, role: "multisend" },
  { asset: multiSendCallOnly150, role: "multisend-call-only" },
  { asset: fallbackHandler150, role: "fallback-handler" },
];

const byAddress = new Map();
const byCodehash = new Map();
const singletonByVersion = new Map();
const byRoleVersion = new Map();

for (const { asset, role } of ASSETS) {
  const entry = { version: asset.version, contractName: asset.contractName, abi: asset.abi, role };
  for (const dep of Object.values(asset.deployments || {})) {
    if (dep?.address) byAddress.set(dep.address.toLowerCase(), entry);
    if (dep?.codeHash) byCodehash.set(dep.codeHash.toLowerCase(), entry);
  }
  // First entry per (role, version) wins (the L1 singleton variant); L2
  // differs only by emitted events, so either ABI drives the form identically.
  if (!byRoleVersion.has(`${role}:${asset.version}`)) {
    byRoleVersion.set(`${role}:${asset.version}`, entry);
  }
  if (role === "singleton" && !singletonByVersion.has(asset.version)) {
    singletonByVersion.set(asset.version, entry);
  }
}

// Re-resolve a cached/serialized safe match ({role, version}) to its bundled
// ABI — records on disk carry only the identifiers, never the ABI itself.
export function abiForRoleVersion(role, version) {
  return byRoleVersion.get(`${role}:${version}`) || null;
}

// Match a contract against the known Safe deployments. `address` catches
// canonical deployments (incl. a proxy's slot-0 singleton), `codehash`
// catches bytecode-identical deployments at non-canonical addresses.
export function matchSafe({ address, codehash }) {
  if (address) {
    const hit = byAddress.get(String(address).toLowerCase());
    if (hit) return hit;
  }
  if (codehash) {
    const hit = byCodehash.get(String(codehash).toLowerCase());
    if (hit) return hit;
  }
  return null;
}

// Fallback for Safes whose singleton isn't a known deployment (e.g. a chain
// missing from safe-deployments): VERSION() told us the version string.
export function safeAbiForVersion(version) {
  if (!version) return null;
  if (singletonByVersion.has(version)) return singletonByVersion.get(version);
  // Nearest known: match major.minor, else give up rather than guess wildly.
  const mm = String(version).split(".").slice(0, 2).join(".");
  for (const [v, entry] of singletonByVersion) {
    if (v.split(".").slice(0, 2).join(".") === mm) return entry;
  }
  return null;
}
