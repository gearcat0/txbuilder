// EOA account inventory for the Accounts screen: every address the app can
// sign with, grouped by address, plus every evmaddressbook entry naming it.
//
// Pure functions (no React / Electron) so they can be unit-tested; key→address
// derivation is injected because it lives with the secp256k1 code in the UI.

// Collect accounts from settings. Returns [{address, sources:[{kind, detail, disabled}]}]
// in insertion order (internal keys, then Trezor, then Ledger). An address held
// by more than one source (e.g. the same key imported twice, or a key that is
// also on a device) is a single row listing each source.
//   kind: "internal" | "trezor" | "ledger"; internal sources carry `index`
//   (the slot in settings.keys), hardware sources carry `path`.
export function collectAccounts(settings, { deriveAddress, isDisabled = () => false } = {}) {
  const s = settings || {};
  const byAddr = new Map();
  const add = (address, source) => {
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) return;
    const k = address.toLowerCase();
    let row = byAddr.get(k);
    if (!row) { row = { address, sources: [] }; byAddr.set(k, row); }
    if (!row.sources.some(x => x.kind === source.kind && x.detail === source.detail)) row.sources.push(source);
  };
  (Array.isArray(s.keys) ? s.keys : []).forEach((key, i) => {
    if (!key || !deriveAddress) return;
    const a = deriveAddress(key);
    if (a) add(a, { kind: "internal", detail: `key #${i + 1}`, index: i, disabled: !!isDisabled(a) });
  });
  for (const acc of Array.isArray(s.trezorAccounts) ? s.trezorAccounts : [])
    add(acc?.address, { kind: "trezor", detail: acc?.path || "", path: acc?.path, verified: !!acc?.verified });
  for (const acc of Array.isArray(s.ledgerAccounts) ? s.ledgerAccounts : [])
    add(acc?.address, { kind: "ledger", detail: acc?.path || "", path: acc?.path, scheme: acc?.scheme, verified: !!acc?.verified });
  return [...byAddr.values()];
}

// Index address-book entries (as returned by get-addresses-multi, each tagged
// with `_book`) by lowercase address. Every distinct (book, name) pair is kept,
// so an address named in several books — or twice in one — yields several
// matches. Returns Map<lowercaseAddr, [{book, name}]>.
export function indexAddressbook(entries) {
  const idx = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.address !== "string") continue;
    const k = e.address.toLowerCase();
    const name = typeof e.description === "string" ? e.description.trim() : "";
    const book = e._book || "Default";
    let list = idx.get(k);
    if (!list) { list = []; idx.set(k, list); }
    if (!list.some(m => m.book === book && m.name === name)) list.push({ book, name });
  }
  return idx;
}
