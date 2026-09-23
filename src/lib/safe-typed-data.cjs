// EIP-712 typed data for a SafeTx, shared by the main-process handlers that
// build a new Safe transaction and those that sign one already pending on the
// Safe Transaction Service. Hardware wallets sign this typed data (or its
// precomputed domain/message hashes); keccak256(0x1901 ‖ domainHash ‖
// messageHash) is the safeTxHash.
//
// CommonJS (required directly by the unbundled main process; added to
// build.files). Never imported by the renderer.
const { hashDomain, hashStruct, hashTypedData } = require("viem");

const ZERO = "0x0000000000000000000000000000000000000000";

// Safe < 1.3.0 has no chainId in its EIP-712 domain. `version` may carry a
// suffix ("1.3.0+L2"); unknown/unparseable versions get the modern domain.
function domainHasChainId(version) {
  const m = /^(\d+)\.(\d+)/.exec(String(version || ""));
  if (!m) return true;
  const major = Number(m[1]), minor = Number(m[2]);
  return major > 1 || (major === 1 && minor >= 3);
}

// `tx` is SafeTx-shaped: {to, value, data, operation, safeTxGas, baseGas,
// gasPrice, gasToken, refundReceiver, nonce}. Accepts protocol-kit's
// SafeTransactionData and the Safe API's pending-tx records (numbers or
// strings, null data) alike.
function buildSafeTypedData({ chainId, safeAddr, version, tx }) {
  const withChain = domainHasChainId(version);
  const typedData = {
    types: {
      EIP712Domain: [
        ...(withChain ? [{ name: "chainId", type: "uint256" }] : []),
        { name: "verifyingContract", type: "address" },
      ],
      SafeTx: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
        { name: "operation", type: "uint8" },
        { name: "safeTxGas", type: "uint256" },
        { name: "baseGas", type: "uint256" },
        { name: "gasPrice", type: "uint256" },
        { name: "gasToken", type: "address" },
        { name: "refundReceiver", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "SafeTx",
    domain: {
      ...(withChain ? { chainId: String(chainId) } : {}),
      verifyingContract: safeAddr,
    },
    message: {
      to: tx.to,
      value: String(tx.value ?? "0"),
      data: tx.data || "0x",
      operation: Number(tx.operation ?? 0),
      safeTxGas: String(tx.safeTxGas ?? "0"),
      baseGas: String(tx.baseGas ?? "0"),
      gasPrice: String(tx.gasPrice ?? "0"),
      gasToken: tx.gasToken || ZERO,
      refundReceiver: tx.refundReceiver || ZERO,
      nonce: String(tx.nonce ?? "0"),
    },
  };
  return { typedData, ...hashSafeTypedData(typedData) };
}

// {safeTxHash, domainHash, messageHash} for SafeTx typed data.
function hashSafeTypedData(typedData) {
  const { types, domain, message } = typedData;
  return {
    safeTxHash: hashTypedData({ domain, types, primaryType: "SafeTx", message }),
    domainHash: hashDomain({ domain, types }),
    messageHash: hashStruct({ data: message, primaryType: "SafeTx", types }),
  };
}

module.exports = { buildSafeTypedData, hashSafeTypedData, domainHasChainId };
