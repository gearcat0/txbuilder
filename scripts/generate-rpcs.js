// Generates src/data/rpcs.json — a bundled per-chain RPC endpoint database that
// seeds the log-scan endpoint pool so discovery works even when chainlist.org
// is unreachable. Run via `npm run gen:rpcs`; output is checked in.
//
// Source: ethereum-lists/chains via chainid.network/chains.json (what
// chainlist.org is built on). We keep only https, non-templated public
// endpoints, capped per chain.
const fs = require("fs");
const path = require("path");

const SOURCE = process.env.TXB_CHAINLIST_URL || "https://chainid.network/chains.json";
const MAX_PER_CHAIN = 8;

function usable(url) {
  return typeof url === "string"
    && /^https:\/\//i.test(url)
    && !url.includes("${")            // templated (needs an API key)
    && !/\bYOUR_/i.test(url)
    && !/\/(v3|v2)\/$/.test(url);     // dangling key path
}

async function main() {
  console.log("fetching", SOURCE);
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`chains source ${res.status}`);
  const chains = await res.json();
  if (!Array.isArray(chains)) throw new Error("unexpected chains payload");

  const out = {};
  let withRpc = 0;
  for (const c of chains) {
    const id = c && c.chainId;
    if (!Number.isInteger(id)) continue;
    const rpcs = [...new Set((c.rpc || []).filter(usable))].slice(0, MAX_PER_CHAIN);
    if (rpcs.length) { out[String(id)] = rpcs; withRpc++; }
  }

  const outPath = path.join(__dirname, "..", "src", "data", "rpcs.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 0) + "\n");
  console.log(`wrote ${outPath}: ${withRpc} chains, ${Object.values(out).reduce((n, a) => n + a.length, 0)} endpoints`);

  // sanity anchor
  if (!out["1"] || !out["1"].length) throw new Error("no mainnet (chain 1) endpoints — refusing to write");
}

main().catch(e => { console.error("generate-rpcs failed:", e.message); process.exit(1); });
