// Integrity checks for the checked-in signature DB (src/data/signatures.json,
// regenerated via `npm run gen:signatures`).
import { describe, it, expect } from "vitest";
import { keccak256 } from "js-sha3";
import db from "../src/data/signatures.json";

describe("signatures.json", () => {
  it("contains the anchor selectors", () => {
    expect(db["a9059cbb"]?.name).toBe("transfer");
    expect(db["095ea7b3"]?.name).toBe("approve");
    expect(db["01ffc9a7"]?.name).toBe("supportsInterface");
    expect(db["6a761202"]?.name).toBe("execTransaction");
  });

  it("every selector is the keccak of its reconstructed signature", () => {
    for (const [selector, entry] of Object.entries(db)) {
      const sig = `${entry.name}(${entry.inputs.map(i => i.type).join(",")})`;
      expect(keccak256(sig).slice(0, 8), sig).toBe(selector);
    }
  });

  it("every input has a name and a type (params are keyed by name downstream)", () => {
    for (const entry of Object.values(db)) {
      for (const input of entry.inputs) {
        expect(input.name).toBeTruthy();
        expect(input.type).toBeTruthy();
      }
      expect(new Set(entry.inputs.map(i => i.name)).size).toBe(entry.inputs.length);
    }
  });
});
