import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mod from "../src/addressbook-locate.cjs";

const { resolveAddressbookPath, isExecutableFile, whichInPath, addressbookInstallCandidates, resolveAddressbookBin, resetAddressbookBinCache } = mod;

let tmp;
function makeExe(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, "#!/bin/sh\necho '[]'\n");
  fs.chmodSync(p, 0o755);
  return p;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abloc-"));
  resetAddressbookBinCache();
  delete process.env.TXB_ADDRESSBOOK_EXTRA_DIRS;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.TXB_ADDRESSBOOK_EXTRA_DIRS;
});

describe("resolveAddressbookPath", () => {
  it("expands ~ and passes through explicit paths", () => {
    expect(resolveAddressbookPath("")).toBe("evmaddressbook");
    expect(resolveAddressbookPath("  ")).toBe("evmaddressbook");
    expect(resolveAddressbookPath("~")).toBe(os.homedir());
    expect(resolveAddressbookPath("~/bin/ab")).toBe(path.join(os.homedir(), "bin/ab"));
    expect(resolveAddressbookPath("/opt/ab")).toBe("/opt/ab");
  });
});

describe("isExecutableFile / whichInPath", () => {
  it("detects an executable file on a PATH and rejects non-executables/dirs", () => {
    const exe = makeExe(tmp, "evmaddressbook");
    expect(isExecutableFile(exe)).toBe(true);
    expect(isExecutableFile(tmp)).toBe(false); // a directory
    expect(isExecutableFile(path.join(tmp, "nope"))).toBe(false);
    const plain = path.join(tmp, "plain"); fs.writeFileSync(plain, "x"); fs.chmodSync(plain, 0o644);
    if (process.platform !== "win32") expect(isExecutableFile(plain)).toBe(false);

    expect(whichInPath("evmaddressbook", { PATH: tmp })).toBe(exe);
    expect(whichInPath("evmaddressbook", { PATH: "/no/such/dir" })).toBe(null);
  });
});

describe("addressbookInstallCandidates", () => {
  it("returns absolute evmaddressbook paths and honors TXB_ADDRESSBOOK_EXTRA_DIRS first", () => {
    const cands = addressbookInstallCandidates();
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.every(c => path.isAbsolute(c))).toBe(true);
    expect(cands.every(c => /evmaddressbook(\.exe)?$/.test(c))).toBe(true);

    process.env.TXB_ADDRESSBOOK_EXTRA_DIRS = tmp;
    const withExtra = addressbookInstallCandidates();
    const exeName = process.platform === "win32" ? "evmaddressbook.exe" : "evmaddressbook";
    expect(withExtra[0]).toBe(path.join(tmp, exeName));
  });

  it("includes the platform's default install location", () => {
    const cands = addressbookInstallCandidates().join("\n");
    if (process.platform === "darwin") {
      expect(cands).toContain("/Applications/EVM Address Book.app/Contents/MacOS/evmaddressbook");
      expect(cands).toContain("/Applications/evmaddressbook/Contents/MacOS/evmaddressbook");
    } else if (process.platform === "win32") {
      expect(cands).toContain(path.join("EVM Address Book", "evmaddressbook.exe"));
    } else {
      expect(cands).toContain("/opt/EVM Address Book/evmaddressbook");
    }
  });
});

describe("resolveAddressbookBin priority", () => {
  it("prefers an explicit Settings path over everything", () => {
    process.env.TXB_ADDRESSBOOK_EXTRA_DIRS = tmp; makeExe(tmp, process.platform === "win32" ? "evmaddressbook.exe" : "evmaddressbook");
    expect(resolveAddressbookBin({ explicitPath: "/custom/ab", env: { PATH: tmp } })).toBe("/custom/ab");
  });

  it("uses the binary on PATH when present", () => {
    const dir = path.join(tmp, "onpath"); makeExe(dir, process.platform === "win32" ? "evmaddressbook.exe" : "evmaddressbook");
    expect(resolveAddressbookBin({ explicitPath: "", env: { PATH: dir } })).toBe("evmaddressbook");
  });

  it("falls back to the install location when not on PATH", () => {
    const installDir = path.join(tmp, "install");
    const installed = makeExe(installDir, process.platform === "win32" ? "evmaddressbook.exe" : "evmaddressbook");
    process.env.TXB_ADDRESSBOOK_EXTRA_DIRS = installDir;
    expect(resolveAddressbookBin({ explicitPath: "", env: { PATH: "/no/such/dir" } })).toBe(installed);
  });

  it("never returns a non-existent path — an existing binary or the bare name", () => {
    // On a machine with no install this is the bare name; on one with an
    // install it's that real path. Either way it must be executable-or-bare.
    const bin = resolveAddressbookBin({ explicitPath: "", env: { PATH: "/no/such/dir" } });
    expect(bin === "evmaddressbook" || isExecutableFile(bin)).toBe(true);
  });

  it("caches the auto-resolution until reset", () => {
    const exeName = process.platform === "win32" ? "evmaddressbook.exe" : "evmaddressbook";
    const dirA = path.join(tmp, "a"), dirB = path.join(tmp, "b");
    const a = makeExe(dirA, exeName), b = makeExe(dirB, exeName);
    process.env.TXB_ADDRESSBOOK_EXTRA_DIRS = dirA;
    expect(resolveAddressbookBin({ explicitPath: "", env: { PATH: "/no/such" } })).toBe(a);
    // Changing the input without resetting returns the cached result.
    process.env.TXB_ADDRESSBOOK_EXTRA_DIRS = dirB;
    expect(resolveAddressbookBin({ explicitPath: "", env: { PATH: "/no/such" } })).toBe(a);
    // After a reset it re-resolves against the new input.
    resetAddressbookBinCache();
    expect(resolveAddressbookBin({ explicitPath: "", env: { PATH: "/no/such" } })).toBe(b);
  });
});
