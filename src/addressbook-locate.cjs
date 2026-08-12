// Locating the evmaddressbook binary. Priority:
//   1. an explicit path from Settings (tilde-expanded)
//   2. the binary on PATH
//   3. the default install location for the platform
//   4. the bare name "evmaddressbook" (so a spawn ENOENT surfaces as a status
//      issue, preserving the previous behavior)
//
// evmaddressbook is distributed as an Electron app whose CLI runs through its
// executable (electron-builder executableName "evmaddressbook", productName
// "EVM Address Book"), so after a normal GUI install the executable is NOT on
// PATH — hence the install-location fallback.
//
// CommonJS (required directly by the unbundled main process; added to
// build.files). Never imported by the renderer, so no Vite interop concerns.
const fs = require("fs");
const os = require("os");
const path = require("path");

function resolveAddressbookPath(p) {
  p = typeof p === "string" ? p.trim() : "";
  if (!p) return "evmaddressbook";
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isExecutableFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform === "win32") return true; // no execute bit on Windows
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Find an executable by name on the given env's PATH (falls back to the
// process PATH). Returns the full path, or null.
function whichInPath(name, env) {
  const PATH = (env && env.PATH) || process.env.PATH || "";
  const dirs = PATH.split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32"
    ? (((env && env.PATHEXT) || process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
        .split(";").filter(Boolean).map(ext => name + ext.toLowerCase()))
    : [name];
  for (const dir of dirs) {
    for (const n of names) {
      const full = path.join(dir, n);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

// Default install locations of the evmaddressbook executable per platform.
// TXB_ADDRESSBOOK_EXTRA_DIRS (path-delimited) is checked first, for custom
// installs and tests.
function addressbookInstallCandidates() {
  const home = os.homedir();
  const exe = process.platform === "win32" ? "evmaddressbook.exe" : "evmaddressbook";
  const extra = (process.env.TXB_ADDRESSBOOK_EXTRA_DIRS || "")
    .split(path.delimiter).filter(Boolean).map(d => path.join(d, exe));
  let defaults;
  if (process.platform === "darwin") {
    const macExe = (base) => path.join(base, "Contents", "MacOS", "evmaddressbook");
    defaults = [
      macExe("/Applications/EVM Address Book.app"),
      macExe(path.join(home, "Applications", "EVM Address Book.app")),
      macExe("/Applications/evmaddressbook.app"),
      macExe("/Applications/evmaddressbook"),
    ];
  } else if (process.platform === "win32") {
    const lad = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const pf = process.env.PROGRAMFILES || "C:\\Program Files";
    const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    defaults = [
      path.join(lad, "Programs", "EVM Address Book", "evmaddressbook.exe"),
      path.join(pf, "EVM Address Book", "evmaddressbook.exe"),
      path.join(pf86, "EVM Address Book", "evmaddressbook.exe"),
    ];
  } else {
    defaults = [
      "/opt/EVM Address Book/evmaddressbook",
      "/usr/local/bin/evmaddressbook",
      "/usr/bin/evmaddressbook",
      path.join(home, ".local", "bin", "evmaddressbook"),
    ];
  }
  return [...extra, ...defaults];
}

let autoBinCache; // undefined = not yet resolved; string = resolved binary
function resetAddressbookBinCache() { autoBinCache = undefined; }

// Resolve the binary to spawn. `explicitPath` is the Settings value (may be
// empty); `env` supplies the PATH to search (the resolved shell env).
function resolveAddressbookBin({ explicitPath, env } = {}) {
  const raw = typeof explicitPath === "string" ? explicitPath.trim() : "";
  if (raw) return resolveAddressbookPath(raw); // explicit override, no caching
  if (autoBinCache !== undefined) return autoBinCache;
  if (whichInPath("evmaddressbook", env)) return (autoBinCache = "evmaddressbook");
  for (const cand of addressbookInstallCandidates()) {
    if (isExecutableFile(cand)) {
      console.log(`[addressbook] using installed binary at ${cand}`);
      return (autoBinCache = cand);
    }
  }
  return (autoBinCache = "evmaddressbook"); // not found; spawn ENOENT → status issue
}

module.exports = {
  resolveAddressbookPath, isExecutableFile, whichInPath,
  addressbookInstallCandidates, resolveAddressbookBin, resetAddressbookBinCache,
};
