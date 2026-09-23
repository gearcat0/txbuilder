import { describe, it, expect } from "vitest";
import { collectAccounts, indexAddressbook } from "../src/lib/accounts.js";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const derive = (k) => ({ k1: A, k2: B }[k] || null);

describe("collectAccounts", () => {
  it("collects internal, trezor and ledger accounts with their source", () => {
    const rows = collectAccounts({
      keys: ["k1", "", "bad", "k2"],
      trezorAccounts: [{ address: C, path: "m/44'/60'/0'/0/0", verified: true }],
      ledgerAccounts: [{ address: A.toUpperCase().replace("0X", "0x"), path: "m/44'/60'/0'/0", scheme: "legacy" }],
    }, { deriveAddress: derive, isDisabled: (a) => a === B });
    expect(rows.map(r => r.address)).toEqual([A, B, C]);
    expect(rows[0].sources).toEqual([
      { kind: "internal", detail: "key #1", disabled: false },
      { kind: "ledger", detail: "m/44'/60'/0'/0", scheme: "legacy", verified: false },
    ]);
    expect(rows[1].sources[0]).toMatchObject({ kind: "internal", detail: "key #4", disabled: true });
    expect(rows[2].sources[0]).toMatchObject({ kind: "trezor", verified: true });
  });

  it("tolerates missing/malformed settings", () => {
    expect(collectAccounts(null)).toEqual([]);
    expect(collectAccounts({ keys: ["k1"], trezorAccounts: [{ address: "nope" }, null] })).toEqual([]);
  });
});

describe("indexAddressbook", () => {
  it("keeps every book that names an address, deduping identical pairs", () => {
    const idx = indexAddressbook([
      { address: A, description: "Ops key", _book: "Default" },
      { address: A.toLowerCase(), description: "Treasury signer", _book: "Team" },
      { address: A, description: "Ops key", _book: "Default" },
      { address: B, description: " Cold ", _book: "Team" },
      { address: 42 },
    ]);
    expect(idx.get(A.toLowerCase())).toEqual([
      { book: "Default", name: "Ops key" },
      { book: "Team", name: "Treasury signer" },
    ]);
    expect(idx.get(B.toLowerCase())).toEqual([{ book: "Team", name: "Cold" }]);
    expect(idx.get(C.toLowerCase())).toBeUndefined();
  });
});
