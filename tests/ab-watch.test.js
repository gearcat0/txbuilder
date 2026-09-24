import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isAddressbookFile, versionAtLeast, debounce, MIN_ADDRESSBOOK_VERSION } = require("../src/lib/ab-watch.cjs");

describe("isAddressbookFile", () => {
  it("accepts the Default book, named books and the chain list", () => {
    for (const f of ["addresses.json", "addressbook_Y29udHJhaWw.json", "addressbook_c3RyZXNzdGVzdA.json", "chains.json"]) {
      expect(isAddressbookFile(f)).toBe(true);
    }
  });
  it("ignores atomic-write temp files and unrelated files", () => {
    for (const f of ["addresses.json.tmp-1a2b3c", "addressbook_X.json.tmp-9f", "settings.json", "contracts", "icons", "", null]) {
      expect(isAddressbookFile(f)).toBe(false);
    }
  });
});

describe("versionAtLeast", () => {
  it("requires evmaddressbook 1.12.0 by default", () => {
    expect(MIN_ADDRESSBOOK_VERSION).toBe("1.12.0");
    expect(versionAtLeast("1.12.0")).toBe(true);
    expect(versionAtLeast("1.12.3")).toBe(true);
    expect(versionAtLeast("v2.0.0")).toBe(true);
    expect(versionAtLeast("1.11.0")).toBe(false);
    expect(versionAtLeast("1.9.9")).toBe(false);
    expect(versionAtLeast(null)).toBe(false);
    expect(versionAtLeast("garbage")).toBe(false);
  });
});

describe("debounce", () => {
  it("collapses a burst into one call after the quiet period", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 400);
    d(); d(); vi.advanceTimersByTime(300); d();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(fn).toHaveBeenCalledTimes(1);
    d(); d.cancel(); vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
