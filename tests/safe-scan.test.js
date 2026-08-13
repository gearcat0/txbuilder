import { describe, it, expect } from "vitest";
import { keccak256 } from "js-sha3";
import SS from "../src/lib/safe-scan.cjs";

const pad = (a) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const uintWord = (n) => BigInt(n).toString(16).padStart(64, "0");

describe("topics", () => {
  it("match keccak of the canonical signatures", () => {
    expect(SS.TOPIC_ADDED_OWNER).toBe("0x" + keccak256("AddedOwner(address)"));
    expect(SS.TOPIC_REMOVED_OWNER).toBe("0x" + keccak256("RemovedOwner(address)"));
    expect(SS.TOPIC_SAFE_SETUP).toBe("0x" + keccak256("SafeSetup(address,address[],uint256,address,address)"));
    expect(SS.TOPIC_PROXY_V13).toBe("0x" + keccak256("ProxyCreation(address,address)"));
    // spot-check the researched value
    expect(SS.TOPIC_ADDED_OWNER).toBe("0x9465fa0c962cc76958e6373a993326400c1c94f8be2fe3a952adfa7f60b2ea26");
  });
});

const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const OWNER2 = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const SAFE = "0x1111111111111111111111111111111111111111";

describe("decodeAddedOwnerLog", () => {
  it("reads a pre-1.4.1 log (owner in data, no topic1)", () => {
    const log = { address: SAFE, topics: [SS.TOPIC_ADDED_OWNER], data: "0x" + pad(OWNER) };
    expect(SS.decodeAddedOwnerLog(log)).toBe(OWNER);
  });
  it("reads a 1.4.1+ log (owner indexed in topic1)", () => {
    const log = { address: SAFE, topics: [SS.TOPIC_ADDED_OWNER, "0x" + pad(OWNER)], data: "0x" };
    expect(SS.decodeAddedOwnerLog(log)).toBe(OWNER);
  });
});

describe("decodeSafeSetupOwners", () => {
  it("decodes the owners array at head offset 0x80", () => {
    // data = [ptr=0x80, threshold, initializer, fallbackHandler, len, owner0, owner1]
    const data = "0x" + uintWord(0x80) + uintWord(2) + pad("0x0") + pad("0x0")
      + uintWord(2) + pad(OWNER) + pad(OWNER2);
    expect(SS.decodeSafeSetupOwners(data)).toEqual([OWNER, OWNER2]);
  });
  it("rejects malformed / zero-owner arrays", () => {
    const bad = "0x" + uintWord(0x80) + uintWord(1) + pad("0x0") + pad("0x0") + uintWord(1) + pad("0x0");
    expect(SS.decodeSafeSetupOwners(bad)).toBe(null);
  });
});

describe("membershipHit", () => {
  const owned = new Set([OWNER]);
  it("matches an AddedOwner log for our address", () => {
    const log = { address: SAFE, topics: [SS.TOPIC_ADDED_OWNER, "0x" + pad(OWNER)], data: "0x" };
    expect(SS.membershipHit(log, owned)).toEqual({ safe: SAFE, owners: [OWNER] });
  });
  it("matches a SafeSetup log containing our address, ignoring others", () => {
    const data = "0x" + uintWord(0x80) + uintWord(1) + pad("0x0") + pad("0x0") + uintWord(2) + pad(OWNER2) + pad(OWNER);
    const log = { address: SAFE, topics: [SS.TOPIC_SAFE_SETUP], data };
    expect(SS.membershipHit(log, owned)).toEqual({ safe: SAFE, owners: [OWNER] });
  });
  it("returns null when our address is not involved", () => {
    const log = { address: SAFE, topics: [SS.TOPIC_ADDED_OWNER, "0x" + pad(OWNER2)], data: "0x" };
    expect(SS.membershipHit(log, owned)).toBe(null);
  });
});

