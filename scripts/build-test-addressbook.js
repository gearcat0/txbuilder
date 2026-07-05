// Builds a large evmaddressbook "book" file from public token lists, for
// stress-testing TX Builder with a big address book. Output is named
// addressbook_<base64(name)>.json — drop it into evmaddressbook's data dir.
const fs = require("fs");
const { getAddress } = require("viem");

const BOOK_NAME = process.argv[2] || "StressTest";
const CAP = Number(process.argv[3] || 2000);
const OUT_DIR = process.argv[4] || "/home/claude/txbuilder/test-data";

// Testnets + non-EVM (Solana) to skip; everything else is a real EVM mainnet.
const EXCLUDE = new Set([3, 4, 5, 42, 69, 420, 80001, 84531, 84532, 421611, 421613, 421614,
  11155111, 11155420, 534351, 80002, 97, 43113, 4002, 501000101]);

const SOURCES = [
  // L2s / sidechains first so the huge mainnet list doesn't crowd them out.
  "/tmp/uniswap.json",
  "/tmp/cg_poly.json",
  "/tmp/cg_arb.json",
  "/tmp/cg_base.json",
  "/tmp/cg_eth.json",
];

function tokensOf(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(j.tokens) ? j.tokens : (Array.isArray(j) ? j : []);
  } catch { return []; }
}

const byAddr = new Map(); // checksummed address -> { address, description, activeChains }
let scanned = 0, invalid = 0;

for (const file of SOURCES) {
  for (const t of tokensOf(file)) {
    scanned++;
    const chainId = Number(t.chainId);
    if (!Number.isInteger(chainId) || chainId <= 0 || EXCLUDE.has(chainId)) continue;
    let addr;
    try { addr = getAddress(String(t.address)); } catch { invalid++; continue; }
    const name = (t.name || t.symbol || "Token").toString().slice(0, 64);
    let e = byAddr.get(addr);
    if (!e) {
      if (byAddr.size >= CAP) continue; // cap unique addresses, still merge chains below
      e = { address: addr, description: name, activeChains: {} };
      byAddr.set(addr, e);
    }
    if (!e.activeChains[chainId]) {
      e.activeChains[chainId] = { addressType: "contract", contractName: (t.symbol || name).toString().slice(0, 32) };
    }
  }
}

const book = [...byAddr.values()];
// Chain distribution report
const dist = {};
for (const e of book) for (const c of Object.keys(e.activeChains)) dist[c] = (dist[c] || 0) + 1;

const b64 = Buffer.from(BOOK_NAME, "utf8").toString("base64").replace(/=+$/, "");
const outPath = `${OUT_DIR}/addressbook_${b64}.json`;
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(book, null, 2));

console.log(`scanned ${scanned} tokens, ${invalid} invalid addresses skipped`);
console.log(`book "${BOOK_NAME}" -> ${book.length} unique addresses`);
console.log(`file: ${outPath}  (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
console.log("multi-chain addresses:", book.filter(e => Object.keys(e.activeChains).length > 1).length);
console.log("chain distribution (addresses per chain):");
console.log(Object.fromEntries(Object.entries(dist).sort((a, b) => b[1] - a[1])));
