// Pure core for the "discover Safes I own" log scan: event topics, getLogs
// filter builders, log decoders, error classification, adaptive chunking, and
// the RPC-endpoint health state machine. No I/O — the main-process driver
// supplies fetch/fs. CommonJS because the unbundled main process require()s it
// (added to build.files); unit-tested via `import mod from "../src/…cjs"`.
//
// Indexing reality (from @safe-global/safe-deployments ABIs): AddedOwner /
// RemovedOwner only index `owner` in Safe v1.4.1+, and SafeSetup never indexes
// its owners array. So the fast path (topic-filter by owner) only finds 1.4.1+
// "added" Safes; the deep path firehoses AddedOwner+SafeSetup by topic0 and
// decodes each log's data to test membership.
const { keccak256 } = require("js-sha3");

const sig = (s) => "0x" + keccak256(s);
const TOPIC_ADDED_OWNER = sig("AddedOwner(address)");
const TOPIC_REMOVED_OWNER = sig("RemovedOwner(address)");
const TOPIC_SAFE_SETUP = sig("SafeSetup(address,address[],uint256,address,address)");
const TOPIC_PROXY_V1 = sig("ProxyCreation(address)");
const TOPIC_PROXY_V13 = sig("ProxyCreation(address,address)");

const FAST_TOPIC_MAX = 100; // max owned addresses per OR-topic filter

