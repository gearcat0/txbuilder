// Native balances for many addresses in one eth_call, via Multicall3's
// getEthBalance (the approach wallets like MetaMask take with their balance
// checker contract). Multicall3 lives at the same address on nearly every EVM
// chain; where it doesn't, the caller falls back to eth_getBalance.
//
// CommonJS (required directly by the unbundled main process; added to
// build.files). Never imported by the renderer.
const { encodeFunctionData, decodeFunctionResult } = require("viem");

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const ABI = [
  {
    type: "function", name: "aggregate3", stateMutability: "payable",
    inputs: [{ name: "calls", type: "tuple[]", components: [
      { name: "target", type: "address" }, { name: "allowFailure", type: "bool" }, { name: "callData", type: "bytes" },
    ] }],
    outputs: [{ name: "returnData", type: "tuple[]", components: [
      { name: "success", type: "bool" }, { name: "returnData", type: "bytes" },
    ] }],
  },
  {
    type: "function", name: "getEthBalance", stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }], outputs: [{ name: "balance", type: "uint256" }],
  },
];

// Calldata for one aggregate3 call returning each address's balance.
function encodeBalancesCall(addresses) {
  return encodeFunctionData({
    abi: ABI, functionName: "aggregate3",
    args: [addresses.map(addr => ({
      target: MULTICALL3, allowFailure: true,
      callData: encodeFunctionData({ abi: ABI, functionName: "getEthBalance", args: [addr] }),
    }))],
  });
}

// aggregate3 return data → {address: hex wei | null} (null where that call
// failed). Throws on "0x" (no contract at the address) or malformed data.
function decodeBalancesResult(addresses, data) {
  if (!data || data === "0x") throw new Error("Multicall3 returned no data");
  const results = decodeFunctionResult({ abi: ABI, functionName: "aggregate3", data });
  if (results.length !== addresses.length) throw new Error("Multicall3 result count mismatch");
  const out = {};
  addresses.forEach((addr, i) => {
    const r = results[i];
    out[addr] = r.success && r.returnData !== "0x"
      ? "0x" + decodeFunctionResult({ abi: ABI, functionName: "getEthBalance", data: r.returnData }).toString(16)
      : null;
  });
  return out;
}

module.exports = { MULTICALL3, ABI, encodeBalancesCall, decodeBalancesResult };
