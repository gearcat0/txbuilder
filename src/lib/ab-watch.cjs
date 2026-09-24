// Watching evmaddressbook's data directory so new/changed entries reach TX
// Builder without a restart. evmaddressbook (>= 1.12.0) reports the directory
// via `--data-dir`; it keeps each book as a JSON file there and saves by
// writing a temp file and renaming it over the target, so the *directory* is
// watched (a watch on the file itself dies with the first rename).
//
// CommonJS (required directly by the unbundled main process; added to
// build.files). Never imported by the renderer.

const MIN_ADDRESSBOOK_VERSION = "1.12.0";

// Files whose change means the address data changed: the Default book,
// named books, and the chain list. Temp files from atomic writes
// ("<file>.tmp-<hex>") are ignored — the rename that follows is reported
// under the real name.
function isAddressbookFile(name) {
  if (typeof name !== "string" || name.includes(".tmp-")) return false;
  return name === "addresses.json" || name === "chains.json" || /^addressbook_[A-Za-z0-9_-]*\.json$/.test(name);
}

// "1.12.0" >= "1.11.3"? Tolerates a leading "v" and trailing text.
function versionAtLeast(version, min = MIN_ADDRESSBOOK_VERSION) {
  const parse = (v) => {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ""));
    return m ? m.slice(1).map(Number) : null;
  };
  const a = parse(version), b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

// Collapse a burst of events into one call `ms` after the last event.
function debounce(fn, ms) {
  let timer = null;
  const wrapped = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(); }, ms);
  };
  wrapped.cancel = () => { if (timer) clearTimeout(timer); timer = null; };
  return wrapped;
}

module.exports = { MIN_ADDRESSBOOK_VERSION, isAddressbookFile, versionAtLeast, debounce };