describe("filters", () => {
  it("fast filter ORs owned addresses in topic1, no address key", () => {
    const [f] = SS.buildFastFilter({ addresses: [OWNER, OWNER2], fromBlock: 100, toBlock: 200 });
    expect(f.address).toBeUndefined();
    expect(f.topics[0]).toBe(SS.TOPIC_ADDED_OWNER);
    expect(f.topics[1]).toEqual([SS.pad32(OWNER), SS.pad32(OWNER2)]);
    expect(f.fromBlock).toBe("0x64");
  });
  it("splits fast filters over FAST_TOPIC_MAX", () => {
    const addrs = Array.from({ length: 150 }, (_, i) => "0x" + String(i).padStart(40, "0"));
    expect(SS.buildFastFilter({ addresses: addrs, fromBlock: 0, toBlock: 1 }).length).toBe(2);
  });
  it("deep filter ORs both topic0s", () => {
    const f = SS.buildDeepFilter({ fromBlock: 0, toBlock: 1 });
    expect(f.topics[0]).toEqual([SS.TOPIC_ADDED_OWNER, SS.TOPIC_SAFE_SETUP]);
  });
});

describe("classifyGetLogsError", () => {
  it("classifies provider errors", () => {
    expect(SS.classifyGetLogsError(null)).toBe("ok");
    expect(SS.classifyGetLogsError({ message: "query returned more than 10000 results" })).toBe("too-many-results");
    expect(SS.classifyGetLogsError({ code: -32005, message: "x" })).toBe("too-many-results"); // Infura result cap
    expect(SS.classifyGetLogsError({ code: -32097 })).toBe("rate-limited");
    expect(SS.classifyGetLogsError({ message: "block range is too wide" })).toBe("range-too-large");
    expect(SS.classifyGetLogsError({ status: 429, message: "Too Many Requests" })).toBe("rate-limited");
    expect(SS.classifyGetLogsError({ message: "filter not found" })).toBe("unsupported-filter");
    expect(SS.classifyGetLogsError({ message: "ECONNREFUSED" })).toBe("network");
  });
});

describe("nextChunkSize", () => {
  it("halves on caps, grows on ok, holds on transient", () => {
    expect(SS.nextChunkSize(100000, "too-many-results")).toBe(50000);
    expect(SS.nextChunkSize(100000, "range-too-large")).toBe(50000);
    expect(SS.nextChunkSize(100000, "ok")).toBe(125000);
    expect(SS.nextChunkSize(100000, "rate-limited")).toBe(100000);
    expect(SS.nextChunkSize(2000, "too-many-results", { min: 2000 })).toBe(2000);
  });
});

describe("isUnclassifiedError", () => {
  it("is false for recognized provider errors and true for unknown ones", () => {
    expect(SS.isUnclassifiedError(null)).toBe(false);
    expect(SS.isUnclassifiedError({ message: "block range too wide" })).toBe(false);
    expect(SS.isUnclassifiedError({ message: "query returned more than 10000 results" })).toBe(false);
    expect(SS.isUnclassifiedError({ code: -32005 })).toBe(false);
    expect(SS.isUnclassifiedError({ code: -32097 })).toBe(false);
    expect(SS.isUnclassifiedError({ status: 429 })).toBe(false);
    expect(SS.isUnclassifiedError({ message: "ECONNREFUSED" })).toBe(false);
    // a real provider error we don't pattern-match yet → flagged for logging
    expect(SS.isUnclassifiedError({ code: -32000, message: "execution aborted (timeout)" })).toBe(false); // "aborted" is a network pattern
    expect(SS.isUnclassifiedError({ code: -32602, message: "invalid argument 0: hex string too long" })).toBe(true);
    expect(SS.isUnclassifiedError({ message: "something entirely novel" })).toBe(true);
  });
});