function pad32(addr) {
  return "0x" + String(addr).replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

// ── decoders ────────────────────────────────────────────────────────────────

// A 32-byte ABI word → the address in its low 20 bytes, or null if empty/zero/
// malformed (non-zero high bytes reject it as not-an-address).
function wordToAddress(word) {
  if (!word || word === "0x") return null;
  const h = String(word).replace(/^0x/, "").toLowerCase();
  if (h.length < 40 || !/^[0-9a-f]+$/.test(h)) return null;
  const addr = h.slice(-40);
  if (/^0+$/.test(addr) || !/^0*$/.test(h.slice(0, -40))) return null;
  return "0x" + addr;
}

function decodeUint(hex) {
  if (!hex || hex === "0x") return null;
  try { return BigInt(hex); } catch { return null; }
}

// AddedOwner/RemovedOwner: owner is in topics[1] when indexed (1.4.1+) and in
// data when not (≤1.3.0). Handle both.
function decodeAddedOwnerLog(log) {
  const data = log && log.data;
  if (data && data !== "0x" && data.replace(/^0x/, "").length >= 64) {
    const a = wordToAddress("0x" + data.replace(/^0x/, "").slice(0, 64));
    if (a) return a;
  }
  const topics = (log && log.topics) || [];
  return topics.length > 1 ? wordToAddress(topics[1]) : null;
}

// Decode an ABI address[] whose head pointer sits at head-word `ptrWordIndex`
// of `dataHex`. Zero addresses reject the whole array (an owner set can't hold
// them). Returns lowercased addresses or null on malformed data.
function decodeAddressArrayAt(dataHex, ptrWordIndex) {
  if (!dataHex || dataHex === "0x") return null;
  const h = String(dataHex).replace(/^0x/, "");
  try {
    const ptr = ptrWordIndex * 64;
    if (h.length < ptr + 64) return null;
    const offset = Number(BigInt("0x" + h.slice(ptr, ptr + 64))) * 2;
    if (h.length < offset + 64) return null;
    const len = Number(BigInt("0x" + h.slice(offset, offset + 64)));
    if (len < 0 || len > 1000 || h.length < offset + 64 + len * 64) return null;
    const out = [];
    for (let i = 0; i < len; i++) {
      const a = wordToAddress("0x" + h.slice(offset + 64 + i * 64, offset + 64 + (i + 1) * 64));
      if (!a) return null;
      out.push(a);
    }
    return out;
  } catch {
    return null;
  }
}

// SafeSetup(address indexed initiator, address[] owners, uint256 threshold,
// address initializer, address fallbackHandler): initiator is indexed, so data
// holds [owners, threshold, initializer, fallbackHandler] — owners pointer at
// head word 0.
function decodeSafeSetupOwners(dataHex) {
  return decodeAddressArrayAt(dataHex, 0);
}

// Which of `ownedSet` (lowercased Set) this log implicates, and the candidate
// Safe (log.address). Returns { safe, owners:[...] } or null.
function membershipHit(log, ownedSet) {
  const safe = log && log.address ? String(log.address).toLowerCase() : null;
  if (!safe) return null;
  const topic0 = ((log.topics || [])[0] || "").toLowerCase();
  let owners = null;
  if (topic0 === TOPIC_ADDED_OWNER || topic0 === TOPIC_REMOVED_OWNER) {
    const o = decodeAddedOwnerLog(log);
    owners = o ? [o] : [];
  } else if (topic0 === TOPIC_SAFE_SETUP) {
    owners = decodeSafeSetupOwners(log.data) || [];
  } else {
    return null;
  }
  const matched = owners.map(o => o.toLowerCase()).filter(o => ownedSet.has(o));
  return matched.length ? { safe, owners: matched } : null;
}

// ── filters ─────────────────────────────────────────────────────────────────

const toBlockTag = (n) => (typeof n === "number" ? "0x" + n.toString(16) : n);

// Fast path: 1.4.1+ Safes where one of `addresses` was added (owner indexed).
// topic1 as an array is an OR over all owned addresses in one query. Returns an
// array of filters (split when addresses exceed FAST_TOPIC_MAX).
function buildFastFilter({ addresses, fromBlock, toBlock }) {
  const filters = [];
  for (let i = 0; i < addresses.length; i += FAST_TOPIC_MAX) {
    filters.push({
      fromBlock: toBlockTag(fromBlock),
      toBlock: toBlockTag(toBlock),
      topics: [TOPIC_ADDED_OWNER, addresses.slice(i, i + FAST_TOPIC_MAX).map(pad32)],
    });
  }
  return filters;
}

// Deep path: firehose AddedOwner + SafeSetup by topic0 (OR), any contract.
function buildDeepFilter({ fromBlock, toBlock }) {
  return {
    fromBlock: toBlockTag(fromBlock),
    toBlock: toBlockTag(toBlock),
    topics: [[TOPIC_ADDED_OWNER, TOPIC_SAFE_SETUP]],
  };
}

// ── error classification + adaptive chunking ────────────────────────────────

// Shared matchers so classifyGetLogsError and isUnclassifiedError agree on what
// counts as "recognized". Order matters in the classifier below.
const ERR_RE = {
  rate: /rate.?limit|too many requests|429/,
  results: /more than \d+ results|10000 results|response size|result set too large|query returned more than/,
  range: /block range|range is too|query timeout|exceeded|too wide|limit exceeded|logs matched/,
  unsupported: /filter not found|not supported|unsupported|method not|invalid params.*address|missing.*address/,
  network: /econnrefused|etimedout|enotfound|econnreset|network|fetch failed|aborted|socket hang up/,
};
function errParts(err) {
  const code = typeof err.code === "number" ? err.code : (err.error && err.error.code);
  const msg = String((err && (err.message || (err.error && err.error.message))) || err).toLowerCase();
  return { code, msg };
}

function classifyGetLogsError(err) {
  if (!err) return "ok";
  const { code, msg } = errParts(err);
  if (err.status === 429 || code === -32097 || ERR_RE.rate.test(msg)) return "rate-limited";
  if (ERR_RE.results.test(msg) || code === -32005) return "too-many-results";
  if (ERR_RE.range.test(msg)) return "range-too-large";
  if (ERR_RE.unsupported.test(msg)) return "unsupported-filter";
  if (ERR_RE.network.test(msg)) return "network";
  return "network"; // default bucket: unrecognized → treated as transient
}

// True when classifyGetLogsError only returned "network" because nothing
// matched — i.e. a real provider error we haven't taught the classifier yet.
// Callers log these (once) so the pattern set can be widened.
function isUnclassifiedError(err) {
  if (!err) return false;
  const { code, msg } = errParts(err);
  if (err.status === 429 || code === -32097 || code === -32005) return false;
  return !(ERR_RE.rate.test(msg) || ERR_RE.results.test(msg) || ERR_RE.range.test(msg)
    || ERR_RE.unsupported.test(msg) || ERR_RE.network.test(msg));
}

function nextChunkSize(current, outcome, { min = 2000, max = 2_000_000 } = {}) {
  if (outcome === "range-too-large" || outcome === "too-many-results") return Math.max(min, Math.floor(current / 2));
  if (outcome === "ok") return Math.min(max, Math.floor(current * 1.25));
  return current; // rate-limited / network: retry same range after backoff
}

// Per-endpoint adaptive block-range sizing. Unlike a single shared chunk, each
// endpoint remembers its own converged size so a stingy node's shrink never
// contaminates a generous one. `minBad` is the smallest block-span that ever
// drew a structural range-too-large from THIS endpoint (a stable provider
// limit); we stop growing at 90% of it, which ends the overshoot/knock-down
// oscillation that made range-too-large flash on every success.
// Floor is deliberately low (100): some public RPCs cap eth_getLogs at a few
// hundred blocks, and a higher floor would make those endpoints error forever.
// Per-endpoint memory means only the stingy node uses tiny spans.
const CHUNK_MIN = 100, CHUNK_MAX = 2_000_000, CHUNK_START = 500000;
function newChunkState() { return { cur: CHUNK_START, minBad: 0 }; }
function chunkSize(state) { return state && state.cur ? state.cur : CHUNK_START; }
function chunkAfter(state, outcome, usedSize) {
  const s = { cur: (state && state.cur) || CHUNK_START, minBad: (state && state.minBad) || 0 };
  if (outcome === "ok") {
    // Grow toward, but never back up to, a size we know this endpoint rejects.
    const ceil = s.minBad ? Math.max(CHUNK_MIN, Math.floor(s.minBad * 0.9)) : CHUNK_MAX;
    s.cur = Math.min(ceil, nextChunkSize(s.cur, "ok", { min: CHUNK_MIN, max: CHUNK_MAX }));
  } else if (outcome === "range-too-large") {
    s.minBad = s.minBad ? Math.min(s.minBad, usedSize) : usedSize;
    s.cur = Math.min(s.cur, nextChunkSize(usedSize, "range-too-large", { min: CHUNK_MIN }));
  } else if (outcome === "too-many-results") {
    // Result-cap is log-density dependent, not a structural block limit, so it
    // does NOT pin minBad — just back off the current size for this dense span.
    s.cur = nextChunkSize(usedSize, "too-many-results", { min: CHUNK_MIN });
  }
  // rate-limited / network: size unchanged (the range wasn't the problem).
  return s;
}

const bisectStep = (lo, hi) => Math.floor((lo + hi) / 2);

// ── endpoint health state machine ───────────────────────────────────────────

function newHealth(url, chainId) {
  return { url, chainId, lastSuccessAt: null, firstFailureAt: null, consecutiveFailures: 0, disabledUntil: 0, disabled: false };
}

function recordSuccess(rec, now) {
  return { ...rec, lastSuccessAt: now, firstFailureAt: null, consecutiveFailures: 0, disabledUntil: 0, disabled: false };
}

// A failure only advances the "continuous failure" clock (firstFailureAt) when
// we know we're actually online — otherwise a local blackout would wrongly
// disable good endpoints. Transient backoff always applies regardless.
function shouldCountFailure({ recentGlobalSuccessAt, now, windowMs = 120000 }) {
  return recentGlobalSuccessAt != null && now - recentGlobalSuccessAt <= windowMs;
}

// A 429 means "slow down", not "this endpoint is broken": apply backoff so the
// pacing eases off, but never advance the 36h disable clock — the endpoint is
// alive and will serve us again shortly.
function recordRateLimit(rec, now, { backoffBase = 2000, backoffCap = 300000 } = {}) {
  const consecutiveFailures = (rec.consecutiveFailures || 0) + 1;
  const backoff = Math.min(backoffCap, backoffBase * 2 ** Math.min(consecutiveFailures - 1, 20));
  return { ...rec, consecutiveFailures, disabledUntil: now + backoff };
}

function recordFailure(rec, now, { count, backoffBase = 2000, backoffCap = 300000, disableAfterMs = 36 * 3600 * 1000 } = {}) {
  const consecutiveFailures = (rec.consecutiveFailures || 0) + 1;
  const backoff = Math.min(backoffCap, backoffBase * 2 ** Math.min(consecutiveFailures - 1, 20));
  const firstFailureAt = count ? (rec.firstFailureAt != null ? rec.firstFailureAt : now) : rec.firstFailureAt;
  const sinceFirst = firstFailureAt != null ? now - firstFailureAt : 0;
  const noSuccessSince = rec.lastSuccessAt == null || (firstFailureAt != null && rec.lastSuccessAt < firstFailureAt);
  const disabled = !!(count && firstFailureAt != null && sinceFirst > disableAfterMs && noSuccessSince);
  return { ...rec, consecutiveFailures, disabledUntil: now + backoff, firstFailureAt, disabled };
}

function isEndpointAvailable(rec, now) {
  return !!rec && !rec.disabled && (rec.disabledUntil || 0) <= now;
}

module.exports = {
  TOPIC_ADDED_OWNER, TOPIC_REMOVED_OWNER, TOPIC_SAFE_SETUP, TOPIC_PROXY_V1, TOPIC_PROXY_V13,
  FAST_TOPIC_MAX, pad32, wordToAddress, decodeUint, decodeAddedOwnerLog,
  decodeAddressArrayAt, decodeSafeSetupOwners, membershipHit,
  buildFastFilter, buildDeepFilter, classifyGetLogsError, isUnclassifiedError,
  nextChunkSize, newChunkState, chunkSize, chunkAfter, bisectStep,
  newHealth, recordSuccess, shouldCountFailure, recordRateLimit, recordFailure, isEndpointAvailable,
};
