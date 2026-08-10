// Local EIP-712 signing with raw private keys — no network, no Safe
// infrastructure. The digest is the Safe transaction hash
// (keccak256(0x1901 ‖ domainSeparator ‖ structHash)) as returned by
// safe-build-typed-data; the 65-byte r‖s‖v output uses v = 27/28, which Safe
// contracts interpret as an ECDSA signature over the typed-data digest (the
// same shape hardware wallets return).
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak256 } from "js-sha3";

function hexToBytes(hex) {
  const h = String(hex).replace(/^0x/i, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const is32ByteHex = (s) => /^(0x)?[0-9a-fA-F]{64}$/.test(String(s || ""));

export function signDigest(privKeyHex, digestHex) {
  if (!is32ByteHex(privKeyHex) || !is32ByteHex(digestHex)) return null;
  try {
    const sig = secp256k1.sign(hexToBytes(digestHex), hexToBytes(privKeyHex)); // lowS by default
    const r = sig.r.toString(16).padStart(64, "0");
    const s = sig.s.toString(16).padStart(64, "0");
    const v = (27 + sig.recovery).toString(16).padStart(2, "0");
    return "0x" + r + s + v;
  } catch {
    return null;
  }
}

// Recover the signer address from a signDigest-style r‖s‖v signature —
// used to verify signatures before they enter a bundle, and by tests.
export function recoverAddress(digestHex, signatureHex) {
  try {
    const sigHex = String(signatureHex).replace(/^0x/i, "");
    if (sigHex.length !== 130 || !is32ByteHex(digestHex)) return null;
    const v = parseInt(sigHex.slice(128, 130), 16);
    if (v !== 27 && v !== 28) return null;
    const pub = secp256k1.Signature.fromCompact(sigHex.slice(0, 128))
      .addRecoveryBit(v - 27)
      .recoverPublicKey(hexToBytes(digestHex))
      .toRawBytes(false);
    return "0x" + keccak256(pub.slice(1)).slice(-40);
  } catch {
    return null;
  }
}
