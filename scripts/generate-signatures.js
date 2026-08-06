// Generates src/data/signatures.json — the bundled selector → signature DB
// used by capability detection for contracts with no fetchable ABI.
// Run via `npm run gen:signatures`; the output is checked in.
//
// Entries are [signature, paramNames]. Signatures must be canonical (no
// spaces, no param names, tuples spelled out). Identical signatures across
// interfaces are deduped (first entry wins the param names); two DIFFERENT
// signatures hashing to the same selector abort the build.
const fs = require("fs");
const path = require("path");
const { keccak256 } = require("js-sha3");

const ENTRIES = [
  // ── ERC-20 ──
  ["name()", []],
  ["symbol()", []],
  ["decimals()", []],
  ["totalSupply()", []],
  ["balanceOf(address)", ["account"]],
  ["transfer(address,uint256)", ["to", "amount"]],
  ["allowance(address,address)", ["owner", "spender"]],
  ["approve(address,uint256)", ["spender", "amount"]],
  ["transferFrom(address,address,uint256)", ["from", "to", "amount"]],
  ["increaseAllowance(address,uint256)", ["spender", "addedValue"]],
  ["decreaseAllowance(address,uint256)", ["spender", "subtractedValue"]],
  ["mint(address,uint256)", ["to", "amount"]],
  ["burn(uint256)", ["amount"]],
  ["burnFrom(address,uint256)", ["account", "amount"]],
  // ── ERC-2612 permit ──
  ["permit(address,address,uint256,uint256,uint8,bytes32,bytes32)", ["owner", "spender", "value", "deadline", "v", "r", "s"]],
  ["nonces(address)", ["owner"]],
  ["DOMAIN_SEPARATOR()", []],
  // ── ERC-721 (+Metadata/Enumerable; shared sigs deduped against ERC-20) ──
  ["ownerOf(uint256)", ["tokenId"]],
  ["safeTransferFrom(address,address,uint256)", ["from", "to", "tokenId"]],
  ["safeTransferFrom(address,address,uint256,bytes)", ["from", "to", "tokenId", "data"]],
  ["getApproved(uint256)", ["tokenId"]],
  ["setApprovalForAll(address,bool)", ["operator", "approved"]],
  ["isApprovedForAll(address,address)", ["owner", "operator"]],
  ["tokenURI(uint256)", ["tokenId"]],
  ["tokenOfOwnerByIndex(address,uint256)", ["owner", "index"]],
  ["tokenByIndex(uint256)", ["index"]],
  // ── ERC-1155 ──
  ["balanceOf(address,uint256)", ["account", "id"]],
  ["balanceOfBatch(address[],uint256[])", ["accounts", "ids"]],
  ["safeTransferFrom(address,address,uint256,uint256,bytes)", ["from", "to", "id", "amount", "data"]],
  ["safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)", ["from", "to", "ids", "amounts", "data"]],
  ["uri(uint256)", ["id"]],
  // ── ERC-4626 ──
  ["asset()", []],
  ["totalAssets()", []],
  ["convertToShares(uint256)", ["assets"]],
  ["convertToAssets(uint256)", ["shares"]],
  ["maxDeposit(address)", ["receiver"]],
  ["previewDeposit(uint256)", ["assets"]],
  ["deposit(uint256,address)", ["assets", "receiver"]],
  ["maxMint(address)", ["receiver"]],
  ["previewMint(uint256)", ["shares"]],
  ["mint(uint256,address)", ["shares", "receiver"]],
  ["maxWithdraw(address)", ["owner"]],
  ["previewWithdraw(uint256)", ["assets"]],
  ["withdraw(uint256,address,address)", ["assets", "receiver", "owner"]],
  ["maxRedeem(address)", ["owner"]],
  ["previewRedeem(uint256)", ["shares"]],
  ["redeem(uint256,address,address)", ["shares", "receiver", "owner"]],
  // ── ERC-165 / ERC-1271 / ERC-2981 ──
  ["supportsInterface(bytes4)", ["interfaceId"]],
  ["isValidSignature(bytes32,bytes)", ["hash", "signature"]],
  ["royaltyInfo(uint256,uint256)", ["tokenId", "salePrice"]],
  // ── Ownable / Ownable2Step ──
  ["owner()", []],
  ["transferOwnership(address)", ["newOwner"]],
  ["renounceOwnership()", []],
  ["pendingOwner()", []],
  ["acceptOwnership()", []],
  // ── AccessControl ──
  ["hasRole(bytes32,address)", ["role", "account"]],
  ["getRoleAdmin(bytes32)", ["role"]],
  ["grantRole(bytes32,address)", ["role", "account"]],
  ["revokeRole(bytes32,address)", ["role", "account"]],
  ["renounceRole(bytes32,address)", ["role", "account"]],
  ["DEFAULT_ADMIN_ROLE()", []],
  // ── Pausable ──
  ["paused()", []],
  ["pause()", []],
  ["unpause()", []],
  // ── Proxy / upgradeability ──
  ["implementation()", []],
  ["admin()", []],
  ["upgradeTo(address)", ["newImplementation"]],
  ["upgradeToAndCall(address,bytes)", ["newImplementation", "data"]],
  ["changeAdmin(address)", ["newAdmin"]],
  ["proxiableUUID()", []],
  ["masterCopy()", []],
  // ── Multicall / WETH ──
  ["multicall(bytes[])", ["data"]],
  ["deposit()", []],
  ["withdraw(uint256)", ["wad"]],
  // ── Safe core (also matters on Safe forks that miss the bundled match) ──
  ["VERSION()", []],
  ["getOwners()", []],
  ["getThreshold()", []],
  ["isOwner(address)", ["owner"]],
  ["nonce()", []],
  ["domainSeparator()", []],
  ["getChainId()", []],
  ["execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)",
    ["to", "value", "data", "operation", "safeTxGas", "baseGas", "gasPrice", "gasToken", "refundReceiver", "signatures"]],
  ["addOwnerWithThreshold(address,uint256)", ["owner", "_threshold"]],
  ["removeOwner(address,address,uint256)", ["prevOwner", "owner", "_threshold"]],
  ["swapOwner(address,address,address)", ["prevOwner", "oldOwner", "newOwner"]],
  ["changeThreshold(uint256)", ["_threshold"]],
  ["enableModule(address)", ["module"]],
  ["disableModule(address,address)", ["prevModule", "module"]],
  ["isModuleEnabled(address)", ["module"]],
  ["getModulesPaginated(address,uint256)", ["start", "pageSize"]],
  ["setGuard(address)", ["guard"]],
  ["setFallbackHandler(address)", ["handler"]],
  ["multiSend(bytes)", ["transactions"]],
  ["approveHash(bytes32)", ["hashToApprove"]],
];

