// Generates src/data/native-currencies.json — chainId → native gas token
// {symbol, decimals}, so balances show BNB on BSC, MNT on Mantle, etc. Run via
// `npm run gen:native`; output is checked in.
//
// Source: ethereum-lists/chains via chainid.network/chains.json (the same
// registry src/data/rpcs.json is generated from).
const fs = require("fs");
const path = require("path");

const SOURCE = process.env.TXB_CHAINLIST_URL || "https://chainid.network/chains.json";

// Chain IDs the registry assigns to a different network than the one
// evmaddressbook (and everyone else) uses them for.
const OVERRIDES = {
  "999": { symbol: "HYPE" }, // HyperEVM mainnet; the registry has Wanchain Testnet here
};

async function main() {
  console.log("fetching", SOURCE);
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`chains source ${res.status}`);
  const chains = await res.json();
  if (!Array.isArray(chains)) throw new Error("unexpected chains payload");

  const out = {};
  for (const c of chains) {
    const id = c && c.chainId;
    const nc = c && c.nativeCurrency;
    if (!Number.isInteger(id) || !nc || typeof nc.symbol !== "string" || !nc.symbol.trim()) continue;
    const decimals = Number.isInteger(nc.decimals) ? nc.decimals : 18;
    out[String(id)] = decimals === 18 ? { symbol: nc.symbol.trim() } : { symbol: nc.symbol.trim(), decimals };
  }

  Object.assign(out, OVERRIDES);

  // sanity anchors
  if (out["1"]?.symbol !== "ETH" || out["56"]?.symbol !== "BNB") {
    throw new Error("unexpected symbols for chain 1 / 56 — refusing to write");
  }
  const outPath = path.join(__dirname, "..", "src", "data", "native-currencies.json");
  fs.writeFileSync(outPath, JSON.stringify(out) + "\n");
  console.log(`wrote ${outPath}: ${Object.keys(out).length} chains`);
}

main().catch(e => { console.error("generate-native-currencies failed:", e.message); process.exit(1); });
