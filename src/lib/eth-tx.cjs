// Plain Ethereum transactions for hardware-wallet executors: the executor EOA
// sends execTransaction to the Safe and pays gas, so a Trezor/Ledger account
// has to sign a normal (not typed-data) transaction.
//
// The unsigned transaction travels between processes as hex strings (IPC and
// JSON can't carry BigInt); `toViemTx` turns it back into viem's shape.
//
// CommonJS (required directly by the unbundled main process; added to
// build.files). Never imported by the renderer.
const { serializeTransaction, recoverTransactionAddress, keccak256 } = require("viem");

const hex = (n) => "0x" + BigInt(n).toString(16);

// Fee fields for the next block. EIP-1559 when the chain reports a base fee:
// maxFee = 2 × baseFee + tip (survives ~6 full blocks of base-fee growth);
// otherwise a legacy gasPrice.
function feeFields({ baseFeePerGas, maxPriorityFeePerGas, gasPrice }) {
  if (baseFeePerGas != null) {
    const tip = BigInt(maxPriorityFeePerGas ?? 1_500_000_000n);
    return { type: "eip1559", maxPriorityFeePerGas: hex(tip), maxFeePerGas: hex(BigInt(baseFeePerGas) * 2n + tip) };
  }
  return { type: "legacy", gasPrice: hex(gasPrice) };
}

// Estimated gas plus 20% headroom — Safe execution gas can vary with state
// touched between estimate and inclusion.
const withGasBuffer = (estimate) => hex((BigInt(estimate) * 12n) / 10n);

// Worst-case gas cost of the transaction in wei.
function maxCost(tx) {
  return BigInt(tx.gas) * BigInt(tx.type === "eip1559" ? tx.maxFeePerGas : tx.gasPrice);
}

function toViemTx(tx) {
  const base = {
    chainId: Number(tx.chainId), nonce: Number(BigInt(tx.nonce)), to: tx.to,
    value: BigInt(tx.value || 0), data: tx.data || "0x", gas: BigInt(tx.gas),
  };
  return tx.type === "eip1559"
    ? { ...base, type: "eip1559", maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) }
    : { ...base, type: "legacy", gasPrice: BigInt(tx.gasPrice) };
}

// Unsigned serialization — what a Ledger signs (raw RLP, without 0x).
const serializeUnsigned = (tx) => serializeTransaction(toViemTx(tx));

// Devices report v differently: 0/1 (typed tx), 27/28, or EIP-155
// (chainId×2 + 35/36). Reduce it to the recovery bit.
function yParityOf(v) {
  const n = Number(typeof v === "string" ? BigInt(v.startsWith("0x") ? v : "0x" + v) : v);
  if (n === 0 || n === 1) return n;
  if (n === 27 || n === 28) return n - 27;
  if (n >= 35) return (n - 35) % 2;
  throw new Error(`Unrecognized signature v ${v}`);
}
const pad32 = (x) => "0x" + String(x).replace(/^0x/i, "").padStart(64, "0");

// Serialize the signed transaction and prove it's from `from`. Returns
// {raw, txHash}; throws when the signature recovers to another address.
async function assembleSigned(tx, { r, s, v }, from) {
  const vt = toViemTx(tx);
  const yParity = yParityOf(v);
  const sig = vt.type === "eip1559"
    ? { r: pad32(r), s: pad32(s), yParity }
    : { r: pad32(r), s: pad32(s), v: BigInt(vt.chainId) * 2n + 35n + BigInt(yParity) };
  const raw = serializeTransaction(vt, sig);
  const signer = await recoverTransactionAddress({ serializedTransaction: raw });
  if (!from || signer.toLowerCase() !== String(from).toLowerCase()) {
    throw new Error(`Transaction is signed by ${signer}, not the selected account ${from}`);
  }
  return { raw, txHash: keccak256(raw) };
}

module.exports = { feeFields, withGasBuffer, maxCost, toViemTx, serializeUnsigned, yParityOf, assembleSigned, hex };