// Split "address,uint256,(address,bytes)[]" on top-level commas only.
function splitTypes(inner) {
  if (!inner) return [];
  const out = [];
  let depth = 0, cur = "";
  for (const ch of inner) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function fail(msg) {
  console.error(`generate-signatures: ${msg}`);
  process.exit(1);
}

const db = {};
const sigBySelector = {};
for (const [sig, names] of ENTRIES) {
  const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\((.*)\)$/.exec(sig);
  if (!m) fail(`unparseable signature: ${sig}`);
  if (/\s/.test(sig)) fail(`signature contains whitespace: ${sig}`);
  const [, name, inner] = m;
  const types = splitTypes(inner);
  if (names.length && names.length !== types.length) fail(`param name count mismatch: ${sig}`);
  const selector = keccak256(sig).slice(0, 8);
  if (sigBySelector[selector] && sigBySelector[selector] !== sig) {
    fail(`selector collision: ${sig} vs ${sigBySelector[selector]} (${selector})`);
  }
  if (sigBySelector[selector]) continue; // identical sig listed twice — first wins
  sigBySelector[selector] = sig;
  db[selector] = {
    name,
    inputs: types.map((type, i) => ({ name: names[i] || `arg${i}`, type })),
  };
}

const outPath = path.join(__dirname, "..", "src", "data", "signatures.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(db, null, 1) + "\n");
console.log(`wrote ${outPath}: ${Object.keys(db).length} selectors`);

// Sanity anchors — fail loudly if the hashing ever drifts.
for (const [sel, name] of [["a9059cbb", "transfer"], ["095ea7b3", "approve"], ["01ffc9a7", "supportsInterface"]]) {
  if (db[sel]?.name !== name) fail(`sanity check failed: ${sel} → ${db[sel]?.name}, expected ${name}`);
}