describe("per-endpoint chunk state", () => {
  it("shrinks and pins minBad on a structural range error", () => {
    const st = SS.chunkAfter(SS.newChunkState(), "range-too-large", 100000);
    expect(st.minBad).toBe(100000);
    expect(st.cur).toBeLessThanOrEqual(50000);
  });

  it("shrinks but does NOT pin minBad on a density-based result-cap error", () => {
    const st = SS.chunkAfter(SS.newChunkState(), "too-many-results", 100000);
    expect(st.minBad).toBe(0);
    expect(st.cur).toBe(50000);
  });

  it("grows toward but never past 90% of a known-bad size (kills the flapping)", () => {
    expect(SS.chunkAfter({ cur: 40000, minBad: 100000 }, "ok", 40000).cur).toBe(50000);  // 40000*1.25, under ceil 90000
    expect(SS.chunkAfter({ cur: 85000, minBad: 100000 }, "ok", 85000).cur).toBe(90000);  // clamped to ceil 90000
    expect(SS.chunkAfter({ cur: 90000, minBad: 100000 }, "ok", 90000).cur).toBe(90000);  // already at ceil → no re-overshoot
  });

  it("leaves size unchanged on transient errors", () => {
    expect(SS.chunkAfter({ cur: 7777, minBad: 0 }, "rate-limited", 7777).cur).toBe(7777);
    expect(SS.chunkAfter({ cur: 7777, minBad: 0 }, "network", 7777).cur).toBe(7777);
  });

  it("converges against a fixed provider limit and stops erroring", () => {
    const LIMIT = 1000; // provider rejects any span wider than this
    let st = SS.newChunkState();
    const outcomes = [];
    for (let i = 0; i < 60; i++) {
      const used = SS.chunkSize(st);
      if (used > LIMIT) { st = SS.chunkAfter(st, "range-too-large", used); outcomes.push("range"); }
      else { st = SS.chunkAfter(st, "ok", used); outcomes.push("ok"); }
    }
    expect(outcomes.slice(-12).every(o => o === "ok")).toBe(true); // settled, no more flapping
    expect(SS.chunkSize(st)).toBeLessThanOrEqual(LIMIT);
  });
});

describe("endpoint health state machine", () => {
  const url = "https://rpc.example";
  it("recordSuccess resets everything", () => {
    let r = SS.newHealth(url, 1);
    r = SS.recordFailure(r, 1000, { count: true });
    r = SS.recordSuccess(r, 2000);
    expect(r).toMatchObject({ lastSuccessAt: 2000, firstFailureAt: null, consecutiveFailures: 0, disabled: false, disabledUntil: 0 });
  });

  it("applies transient backoff always, but only advances the failure clock when counted (offline guard)", () => {
    let r = SS.newHealth(url, 1);
    // offline: not counted → backoff set, but firstFailureAt stays null
    r = SS.recordFailure(r, 1000, { count: false });
    expect(r.disabledUntil).toBeGreaterThan(1000);
    expect(r.firstFailureAt).toBe(null);
    expect(r.disabled).toBe(false);
    // online failure: counted → clock starts
    r = SS.recordFailure(r, 2000, { count: true });
    expect(r.firstFailureAt).toBe(2000);
  });

  it("hard-disables after 36h of continuous online failure with no success", () => {
    const H36 = 36 * 3600 * 1000;
    let r = SS.newHealth(url, 1);
    r = SS.recordFailure(r, 0, { count: true });          // firstFailureAt=0
    expect(r.disabled).toBe(false);
    r = SS.recordFailure(r, H36 + 1, { count: true });    // >36h later, still failing
    expect(r.disabled).toBe(true);
    expect(SS.isEndpointAvailable(r, H36 + 2)).toBe(false);
  });

  it("recordRateLimit backs off but never advances the disable clock", () => {
    let r = SS.newHealth(url, 1);
    r = SS.recordRateLimit(r, 1000);
    expect(r.disabledUntil).toBeGreaterThan(1000); // backoff applied
    expect(r.firstFailureAt).toBe(null);           // not counted toward 36h disable
    expect(r.disabled).toBe(false);
    // even sustained rate-limiting never hard-disables
    r = SS.recordRateLimit(r, 1000 + 40 * 3600 * 1000);
    expect(r.disabled).toBe(false);
  });

  it("shouldCountFailure freezes during a blackout", () => {
    const now = 1_000_000;
    expect(SS.shouldCountFailure({ recentGlobalSuccessAt: now - 1000, now })).toBe(true);
    expect(SS.shouldCountFailure({ recentGlobalSuccessAt: now - 200000, now })).toBe(false);
    expect(SS.shouldCountFailure({ recentGlobalSuccessAt: null, now })).toBe(false);
  });

  it("isEndpointAvailable respects backoff window", () => {
    let r = SS.newHealth(url, 1);
    r = SS.recordFailure(r, 1000, { count: true });
    expect(SS.isEndpointAvailable(r, 1500)).toBe(false); // within backoff
    expect(SS.isEndpointAvailable(r, r.disabledUntil + 1)).toBe(true);
  });
});
