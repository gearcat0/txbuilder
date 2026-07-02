// The Ledger libraries (@ledgerhq/hw-app-eth, hw-transport-webhid) are written
// for Node and reference the globals `Buffer` and `process`, which don't exist
// in a browser/Vite bundle. Provide minimal shims. This module is imported
// first in the renderer entry so the shims exist before any Ledger code is
// dynamically imported at sign time.
import { Buffer } from "buffer";

if (!globalThis.Buffer) globalThis.Buffer = Buffer;
if (!globalThis.global) globalThis.global = globalThis;
if (!globalThis.process) {
  globalThis.process = { env: {}, versions: {}, browser: true, nextTick: (fn, ...a) => setTimeout(() => fn(...a), 0) };
} else if (!globalThis.process.versions) {
  globalThis.process.versions = {};
}
