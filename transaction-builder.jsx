import React, { useState, useRef, useEffect, useMemo, useCallback, useContext } from "react";
import { keccak256 } from "js-sha3";
import { secp256k1 } from "@noble/curves/secp256k1.js";

// ── Mock Data ──
const MOCK_ABI_IMPL = [
  { inputs: [], name: "AccessControlBadConfirmation", type: "error" },
  { inputs: [{ internalType: "address", name: "account", type: "address" }, { internalType: "bytes32", name: "neededRole", type: "bytes32" }], name: "AccessControlUnauthorizedAccount", type: "error" },
  { inputs: [{ internalType: "address", name: "asset_", type: "address" }, { internalType: "bool", name: "active_", type: "bool" }], name: "addAsset", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "address", name: "owner", type: "address" }, { internalType: "address", name: "spender", type: "address" }], name: "approve", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "deleteAsset", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "uint256", name: "amount", type: "uint256" }], name: "deposit", outputs: [], stateMutability: "payable", type: "function" },
  { inputs: [{ internalType: "address", name: "asset_", type: "address" }, { internalType: "uint256", name: "amount_", type: "uint256" }], name: "depositAsset", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "bytes32", name: "role", type: "bytes32" }], name: "grantRole", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "initialize", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "address", name: "to", type: "address" }, { internalType: "uint256", name: "amount", type: "uint256" }], name: "mint", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "address", name: "to", type: "address" }, { internalType: "uint256", name: "shares", type: "uint256" }], name: "mintShares", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "address", name: "user_", type: "address" }, { internalType: "uint64", name: "baseWithdrawalFee_", type: "uint64" }, { internalType: "bool", name: "toOverride_", type: "bool" }], name: "overrideBaseWithdrawalFee", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "pause", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "address", name: "owner", type: "address" }, { internalType: "address", name: "spender", type: "address" }, { internalType: "uint256", name: "value", type: "uint256" }, { internalType: "uint256", name: "deadline", type: "uint256" }, { internalType: "uint8", name: "v", type: "uint8" }, { internalType: "bytes32", name: "r", type: "bytes32" }, { internalType: "bytes32", name: "s", type: "bytes32" }], name: "permit", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "processAccounting", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "address", name: "buffer_", type: "address" }], name: "setBuffer", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "unpause", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "address", name: "newOwner", type: "address" }], name: "transferOwnership", outputs: [], stateMutability: "nonpayable", type: "function" },
];

const MOCK_ABI_PROXY = [
  { inputs: [{ internalType: "address", name: "implementation_", type: "address" }], name: "upgradeTo", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "address", name: "implementation_", type: "address" }, { internalType: "bytes", name: "data_", type: "bytes" }], name: "upgradeToAndCall", outputs: [], stateMutability: "payable", type: "function" },
  { inputs: [], name: "implementation", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "admin", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
];

const CHAIN_COLORS = {
  1:"#627EEA",42161:"#28A0F0",10:"#FF0420",137:"#8247E5",8453:"#0052FF",
  56:"#F0B90B",43114:"#E84142",250:"#1969FF",100:"#04795B",324:"#8B8DFC",
};
// Native gas-token symbol per chainId — used for Trezor account balance display.
// evmaddressbook doesn't expose the symbol so we keep a small map and default to
// "" (no suffix) for unknown chains.
const NATIVE_SYMBOL = {
  1:"ETH",10:"ETH",42161:"ETH",8453:"ETH",324:"ETH",
  137:"POL",56:"BNB",43114:"AVAX",100:"xDAI",250:"FTM",
  11155111:"ETH",84532:"ETH",
};
const formatNative=(hex,symbol)=>{
  if(!hex||hex==="0x") return "—";
  try {
    const wei=BigInt(hex);
    if(wei===0n) return `0${symbol?" "+symbol:""}`;
    const tenK=10n**14n;
    const scaled=wei/tenK;
    const whole=scaled/10000n;
    const frac=scaled%10000n;
    if(whole===0n&&frac===0n) return `<0.0001${symbol?" "+symbol:""}`;
    const fracStr=frac.toString().padStart(4,"0").replace(/0+$/,"")||"0";
    return `${whole.toString()}.${fracStr}${symbol?" "+symbol:""}`;
  } catch { return "—"; }
};
const FALLBACK_NETWORKS = [
  { id: 1, name: "Ethereum", color: "#627EEA" },
  { id: 42161, name: "Arbitrum", color: "#28A0F0" },
  { id: 10, name: "Optimism", color: "#FF0420" },
  { id: 137, name: "Polygon", color: "#8247E5" },
  { id: 8453, name: "Base", color: "#0052FF" },
];

const shorten = (a) => a ? a.slice(0, 6) + "…" + a.slice(-4) : "";
const sigOf = (m) => `${m.name}(${m.inputs.map(i => i.type).join(",")})`;
const mockEncode = () => "0x" + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

function toChecksumAddress(addr) {
  const bare=addr.slice(2).toLowerCase();
  const hash=keccak256(bare);
  return "0x"+bare.split("").map((c,i)=>/[a-f]/.test(c)?parseInt(hash[i],16)>=8?c.toUpperCase():c:c).join("");
}
function isValidAddress(addr) {
  if(!addr||!/^0x[0-9a-fA-F]{40}$/.test(addr)) return {valid:false,reason:"invalid"};
  const bare=addr.slice(2);
  if(bare===bare.toLowerCase()||bare===bare.toUpperCase()) return {valid:true};
  return toChecksumAddress(addr)===addr?{valid:true}:{valid:false,reason:"checksum"};
}
// ── Solidity type validation ──
function validateParam(type,value) {
  if(value===undefined||value===null||value==="") return "Required";
  // address
  if(type==="address") {
    const r=isValidAddress(value);
    return r.valid?null:r.reason==="checksum"?"Checksum failed":"Invalid address";
  }
  // bool
  if(type==="bool") return (value==="true"||value==="false")?null:"Must be true or false";
  // uintN / intN
  const uintM=type.match(/^uint(\d+)?$/); const intM=type.match(/^int(\d+)?$/);
  if(uintM||intM) {
    const bits=parseInt((uintM||intM)[1]||"256",10);
    const isHex=value.startsWith("0x")||value.startsWith("0X");
    if(isHex) { if(!/^0x[0-9a-fA-F]+$/i.test(value)) return "Invalid hex"; }
    else { if(!/^-?\d+$/.test(value)) return "Must be an integer"; }
    try {
      const n=BigInt(value);
      if(uintM) {
        if(n<0n) return "Must be non-negative";
        if(n>=(1n<<BigInt(bits))) return `Exceeds uint${bits} max`;
      } else {
        const lo=-(1n<<BigInt(bits-1)), hi=(1n<<BigInt(bits-1))-1n;
        if(n<lo||n>hi) return `Out of int${bits} range`;
      }
    } catch { return "Invalid number"; }
    return null;
  }
  // bytesN (fixed)
  const bytesM=type.match(/^bytes(\d+)$/);
  if(bytesM) {
    const n=parseInt(bytesM[1],10);
    if(!/^0x[0-9a-fA-F]*$/i.test(value)) return "Must be hex (0x…)";
    const byteLen=(value.length-2)/2;
    if(byteLen!==n) return `Must be exactly ${n} bytes (${n*2} hex chars)`;
    return null;
  }
  // bytes (dynamic)
  if(type==="bytes") {
    if(!/^0x([0-9a-fA-F]{2})*$/i.test(value)) return "Must be hex (0x…) with even length";
    return null;
  }
  // string
  if(type==="string") return null;
  // arrays (type[])
  if(type.endsWith("[]")||type.match(/\[\d+\]$/)) {
    const baseType=type.replace(/\[\d*\]$/,"");
    try {
      const arr=JSON.parse(value);
      if(!Array.isArray(arr)) return "Must be a JSON array";
      const fixedM=type.match(/\[(\d+)\]$/);
      if(fixedM&&arr.length!==parseInt(fixedM[1],10)) return `Must have exactly ${fixedM[1]} elements`;
      for(let i=0;i<arr.length;i++) {
        const err=validateParam(baseType,String(arr[i]));
        if(err) return `[${i}]: ${err}`;
      }
    } catch { return "Must be a JSON array"; }
    return null;
  }
  // tuple — validated per-component, not here
  if(type==="tuple"||type.startsWith("tuple")) return null;
  return null;
}
function allParamsValid(inputs,params) {
  if(!inputs) return true;
  for(const ip of inputs) {
    const val=params[ip.name];
    if(ip.type==="bool") { if(val!=="true"&&val!=="false") return false; continue; }
    if(ip.type==="tuple"&&ip.components) {
      const t=val?.__tuple||{};
      for(const c of ip.components) {
        if(c.type==="bool") { if(t[c.name]!=="true"&&t[c.name]!=="false") return false; continue; }
        if(validateParam(c.type,t[c.name]||"")) return false;
      }
      continue;
    }
    if(validateParam(ip.type,val||"")) return false;
  }
  return true;
}

// ── Minimal ABI encoding for eth_call ──
function encodeFunctionSelector(name,inputs) {
  const sig=`${name}(${inputs.map(i=>i.type).join(",")})`;
  return "0x"+keccak256(sig).slice(0,8);
}
function abiEncodeParam(type,value) {
  if(type==="address") return value.slice(2).toLowerCase().padStart(64,"0");
  if(type==="bool") return (value==="true"?"1":"0").padStart(64,"0");
  if(type.match(/^uint\d*$/)||type.match(/^int\d*$/)) {
    const n=BigInt(value);
    if(n<0n) { const bits=BigInt(type.match(/\d+/)?.[0]||"256"); return ((1n<<bits)+n).toString(16).padStart(64,"0"); }
    return n.toString(16).padStart(64,"0");
  }
  if(type.match(/^bytes\d+$/)) return value.slice(2).padEnd(64,"0");
  return value.replace(/^0x/,"").padStart(64,"0");
}
function encodeCalldata(method,params) {
  const sel=encodeFunctionSelector(method.name,method.inputs);
  const encoded=method.inputs.map(i=>abiEncodeParam(i.type,params[i.name]||"")).join("");
  return sel+encoded;
}

const SAFE_CONTRACTS=new Set(["GnosisSafeProxy","SafeProxy","GnosisSafe","GnosisSafeL2","Safe","SafeL2"]);
function getSafeInfo(addresses,addr,chainId) {
  if(!addr||addr.length!==42) return null;
  const entry=addresses.find(a=>a.address.toLowerCase()===addr.toLowerCase());
  if(!entry) return null;
  const chainKey=String(chainId);
  const info=entry.activeChains?.[chainKey]||Object.values(entry.activeChains||{})[0];
  if(!info||!SAFE_CONTRACTS.has(info.contractName)) return null;
  return {version:info.version||null,contractName:info.contractName,threshold:info.threshold,owners:info.owners?.length};
}
function SafeTag({info}) {
  if(!info) return null;
  return (
    <span style={{fontFamily:F.sans,fontSize:9,fontWeight:600,color:"#4ADE80",background:"#4ADE8018",padding:"1px 6px",borderRadius:3,display:"inline-flex",alignItems:"center",gap:3,whiteSpace:"nowrap"}}>
      Safe{info.version?` v${info.version}`:""}
      {info.threshold&&info.owners?<span style={{opacity:0.7}}>{info.threshold}/{info.owners}</span>:null}
    </span>
  );
}

// ── Icons ──
const I = {
  plus: (s=14) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>,
  trash: (s=13) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4m2 0v9.33a1.33 1.33 0 01-1.34 1.34H4.67a1.33 1.33 0 01-1.34-1.34V4h9.34z"/></svg>,
  copy: (s=12) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="5" y="5" width="9" height="9" rx="1"/><path d="M3 11V3a1 1 0 011-1h8"/></svg>,
  check: (s=12) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M3 8.5l3.5 3.5 6.5-8"/></svg>,
  chev: (s=12,d="down") => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" style={{transform:`rotate(${d==="up"?180:d==="left"?90:d==="right"?-90:0}deg)`,transition:"transform 0.15s"}}><path d="M4 6l4 4 4-4"/></svg>,
  grip: (s=12) => <svg width={s} height={s} viewBox="0 0 16 16" fill="currentColor" opacity="0.3"><circle cx="6" cy="4" r="1.2"/><circle cx="10" cy="4" r="1.2"/><circle cx="6" cy="8" r="1.2"/><circle cx="10" cy="8" r="1.2"/><circle cx="6" cy="12" r="1.2"/><circle cx="10" cy="12" r="1.2"/></svg>,
  dl: (s=13) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2v9M4 8l4 4 4-4M2 14h12"/></svg>,
  ul: (s=13) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 11V2M4 5l4-4 4 4M2 14h12"/></svg>,
  send: (s=14) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2L7 9M14 2l-5 12-2-5-5-2 12-5z"/></svg>,
  play: (s=14) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6"/><path d="M6.5 5l4.5 3-4.5 3V5z" fill="currentColor" stroke="none"/></svg>,
  abi: (s=13) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 2h8a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M6 5h4M6 8h4M6 11h2"/></svg>,
  book: (s=13) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 3a1 1 0 011-1h3c1.1 0 2 .9 2 2v10s-1-1-2-1H3a1 1 0 01-1-1V3z"/><path d="M14 3a1 1 0 00-1-1h-3c-1.1 0-2 .9-2 2v10s1-1 2-1h3a1 1 0 001-1V3z"/></svg>,
  err: (s=14) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 5v3.5"/><circle cx="8" cy="11" r="0.5" fill="currentColor" stroke="none"/></svg>,
  spin: (s=14) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{animation:"spin 0.8s linear infinite"}}><path d="M8 2a6 6 0 015.2 3"/></svg>,
  refresh: (s=12) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2.5 8a5.5 5.5 0 019.3-4"/><path d="M13.5 8a5.5 5.5 0 01-9.3 4"/><path d="M11 1l1 3-3 1"/><path d="M5 15l-1-3 3-1"/></svg>,
  back: (s=14) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 3L5 8l5 5"/></svg>,
  save: (s=13) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12.7 14H3.3A1.3 1.3 0 012 12.7V3.3A1.3 1.3 0 013.3 2h7.4l3.3 3.3v7.4A1.3 1.3 0 0112.7 14z"/><path d="M11.3 14V9.3H4.7V14"/><path d="M4.7 2v3.3h5.3"/></svg>,
  folder: (s=13) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 13.3V3.3A1.3 1.3 0 013.3 2h3.4l1.3 2h4.7A1.3 1.3 0 0114 5.3v8A1.3 1.3 0 0112.7 14H3.3A1.3 1.3 0 012 13.3z"/></svg>,
  queue: (s=13) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 4h12M2 8h12M2 12h8"/></svg>,
  eye: (s=14) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg>,
  eyeOff: (s=14) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1 8s2.5-5 7-5c1.6 0 3 .6 4.2 1.5M15 8s-1.2 2.5-3.5 3.8M9.9 10a2 2 0 01-3.8-1M2 2l12 12"/></svg>,
  filter: (s=12) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 3h12l-4.5 6V14l-3-1V9L2 3z"/></svg>,
  gear: (s=12) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg>,
  x: (s=12) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>,
};

const F = { mono: `'JetBrains Mono','SF Mono','Fira Code',monospace`, sans: `'DM Sans',system-ui,sans-serif` };
const C = {
  bg:"#08080A", s1:"#111114", s2:"#18181C", s3:"#202026", s4:"#28282F",
  b1:"#2A2A32", b2:"#38383F",
  t1:"#EAEAEF", t2:"#A0A0B8", t3:"#6A6A80", t4:"#48485A",
  acc:"#00E4B8", accD:"#00E4B815", accM:"#00E4B833",
  red:"#FF4060", redD:"#FF406015",
  warn:"#FFAA22", warnD:"#FFAA2218",
  blue:"#5599FF", blueD:"#5599FF15",
  purple:"#9977FF", purpleD:"#9977FF18",
};

function TypeBadge({type}) {
  const isA=type==="address",isU=type.startsWith("uint")||type.startsWith("int"),isB=type==="bool",isBt=type.startsWith("bytes");
  const color=isA?C.purple:isU?C.blue:isB?C.acc:isBt?C.warn:C.t3;
  const bg=isA?C.purpleD:isU?C.blueD:isB?C.accD:isBt?C.warnD:C.s3;
  return <span style={{fontFamily:F.mono,fontSize:9.5,color,background:bg,padding:"1px 5px",borderRadius:3}}>{type}</span>;
}

function ParamSignature({inputs,style={}}) {
  if(!inputs||inputs.length===0) return <span style={{fontFamily:F.mono,fontSize:10,color:C.t4,...style}}>()</span>;
  return (
    <span style={{fontFamily:F.mono,fontSize:10,color:C.t3,lineHeight:1.7,...style}}>
      ({inputs.map((inp,i)=>(
        <span key={i}>
          {i>0&&<span style={{color:C.t4}}>,{" "}</span>}
          <span style={{color:C.t3}}>{inp.name}</span>
          <span style={{color:C.t4}}>:</span>
          <TypeBadge type={inp.type}/>
        </span>
      ))})
    </span>
  );
}

// Address-book config (available + enabled set + toggle) — shared via context
// so we don't have to thread props through ParamInput / TransactionForm.
const BooksContext=React.createContext({availableBooks:[],enabledBooks:["Default"],onToggleBook:null});

// Deterministic palette for book labels — derived from book name.
const BOOK_PALETTE = [
  {fg:"#9CD3FF",bg:"#1E3850"}, // blue
  {fg:"#FFB8B8",bg:"#4A1F1F"}, // red/pink
  {fg:"#F0C97A",bg:"#3D2D0F"}, // amber
  {fg:"#A8E6A0",bg:"#1F3A1C"}, // green
  {fg:"#D5A8FF",bg:"#321F4D"}, // purple
  {fg:"#FFD4B0",bg:"#3D2616"}, // orange
];
function bookColor(name) {
  if(!name) return BOOK_PALETTE[0];
  let h=0; for(let i=0;i<name.length;i++) h=(h*31+name.charCodeAt(i))>>>0;
  return BOOK_PALETTE[h%BOOK_PALETTE.length];
}
function BookLabel({name,size=9}) {
  if(!name) return null;
  const c=bookColor(name);
  return <span style={{
    fontFamily:F.sans,fontSize:size,fontWeight:600,color:c.fg,background:c.bg,
    padding:"1px 5px",borderRadius:3,letterSpacing:"0.02em",
  }}>{name}</span>;
}

// ── Address Book Picker ──
function AddressBookPicker({addresses,onSelect,compact=false,availableBooks,enabledBooks,onToggleBook}) {
  const ctx=useContext(BooksContext);
  if(availableBooks==null) availableBooks=ctx.availableBooks||[];
  if(enabledBooks==null) enabledBooks=ctx.enabledBooks||["Default"];
  if(onToggleBook==null) onToggleBook=ctx.onToggleBook;
  const [open,setOpen]=useState(false);
  const [filter,setFilter]=useState("");
  const [booksOpen,setBooksOpen]=useState(false);
  const ref=useRef(null);
  const inputRef=useRef(null);
  const filtered=useMemo(()=>{
    if(!filter) return addresses;
    const lc=filter.toLowerCase();
    return addresses.filter(a=>a.description.toLowerCase().includes(lc)||a.address.toLowerCase().includes(lc));
  },[addresses,filter]);

  useEffect(()=>{
    const h=e=>{if(ref.current&&!ref.current.contains(e.target)){setOpen(false);setBooksOpen(false)}};
    document.addEventListener("mousedown",h);return()=>document.removeEventListener("mousedown",h);
  },[]);
  useEffect(()=>{if(open&&inputRef.current)inputRef.current.focus()},[open]);

  const showBooksConfig=availableBooks.length>0&&typeof onToggleBook==="function";

  return (
    <div ref={ref} style={{position:"relative",display:"inline-flex"}}>
      <button onClick={()=>{setOpen(!open);setFilter("");setBooksOpen(false)}} title="Address book" style={{
        background:"none",border:`1px solid ${open?C.acc+"55":C.b1}`,borderRadius:compact?4:6,
        color:open?C.acc:C.t4,cursor:"pointer",padding:compact?"3px 5px":"6px 8px",
        display:"flex",alignItems:"center",gap:4,transition:"all 0.15s",
      }}
        onMouseEnter={e=>{if(!open)e.currentTarget.style.borderColor=C.b2;e.currentTarget.style.color=C.t2}}
        onMouseLeave={e=>{if(!open)e.currentTarget.style.borderColor=C.b1;e.currentTarget.style.color=open?C.acc:C.t4}}
      >
        {I.book(compact?10:12)}
      </button>
      {open&&(
        <div style={{
          position:"absolute",top:"calc(100% + 4px)",right:0,zIndex:300,width:360,
          background:C.s1,border:`1px solid ${C.b2}`,borderRadius:8,
          boxShadow:"0 12px 48px rgba(0,0,0,0.7)",overflow:"hidden",display:"flex",flexDirection:"column",maxHeight:340,
        }}>
          <div style={{padding:"8px 8px 6px",borderBottom:`1px solid ${C.b1}`,display:"flex",alignItems:"center",gap:6,position:"relative"}}>
            <input ref={inputRef} value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Search name or address…"
              style={{
                fontFamily:F.mono,fontSize:11,flex:1,boxSizing:"border-box",padding:"6px 10px",borderRadius:5,
                border:`1px solid ${C.b1}`,background:C.s2,color:C.t1,outline:"none",
              }}/>
            {showBooksConfig&&(
              <button onClick={()=>setBooksOpen(o=>!o)} title="Configure address books"
                style={{
                  background:booksOpen?C.accD:"transparent",border:`1px solid ${booksOpen?C.acc+"55":C.b1}`,
                  borderRadius:5,color:booksOpen?C.acc:C.t3,cursor:"pointer",
                  padding:"5px 7px",display:"flex",alignItems:"center",transition:"all 0.12s",
                }}>{I.gear?I.gear(12):I.plus(12)}</button>
            )}
            {showBooksConfig&&booksOpen&&(
              <div style={{
                position:"absolute",top:"calc(100% + 2px)",right:8,zIndex:310,minWidth:200,
                background:C.s1,border:`1px solid ${C.b2}`,borderRadius:7,
                boxShadow:"0 10px 32px rgba(0,0,0,0.7)",overflow:"hidden",
              }}>
                <div style={{padding:"6px 10px",fontFamily:F.sans,fontSize:9,color:C.t4,
                  textTransform:"uppercase",letterSpacing:"0.08em",borderBottom:`1px solid ${C.b1}`}}>
                  Include books
                </div>
                {availableBooks.map(b=>{
                  const checked=enabledBooks.includes(b);
                  return (
                    <label key={b} style={{
                      display:"flex",alignItems:"center",gap:8,padding:"7px 10px",cursor:"pointer",
                      borderBottom:`1px solid ${C.b1}22`,
                    }}
                      onMouseEnter={e=>e.currentTarget.style.background=C.s2}
                      onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      <input type="checkbox" checked={checked} onChange={()=>onToggleBook(b)}
                        style={{accentColor:C.acc}}/>
                      <BookLabel name={b}/>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
          <div style={{overflowY:"auto",flex:1}}>
            {filtered.length===0&&(
              <div style={{padding:"14px 12px",fontFamily:F.sans,fontSize:11,color:C.t4,textAlign:"center"}}>
                {addresses.length===0?"Address book unavailable":"No matches"}
              </div>
            )}
            {filtered.slice(0,60).map((a,i)=>(
              <button key={`${a._book||"_"}|${a.address}|${i}`} onClick={()=>{onSelect(a.address);setOpen(false);setFilter("");setBooksOpen(false)}} style={{
                width:"100%",textAlign:"left",padding:"7px 12px",border:"none",
                borderBottom:`1px solid ${C.b1}11`,background:"transparent",
                cursor:"pointer",display:"flex",flexDirection:"column",gap:2,transition:"background 0.1s",
              }}
                onMouseEnter={e=>e.currentTarget.style.background=C.s2}
                onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <span style={{fontFamily:F.sans,fontSize:11,color:C.t1,fontWeight:500}}>{a.description}</span>
                  {a._book&&<BookLabel name={a._book}/>}
                </div>
                <div style={{fontFamily:F.mono,fontSize:9.5,color:C.t4}}>{a.address}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Param Input ──
function ParamInput({ip,value,onChange,inp,addresses,chainId,decimals}) {
  const [decimalMode,setDecimalMode]=useState(false);
  const [decimalDisplay,setDecimalDisplay]=useState("");
  const err=value!==""?validateParam(ip.type,value):null;
  const hasVal=value!==undefined&&value!==null&&value!=="";
  const borderErr=hasVal&&err?{borderColor:C.red+"55"}:{};
  const showDecimalToggle=typeof decimals==="number"&&decimals>0&&(ip.type==="uint256"||ip.type==="uint");

  const paramLabel=<label style={{fontFamily:F.sans,fontSize:10,color:C.t3,marginBottom:1,display:"flex",alignItems:"center",gap:5}}>
    <span>{ip.name}</span><TypeBadge type={ip.type}/>
  </label>;

  // bool
  if(ip.type==="bool") {
    return (
      <div style={{display:"flex",flexDirection:"column",gap:3}}>
        {paramLabel}
        <div style={{display:"flex",gap:6}}>
        {["true","false"].map(v=>(
          <button key={v} onClick={()=>onChange(v)} style={{
            fontFamily:F.mono,fontSize:11.5,padding:"8px 22px",borderRadius:6,
            border:`1px solid ${value===v?C.acc+"55":C.b1}`,
            background:value===v?C.accD:"transparent",
            color:value===v?C.acc:C.t3,cursor:"pointer",transition:"all 0.12s",
          }}>{v}</button>
        ))}
        </div>
      </div>
    );
  }

  // address
  if(ip.type==="address") {
    const pc=value?.length===42?isValidAddress(value):null;
    return (
      <div style={{display:"flex",flexDirection:"column",gap:3}}>
        {paramLabel}
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          <div style={{flex:1,position:"relative"}}>
            <input value={value||""} onChange={e=>onChange(e.target.value)} placeholder="0x…" {...inp(pc&&!pc.valid?{borderColor:C.red+"55"}:{})}/>
            <span style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",display:"flex",alignItems:"center",gap:4}}>
              {pc?.valid&&<SafeTag info={getSafeInfo(addresses,value,chainId)}/>}
              {pc?.valid&&<span style={{color:C.acc}}>{I.check(12)}</span>}
              {pc&&!pc.valid&&<span style={{color:C.red,cursor:"default",display:"flex"}} title="Checksum failed">{I.err(12)}</span>}
            </span>
          </div>
          <AddressBookPicker compact addresses={addresses} onSelect={onChange}/>
        </div>
        {pc&&!pc.valid&&<div style={{fontFamily:F.sans,fontSize:10,color:C.red}}>Checksum failed</div>}
      </div>
    );
  }

  // tuple
  if(ip.type==="tuple"&&ip.components) {
    return (
      <div style={{display:"flex",flexDirection:"column",gap:3}}>
        {paramLabel}
        <div style={{border:`1px solid ${C.b1}`,borderRadius:7,padding:"10px 12px",background:C.s1,display:"flex",flexDirection:"column",gap:8}}>
        {ip.components.map(c=>{
          const key=ip.name+"."+c.name;
          return (
            <div key={c.name}>
              <label style={{fontFamily:F.sans,fontSize:10,color:C.t3,marginBottom:4,display:"flex",alignItems:"center",gap:5}}>
                <span>{c.name}</span><TypeBadge type={c.type}/>
              </label>
              <ParamInput ip={c} value={value?.__tuple?.[c.name]||""} onChange={v=>{
                const t={...(value?.__tuple||{}),[c.name]:v};
                onChange({__tuple:t,__components:ip.components});
              }} inp={inp} addresses={addresses} chainId={chainId}/>
            </div>
          );
        })}
        </div>
      </div>
    );
  }

  // integer hints
  const isInt=ip.type.match(/^u?int(\d+)?$/);
  const placeholder=isInt?(decimalMode?`Human-readable (e.g. 1.5 = 1.5×10^${decimals})`:`${ip.type} (decimal or 0x hex)`):ip.type.startsWith("bytes")&&ip.type!=="bytes"?`0x… (${parseInt(ip.type.slice(5))*2} hex chars)`:ip.type==="bytes"?"0x…":ip.type.endsWith("[]")?"JSON array, e.g. [1, 2, 3]":ip.type;

  // Decimal mode conversion
  const handleDecimalInput=(displayVal)=>{
    setDecimalDisplay(displayVal);
    if(!displayVal) { onChange(""); return; }
    try {
      const parts=displayVal.split(".");
      const whole=parts[0]||"0";
      const frac=(parts[1]||"").slice(0,decimals).padEnd(decimals,"0");
      const raw=BigInt(whole)*BigInt(10)**BigInt(decimals)+BigInt(frac);
      onChange(raw.toString());
    } catch { onChange(displayVal); }
  };

  const decimalErr=decimalMode&&decimalDisplay&&!/^\d+\.?\d*$/.test(decimalDisplay)?"Must be a positive number":null;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:3}}>
      <label style={{fontFamily:F.sans,fontSize:10,color:C.t3,marginBottom:1,display:"flex",alignItems:"center",gap:5}}>
        <span>{ip.name}</span><TypeBadge type={ip.type}/>
        {showDecimalToggle&&<>
          <button onClick={()=>{
            if(!decimalMode) {
              if(value&&/^\d+$/.test(value)) {
                try {
                  const n=BigInt(value);
                  const div=BigInt(10)**BigInt(decimals);
                  const w=n/div;const f=n%div;
                  const fs=f.toString().padStart(decimals,"0").replace(/0+$/,"")||"0";
                  setDecimalDisplay(fs==="0"?w.toString():`${w}.${fs}`);
                } catch { setDecimalDisplay(value||""); }
              } else {
                setDecimalDisplay(value||"");
              }
            } else {
              if(decimalDisplay&&!/^\d+\.?\d*$/.test(decimalDisplay)) {
                onChange(decimalDisplay);
              }
              setDecimalDisplay("");
            }
            setDecimalMode(!decimalMode);
          }} style={{
            fontFamily:F.sans,fontSize:9,fontWeight:600,padding:"1px 7px",borderRadius:10,marginLeft:"auto",
            border:`1px solid ${decimalMode?C.blue+"55":C.b1}`,
            background:decimalMode?C.blueD:"transparent",
            color:decimalMode?C.blue:C.t4,cursor:"pointer",transition:"all 0.12s",
          }}>
            {decimalMode?"Human":"Raw"}
          </button>
        </>}
      </label>
      {decimalMode?(
        <input value={decimalDisplay} onChange={e=>handleDecimalInput(e.target.value)} placeholder={placeholder}
          {...inp(decimalErr?{borderColor:C.red+"55"}:{})}/>
      ):(
        <input value={value||""} onChange={e=>onChange(e.target.value)} placeholder={placeholder} {...inp(borderErr)}/>
      )}
      {decimalMode&&decimalErr&&<div style={{fontFamily:F.sans,fontSize:10,color:C.red}}>{decimalErr}</div>}
      {!decimalMode&&hasVal&&err&&<div style={{fontFamily:F.sans,fontSize:10,color:C.red}}>{err}</div>}
      {decimalMode&&value&&!decimalErr&&<div style={{fontFamily:F.mono,fontSize:9,color:C.t4}}>Raw: {value}</div>}
    </div>
  );
}

// ── ABI Strip: collapsed by default, expandable ──
function AbiStrip({abi,isProxy,abiMode,setAbiMode,implAddr,onRefresh,refreshing}) {
  const [expanded,setExpanded]=useState(false);
  const fc=abi?abi.filter(i=>i.type==="function").length:0;
  const ec=abi?abi.filter(i=>i.type==="error").length:0;
  return (
    <div style={{background:C.s1,border:`1px solid ${C.b1}`,borderRadius:8,overflow:"hidden"}}>
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"6px 12px",cursor:"pointer"}} onClick={()=>setExpanded(!expanded)}>
        <span style={{color:C.t3,display:"flex"}}>{I.abi()}</span>
        <span style={{fontFamily:F.sans,fontSize:10.5,color:C.t2,fontWeight:500}}>ABI</span>
        <span style={{fontFamily:F.mono,fontSize:9.5,color:C.t4}}>
          {fc} fn{fc!==1?"s":""}{ec>0?` · ${ec} err`:""}
        </span>
        {isProxy&&(
          <>
            <div style={{width:1,height:12,background:C.b1,margin:"0 2px"}}/>
            <div style={{display:"flex",borderRadius:4,overflow:"hidden",border:`1px solid ${C.b1}`}}
              onClick={e=>e.stopPropagation()}>
              {["impl","proxy"].map(mode=>(
                <button key={mode} onClick={()=>setAbiMode(mode)} style={{
                  fontFamily:F.sans,fontSize:9.5,fontWeight:600,padding:"2px 9px",border:"none",cursor:"pointer",
                  background:abiMode===mode?(mode==="impl"?C.accD:C.purpleD):"transparent",
                  color:abiMode===mode?(mode==="impl"?C.acc:C.purple):C.t4,transition:"all 0.12s",
                }}>
                  {mode==="impl"?"Implementation":"Proxy"}
                </button>
              ))}
            </div>
            {abiMode==="impl"&&implAddr&&(
              <span style={{fontFamily:F.mono,fontSize:9,color:C.t4}}>{shorten(implAddr)}</span>
            )}
          </>
        )}
        <div style={{flex:1}}/>
        {onRefresh&&(
          <button onClick={e=>{e.stopPropagation();onRefresh()}} disabled={refreshing} title="Re-scan address and refresh ABI" style={{
            background:"none",border:`1px solid ${C.b1}`,borderRadius:4,color:refreshing?C.t4:C.t3,
            cursor:refreshing?"wait":"pointer",padding:"2px 5px",display:"flex",alignItems:"center",
            transition:"all 0.15s",
          }}
            onMouseEnter={e=>{if(!refreshing)e.currentTarget.style.borderColor=C.acc+"55"}}
            onMouseLeave={e=>e.currentTarget.style.borderColor=C.b1}
          >{refreshing?I.spin(11):I.refresh(11)}</button>
        )}
        <span style={{color:C.t4}}>{I.chev(9,expanded?"up":"down")}</span>
      </div>
      {expanded&&(
        <div style={{borderTop:`1px solid ${C.b1}`,padding:"8px 12px",maxHeight:160,overflowY:"auto"}}>
          <pre style={{fontFamily:F.mono,fontSize:9.5,color:C.t3,whiteSpace:"pre-wrap",wordBreak:"break-all",margin:0,lineHeight:1.5}}>
            {JSON.stringify(abi,null,2).slice(0,4000)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Transaction Form ──
const TABS=[
  {id:"write",label:"Write",color:C.acc},
  {id:"read",label:"Read",color:C.blue},
  {id:"events",label:"Events",color:C.purple},
  {id:"custom",label:"Custom Data",color:C.warn},
];

function TransactionForm({onAdd,addresses,chainId,network,onRescanAddresses}) {
  const [address,setAddress]=useState("");
  const [addrStatus,setAddrStatus]=useState(null); // null | "checking" | "valid" | {error:string}
  const [abiLoaded,setAbiLoaded]=useState(false);
  const [refreshing,setRefreshing]=useState(false);
  const [tab,setTab]=useState("write");
  const [queryResult,setQueryResult]=useState(null); // null | {loading} | {data} | {error}
  const [eventFilter,setEventFilter]=useState("");
  const [contractDecimals,setContractDecimals]=useState(null); // null or number
  const [isProxy,setIsProxy]=useState(false);
  const [abiMode,setAbiMode]=useState("impl");
  const [implAbi,setImplAbi]=useState(null);
  const [proxyAbi,setProxyAbi]=useState(null);
  const [selectedMethod,setSelectedMethod]=useState(null);
  const [params,setParams]=useState({});
  const [ethValue,setEthValue]=useState("");
  const customData=tab==="custom";
  const [hexData,setHexData]=useState("");
  const [methodOpen,setMethodOpen]=useState(false);
  const [methodFilter,setMethodFilter]=useState("");
  const dropRef=useRef(null);
  const filterRef=useRef(null);
  const codeCheckRef=useRef(0);

  const [implAddr,setImplAddr]=useState(null);
  const isValid=addrStatus==="valid";
  const activeAbi=abiMode==="impl"?implAbi:proxyAbi;
  const allMethods=useMemo(()=>(activeAbi||[]).filter(i=>i.type==="function"),[activeAbi]);
  const methods=useMemo(()=>{
    if(tab==="read") return allMethods.filter(m=>m.stateMutability==="view"||m.stateMutability==="pure");
    if(tab==="write") return allMethods.filter(m=>m.stateMutability!=="view"&&m.stateMutability!=="pure");
    return allMethods;
  },[allMethods,tab]);
  const events=useMemo(()=>(activeAbi||[]).filter(i=>i.type==="event"),[activeAbi]);
  const filteredEvents=events.filter(e=>e.name.toLowerCase().includes(eventFilter.toLowerCase()));
  const filteredMethods=methods.filter(m=>m.name.toLowerCase().includes(methodFilter.toLowerCase()));

  function loadAbis(addr,seq) {
    if(!window.electronAPI?.getAbi) { setAbiLoaded(true); setTab("custom"); return; }
    const entry=addresses.find(a=>a.address.toLowerCase()===addr.toLowerCase());
    const chainInfo=entry?.activeChains?.[String(chainId)]||Object.values(entry?.activeChains||{})[0];
    const implAddress=chainInfo?.implementationAddress||null;
    setImplAddr(implAddress);

    const proxyP=window.electronAPI.getAbi(addr,chainId);
    const implP=implAddress?window.electronAPI.getAbi(implAddress,chainId):Promise.resolve(null);

    Promise.all([proxyP,implP]).then(([proxyResult,implResult])=>{
      if(seq!==codeCheckRef.current) return;
      const hasAny=abi=>abi&&abi.length>0;
      const hasFunctions=abi=>abi&&abi.some(e=>e.type==="function");
      if(implAddress) {
        setIsProxy(true);
        setProxyAbi(hasAny(proxyResult)?proxyResult:null);
        if(hasFunctions(implResult)) {
          setImplAbi(implResult); setAbiMode("impl"); setAbiLoaded(true);
        } else if(hasFunctions(proxyResult)) {
          setImplAbi(proxyResult); setAbiMode("impl"); setAbiLoaded(true);
        } else {
          setImplAbi(null); setAbiLoaded(true); setTab("custom");
        }
      } else if(hasFunctions(proxyResult)) {
        setImplAbi(proxyResult); setProxyAbi(null);
        setIsProxy(false); setAbiMode("impl"); setAbiLoaded(true);
      } else {
        setAbiLoaded(true); setTab("custom");
      }
    });
  }

  function handleRefresh() {
    if(!address||!window.electronAPI?.scanAddress) return;
    setRefreshing(true);
    window.electronAPI.scanAddress(address,chainId).then(()=>{
      if(onRescanAddresses) onRescanAddresses();
      setAbiLoaded(false); setImplAbi(null); setProxyAbi(null); setIsProxy(false);
      setSelectedMethod(null); setParams({}); setTab("write");
      const seq=++codeCheckRef.current;
      loadAbis(address,seq);
    }).finally(()=>setRefreshing(false));
  }

  // Fetch decimals() whenever a valid address is loaded
  useEffect(()=>{
    setContractDecimals(null);
    if(addrStatus!=="valid"||!address) return;
    const rpc=network?.rpcurl;
    if(!rpc||!window.electronAPI?.ethCall) return;
    let cancelled=false;
    window.electronAPI.ethCall(rpc,address,"0x313ce567").then(res=>{
      if(cancelled) return;
      if(res.result&&res.result!=="0x") {
        try {
          const d=Number(BigInt(res.result));
          if(d>=0&&d<=77) setContractDecimals(d);
        } catch {}
      }
    }).catch(()=>{});
    return ()=>{cancelled=true};
  },[addrStatus,address,network?.rpcurl]);

  function handleAddr(e) {
    const v=e.target.value; setAddress(v); setSelectedMethod(null); setParams({});
    setAbiLoaded(false); setImplAbi(null); setProxyAbi(null); setIsProxy(false);
    setTab("write"); setImplAddr(null);
    if(v.length!==42||!v.startsWith("0x")) { setAddrStatus(null); return; }
    const check=isValidAddress(v);
    if(!check.valid) { setAddrStatus({error:check.reason==="checksum"?"Checksum failed":"Invalid address"}); return; }
    const rpcUrl=network?.rpcurl;
    if(!rpcUrl||!window.electronAPI) {
      setAddrStatus("valid");
      const seq=++codeCheckRef.current;
      loadAbis(v,seq);
      return;
    }
    setAddrStatus("checking");
    const seq=++codeCheckRef.current;
    window.electronAPI.checkCode(rpcUrl,v).then(res=>{
      if(seq!==codeCheckRef.current) return;
      if(res.hasCode===false) {
        setAddrStatus({error:"Address has no contract code"});
      } else {
        setAddrStatus("valid");
        loadAbis(v,seq);
      }
    });
  }

  function selectMethod(m) {
    setSelectedMethod(m); setMethodOpen(false); setMethodFilter("");
    const p={}; m.inputs.forEach(i=>{
      if(i.type==="bool") p[i.name]="false";
      else if(i.type==="tuple"&&i.components) p[i.name]={__tuple:{},__components:i.components};
      else p[i.name]="";
    }); setParams(p);
  }

  const paramsOk=selectedMethod?allParamsValid(selectedMethod.inputs,params):true;

  function handleAdd() {
    if(!isValid||(!selectedMethod&&!customData)||!paramsOk) return;
    onAdd({
      id:Date.now().toString(), to:address,
      method:selectedMethod?selectedMethod.name:"(custom)",
      signature:selectedMethod?sigOf(selectedMethod):null,
      params:{...params}, inputs:selectedMethod?selectedMethod.inputs:[],
      ethValue:ethValue||"0", data:customData?hexData:mockEncode(),
      stateMutability:selectedMethod?.stateMutability||"nonpayable",
    });
    setSelectedMethod(null); setParams({}); setEthValue(""); setHexData("");
  }

  useEffect(()=>{
    const h=e=>{if(dropRef.current&&!dropRef.current.contains(e.target))setMethodOpen(false)};
    document.addEventListener("mousedown",h); return()=>document.removeEventListener("mousedown",h);
  },[]);
  useEffect(()=>{if(methodOpen&&filterRef.current)filterRef.current.focus()},[methodOpen]);
  useEffect(()=>{setSelectedMethod(null);setParams({});setQueryResult(null)},[abiMode,tab]);

  const inp=(extra={})=>({
    style:{
      fontFamily:F.mono,fontSize:12.5,width:"100%",boxSizing:"border-box",
      padding:"9px 12px",borderRadius:7,border:`1px solid ${C.b1}`,
      background:C.s2,color:C.t1,outline:"none",transition:"border-color 0.15s",...extra,
    },
    onFocus:e=>e.target.style.borderColor=C.acc+"55",
    onBlur:e=>e.target.style.borderColor=C.b1,
  });

  return (
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      {/* Address */}
      <div>
        <label style={{fontFamily:F.sans,fontSize:10,color:C.t4,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:5,display:"block"}}>
          Target Contract
        </label>
        <div style={{position:"relative",display:"flex",gap:6,alignItems:"center"}}>
          <div style={{flex:1,position:"relative"}}>
            <input value={address} onChange={handleAddr} placeholder="0x… or ENS name"
              {...inp(addrStatus?.error?{borderColor:C.red+"55"}:addrStatus==="valid"?{borderColor:C.acc+"33"}:{})} />
            <span style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",display:"flex",alignItems:"center",gap:4}}>
              {isValid&&<SafeTag info={getSafeInfo(addresses,address,chainId)}/>}
              {isValid&&<span style={{color:C.acc}}>{I.check(14)}</span>}
              {addrStatus==="checking"&&<span style={{color:C.t4}}>{I.spin(14)}</span>}
              {addrStatus?.error&&<span style={{color:C.red,cursor:"default",display:"flex"}} title={addrStatus.error}>{I.err(14)}</span>}
            </span>
          </div>
          <AddressBookPicker addresses={addresses} onSelect={v=>{const e={target:{value:v}};handleAddr(e)}}/>
        </div>
        {addrStatus?.error&&(
          <div style={{fontFamily:F.sans,fontSize:10,color:C.red,marginTop:2}}>{addrStatus.error}</div>
        )}
      </div>

      {/* ABI strip */}
      {abiLoaded&&<AbiStrip abi={activeAbi} isProxy={isProxy} abiMode={abiMode} setAbiMode={setAbiMode} implAddr={implAddr} onRefresh={handleRefresh} refreshing={refreshing}/>}

      {/* Tabs */}
      {abiLoaded&&(
        <div style={{display:"flex",gap:2,borderRadius:6,overflow:"hidden",border:`1px solid ${C.b1}`,background:C.s1}}>
          {TABS.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} style={{
              fontFamily:F.sans,fontSize:10,fontWeight:600,padding:"5px 14px",border:"none",cursor:"pointer",flex:1,
              background:tab===t.id?t.color+"18":"transparent",
              color:tab===t.id?t.color:C.t4,transition:"all 0.12s",
            }}>{t.label}</button>
          ))}
        </div>
      )}

      {/* Method selector */}
      {abiLoaded&&(tab==="write"||tab==="read")&&(
        <div ref={dropRef} style={{position:"relative"}}>
          <label style={{fontFamily:F.sans,fontSize:10,color:C.t4,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:5,display:"block"}}>Method</label>
          <button onClick={()=>setMethodOpen(!methodOpen)} style={{
            fontFamily:F.mono,fontSize:12,width:"100%",textAlign:"left",padding:"9px 12px",borderRadius:7,
            border:`1px solid ${C.b1}`,background:C.s2,color:selectedMethod?C.t1:C.t4,cursor:"pointer",
            display:"flex",alignItems:"center",gap:6,
          }}>
            {selectedMethod?(
              <span style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",flex:1,minWidth:0}}>
                <span style={{color:C.t1,fontWeight:600}}>{selectedMethod.name}</span>
                <ParamSignature inputs={selectedMethod.inputs}/>
                {selectedMethod.stateMutability==="payable"&&<span style={{fontFamily:F.sans,fontSize:9,color:C.warn,background:C.warnD,padding:"1px 5px",borderRadius:3}}>payable</span>}
                {selectedMethod.stateMutability==="view"&&<span style={{fontFamily:F.sans,fontSize:9,color:C.blue,background:C.blueD,padding:"1px 5px",borderRadius:3}}>view</span>}
              </span>
            ):"Select method…"}
            <span style={{marginLeft:"auto",flexShrink:0,color:C.t4}}>{I.chev(10,methodOpen?"up":"down")}</span>
          </button>

          {methodOpen&&(
            <div style={{
              position:"absolute",top:"calc(100% + 3px)",left:0,right:0,zIndex:100,
              background:C.s1,border:`1px solid ${C.b2}`,borderRadius:8,
              boxShadow:"0 12px 48px rgba(0,0,0,0.6)",overflow:"hidden",display:"flex",flexDirection:"column",maxHeight:340,
            }}>
              <div style={{padding:"8px 8px 6px",borderBottom:`1px solid ${C.b1}`}}>
                <input ref={filterRef} value={methodFilter} onChange={e=>setMethodFilter(e.target.value)} placeholder="Filter…"
                  style={{
                    fontFamily:F.mono,fontSize:11,width:"100%",boxSizing:"border-box",padding:"6px 10px",borderRadius:5,
                    border:`1px solid ${C.b1}`,background:C.s2,color:C.t1,outline:"none",
                  }}/>
              </div>
              <div style={{overflowY:"auto",flex:1}}>
                {filteredMethods.map(m=>(
                  <button key={m.name} onClick={()=>selectMethod(m)} style={{
                    width:"100%",textAlign:"left",padding:"8px 12px",border:"none",
                    borderBottom:`1px solid ${C.b1}11`,
                    background:selectedMethod?.name===m.name?C.s3:"transparent",
                    cursor:"pointer",display:"flex",flexDirection:"column",gap:2,transition:"background 0.1s",
                  }}
                    onMouseEnter={e=>e.currentTarget.style.background=C.s2}
                    onMouseLeave={e=>e.currentTarget.style.background=selectedMethod?.name===m.name?C.s3:"transparent"}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <span style={{fontFamily:F.mono,fontSize:12,color:C.t1,fontWeight:500}}>{m.name}</span>
                      {m.stateMutability==="payable"&&<span style={{fontFamily:F.sans,fontSize:9,color:C.warn,background:C.warnD,padding:"1px 5px",borderRadius:3}}>payable</span>}
                      {m.stateMutability==="view"&&<span style={{fontFamily:F.sans,fontSize:9,color:C.blue,background:C.blueD,padding:"1px 5px",borderRadius:3}}>view</span>}
                    </div>
                    <ParamSignature inputs={m.inputs} style={{fontSize:9.5}}/>
                  </button>
                ))}
                {filteredMethods.length===0&&(
                  <div style={{padding:"16px 12px",fontFamily:F.sans,fontSize:11,color:C.t4,textAlign:"center"}}>
                    No methods match "{methodFilter}"
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Events */}
      {abiLoaded&&tab==="events"&&(
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          <input value={eventFilter} onChange={e=>setEventFilter(e.target.value)} placeholder="Filter events…"
            style={{fontFamily:F.mono,fontSize:11,width:"100%",boxSizing:"border-box",padding:"7px 10px",borderRadius:6,border:`1px solid ${C.b1}`,background:C.s2,color:C.t1,outline:"none"}}/>
          <div style={{display:"flex",flexDirection:"column",gap:4,maxHeight:300,overflowY:"auto"}}>
            {filteredEvents.length===0&&(
              <div style={{fontFamily:F.sans,fontSize:11,color:C.t4,textAlign:"center",padding:16}}>
                {events.length===0?"No events in ABI":"No events match filter"}
              </div>
            )}
            {filteredEvents.map(ev=>(
              <div key={ev.name} style={{background:C.s1,border:`1px solid ${C.b1}`,borderRadius:7,padding:"8px 12px"}}>
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:ev.inputs?.length?4:0}}>
                  <span style={{fontFamily:F.mono,fontSize:11.5,color:C.purple,fontWeight:600}}>{ev.name}</span>
                </div>
                {ev.inputs?.length>0&&(
                  <div style={{display:"flex",flexWrap:"wrap",gap:"2px 8px"}}>
                    {ev.inputs.map((inp,j)=>(
                      <span key={j} style={{fontFamily:F.mono,fontSize:10,display:"inline-flex",alignItems:"center",gap:3}}>
                        {inp.indexed&&<span style={{fontFamily:F.sans,fontSize:8,color:C.warn,background:C.warnD,padding:"0px 4px",borderRadius:2}}>indexed</span>}
                        <span style={{color:C.t3}}>{inp.name}</span>
                        <TypeBadge type={inp.type}/>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Params */}
      {selectedMethod&&(tab==="write"||tab==="read")&&(
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {selectedMethod.inputs.map(ip=>(
            <div key={ip.name}>
              <ParamInput ip={ip} value={params[ip.name]} onChange={v=>setParams({...params,[ip.name]:v})}
                inp={inp} addresses={addresses} chainId={chainId} decimals={contractDecimals}/>
            </div>
          ))}
          {selectedMethod.stateMutability==="payable"&&(
            <div>
              <label style={{fontFamily:F.sans,fontSize:10,color:C.warn,marginBottom:4,display:"flex",alignItems:"center",gap:5}}>
                ETH value <span style={{fontSize:9,color:C.t4}}>(payable)</span>
              </label>
              <input value={ethValue} onChange={e=>setEthValue(e.target.value)} placeholder="0.0"
                {...inp({borderColor:C.warn+"33",background:C.warnD})}/>
            </div>
          )}
        </div>
      )}

      {/* Custom data */}
      {tab==="custom"&&abiLoaded&&(
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <div>
            <label style={{fontFamily:F.sans,fontSize:10,color:C.t4,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:5,display:"block"}}>ETH Value</label>
            <input value={ethValue} onChange={e=>setEthValue(e.target.value)} placeholder="0" {...inp()}/>
          </div>
          <div>
            <label style={{fontFamily:F.sans,fontSize:10,color:C.t4,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:5,display:"block"}}>Data (hex)</label>
            <textarea value={hexData} onChange={e=>setHexData(e.target.value)} placeholder="0x…" rows={3}
              style={{fontFamily:F.mono,fontSize:11,width:"100%",boxSizing:"border-box",padding:"9px 12px",borderRadius:7,border:`1px solid ${C.b1}`,background:C.s2,color:C.t1,outline:"none",resize:"vertical"}}/>
          </div>
        </div>
      )}

      {/* Action buttons */}
      {tab==="write"&&(()=>{const canAdd=isValid&&(selectedMethod?paramsOk:customData);return(
        <button onClick={handleAdd} disabled={!canAdd} style={{
          fontFamily:F.sans,fontSize:12.5,fontWeight:600,padding:"10px 0",borderRadius:7,border:"none",width:"100%",
          background:canAdd?C.acc:C.s3,color:canAdd?C.bg:C.t4,cursor:canAdd?"pointer":"not-allowed",
          display:"flex",alignItems:"center",justifyContent:"center",gap:7,transition:"all 0.15s",
        }}>{I.plus(13)} Add to Batch</button>)})()}

      {tab==="custom"&&(()=>{const canAdd=isValid&&customData;return(
        <button onClick={handleAdd} disabled={!canAdd} style={{
          fontFamily:F.sans,fontSize:12.5,fontWeight:600,padding:"10px 0",borderRadius:7,border:"none",width:"100%",
          background:canAdd?C.acc:C.s3,color:canAdd?C.bg:C.t4,cursor:canAdd?"pointer":"not-allowed",
          display:"flex",alignItems:"center",justifyContent:"center",gap:7,transition:"all 0.15s",
        }}>{I.plus(13)} Add to Batch</button>)})()}

      {tab==="read"&&(
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {(()=>{const canQuery=isValid&&selectedMethod&&paramsOk&&network?.rpcurl;return(
            <button onClick={()=>{
              if(!canQuery) return;
              setQueryResult({loading:true});
              const data=encodeCalldata(selectedMethod,params);
              window.electronAPI.ethCall(network.rpcurl,address,data).then(res=>{
                if(res.error) setQueryResult({error:res.error});
                else setQueryResult({data:res.result,outputs:selectedMethod.outputs});
              }).catch(e=>setQueryResult({error:e.message}));
            }} disabled={!canQuery} style={{
              fontFamily:F.sans,fontSize:12.5,fontWeight:600,padding:"10px 0",borderRadius:7,border:"none",width:"100%",
              background:canQuery?C.blue:C.s3,color:canQuery?"#fff":C.t4,cursor:canQuery?"pointer":"not-allowed",
              display:"flex",alignItems:"center",justifyContent:"center",gap:7,transition:"all 0.15s",
            }}>{I.play(13)} Query</button>)})()}
          {queryResult?.loading&&(
            <div style={{fontFamily:F.mono,fontSize:11,color:C.t4,textAlign:"center",padding:8}}>{I.spin(14)} Querying…</div>
          )}
          {queryResult?.error&&(
            <div style={{background:C.redD,border:`1px solid ${C.red}33`,borderRadius:7,padding:"10px 12px"}}>
              <div style={{fontFamily:F.sans,fontSize:10,fontWeight:600,color:C.red,marginBottom:4}}>Error</div>
              <div style={{fontFamily:F.mono,fontSize:10.5,color:C.t2,wordBreak:"break-all"}}>{queryResult.error}</div>
            </div>
          )}
          {queryResult?.data&&(
            <div style={{background:C.blueD,border:`1px solid ${C.blue}33`,borderRadius:7,padding:"10px 12px"}}>
              <div style={{fontFamily:F.sans,fontSize:10,fontWeight:600,color:C.blue,marginBottom:4}}>
                Result{queryResult.outputs?.length>0&&` (${queryResult.outputs.map(o=>o.type).join(", ")})`}
              </div>
              <div style={{fontFamily:F.mono,fontSize:10.5,color:C.t1,wordBreak:"break-all",background:C.bg,padding:"6px 8px",borderRadius:5,maxHeight:120,overflowY:"auto"}}>
                {queryResult.data}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Batch Row ──
function CopyVal({label,badge,value,color=C.t1,span,mono,bg}) {
  const [c,setC]=useState(false);
  const copy=e=>{e.stopPropagation();navigator.clipboard?.writeText(value);setC(true);setTimeout(()=>setC(false),1200)};
  return (
    <div style={span?{gridColumn:"1 / -1"}:{}}>
      <div style={{fontFamily:F.sans,fontSize:9,color:C.t4,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:2,display:"flex",alignItems:"center",gap:4}}>
        {label} {badge&&<TypeBadge type={badge}/>}
      </div>
      <div onClick={copy} title="Click to copy" style={{
        fontFamily:F.mono,fontSize:mono?9.5:10.5,color:c?C.acc:color,wordBreak:"break-all",cursor:"pointer",
        transition:"color 0.15s",maxHeight:bg?50:undefined,overflow:bg?"auto":undefined,
        ...(bg?{background:C.bg,padding:"6px 8px",borderRadius:5}:{}),
      }}>{c?"Copied!":value}</div>
    </div>
  );
}

function TxRow({tx,i,total,onRemove,onUp,onDown,expanded,onToggle,onDragStart,onDragOver,onDragEnd,onDrop,isDragOver,dragOverPos,isDragging,locked=false}) {
  const rowRef=useRef(null);

  const handleDragOver=e=>{
    e.preventDefault();
    e.dataTransfer.dropEffect="move";
    if(rowRef.current){
      const rect=rowRef.current.getBoundingClientRect();
      const midY=rect.top+rect.height/2;
      onDragOver(i,e.clientY<midY?"above":"below");
    }
  };

  return (
    <div ref={rowRef} style={{position:"relative"}}
      onDragOver={handleDragOver}
      onDrop={e=>{e.preventDefault();onDrop(i)}}
    >
      {/* Drop indicator line — above */}
      {isDragOver&&dragOverPos==="above"&&(
        <div style={{position:"absolute",top:-3,left:0,right:0,height:2,background:C.acc,borderRadius:1,zIndex:10,boxShadow:`0 0 8px ${C.acc}66`}}/>
      )}
    <div
      draggable={!locked}
      onDragStart={locked?undefined:e=>{
        e.dataTransfer.effectAllowed="move";
        e.dataTransfer.setData("text/plain",i.toString());
        onDragStart(i);
      }}
      onDragEnd={locked?undefined:onDragEnd}
      style={{
        background:C.s1,border:`1px solid ${isDragging?C.acc+"44":C.b1}`,borderRadius:8,overflow:"hidden",
        transition:"border-color 0.15s, opacity 0.2s, transform 0.15s",
        opacity:isDragging?0.4:1,
        transform:isDragging?"scale(0.98)":"scale(1)",
      }}
      onMouseEnter={e=>{if(!isDragging)e.currentTarget.style.borderColor=C.b2}}
      onMouseLeave={e=>{if(!isDragging)e.currentTarget.style.borderColor=C.b1}}>
      <div onClick={onToggle} style={{display:"flex",alignItems:"flex-start",gap:8,padding:"9px 12px",cursor:"pointer",userSelect:"none"}}>
        {!locked&&<span style={{color:C.t4,marginTop:2,display:"flex",cursor:"grab"}}
          onMouseDown={e=>e.currentTarget.style.cursor="grabbing"}
          onMouseUp={e=>e.currentTarget.style.cursor="grab"}
        >{I.grip()}</span>}
        <span style={{fontFamily:F.mono,fontSize:10,fontWeight:700,color:C.bg,background:C.acc,borderRadius:4,padding:"2px 6px",minWidth:16,textAlign:"center",marginTop:1}}>{i+1}</span>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
            <span style={{fontFamily:F.mono,fontSize:11,color:C.t3}}>{shorten(tx.to)}</span>
            <span style={{fontFamily:F.mono,fontSize:11.5,color:C.t1,fontWeight:600}}>{tx.method}</span>
            {tx.stateMutability==="payable"&&tx.ethValue!=="0"&&(
              <span style={{fontFamily:F.mono,fontSize:9.5,color:C.warn,background:C.warnD,padding:"1px 5px",borderRadius:3}}>{tx.ethValue} ETH</span>
            )}
          </div>
          {/* Inline params preview */}
          {tx.inputs&&tx.inputs.length>0&&(
            <div style={{marginTop:3,display:"flex",flexWrap:"wrap",gap:"2px 10px"}}>
              {tx.inputs.map((inp,j)=>(
                <span key={j} style={{fontFamily:F.mono,fontSize:10,color:C.t4}}>
                  <span style={{color:C.t3}}>{inp.name}</span>
                  <span style={{color:C.t4}}>{"="}</span>
                  <span style={{color:tx.params[inp.name]?C.t2:C.t4}}>{tx.params[inp.name]||"∅"}</span>
                </span>
              ))}
            </div>
          )}
        </div>
        <div style={{display:"flex",gap:1,alignItems:"center",flexShrink:0,marginTop:1}}>
          {!locked&&[{fn:onUp,dis:i===0,d:"up"},{fn:onDown,dis:i===total-1,d:"down"}].map((b,k)=>(
            <button key={k} onClick={e=>{e.stopPropagation();b.fn()}} disabled={b.dis}
              style={{background:"none",border:"none",color:b.dis?C.t4+"33":C.t4,cursor:b.dis?"default":"pointer",padding:3,borderRadius:3}}>
              {I.chev(10,b.d)}
            </button>
          ))}
          {!locked&&<button onClick={e=>{e.stopPropagation();onRemove()}}
            style={{background:"none",border:"none",color:C.red,cursor:"pointer",padding:3,borderRadius:3,opacity:0.5}}>
            {I.trash(11)}
          </button>}
          <span style={{color:C.t4,marginLeft:2}}>{I.chev(10,expanded?"up":"down")}</span>
        </div>
      </div>
      {expanded&&(
        <div style={{borderTop:`1px solid ${C.b1}`,padding:"10px 12px 10px 42px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px 16px"}}>
          <CopyVal label="To" value={tx.to} color={C.t2}/>
          {tx.signature&&<CopyVal label="Signature" value={tx.signature} color={C.blue}/>}
          {tx.inputs.map(inp=>(
            <CopyVal key={inp.name} label={inp.name} badge={inp.type} value={tx.params[inp.name]||"—"} color={C.t1}/>
          ))}
          <CopyVal label="Calldata" value={tx.data} color={C.t4} span mono bg/>
        </div>
      )}
    </div>
      {/* Drop indicator line — below */}
      {isDragOver&&dragOverPos==="below"&&(
        <div style={{position:"absolute",bottom:-3,left:0,right:0,height:2,background:C.acc,borderRadius:1,zIndex:10,boxShadow:`0 0 8px ${C.acc}66`}}/>
      )}
    </div>
  );
}

// ── Settings Screen ──
function hexToBytes(hex) {
  const bytes=new Uint8Array(hex.length/2);
  for(let i=0;i<hex.length;i+=2) bytes[i/2]=parseInt(hex.substr(i,2),16);
  return bytes;
}
function deriveAddress(privKeyHex) {
  try {
    const bare=privKeyHex.replace(/^0x/i,"").toLowerCase();
    if(!/^[0-9a-f]{64}$/.test(bare)) return null;
    const pub=secp256k1.getPublicKey(hexToBytes(bare),false);
    const hash=keccak256(pub.slice(1));
    return toChecksumAddress("0x"+hash.slice(-40));
  } catch { return null; }
}

function KeyInput({index,value,onChange}) {
  const [show,setShow]=useState(false);
  const addr=value?deriveAddress(value):null;
  const hasVal=value&&value.length>0;
  const isInvalid=hasVal&&!addr;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:4}}>
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        <span style={{fontFamily:F.mono,fontSize:10,color:C.t4,minWidth:18,textAlign:"right"}}>{index+1}</span>
        <div style={{flex:1,position:"relative"}}>
          <input value={value||""} onChange={e=>onChange(e.target.value)}
            type={show?"text":"password"} placeholder="Private key (hex)" autoComplete="off"
            style={{
              fontFamily:F.mono,fontSize:12,width:"100%",boxSizing:"border-box",
              padding:"9px 40px 9px 12px",borderRadius:7,
              border:`1px solid ${isInvalid?C.red+"55":addr?C.acc+"33":C.b1}`,
              background:C.s2,color:C.t1,outline:"none",transition:"border-color 0.15s",
            }}/>
          <button onClick={()=>setShow(!show)} style={{
            position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",
            background:"none",border:"none",color:C.t4,cursor:"pointer",padding:2,display:"flex",
          }}>{show?I.eyeOff(13):I.eye(13)}</button>
        </div>
      </div>
      {addr&&(
        <div style={{marginLeft:26,display:"flex",alignItems:"center",gap:5}}>
          <span style={{fontFamily:F.mono,fontSize:10.5,color:C.t2}}>{addr}</span>
          <span style={{color:C.acc,display:"flex"}}>{I.check(10)}</span>
        </div>
      )}
      {isInvalid&&(
        <div style={{marginLeft:26,fontFamily:F.sans,fontSize:10,color:C.red}}>Invalid private key</div>
      )}
    </div>
  );
}

// Settings-screen section: cached Trezor accounts. Users import accounts here
// once, optionally verify them on the device, and from then on the signing
// screen renders these instantly without touching the Trezor.
function TrezorAccountsSection({settings,setSettings,trezorMode}) {
  const imported=Array.isArray(settings.trezorAccounts)?settings.trezorAccounts:[];
  const [discover,setDiscover]=useState(false);
  const [discoverAccounts,setDiscoverAccounts]=useState([]); // [{address,path}]
  const [connecting,setConnecting]=useState(false);
  const [loadingMore,setLoadingMore]=useState(false);
  const [err,setErr]=useState(null);
  const [verifying,setVerifying]=useState({}); // address -> bool
  const [busy,setBusy]=useState(null); // status text

  const importedSet=useMemo(()=>new Set(imported.map(a=>a.address.toLowerCase())),[imported]);

  const updateAccount=(addr,patch)=>{
    const next=imported.map(a=>a.address.toLowerCase()===addr.toLowerCase()?{...a,...patch}:a);
    setSettings({...settings,trezorAccounts:next});
  };
  const removeAccount=(addr)=>{
    const next=imported.filter(a=>a.address.toLowerCase()!==addr.toLowerCase());
    setSettings({...settings,trezorAccounts:next});
  };
  const importAccount=(acc)=>{
    if(importedSet.has(acc.address.toLowerCase())) return;
    const next=[...imported,{address:acc.address,path:acc.path,verified:false,importedAt:Date.now()}];
    setSettings({...settings,trezorAccounts:next});
  };

  const connect=async()=>{
    setConnecting(true); setErr(null); setBusy("Connecting to Trezor…");
    try {
      const init=await trezorWrap.init(trezorMode);
      if(init.error){setErr(init.error);return}
      setBusy("Loading accounts…");
      const res=await trezorWrap.listAccounts(trezorMode,{count:5,startIndex:0});
      if(res.error){setErr(res.error);return}
      setDiscoverAccounts(res.accounts||[]);
      setDiscover(true);
    } catch(e) { setErr(e?.message||String(e)); }
    finally { setConnecting(false); setBusy(null); }
  };

  const loadMore=async()=>{
    setLoadingMore(true);
    try {
      const res=await trezorWrap.listAccounts(trezorMode,{count:5,startIndex:discoverAccounts.length});
      if(res.error){setErr(res.error);return}
      setDiscoverAccounts(prev=>[...prev,...(res.accounts||[])]);
    } finally { setLoadingMore(false); }
  };

  const disconnect=async()=>{
    try { await trezorWrap.dispose(trezorMode); } catch {}
    setDiscover(false); setDiscoverAccounts([]); setErr(null);
  };

  const verifyImported=async(acc)=>{
    if(verifying[acc.address]) return;
    setVerifying(v=>({...v,[acc.address]:true})); setErr(null); setBusy("Confirm address on Trezor…");
    try {
      const init=await trezorWrap.init(trezorMode);
      if(init.error){setErr(init.error);return}
      const res=await trezorWrap.verifyAddress(trezorMode,{path:acc.path});
      if(res.error){setErr(res.error);return}
      if(res.address&&res.address.toLowerCase()===acc.address.toLowerCase()) {
        updateAccount(acc.address,{verified:true,verifiedAt:Date.now()});
      } else {
        setErr("Device returned a different address — not verified");
      }
    } finally {
      setVerifying(v=>({...v,[acc.address]:false}));
      setBusy(null);
    }
  };

  const verifyDuringDiscover=async(acc)=>{
    if(verifying[acc.address]) return;
    setVerifying(v=>({...v,[acc.address]:true})); setErr(null); setBusy("Confirm address on Trezor…");
    try {
      const res=await trezorWrap.verifyAddress(trezorMode,{path:acc.path});
      if(res.error){setErr(res.error);return}
      if(res.address&&res.address.toLowerCase()===acc.address.toLowerCase()) {
        // If already imported, persist verified; otherwise import-and-verify in one go.
        if(importedSet.has(acc.address.toLowerCase())) {
          updateAccount(acc.address,{verified:true,verifiedAt:Date.now()});
        } else {
          const next=[...imported,{address:acc.address,path:acc.path,verified:true,importedAt:Date.now(),verifiedAt:Date.now()}];
          setSettings({...settings,trezorAccounts:next});
        }
      } else {
        setErr("Device returned a different address — not verified");
      }
    } finally {
      setVerifying(v=>({...v,[acc.address]:false}));
      setBusy(null);
    }
  };

  return (
    <div style={{marginBottom:32}}>
      <div style={{fontSize:14,fontWeight:600,color:C.t1,marginBottom:4}}>Trezor Accounts</div>
      <div style={{fontFamily:F.sans,fontSize:11,color:C.t4,marginBottom:12}}>
        Imported accounts appear instantly on the signing screen. Verifying confirms the address shown here matches what the device displays.
      </div>

      {imported.length===0&&!discover&&(
        <div style={{fontFamily:F.sans,fontSize:11,color:C.t4,padding:"10px 12px",background:C.s2,border:`1px solid ${C.b1}`,borderRadius:7,marginBottom:10}}>
          No Trezor accounts imported yet.
        </div>
      )}

      {imported.length>0&&(
        <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:12}}>
          {imported.map(acc=>{
            const isVerifying=!!verifying[acc.address];
            return (
              <div key={acc.address} style={{
                display:"flex",alignItems:"center",gap:8,padding:"7px 10px",background:C.s2,
                border:`1px solid ${C.b1}`,borderRadius:6,
              }}>
                <span style={{fontFamily:F.mono,fontSize:11,color:C.t1}}>{acc.address}</span>
                <span style={{fontFamily:F.mono,fontSize:9,color:C.t4}}>{acc.path}</span>
                <span style={{flex:1}}/>
                {acc.verified?(
                  <span title={acc.verifiedAt?`Verified ${new Date(acc.verifiedAt).toLocaleDateString()}`:"Verified"}
                    style={{display:"flex",alignItems:"center",gap:3,fontFamily:F.sans,fontSize:9,fontWeight:600,
                      color:C.acc,background:C.accD,padding:"2px 7px",borderRadius:3}}>
                    {I.check(10)} Verified
                  </span>
                ):(
                  <button onClick={()=>verifyImported(acc)} disabled={isVerifying} style={{
                    background:"transparent",border:`1px solid ${C.b1}`,borderRadius:4,
                    color:C.t3,padding:"3px 8px",cursor:isVerifying?"wait":"pointer",
                    display:"flex",alignItems:"center",gap:3,fontFamily:F.sans,fontSize:9.5,fontWeight:500,
                  }}>{isVerifying?I.spin(9):I.eye(9)} {isVerifying?"Confirm…":"Verify"}</button>
                )}
                <button onClick={()=>removeAccount(acc.address)} title="Remove from imported list" style={{
                  background:"transparent",border:"none",color:C.t4,cursor:"pointer",
                  padding:3,display:"flex",borderRadius:4,
                }}
                  onMouseEnter={e=>{e.currentTarget.style.color=C.red;e.currentTarget.style.background=C.redD}}
                  onMouseLeave={e=>{e.currentTarget.style.color=C.t4;e.currentTarget.style.background="transparent"}}
                >{I.x(11)}</button>
              </div>
            );
          })}
        </div>
      )}

      {!discover&&(
        <button onClick={connect} disabled={connecting} style={{
          fontFamily:F.sans,fontSize:11,fontWeight:600,padding:"7px 14px",borderRadius:6,
          border:`1px solid ${connecting?C.b1:C.acc+"55"}`,background:connecting?C.s2:C.accD,
          color:connecting?C.t4:C.acc,cursor:connecting?"wait":"pointer",
          display:"flex",alignItems:"center",gap:6,
        }}>
          {connecting?I.spin(12):I.plus(12)}
          {connecting?"Connecting…":"Import from Trezor"}
        </button>
      )}

      {discover&&(
        <div style={{marginTop:4,padding:"10px 12px",background:C.s2,border:`1px solid ${C.b1}`,borderRadius:7}}>
          <div style={{fontFamily:F.sans,fontSize:10,color:C.t4,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>
            Device accounts
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:4}}>
            {discoverAccounts.map(acc=>{
              const already=importedSet.has(acc.address.toLowerCase());
              const isVerifying=!!verifying[acc.address];
              return (
                <div key={acc.path} style={{
                  display:"flex",alignItems:"center",gap:8,padding:"6px 10px",background:C.s1,
                  border:`1px solid ${C.b1}`,borderRadius:5,
                }}>
                  <span style={{fontFamily:F.mono,fontSize:10.5,color:C.t1}}>{acc.address}</span>
                  <span style={{fontFamily:F.mono,fontSize:9,color:C.t4}}>{acc.path}</span>
                  <span style={{flex:1}}/>
                  <button onClick={()=>verifyDuringDiscover(acc)} disabled={isVerifying} style={{
                    background:"transparent",border:`1px solid ${C.b1}`,borderRadius:4,color:C.t3,
                    padding:"3px 7px",cursor:isVerifying?"wait":"pointer",
                    display:"flex",alignItems:"center",gap:3,fontFamily:F.sans,fontSize:9,fontWeight:500,
                  }}>{isVerifying?I.spin(9):I.eye(9)} {isVerifying?"Confirm…":"Verify"}</button>
                  {already?(
                    <span style={{fontFamily:F.sans,fontSize:9,color:C.t4}}>imported</span>
                  ):(
                    <button onClick={()=>importAccount(acc)} style={{
                      background:C.accD,border:`1px solid ${C.acc+"55"}`,borderRadius:4,color:C.acc,
                      padding:"3px 7px",cursor:"pointer",display:"flex",alignItems:"center",gap:3,
                      fontFamily:F.sans,fontSize:9,fontWeight:600,
                    }}>{I.plus(9)} Import</button>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{display:"flex",gap:6,marginTop:8}}>
            <button onClick={loadMore} disabled={loadingMore} style={{
              fontFamily:F.sans,fontSize:10,fontWeight:500,padding:"5px 10px",borderRadius:5,
              border:`1px solid ${C.b1}`,background:"transparent",color:loadingMore?C.t4:C.t3,
              cursor:loadingMore?"wait":"pointer",display:"flex",alignItems:"center",gap:4,
            }}>{loadingMore?I.spin(10):I.plus(10)} Load 5 more</button>
            <button onClick={disconnect} style={{
              fontFamily:F.sans,fontSize:10,fontWeight:500,padding:"5px 10px",borderRadius:5,
              border:`1px solid ${C.b1}`,background:"transparent",color:C.t3,cursor:"pointer",
            }}>Done</button>
          </div>
        </div>
      )}

      {busy&&(
        <div style={{marginTop:8,fontFamily:F.sans,fontSize:10.5,color:C.acc,
          padding:"6px 10px",background:C.accD,borderRadius:5,display:"flex",alignItems:"center",gap:6}}>
          {I.spin(11)} {busy}
        </div>
      )}
      {err&&(
        <div style={{marginTop:8,fontFamily:F.sans,fontSize:10.5,color:C.red,
          padding:"6px 10px",background:C.redD,borderRadius:5}}>{err}</div>
      )}
    </div>
  );
}

function SettingsScreen({onBack,settings,setSettings,rateLimit}) {
  const {apiKey="",safeApiKey="",keys=[],trezorMode="usb"}=settings;

  const updateKey=(i,v)=>{
    const k=[...keys];k[i]=v;
    setSettings({...settings,keys:k});
  };

  const TrezorModeCard=({id,title,subtitle,detail})=>{
    const active=trezorMode===id;
    return (
      <button onClick={()=>setSettings({...settings,trezorMode:id})}
        style={{
          textAlign:"left",cursor:"pointer",padding:"14px 16px",borderRadius:9,
          border:`1.5px solid ${active?C.acc:C.b1}`,
          background:active?C.accD:C.s2,
          display:"flex",flexDirection:"column",gap:6,outline:"none",
          transition:"border-color 0.12s, background 0.12s",
        }}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{
            width:14,height:14,borderRadius:"50%",
            border:`2px solid ${active?C.acc:C.b1}`,
            display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,
          }}>
            {active&&<span style={{width:6,height:6,borderRadius:"50%",background:C.acc}}/>}
          </span>
          <span style={{fontFamily:F.sans,fontSize:13,fontWeight:600,color:active?C.acc:C.t1}}>{title}</span>
        </div>
        <div style={{fontFamily:F.sans,fontSize:11,color:C.t2,lineHeight:1.4}}>{subtitle}</div>
        {detail&&<div style={{fontFamily:F.sans,fontSize:10,color:C.t4,lineHeight:1.4}}>{detail}</div>}
      </button>
    );
  };

  return (
    <div style={{fontFamily:F.sans,background:C.bg,height:"100vh",color:C.t1,display:"flex",flexDirection:"column"}}>
      {/* Header */}
      <div style={{height:44,borderBottom:`1px solid ${C.b1}`,display:"flex",alignItems:"center",padding:"0 16px",gap:12,flexShrink:0,background:C.s1+"88"}}>
        <button onClick={onBack} style={{
          background:"none",border:"none",color:C.t2,cursor:"pointer",display:"flex",alignItems:"center",gap:4,
          fontFamily:F.sans,fontSize:12,fontWeight:500,padding:"4px 8px",borderRadius:5,
        }}
          onMouseEnter={e=>e.currentTarget.style.color=C.t1}
          onMouseLeave={e=>e.currentTarget.style.color=C.t2}
        >{I.back(14)} Back</button>
        <div style={{width:1,height:18,background:C.b1}}/>
        <span style={{fontFamily:F.mono,fontWeight:800,fontSize:12.5,color:C.acc,letterSpacing:"0.04em"}}>TX·BUILDER</span>
        <span style={{fontFamily:F.sans,fontSize:12,color:C.t3,fontWeight:500}}>Settings</span>
      </div>

      {/* Content */}
      <div style={{flex:1,overflowY:"auto",padding:24}}>
        <div style={{maxWidth:600}}>
          {/* API Key */}
          <div style={{marginBottom:32}}>
            <div style={{fontSize:14,fontWeight:600,color:C.t1,marginBottom:4}}>Etherscan API Key</div>
            <div style={{fontFamily:F.sans,fontSize:11,color:C.t4,marginBottom:10}}>Used for fetching contract ABIs and verification data</div>
            {(()=>{
              const [showApi,setShowApi]=useState(false);
              return (
                <div style={{position:"relative",maxWidth:460}}>
                  <input value={apiKey} onChange={e=>setSettings({...settings,apiKey:e.target.value})}
                    type={showApi?"text":"password"} placeholder="Enter Etherscan API key" autoComplete="off"
                    style={{
                      fontFamily:F.mono,fontSize:12,width:"100%",boxSizing:"border-box",
                      padding:"9px 40px 9px 12px",borderRadius:7,
                      border:`1px solid ${apiKey?C.acc+"33":C.b1}`,
                      background:C.s2,color:C.t1,outline:"none",transition:"border-color 0.15s",
                    }}/>
                  <button onClick={()=>setShowApi(!showApi)} style={{
                    position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",
                    background:"none",border:"none",color:C.t4,cursor:"pointer",padding:2,display:"flex",
                  }}>{showApi?I.eyeOff(13):I.eye(13)}</button>
                </div>
              );
            })()}
          </div>

          {/* Safe API Key */}
          <div style={{marginBottom:32}}>
            <div style={{fontSize:14,fontWeight:600,color:C.t1,marginBottom:4}}>Safe API Key</div>
            <div style={{fontFamily:F.sans,fontSize:11,color:C.t4,marginBottom:10}}>Used for proposing and signing transactions via the Safe Transaction Service</div>
            {(()=>{
              const [showSafe,setShowSafe]=useState(false);
              return (
                <div style={{position:"relative",maxWidth:460}}>
                  <input value={safeApiKey} onChange={e=>setSettings({...settings,safeApiKey:e.target.value})}
                    type={showSafe?"text":"password"} placeholder="Enter Safe API key" autoComplete="off"
                    style={{
                      fontFamily:F.mono,fontSize:12,width:"100%",boxSizing:"border-box",
                      padding:"9px 40px 9px 12px",borderRadius:7,
                      border:`1px solid ${safeApiKey?C.acc+"33":C.b1}`,
                      background:C.s2,color:C.t1,outline:"none",transition:"border-color 0.15s",
                    }}/>
                  <button onClick={()=>setShowSafe(!showSafe)} style={{
                    position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",
                    background:"none",border:"none",color:C.t4,cursor:"pointer",padding:2,display:"flex",
                  }}>{showSafe?I.eyeOff(13):I.eye(13)}</button>
                </div>
              );
            })()}
          </div>

          {/* Trezor Mode */}
          <div style={{marginBottom:32}}>
            <div style={{fontSize:14,fontWeight:600,color:C.t1,marginBottom:4}}>Trezor Connection Mode</div>
            <div style={{fontFamily:F.sans,fontSize:11,color:C.t4,marginBottom:12}}>How TX Builder talks to your Trezor device when signing</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <TrezorModeCard id="usb"
                title="Direct USB I/O"
                subtitle="Native, fast. No popup, no extra software needed."
                detail="Linux requires the standard Trezor udev rule (50-trezor.rules) installed."/>
              <TrezorModeCard id="web"
                title="Trezor Suite / Web"
                subtitle="Uses Trezor Suite locally if it's running; otherwise opens a popup from trezor.io."
                detail="Most compatible. Falls back to the hosted popup which needs internet access."/>
            </div>
          </div>

          {/* Trezor Accounts */}
          <TrezorAccountsSection settings={settings} setSettings={setSettings} trezorMode={trezorMode}/>

          {/* Signing Keys */}
          <div>
            <div style={{fontSize:14,fontWeight:600,color:C.t1,marginBottom:4}}>Signing Keys</div>
            <div style={{fontFamily:F.sans,fontSize:11,color:C.t4,marginBottom:12}}>Private keys for signing transactions. The derived address is shown for each valid key.</div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {Array.from({length:10},(_, i)=>(
                <KeyInput key={i} index={i} value={keys[i]||""} onChange={v=>updateKey(i,v)}/>
              ))}
            </div>
          </div>
        </div>
      </div>
      <RateBar rateLimit={rateLimit}/>
    </div>
  );
}

// ── Safe API Tab ──
// Reusable tx detail display
function SafeTxDetail({tx,addrName,owners,threshold}) {
  return (
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px 14px"}}>
        <div>
          <div style={{fontFamily:F.sans,fontSize:9,color:C.t4,textTransform:"uppercase",marginBottom:1}}>To</div>
          <div style={{fontFamily:F.mono,fontSize:10,color:C.t2,wordBreak:"break-all"}}>{tx.to}</div>
        </div>
        <div>
          <div style={{fontFamily:F.sans,fontSize:9,color:C.t4,textTransform:"uppercase",marginBottom:1}}>Safe TX Hash</div>
          <div style={{fontFamily:F.mono,fontSize:9.5,color:C.t3,wordBreak:"break-all"}}>{tx.safeTxHash}</div>
        </div>
        {tx.dataDecoded&&(
          <div style={{gridColumn:"1 / -1"}}>
            <div style={{fontFamily:F.sans,fontSize:9,color:C.t4,textTransform:"uppercase",marginBottom:1}}>Method</div>
            <div style={{fontFamily:F.mono,fontSize:10.5,color:C.blue}}>{tx.dataDecoded.method}({tx.dataDecoded.parameters?.map(p=>p.type).join(", ")||""})</div>
          </div>
        )}
        {tx.dataDecoded?.parameters?.map((p,pi)=>(
          <div key={pi}>
            <div style={{fontFamily:F.sans,fontSize:9,color:C.t4,textTransform:"uppercase",marginBottom:1,display:"flex",gap:4,alignItems:"center"}}>
              {p.name} <TypeBadge type={p.type}/>
            </div>
            <div style={{fontFamily:F.mono,fontSize:10,color:C.t1,wordBreak:"break-all"}}>{String(p.value)}</div>
          </div>
        ))}
        {tx.data&&tx.data!=="0x"&&!tx.dataDecoded&&(
          <div style={{gridColumn:"1 / -1"}}>
            <div style={{fontFamily:F.sans,fontSize:9,color:C.t4,textTransform:"uppercase",marginBottom:1}}>Calldata</div>
            <div style={{fontFamily:F.mono,fontSize:9,color:C.t4,background:C.bg,padding:"4px 8px",borderRadius:4,wordBreak:"break-all",maxHeight:40,overflow:"auto"}}>{tx.data}</div>
          </div>
        )}
        {tx.executionDate&&(
          <div>
            <div style={{fontFamily:F.sans,fontSize:9,color:C.t4,textTransform:"uppercase",marginBottom:1}}>Executed</div>
            <div style={{fontFamily:F.sans,fontSize:10,color:C.t2}}>{new Date(tx.executionDate).toLocaleString()}</div>
          </div>
        )}
        {tx.executor&&(
          <div>
            <div style={{fontFamily:F.sans,fontSize:9,color:C.t4,textTransform:"uppercase",marginBottom:1}}>Executor</div>
            <div style={{fontFamily:F.mono,fontSize:10,color:C.t2}}>{shorten(tx.executor)}{addrName(tx.executor)?` (${addrName(tx.executor)})`:""}</div>
          </div>
        )}
        {tx.transactionHash&&(
          <div style={{gridColumn:"1 / -1"}}>
            <div style={{fontFamily:F.sans,fontSize:9,color:C.t4,textTransform:"uppercase",marginBottom:1}}>Ethereum TX</div>
            <div style={{fontFamily:F.mono,fontSize:9.5,color:C.t3,wordBreak:"break-all"}}>{tx.transactionHash}</div>
          </div>
        )}
        {tx.blockNumber!=null&&(
          <div>
            <div style={{fontFamily:F.sans,fontSize:9,color:C.t4,textTransform:"uppercase",marginBottom:1}}>Block</div>
            <div style={{fontFamily:F.mono,fontSize:10,color:C.t2}}>{tx.blockNumber}</div>
          </div>
        )}
      </div>
      <div>
        <div style={{fontFamily:F.sans,fontSize:9,color:C.t4,textTransform:"uppercase",marginBottom:4}}>Confirmations</div>
        <div style={{display:"flex",flexDirection:"column",gap:3}}>
          {(tx.confirmations||[]).map((c,ci)=>{
            const name=addrName(c.owner);
            return (
              <div key={ci} style={{display:"flex",alignItems:"center",gap:6,padding:"4px 8px",background:C.bg,borderRadius:4}}>
                <span style={{color:C.acc,display:"flex"}}>{I.check(10)}</span>
                <span style={{fontFamily:F.mono,fontSize:10,color:C.t2}}>{shorten(c.owner)}</span>
                {name&&<span style={{fontFamily:F.sans,fontSize:9,color:C.purple,background:C.purpleD,padding:"1px 5px",borderRadius:3}}>{name}</span>}
                <span style={{fontFamily:F.sans,fontSize:9,color:C.t4,marginLeft:"auto"}}>{new Date(c.submissionDate).toLocaleString()}</span>
              </div>
            );
          })}
          {(owners||[]).filter(o=>!(tx.confirmations||[]).some(c=>c.owner.toLowerCase()===o.toLowerCase())).map((o,oi)=>{
            const name=addrName(o);
            return (
              <div key={"m"+oi} style={{display:"flex",alignItems:"center",gap:6,padding:"4px 8px",background:C.bg,borderRadius:4,opacity:0.4}}>
                <span style={{color:C.t4,display:"flex",width:10,height:10,borderRadius:"50%",border:`1.5px solid ${C.t4}`}}/>
                <span style={{fontFamily:F.mono,fontSize:10,color:C.t4}}>{shorten(o)}</span>
                {name&&<span style={{fontFamily:F.sans,fontSize:9,color:C.t4}}>{name}</span>}
                <span style={{fontFamily:F.sans,fontSize:9,color:C.t4,marginLeft:"auto"}}>pending</span>
              </div>
            );
          })}
        </div>
      </div>
      {tx.proposer&&(
        <div style={{fontFamily:F.sans,fontSize:10,color:C.t4}}>
          Proposed by <span style={{fontFamily:F.mono,color:C.t3}}>{shorten(tx.proposer)}</span>
          {addrName(tx.proposer)&&<span style={{color:C.purple}}> ({addrName(tx.proposer)})</span>}
          {tx.submissionDate&&<span> · {new Date(tx.submissionDate).toLocaleString()}</span>}
        </div>
      )}
    </div>
  );
}

// Expanded row for a Safe tx with rejection sub-tabs
function SafeTxExpandedRow({tx,safeAddr,network,addrName,owners,threshold}) {
  const isRejection=tx.to?.toLowerCase()===safeAddr.toLowerCase()&&tx.value==="0"&&(!tx.data||tx.data==="0x");
  const [detailTab,setDetailTab]=useState(isRejection?"rejection":"details");
  const [originalTx,setOriginalTx]=useState(null);
  const [loadingOriginal,setLoadingOriginal]=useState(false);

  useEffect(()=>{
    if(!isRejection||originalTx) return;
    if(!window.electronAPI?.safeApiByNonce) return;
    setLoadingOriginal(true);
    window.electronAPI.safeApiByNonce(network.id,safeAddr,tx.nonce).then(res=>{
      if(!res.error) {
        const orig=(res.results||[]).find(t=>t.safeTxHash!==tx.safeTxHash);
        if(orig) setOriginalTx(orig);
      }
    }).finally(()=>setLoadingOriginal(false));
  },[isRejection,tx.nonce,tx.safeTxHash]);

  return (
    <div style={{borderTop:`1px solid ${C.b1}`,padding:"10px 12px",display:"flex",flexDirection:"column",gap:8}}>
      {isRejection&&(
        <div style={{display:"flex",gap:2,borderRadius:5,overflow:"hidden",border:`1px solid ${C.b1}`,background:C.s2,marginBottom:4}}>
          {[{id:"rejection",label:"Rejection"},{id:"original",label:"Original Proposal"}].map(t=>(
            <button key={t.id} onClick={()=>setDetailTab(t.id)} style={{
              fontFamily:F.sans,fontSize:9.5,fontWeight:600,padding:"4px 12px",border:"none",cursor:"pointer",flex:1,
              background:detailTab===t.id?(t.id==="rejection"?C.redD:C.blueD):"transparent",
              color:detailTab===t.id?(t.id==="rejection"?C.red:C.blue):C.t4,transition:"all 0.12s",
            }}>{t.label}</button>
          ))}
        </div>
      )}
      {detailTab==="rejection"&&<SafeTxDetail tx={tx} addrName={addrName} owners={owners} threshold={threshold}/>}
      {detailTab==="details"&&<SafeTxDetail tx={tx} addrName={addrName} owners={owners} threshold={threshold}/>}
      {detailTab==="original"&&(
        loadingOriginal?<div style={{fontFamily:F.sans,fontSize:11,color:C.t4,textAlign:"center",padding:10}}>{I.spin(12)} Loading original proposal…</div>
        :originalTx?<SafeTxDetail tx={originalTx} addrName={addrName} owners={owners} threshold={threshold}/>
        :<div style={{fontFamily:F.sans,fontSize:11,color:C.t4,textAlign:"center",padding:10}}>No original proposal found for this nonce</div>
      )}
    </div>
  );
}

// Safe tx summary row (reused in pending and history)
function SafeTxSummaryRow({tx,safeAddr,isSelected,onToggle,threshold,network,addrName,owners,showExecStatus}) {
  const confirmCount=tx.confirmations?.length||0;
  const sigsRequired=tx.confirmationsRequired??(showExecStatus?null:threshold);
  const isRejection=tx.to?.toLowerCase()===safeAddr.toLowerCase()&&tx.value==="0"&&(!tx.data||tx.data==="0x");
  return (
    <div key={tx.safeTxHash}>
      <div onClick={onToggle} style={{
        background:C.s1,border:`1px solid ${isSelected?C.blue+"44":C.b1}`,borderRadius:8,
        overflow:"hidden",cursor:"pointer",transition:"border-color 0.15s",
      }}
        onMouseEnter={e=>{if(!isSelected)e.currentTarget.style.borderColor=C.b2}}
        onMouseLeave={e=>{if(!isSelected)e.currentTarget.style.borderColor=isSelected?C.blue+"44":C.b1}}
      >
        <div style={{display:"flex",alignItems:"center",gap:8,padding:"9px 12px"}}>
          <span style={{fontFamily:F.mono,fontSize:10,fontWeight:700,color:C.bg,background:isRejection?C.red:C.blue,borderRadius:4,padding:"2px 6px",minWidth:16,textAlign:"center"}}>
            {tx.nonce}
          </span>
          {isRejection?(
            <span style={{fontFamily:F.sans,fontSize:11,color:C.red,fontWeight:500}}>Rejection</span>
          ):(
            <span style={{fontFamily:F.mono,fontSize:11,color:C.t2}}>{shorten(tx.to)}</span>
          )}
          {!isRejection&&tx.dataDecoded?.method&&(
            <span style={{fontFamily:F.mono,fontSize:11,color:C.t1,fontWeight:600}}>{tx.dataDecoded.method}</span>
          )}
          {tx.value&&tx.value!=="0"&&(
            <span style={{fontFamily:F.mono,fontSize:9.5,color:C.warn,background:C.warnD,padding:"1px 5px",borderRadius:3}}>
              {(Number(tx.value)/1e18).toFixed(4)} ETH
            </span>
          )}
          <div style={{flex:1}}/>
          {showExecStatus&&tx.executionDate&&(
            <span style={{fontFamily:F.mono,fontSize:9.5,color:C.t4}} title={new Date(tx.executionDate).toLocaleString()}>
              {new Date(tx.executionDate).toLocaleDateString()}
            </span>
          )}
          {showExecStatus&&tx.blockNumber!=null&&(
            <span style={{fontFamily:F.mono,fontSize:9.5,color:C.t4}}>blk {tx.blockNumber}</span>
          )}
          {showExecStatus&&tx.isExecuted&&(
            <span style={{fontFamily:F.sans,fontSize:9,color:tx.isSuccessful?C.acc:C.red,background:tx.isSuccessful?C.accD:C.redD,padding:"1px 6px",borderRadius:3}}>
              {tx.isSuccessful?"Executed":"Failed"}
            </span>
          )}
          <span style={{fontFamily:F.mono,fontSize:10,color:sigsRequired&&confirmCount>=sigsRequired?C.acc:C.warn}}>
            {sigsRequired?`${confirmCount}/${sigsRequired} sigs`:`${confirmCount} sig${confirmCount===1?"":"s"}`}
          </span>
          <span style={{color:C.t4}}>{I.chev(10,isSelected?"up":"down")}</span>
        </div>
        {isSelected&&<SafeTxExpandedRow tx={tx} safeAddr={safeAddr} network={network} addrName={addrName} owners={owners} threshold={threshold}/>}
      </div>
    </div>
  );
}

function SafeApiTab({safeAddr,network,settings,addresses,addrName,txs,nonce,currentNonce}) {
  const [pending,setPending]=useState(null);
  const [history,setHistory]=useState(null);
  const [historyTotal,setHistoryTotal]=useState(null);
  const [historyPage,setHistoryPage]=useState(0);
  const [historyPageSize,setHistoryPageSize]=useState(10);
  const [filterDraft,setFilterDraft]=useState({afterDate:"",beforeDate:"",afterBlock:"",beforeBlock:""});
  const [filtersApplied,setFiltersApplied]=useState({});
  const [showFilters,setShowFilters]=useState(false);
  const [exportMenuOpen,setExportMenuOpen]=useState(false);
  const [exporting,setExporting]=useState(false);
  const exportMenuRef=useRef(null);
  const [error,setError]=useState(null);
  const [selectedTx,setSelectedTx]=useState(null);
  const [safeInfo,setSafeInfo]=useState(null);
  const [selectedSigner,setSelectedSigner]=useState(null);
  const [proposing,setProposing]=useState(false);
  const [proposeResult,setProposeResult]=useState(null);
  const [activeTab,setActiveTab]=useState("pending");

  // Pending + safe info: fetch when address/nonce ready
  useEffect(()=>{
    if(!safeAddr||!network?.id||!window.electronAPI?.safeApiPending) return;
    if(currentNonce==null) return;
    setPending(null);setError(null);
    window.electronAPI.safeApiPending(network.id,safeAddr,currentNonce).then(res=>{
      if(res.error) setError(res.error);
      else setPending(res.results||[]);
    }).catch(e=>setError(e.message));
    window.electronAPI.safeApiInfo(network.id,safeAddr).then(res=>{
      if(!res.error) setSafeInfo(res);
    }).catch(()=>{});
  },[safeAddr,network?.id,currentNonce]);

  // Reset history pagination when the safe changes
  useEffect(()=>{
    setHistoryPage(0);setHistoryTotal(null);setHistory(null);setSelectedTx(null);
  },[safeAddr,network?.id]);

  // History: fetch only when on history tab, or when page/size/filters change
  useEffect(()=>{
    if(activeTab!=="history") return;
    if(!safeAddr||!network?.id||!window.electronAPI?.safeApiHistory) return;
    setHistory(null);
    window.electronAPI.safeApiHistory(network.id,safeAddr,{
      limit:historyPageSize,
      offset:historyPage*historyPageSize,
      ...filtersApplied,
    }).then(res=>{
      if(res.error){setError(res.error);return}
      setHistory(res.results||[]);
      setHistoryTotal(res.count??null);
    }).catch(e=>setError(e.message));
  },[activeTab,safeAddr,network?.id,historyPage,historyPageSize,filtersApplied]);

  // Close export menu when clicking outside
  useEffect(()=>{
    const h=e=>{if(exportMenuRef.current&&!exportMenuRef.current.contains(e.target))setExportMenuOpen(false)};
    document.addEventListener("mousedown",h);return()=>document.removeEventListener("mousedown",h);
  },[]);

  const buildFilterArgs=(draft)=>{
    const f={};
    if(draft.afterDate) f.executedAfter=`${draft.afterDate}T00:00:00Z`;
    if(draft.beforeDate) f.executedBefore=`${draft.beforeDate}T23:59:59Z`;
    if(draft.afterBlock) f.blockAfter=Number(draft.afterBlock);
    if(draft.beforeBlock) f.blockBefore=Number(draft.beforeBlock);
    return f;
  };
  const applyFilters=()=>{setFiltersApplied(buildFilterArgs(filterDraft));setHistoryPage(0)};
  const clearFilters=()=>{setFilterDraft({afterDate:"",beforeDate:"",afterBlock:"",beforeBlock:""});setFiltersApplied({});setHistoryPage(0)};
  const hasFilters=Object.keys(filtersApplied).length>0;

  const exportHistory=async(format)=>{
    setExporting(true);setExportMenuOpen(false);
    try {
      const all=[];
      let offset=0;const batch=100;
      while(true) {
        const res=await window.electronAPI.safeApiHistory(network.id,safeAddr,{
          limit:batch,offset,...filtersApplied,
        });
        if(res.error) throw new Error(res.error);
        const rows=res.results||[];
        all.push(...rows);
        if(rows.length<batch) break;
        offset+=batch;
        if(all.length>=10000) break; // safety cap
      }
      const stamp=new Date().toISOString().slice(0,10);
      const fname=`safe-${safeAddr.slice(0,10)}-history-${stamp}.${format}`;
      let content,mime;
      if(format==="json") {
        content=JSON.stringify(all,null,2);mime="application/json";
      } else {
        const headers=["nonce","executionDate","blockNumber","transactionHash","safeTxHash","to","value","method","isExecuted","isSuccessful","confirmations","confirmationsRequired"];
        const escape=(v)=>{const s=String(v??"");return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s};
        const rows=all.map(tx=>[
          tx.nonce,tx.executionDate||"",tx.blockNumber??"",tx.transactionHash||"",tx.safeTxHash||"",
          tx.to||"",tx.value||"0",tx.dataDecoded?.method||"",
          tx.isExecuted?"true":"false",tx.isSuccessful?"true":"false",
          tx.confirmations?.length||0,tx.confirmationsRequired??"",
        ]);
        content=[headers,...rows].map(r=>r.map(escape).join(",")).join("\n");
        mime="text/csv";
      }
      const blob=new Blob([content],{type:mime});
      const u=URL.createObjectURL(blob);
      const a=document.createElement("a");a.href=u;a.download=fname;a.click();
      URL.revokeObjectURL(u);
    } catch(e) {
      setError(`Export failed: ${e.message}`);
    } finally {
      setExporting(false);
    }
  };

  const threshold=safeInfo?.threshold||null;
  const owners=safeInfo?.owners||[];
  const activeTxs=activeTab==="pending"?pending:history;

  if(!settings.safeApiKey) {
    return (
      <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center"}}>
        <div style={{textAlign:"center",maxWidth:320}}>
          <div style={{fontFamily:F.sans,fontSize:13,fontWeight:500,color:C.t3,marginBottom:6}}>Safe.global API key must be configured in settings</div>
          <div style={{fontFamily:F.sans,fontSize:11,color:C.t4}}>Add your API key in the Settings screen to use the Safe Transaction Service.</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:14}}>
      {/* Safe info */}
      {safeInfo&&(
        <div style={{background:C.s1,border:`1px solid ${C.b1}`,borderRadius:8,padding:"10px 14px",display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontFamily:F.sans,fontSize:11,color:C.t2}}>Threshold</span>
          <span style={{fontFamily:F.mono,fontSize:11,fontWeight:600,color:C.acc}}>{safeInfo.threshold}/{safeInfo.owners?.length}</span>
          <div style={{width:1,height:14,background:C.b1}}/>
          <span style={{fontFamily:F.sans,fontSize:11,color:C.t2}}>Nonce</span>
          <span style={{fontFamily:F.mono,fontSize:11,color:C.t1}}>{safeInfo.nonce}</span>
        </div>
      )}

      {/* Tabs */}
      <div style={{display:"flex",gap:2,borderRadius:6,overflow:"hidden",border:`1px solid ${C.b1}`,background:C.s1}}>
        {[{id:"pending",label:`Pending${pending?` (${pending.length})`:""}`},{id:"history",label:"Transaction History"}].map(t=>(
          <button key={t.id} onClick={()=>{setActiveTab(t.id);setSelectedTx(null)}} style={{
            fontFamily:F.sans,fontSize:10.5,fontWeight:600,padding:"6px 16px",border:"none",cursor:"pointer",flex:1,
            background:activeTab===t.id?C.blueD:"transparent",
            color:activeTab===t.id?C.blue:C.t4,transition:"all 0.12s",
          }}>{t.label}</button>
        ))}
      </div>

      {/* History controls */}
      {activeTab==="history"&&(
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            <span style={{fontFamily:F.sans,fontSize:10,color:C.t4,textTransform:"uppercase",letterSpacing:"0.08em"}}>Per page</span>
            <div style={{display:"flex",border:`1px solid ${C.b1}`,borderRadius:5,overflow:"hidden"}}>
              {[10,25,100].map(n=>(
                <button key={n} onClick={()=>{setHistoryPageSize(n);setHistoryPage(0)}} style={{
                  fontFamily:F.mono,fontSize:10.5,fontWeight:600,padding:"4px 10px",border:"none",cursor:"pointer",
                  background:historyPageSize===n?C.blueD:"transparent",color:historyPageSize===n?C.blue:C.t3,
                }}>{n}</button>
              ))}
            </div>
            <button onClick={()=>setShowFilters(!showFilters)} style={{
              fontFamily:F.sans,fontSize:11,padding:"4px 10px",borderRadius:5,
              border:`1px solid ${hasFilters?C.blue+"55":C.b1}`,
              background:showFilters?C.s2:"transparent",
              color:hasFilters?C.blue:C.t3,cursor:"pointer",display:"flex",alignItems:"center",gap:5,
            }}>
              {I.filter(11)} Filters{hasFilters?` (${Object.keys(filtersApplied).length})`:""}
            </button>
            {hasFilters&&(
              <button onClick={clearFilters} style={{
                fontFamily:F.sans,fontSize:10.5,padding:"4px 8px",borderRadius:5,
                border:`1px solid ${C.b1}`,background:"transparent",color:C.t4,cursor:"pointer",
              }}>Clear</button>
            )}
            <div style={{flex:1}}/>
            <div ref={exportMenuRef} style={{position:"relative"}}>
              <button onClick={()=>setExportMenuOpen(!exportMenuOpen)} disabled={exporting||!history||history.length===0} style={{
                fontFamily:F.sans,fontSize:11,padding:"4px 10px",borderRadius:5,
                border:`1px solid ${C.b1}`,background:"transparent",
                color:(exporting||!history||history.length===0)?C.t4:C.t2,
                cursor:(exporting||!history||history.length===0)?"not-allowed":"pointer",
                display:"flex",alignItems:"center",gap:5,opacity:(exporting||!history||history.length===0)?0.5:1,
              }}>{exporting?I.spin(11):I.dl(11)} {exporting?"Exporting…":"Export"} {!exporting&&I.chev(9)}</button>
              {exportMenuOpen&&!exporting&&(
                <div style={{
                  position:"absolute",top:"calc(100% + 4px)",right:0,zIndex:50,minWidth:120,
                  background:C.s1,border:`1px solid ${C.b2}`,borderRadius:6,
                  boxShadow:"0 8px 32px rgba(0,0,0,0.6)",overflow:"hidden",
                }}>
                  {[{f:"csv",l:"CSV"},{f:"json",l:"JSON"}].map(o=>(
                    <button key={o.f} onClick={()=>exportHistory(o.f)} style={{
                      fontFamily:F.sans,fontSize:11,width:"100%",textAlign:"left",padding:"6px 12px",
                      border:"none",background:"transparent",color:C.t1,cursor:"pointer",
                    }}
                      onMouseEnter={e=>e.currentTarget.style.background=C.s2}
                      onMouseLeave={e=>e.currentTarget.style.background="transparent"}
                    >{o.l}</button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {showFilters&&(
            <div style={{background:C.s1,border:`1px solid ${C.b1}`,borderRadius:7,padding:"10px 12px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px 12px"}}>
              {[
                {k:"afterDate",l:"Executed after",t:"date"},
                {k:"beforeDate",l:"Executed before",t:"date"},
                {k:"afterBlock",l:"Block from",t:"number",ph:"e.g. 18000000"},
                {k:"beforeBlock",l:"Block to",t:"number",ph:"e.g. 19000000"},
              ].map(({k,l,t,ph})=>(
                <label key={k} style={{display:"flex",flexDirection:"column",gap:3}}>
                  <span style={{fontFamily:F.sans,fontSize:9,color:C.t4,textTransform:"uppercase",letterSpacing:"0.08em"}}>{l}</span>
                  <input type={t} value={filterDraft[k]} placeholder={ph||""}
                    onChange={e=>setFilterDraft({...filterDraft,[k]:e.target.value})}
                    style={{
                      fontFamily:F.mono,fontSize:11,padding:"5px 8px",borderRadius:5,
                      border:`1px solid ${C.b1}`,background:C.bg,color:C.t1,outline:"none",
                      colorScheme:"dark",
                    }}/>
                </label>
              ))}
              <div style={{gridColumn:"1 / -1",display:"flex",gap:6,justifyContent:"flex-end",marginTop:2}}>
                <button onClick={applyFilters} style={{
                  fontFamily:F.sans,fontSize:11,fontWeight:600,padding:"5px 14px",borderRadius:5,
                  border:"none",background:C.blue,color:"#fff",cursor:"pointer",
                }}>Apply</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error&&(
        <div style={{background:C.redD,border:`1px solid ${C.red}33`,borderRadius:7,padding:"10px 12px"}}>
          <div style={{fontFamily:F.sans,fontSize:10,fontWeight:600,color:C.red,marginBottom:2}}>Error fetching from Safe API</div>
          <div style={{fontFamily:F.mono,fontSize:10.5,color:C.t2,wordBreak:"break-all"}}>{error}</div>
        </div>
      )}

      {/* Loading */}
      {activeTxs===null&&!error&&(
        <div style={{fontFamily:F.sans,fontSize:11,color:C.t4,textAlign:"center",padding:20,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
          {I.spin(14)} Fetching transactions…
        </div>
      )}

      {/* Empty */}
      {activeTxs&&activeTxs.length===0&&(
        <div style={{fontFamily:F.sans,fontSize:12,color:C.t4,textAlign:"center",padding:20}}>
          {activeTab==="pending"?"No pending transactions":(hasFilters?"No transactions match the selected filters":"No transaction history")}
        </div>
      )}

      {/* Transaction list */}
      {activeTxs&&activeTxs.length>0&&(
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {activeTxs.map(tx=>(
            <SafeTxSummaryRow key={tx.safeTxHash} tx={tx} safeAddr={safeAddr}
              isSelected={selectedTx?.safeTxHash===tx.safeTxHash}
              onToggle={()=>setSelectedTx(selectedTx?.safeTxHash===tx.safeTxHash?null:tx)}
              threshold={threshold} network={network} addrName={addrName} owners={owners}
              showExecStatus={activeTab==="history"}/>
          ))}
        </div>
      )}

      {/* History pagination */}
      {activeTab==="history"&&history&&(historyTotal!=null||historyPage>0||history.length>=historyPageSize)&&(
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"4px 2px"}}>
          <span style={{fontFamily:F.mono,fontSize:10,color:C.t4}}>
            {historyTotal!=null
              ?(historyTotal===0?"0":`${historyPage*historyPageSize+1}–${Math.min(historyTotal,(historyPage+1)*historyPageSize)} of ${historyTotal}`)
              :`Page ${historyPage+1}`}
          </span>
          <div style={{display:"flex",gap:6}}>
            <button onClick={()=>{setHistoryPage(Math.max(0,historyPage-1));setSelectedTx(null)}}
              disabled={historyPage===0} style={{
              fontFamily:F.sans,fontSize:10.5,padding:"4px 10px",borderRadius:5,
              border:`1px solid ${C.b1}`,background:"transparent",
              color:historyPage===0?C.t4:C.t2,cursor:historyPage===0?"not-allowed":"pointer",
              opacity:historyPage===0?0.4:1,
            }}>← Prev</button>
            <button onClick={()=>{setHistoryPage(historyPage+1);setSelectedTx(null)}}
              disabled={historyTotal!=null?(historyPage+1)*historyPageSize>=historyTotal:history.length<historyPageSize}
              style={{
              fontFamily:F.sans,fontSize:10.5,padding:"4px 10px",borderRadius:5,
              border:`1px solid ${C.b1}`,background:"transparent",
              color:(historyTotal!=null?(historyPage+1)*historyPageSize>=historyTotal:history.length<historyPageSize)?C.t4:C.t2,
              cursor:(historyTotal!=null?(historyPage+1)*historyPageSize>=historyTotal:history.length<historyPageSize)?"not-allowed":"pointer",
              opacity:(historyTotal!=null?(historyPage+1)*historyPageSize>=historyTotal:history.length<historyPageSize)?0.4:1,
            }}>Next →</button>
          </div>
        </div>
      )}

      {/* Signer selection */}
      {activeTab==="pending"&&(()=>{
        const signers=(settings.keys||[]).filter(k=>k&&k.length>0).map(k=>{
          const addr=deriveAddress(k);
          if(!addr) return null;
          const isOwner=owners.length===0||owners.some(o=>o.toLowerCase()===addr.toLowerCase());
          return {key:k,address:addr,isOwner};
        }).filter(Boolean);
        const ownerSigners=signers.filter(s=>s.isOwner);

        const handlePropose=(reject=false)=>{
          if(!selectedSigner||proposing) return;
          const signer=signers.find(s=>s.address===selectedSigner);
          if(!signer) return;
          setProposing(true);setProposeResult(null);

          const proposeTxs=reject
            ?[{to:safeAddr,ethValue:"0",data:"0x"}]
            :(txs||[]);
          const txNonce=nonce?parseInt(nonce):safeInfo?.nonce;

          window.electronAPI.safeApiPropose({
            chainId:network.id,safeAddr,rpcUrl:network.rpcurl,
            privateKey:signer.key.replace(/^0x/i,""),
            transactions:proposeTxs,nonce:txNonce,
            safeApiKey:settings.safeApiKey,
          }).then(res=>{
            setProposeResult(res);
            if(res.success) {
              // Refresh pending list
              window.electronAPI.safeApiPending(network.id,safeAddr,currentNonce).then(r=>{
                if(!r.error) setPending(r.results||[]);
              });
            }
          }).catch(e=>setProposeResult({error:e.message}))
            .finally(()=>setProposing(false));
        };

        return (
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            <label style={{fontFamily:F.sans,fontSize:10,color:C.t4,textTransform:"uppercase",letterSpacing:"0.1em"}}>
              Sign & Propose with
            </label>
            {ownerSigners.length===0?(
              <div style={{fontFamily:F.sans,fontSize:11,color:C.t4,padding:"10px 12px",background:C.s1,border:`1px solid ${C.b1}`,borderRadius:7}}>
                No owner keys configured. Add private keys for Safe owners in Settings.
              </div>
            ):(
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {ownerSigners.map(s=>{
                  const name=addrName(s.address);
                  return (
                    <label key={s.address} style={{
                      display:"flex",alignItems:"center",gap:8,padding:"7px 10px",background:C.s1,
                      border:`1px solid ${selectedSigner===s.address?C.blue+"44":C.b1}`,borderRadius:6,cursor:"pointer",
                    }}>
                      <input type="radio" name="apiSigner" checked={selectedSigner===s.address}
                        onChange={()=>setSelectedSigner(s.address)} style={{accentColor:C.blue}}/>
                      <span style={{fontFamily:F.mono,fontSize:10.5,color:C.t1}}>{s.address}</span>
                      {name&&<span style={{fontFamily:F.sans,fontSize:10,color:C.purple,background:C.purpleD,padding:"1px 6px",borderRadius:3}}>{name}</span>}
                    </label>
                  );
                })}
              </div>
            )}

            {/* Result */}
            {proposeResult?.success&&(
              <div style={{background:C.accD,border:`1px solid ${C.acc}33`,borderRadius:7,padding:"10px 12px"}}>
                <div style={{fontFamily:F.sans,fontSize:10,fontWeight:600,color:C.acc,marginBottom:4}}>Transaction proposed successfully</div>
                <div style={{fontFamily:F.mono,fontSize:9.5,color:C.t3,wordBreak:"break-all"}}>SafeTxHash: {proposeResult.safeTxHash}</div>
                <div style={{fontFamily:F.mono,fontSize:9.5,color:C.t4}}>Signed by: {proposeResult.signer}</div>
              </div>
            )}
            {proposeResult?.error&&(
              <div style={{background:C.redD,border:`1px solid ${C.red}33`,borderRadius:7,padding:"10px 12px"}}>
                <div style={{fontFamily:F.sans,fontSize:10,fontWeight:600,color:C.red,marginBottom:2}}>Failed to propose</div>
                <div style={{fontFamily:F.mono,fontSize:10,color:C.t2,wordBreak:"break-all"}}>{proposeResult.error}</div>
              </div>
            )}

            {/* Buttons */}
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>handlePropose(false)} disabled={!selectedSigner||proposing||!txs?.length} style={{
                fontFamily:F.sans,fontSize:12,fontWeight:600,flex:1,padding:"10px 0",borderRadius:7,
                border:"none",background:selectedSigner&&!proposing&&txs?.length?C.blue:C.s3,
                color:selectedSigner&&!proposing&&txs?.length?"#fff":C.t4,
                cursor:selectedSigner&&!proposing&&txs?.length?"pointer":"not-allowed",
                display:"flex",alignItems:"center",justifyContent:"center",gap:6,
              }}>{proposing?I.spin(13):I.send(13)} Propose to Safe API</button>
              <button onClick={()=>handlePropose(true)} disabled={!selectedSigner||proposing}
                title="Propose a rejection (0 ETH to self with same nonce)" style={{
                fontFamily:F.sans,fontSize:12,fontWeight:500,padding:"10px 18px",borderRadius:7,
                border:`1px solid ${selectedSigner&&!proposing?C.red+"55":C.b1}`,background:"transparent",
                color:selectedSigner&&!proposing?C.red:C.t4,
                cursor:selectedSigner&&!proposing?"pointer":"not-allowed",
                display:"flex",alignItems:"center",gap:6,
              }}>{I.err(13)} Reject</button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ── Signing Screen (left panel in signing mode) ──
// Trezor wrapper — routes between USB (IPC to main) and Web (@trezor/connect-web).
// @trezor/connect-web defaults try Trezor Suite over localhost first, then fall back
// to the iframe popup loaded from trezor.io — exactly the user-requested Web behavior.
const trezorWrap=(()=>{
  let webTC=null,webInited=false,webBackend=null;
  const MANIFEST={appName:"TX Builder",email:"txbuilder@users.noreply.github.com",appUrl:"https://github.com/gearcat0/txbuilder"};
  // Probe Trezor Suite's local WebSocket endpoint. Returns true only if the
  // socket transitions to OPEN within the timeout. We do this ourselves
  // because connect-web's `auto`/`suite-desktop` coreMode silently falls
  // back to the trezor.io iframe inside the package's dynamic dispatcher,
  // hiding whether Suite was reachable.
  const probeSuite=()=>new Promise(resolve=>{
    let done=false,ws=null;
    const finish=ok=>{ if(done) return; done=true; try{ws&&ws.close();}catch{} resolve(ok); };
    try {
      ws=new WebSocket("ws://127.0.0.1:21335/connect-ws");
      ws.addEventListener("open",()=>finish(true));
      ws.addEventListener("error",()=>finish(false));
      ws.addEventListener("close",()=>finish(false));
      setTimeout(()=>finish(false),1500);
    } catch { finish(false); }
  });
  // Web mode = "prefer local Trezor Suite, fall back to trezor.io iframe popup".
  // We probe the Suite WebSocket first so the choice is deterministic and
  // visible in the network panel.
  const getWeb=async()=>{
    if(!webTC) {
      const mod=await import("@trezor/connect-web");
      webTC=mod.default||mod;
    }
    if(!webInited) {
      const suiteReachable=await probeSuite();
      const mode=suiteReachable?"suite-desktop":"iframe";
      await webTC.init({manifest:MANIFEST,coreMode:mode,lazyLoad:false});
      webBackend=mode;
      webInited=true;
    }
    return webTC;
  };
  const bundleFor=(count,startIndex)=>{
    const b=[];
    for(let i=0;i<count;i++) b.push({path:`m/44'/60'/0'/0/${startIndex+i}`,showOnTrezor:false});
    return b;
  };
  return {
    async init(mode) {
      if(mode==="web") {
        try { await getWeb(); return {success:true}; }
        catch(e) { return {error:e?.message||String(e)}; }
      }
      return await window.electronAPI.trezorInit();
    },
    async listAccounts(mode,{count=5,startIndex=0}={}) {
      if(mode==="web") {
        try {
          const TC=await getWeb();
          const res=await TC.ethereumGetAddress({bundle:bundleFor(count,startIndex)});
          if(!res.success) return {error:res.payload?.error||"Trezor returned failure"};
          return {accounts:res.payload.map(p=>({address:p.address,path:p.serializedPath}))};
        } catch(e) { return {error:e?.message||String(e)}; }
      }
      return await window.electronAPI.trezorListAccounts({count,startIndex});
    },
    async signTyped(mode,{path,typedData,domainHash,messageHash}) {
      if(mode==="web") {
        try {
          const TC=await getWeb();
          const res=await TC.ethereumSignTypedData({
            path,data:typedData,metamask_v4_compat:true,
            ...(domainHash?{domain_separator_hash:domainHash}:{}),
            ...(messageHash?{message_hash:messageHash}:{}),
          });
          if(!res.success) return {error:res.payload?.error||"Trezor returned failure"};
          return {address:res.payload.address,signature:res.payload.signature};
        } catch(e) { return {error:e?.message||String(e)}; }
      }
      return await window.electronAPI.trezorSignTyped({path,typedData,domainHash,messageHash});
    },
    // Abort an in-flight device operation. Works whether we're waiting on the
    // device confirmation or stuck on the Suite device-selection screen.
    async cancel(mode,reason) {
      if(mode==="web") {
        try { if(webTC) webTC.cancel(reason||"Cancelled by user"); return {success:true}; }
        catch(e) { return {error:e?.message||String(e)}; }
      }
      return await window.electronAPI.trezorCancel(reason);
    },
    async verifyAddress(mode,{path}) {
      if(mode==="web") {
        try {
          const TC=await getWeb();
          const res=await TC.ethereumGetAddress({path,showOnTrezor:true});
          if(!res.success) return {error:res.payload?.error||"Trezor returned failure"};
          return {address:res.payload.address};
        } catch(e) { return {error:e?.message||String(e)}; }
      }
      return await window.electronAPI.trezorVerifyAddress({path});
    },
    async dispose(mode) {
      if(mode==="web") {
        try {
          if(webTC&&webInited) { await webTC.dispose(); webInited=false; webBackend=null; }
          return {success:true};
        } catch(e) { return {error:e?.message||String(e)}; }
      }
      return await window.electronAPI.trezorDispose();
    },
    getWebBackend() { return webBackend; },
  };
})();

// A signature attempt ended in cancellation/rejection rather than a real
// failure — either the user hit our Cancel button (Method_Cancel / "Canceled"),
// closed the popup (Method_Interrupted), or declined on the device
// (Failure_ActionCancelled / "Action cancelled by user").
const isCancelMsg=(m)=>/cancel|interrupt|reject|denied|not granted/i.test(String(m||""));

function SigningScreen({safeAddr,network,settings,addresses,initialNonce,txs,onCancel}) {
  const [sigTab,setSigTab]=useState("local"); // "local" | "api"
  const [bundleInput,setBundleInput]=useState("");
  const [bundleError,setBundleError]=useState(null);
  const [parsedBundle,setParsedBundle]=useState(null);
  const [selectedSigners,setSelectedSigners]=useState({});
  const [nonce,setNonce]=useState(initialNonce!=null?String(initialNonce):"");
  const [nonceSet,setNonceSet]=useState(initialNonce!=null);
  const nonceLoading=!nonceSet&&nonce==="";
  const [signatures,setSignatures]=useState([]); // [{address,sig,source}]
  const [signing,setSigning]=useState(false);
  const [signError,setSignError]=useState(null);
  const [signProgress,setSignProgress]=useState(null);
  const [outputBundle,setOutputBundle]=useState(null);
  const [copied,setCopied]=useState(false);
  const cancelledRef=useRef(false); // set when the user hits Cancel mid-sign

  // Trezor — accounts come from settings (imported in the Settings screen).
  // No device call happens here until the user actually signs.
  const trezorMode=settings.trezorMode||"usb";
  const trezorAccounts=useMemo(()=>{
    return Array.isArray(settings.trezorAccounts)?settings.trezorAccounts:[];
  },[settings.trezorAccounts]);
  const [selectedTrezor,setSelectedTrezor]=useState({});
  const [balances,setBalances]=useState({});         // address -> hex wei

  // Get Safe owners from address book
  const safeEntry=useMemo(()=>{
    const entry=addresses.find(a=>a.address.toLowerCase()===safeAddr.toLowerCase());
    if(!entry) return null;
    const chainKey=String(network?.id);
    const info=entry.activeChains?.[chainKey]||Object.values(entry.activeChains||{})[0];
    return info||null;
  },[addresses,safeAddr,network?.id]);
  const owners=useMemo(()=>(safeEntry?.owners||[]).map(o=>o.toLowerCase()),[safeEntry]);

  // Derive available signers from settings, mark non-owners
  const availableSigners=useMemo(()=>{
    return (settings.keys||[]).filter(k=>k&&k.length>0).map(k=>{
      const addr=deriveAddress(k);
      if(!addr) return null;
      const isOwner=owners.includes(addr.toLowerCase());
      return {key:k,address:addr,isOwner};
    }).filter(Boolean);
  },[settings.keys,owners]);

  // Pick up nonce from parent when it arrives async
  useEffect(()=>{
    if(initialNonce!=null&&!nonceSet) { setNonce(String(initialNonce)); setNonceSet(true); }
  },[initialNonce,nonceSet]);

  // Parse pasted bundle
  useEffect(()=>{
    if(!bundleInput.trim()) { setParsedBundle(null); setBundleError(null); return; }
    try {
      const data=JSON.parse(bundleInput);
      if(!data.safeTxHash&&!data.signatures&&!data.nonce&&data.nonce!==0) throw new Error("Not a valid signing bundle");
      setParsedBundle(data);
      setBundleError(null);
      if(data.nonce!==undefined) setNonce(String(data.nonce));
      if(data.signatures) setSignatures(data.signatures);
    } catch(e) { setBundleError(e.message); setParsedBundle(null); }
  },[bundleInput]);

  // Look up address name from address book
  const addrName=(addr)=>{
    const entry=addresses.find(a=>a.address.toLowerCase()===addr.toLowerCase());
    return entry?entry.description:null;
  };

  // Safe info for threshold
  const safeInfo=getSafeInfo(addresses,safeAddr,network?.id);
  const threshold=safeInfo?.threshold||null;
  const totalOwners=safeInfo?.owners||null;

  // Fetch native balances in parallel whenever the account list changes.
  useEffect(()=>{
    if(!network?.rpcurl||trezorAccounts.length===0) return;
    if(!window.electronAPI?.ethGetBalance) return;
    let cancelled=false;
    (async()=>{
      const updates={};
      await Promise.all(trezorAccounts.map(async acc=>{
        const res=await window.electronAPI.ethGetBalance(network.rpcurl,acc.address);
        if(cancelled) return;
        if(!res.error&&res.result) updates[acc.address]=res.result;
      }));
      if(!cancelled&&Object.keys(updates).length) setBalances(b=>({...b,...updates}));
    })();
    return ()=>{cancelled=true};
  },[trezorAccounts,network?.rpcurl]);

  // Build typed data and collect signatures from selected signers
  const collectSignatures=async(rejection=false)=>{
    const pkSigners=Object.entries(selectedSigners).filter(([,v])=>v).map(([addr])=>addr);
    const tzSigners=Object.entries(selectedTrezor).filter(([,v])=>v).map(([addr])=>addr);
    if(pkSigners.length===0&&tzSigners.length===0) return null;

    const transactions=rejection
      ?[{to:safeAddr,ethValue:"0",data:"0x"}]
      :txs.map(t=>({to:t.to,ethValue:t.ethValue||"0",data:t.data||"0x"}));

    let typedData=null,safeTxHash=null,domainHash=null,messageHash=null;
    if(tzSigners.length>0) {
      setSignProgress("Building Safe transaction…");
      const built=await window.electronAPI.safeBuildTypedData({
        chainId:network.id,safeAddr,rpcUrl:network.rpcurl,
        transactions,nonce:parseInt(nonce),
      });
      if(built.error) throw new Error(`Build failed: ${built.error}`);
      typedData=built.typedData; safeTxHash=built.safeTxHash;
      domainHash=built.domainHash; messageHash=built.messageHash;
    }

    const newSigs=[...signatures];
    // Private-key signers — placeholder until real EIP-712 local signing lands
    for(const addr of pkSigners) {
      newSigs.push({address:addr,sig:"0x"+(rejection?"cd":"ab").repeat(65),source:"key"});
    }
    // Trezor signers — sequential, one device confirmation at a time
    for(const addr of tzSigners) {
      if(cancelledRef.current) throw new Error("Cancelled by user");
      const acc=trezorAccounts.find(a=>a.address.toLowerCase()===addr.toLowerCase());
      if(!acc) continue;
      setSignProgress(`Confirm on Trezor: ${shorten(addr)}`);
      const res=await trezorWrap.signTyped(trezorMode,{path:acc.path,typedData,domainHash,messageHash});
      if(res.error) throw new Error(`Trezor: ${res.error}`);
      newSigs.push({address:addr,sig:res.signature,source:"trezor",path:acc.path});
    }
    return {signatures:newSigs,safeTxHash};
  };

  const handleSign=async()=>{
    cancelledRef.current=false;
    setSigning(true); setSignError(null); setSignProgress(null);
    try {
      const result=await collectSignatures(false);
      if(!result) return;
      setSignatures(result.signatures);
      setOutputBundle(JSON.stringify({
        safeAddr,chainId:network?.id,nonce:parseInt(nonce)||0,
        safeTxHash:result.safeTxHash,
        signatures:result.signatures,sigCount:result.signatures.length,threshold,
      },null,2));
      setSelectedSigners({}); setSelectedTrezor({});
    } catch(e) {
      const msg=e?.message||String(e);
      setSignError(cancelledRef.current||isCancelMsg(msg)?"Signing cancelled — nothing was signed.":msg);
    } finally {
      setSigning(false); setSignProgress(null); cancelledRef.current=false;
    }
  };

  const handleReject=async()=>{
    cancelledRef.current=false;
    setSigning(true); setSignError(null); setSignProgress(null);
    try {
      const result=await collectSignatures(true);
      if(!result) return;
      setOutputBundle(JSON.stringify({
        safeAddr,chainId:network?.id,nonce:parseInt(nonce)||0,type:"rejection",
        description:"Send 0 ETH to self (nonce consumption)",
        safeTxHash:result.safeTxHash,
        signatures:result.signatures,sigCount:result.signatures.length,threshold,
      },null,2));
      setSelectedSigners({}); setSelectedTrezor({});
    } catch(e) {
      const msg=e?.message||String(e);
      setSignError(cancelledRef.current||isCancelMsg(msg)?"Signing cancelled — nothing was signed.":msg);
    } finally {
      setSigning(false); setSignProgress(null); cancelledRef.current=false;
    }
  };

  // Abort an in-progress signing attempt — recovers from a hung Trezor Suite
  // connection or a device that's waiting. Tells the device layer to cancel;
  // the in-flight signTyped call then returns a Method_Cancel failure which the
  // sign/reject handlers surface as "Signing cancelled".
  const handleCancelSign=async()=>{
    cancelledRef.current=true;
    setSignProgress("Cancelling…");
    try { await trezorWrap.cancel(trezorMode,"Cancelled by user"); } catch {}
  };

  // Release the Trezor session on unmount or mode change
  useEffect(()=>{
    return ()=>{ trezorWrap.dispose(trezorMode).catch(()=>{}); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  const doCopy=()=>{if(outputBundle){navigator.clipboard?.writeText(outputBundle);setCopied(true);setTimeout(()=>setCopied(false),1500)}};
  const doSaveFile=()=>{
    if(!outputBundle) return;
    const b=new Blob([outputBundle],{type:"application/json"});
    const u=URL.createObjectURL(b);const a=document.createElement("a");
    a.href=u;a.download=`signing-bundle-nonce-${nonce||"0"}.json`;a.click();URL.revokeObjectURL(u);
  };

  return (
    <div style={{display:"flex",flexDirection:"column",gap:14,height:"100%"}}>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <button onClick={onCancel} style={{
          fontFamily:F.sans,fontSize:11,fontWeight:500,padding:"5px 12px",borderRadius:5,
          border:`1px solid ${C.b1}`,background:"transparent",color:C.t3,cursor:"pointer",
          display:"flex",alignItems:"center",gap:4,
        }}>{I.back(12)} Back to editing</button>
        <div style={{flex:1}}/>
        <span style={{fontFamily:F.sans,fontSize:13,fontWeight:600,color:C.t1}}>Sign & Submit</span>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:2,borderRadius:6,overflow:"hidden",border:`1px solid ${C.b1}`,background:C.s1}}>
        {[{id:"local",label:"Local Signing"},{id:"api",label:"Safe API"}].map(t=>(
          <button key={t.id} onClick={()=>setSigTab(t.id)} style={{
            fontFamily:F.sans,fontSize:10.5,fontWeight:600,padding:"6px 16px",border:"none",cursor:"pointer",flex:1,
            background:sigTab===t.id?(t.id==="local"?C.accD:C.blueD):"transparent",
            color:sigTab===t.id?(t.id==="local"?C.acc:C.blue):C.t4,transition:"all 0.12s",
          }}>{t.label}</button>
        ))}
      </div>

      {/* Local Signing */}
      {sigTab==="local"&&(
        <div style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:14}}>
          {/* Nonce */}
          <div>
            <label style={{fontFamily:F.sans,fontSize:10,color:C.t4,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:5,display:"block"}}>
              Safe Nonce
            </label>
            <div style={{position:"relative"}}>
              <input value={nonce} onChange={e=>setNonce(e.target.value)} placeholder={nonceLoading?"Loading…":"Transaction nonce"}
                style={{fontFamily:F.mono,fontSize:12,width:"100%",boxSizing:"border-box",padding:"9px 12px",borderRadius:7,
                  border:`1px solid ${nonce&&!/^\d+$/.test(nonce)?C.red+"55":C.b1}`,background:C.s2,color:C.t1,outline:"none"}}/>
              {nonceLoading&&<span style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",color:C.t4}}>{I.spin(12)}</span>}
            </div>
            {nonce&&!/^\d+$/.test(nonce)&&<div style={{fontFamily:F.sans,fontSize:10,color:C.red,marginTop:2}}>Must be a non-negative integer</div>}
          </div>

          {/* Import bundle */}
          <div>
            <label style={{fontFamily:F.sans,fontSize:10,color:C.t4,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:5,display:"block"}}>
              Import Signing Bundle <span style={{textTransform:"none",fontStyle:"italic"}}>(optional — paste to add existing signatures)</span>
            </label>
            <textarea value={bundleInput} onChange={e=>setBundleInput(e.target.value)} placeholder='Paste JSON bundle here…' rows={3}
              style={{fontFamily:F.mono,fontSize:10.5,width:"100%",boxSizing:"border-box",padding:"9px 12px",borderRadius:7,
                border:`1px solid ${bundleError?C.red+"55":C.b1}`,background:C.s2,color:C.t1,outline:"none",resize:"vertical"}}/>
            {bundleError&&<div style={{fontFamily:F.sans,fontSize:10,color:C.red,marginTop:2}}>{bundleError}</div>}
          </div>

          {/* Collected signatures */}
          <div>
            <label style={{fontFamily:F.sans,fontSize:10,color:C.t4,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:5,display:"flex",alignItems:"center",gap:6}}>
              Signatures
              {threshold&&<span style={{fontFamily:F.mono,fontSize:10,color:signatures.length>=threshold?C.acc:C.warn,textTransform:"none"}}>
                {signatures.length}/{threshold} required
              </span>}
            </label>
            {signatures.length===0&&(
              <div style={{fontFamily:F.sans,fontSize:11,color:C.t4,padding:"10px 0"}}>No signatures collected yet</div>
            )}
            {signatures.length>0&&(
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {signatures.map((sig,i)=>{
                  const name=addrName(sig.address);
                  return (
                    <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",background:C.s1,border:`1px solid ${C.b1}`,borderRadius:6}}>
                      <span style={{color:C.acc,display:"flex"}}>{I.check(12)}</span>
                      <span style={{fontFamily:F.mono,fontSize:10.5,color:C.t2}}>{sig.address}</span>
                      {name&&<span style={{fontFamily:F.sans,fontSize:10,color:C.purple,background:C.purpleD,padding:"1px 6px",borderRadius:3}}>{name}</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Select signer */}
          <div>
            <label style={{fontFamily:F.sans,fontSize:10,color:C.t4,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:5,display:"block"}}>
              Sign with
            </label>
            {availableSigners.length===0&&(
              <div style={{fontFamily:F.sans,fontSize:11,color:C.t4,padding:"10px 12px",background:C.s1,border:`1px solid ${C.b1}`,borderRadius:7}}>
                No signing keys configured. Add private keys in Settings.
              </div>
            )}
            {availableSigners.length>0&&(
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {availableSigners.map(s=>{
                  const alreadySigned=signatures.some(sig=>sig.address.toLowerCase()===s.address.toLowerCase());
                  const notOwner=!s.isOwner;
                  const disabled=alreadySigned||notOwner;
                  const name=addrName(s.address);
                  return (
                    <label key={s.address} style={{
                      display:"flex",alignItems:"center",gap:8,padding:"7px 10px",background:C.s1,
                      border:`1px solid ${selectedSigners[s.address]?C.acc+"44":C.b1}`,borderRadius:6,
                      cursor:disabled?"not-allowed":"pointer",opacity:disabled?0.4:1,
                    }}>
                      <input type="checkbox" disabled={disabled} checked={!!selectedSigners[s.address]}
                        onChange={e=>setSelectedSigners({...selectedSigners,[s.address]:e.target.checked})}
                        style={{accentColor:C.acc}}/>
                      <span style={{fontFamily:F.mono,fontSize:10.5,color:C.t1}}>{s.address}</span>
                      {name&&<span style={{fontFamily:F.sans,fontSize:10,color:C.purple,background:C.purpleD,padding:"1px 6px",borderRadius:3}}>{name}</span>}
                      {alreadySigned&&<span style={{fontFamily:F.sans,fontSize:9,color:C.acc}}>signed</span>}
                      {notOwner&&!alreadySigned&&<span style={{fontFamily:F.sans,fontSize:9,color:C.t4}}>not an owner</span>}
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* Hardware Wallet (Trezor) — populated from settings */}
          {trezorAccounts.length>0&&(
            <div>
              <label style={{fontFamily:F.sans,fontSize:10,color:C.t4,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:5,display:"flex",alignItems:"center",gap:6}}>
                Hardware Wallet
                <span style={{fontFamily:F.mono,fontSize:9,color:C.t3,textTransform:"none",letterSpacing:"normal"}}>
                  Trezor · {trezorMode==="usb"?"Direct USB":"Suite / Web"}
                </span>
              </label>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {trezorAccounts.map(acc=>{
                  const alreadySigned=signatures.some(sig=>sig.address.toLowerCase()===acc.address.toLowerCase());
                  const isOwner=owners.includes(acc.address.toLowerCase());
                  const notOwner=!isOwner;
                  const disabled=alreadySigned||notOwner;
                  const name=addrName(acc.address);
                  const balHex=balances[acc.address];
                  const sym=NATIVE_SYMBOL[network?.id]||"";
                  return (
                    <label key={acc.path||acc.address} style={{
                      display:"flex",alignItems:"center",gap:8,padding:"7px 10px",background:C.s1,
                      border:`1px solid ${selectedTrezor[acc.address]?C.acc+"44":C.b1}`,borderRadius:6,
                      cursor:disabled?"not-allowed":"pointer",opacity:disabled?0.4:1,
                    }}>
                      <input type="checkbox" disabled={disabled} checked={!!selectedTrezor[acc.address]}
                        onChange={e=>setSelectedTrezor({...selectedTrezor,[acc.address]:e.target.checked})}
                        style={{accentColor:C.acc}}/>
                      <span style={{fontFamily:F.mono,fontSize:10.5,color:C.t1}}>{acc.address}</span>
                      <span style={{fontFamily:F.mono,fontSize:9,color:C.t4}}>{acc.path}</span>
                      {acc.verified&&(
                        <span title="Verified on Trezor screen" style={{
                          display:"flex",alignItems:"center",gap:2,fontFamily:F.sans,fontSize:9,fontWeight:600,
                          color:C.acc,background:C.accD,padding:"1px 5px",borderRadius:3,
                        }}>{I.check(9)} verified</span>
                      )}
                      {name&&<span style={{fontFamily:F.sans,fontSize:10,color:C.purple,background:C.purpleD,padding:"1px 6px",borderRadius:3}}>{name}</span>}
                      <span style={{flex:1}}/>
                      <span style={{fontFamily:F.mono,fontSize:10,color:balHex?C.t2:C.t4,whiteSpace:"nowrap"}}
                        title={balHex?`${BigInt(balHex).toString()} wei`:"loading…"}>
                        {balHex?formatNative(balHex,sym):"…"}
                      </span>
                      {alreadySigned&&<span style={{fontFamily:F.sans,fontSize:9,color:C.acc}}>signed</span>}
                      {notOwner&&!alreadySigned&&<span style={{fontFamily:F.sans,fontSize:9,color:C.t4}}>not an owner</span>}
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* Action buttons */}
          {(()=>{
            const hasSigners=Object.values(selectedSigners).some(v=>v)||Object.values(selectedTrezor).some(v=>v);
            const nonceValid=nonce&&/^\d+$/.test(nonce);
            const canSign=hasSigners&&nonceValid&&!signing;
            return (
              <>
                {signProgress&&(
                  <div style={{fontFamily:F.sans,fontSize:11,color:C.acc,padding:"6px 10px",background:C.accD,borderRadius:5,display:"flex",alignItems:"center",gap:6}}>
                    {I.spin(11)} {signProgress}
                  </div>
                )}
                {signError&&(
                  <div style={{fontFamily:F.sans,fontSize:11,color:C.red,padding:"6px 10px",background:C.redD,borderRadius:5}}>
                    {signError}
                  </div>
                )}
                <div style={{display:"flex",gap:8}}>
                  {signing?(
                    <button onClick={handleCancelSign} style={{
                      fontFamily:F.sans,fontSize:12,fontWeight:600,flex:1,padding:"10px 0",borderRadius:7,
                      border:`1px solid ${C.red}55`,background:C.redD,color:C.red,
                      cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6,
                    }}>{I.x(13)} Cancel signing</button>
                  ):(
                    <>
                      <button onClick={handleSign} disabled={!canSign} style={{
                        fontFamily:F.sans,fontSize:12,fontWeight:600,flex:1,padding:"10px 0",borderRadius:7,
                        border:"none",background:canSign?C.acc:C.s3,color:canSign?C.bg:C.t4,
                        cursor:canSign?"pointer":"not-allowed",display:"flex",alignItems:"center",justifyContent:"center",gap:6,
                      }}>{I.check(13)} Sign Transaction</button>
                      <button onClick={handleReject} disabled={!canSign} title="Sign a rejection (same nonce, 0 ETH to self)" style={{
                        fontFamily:F.sans,fontSize:12,fontWeight:500,padding:"10px 18px",borderRadius:7,
                        border:`1px solid ${canSign?C.red+"55":C.b1}`,background:"transparent",
                        color:canSign?C.red:C.t4,cursor:canSign?"pointer":"not-allowed",
                        display:"flex",alignItems:"center",gap:6,
                      }}>{I.err(13)} Reject</button>
                    </>
                  )}
                </div>
              </>
            );
          })()}

          {/* Output bundle */}
          {outputBundle&&(
            <div style={{background:C.s1,border:`1px solid ${C.b1}`,borderRadius:8,overflow:"hidden"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",borderBottom:`1px solid ${C.b1}`}}>
                <span style={{fontFamily:F.sans,fontSize:10,fontWeight:600,color:C.t2}}>Output Bundle</span>
                <div style={{flex:1}}/>
                <button onClick={doCopy} style={{fontFamily:F.sans,fontSize:10,padding:"3px 10px",borderRadius:4,border:`1px solid ${C.b1}`,background:"transparent",color:C.t3,cursor:"pointer",display:"flex",alignItems:"center",gap:4}}>
                  {copied?<>{I.check(10)} Copied</>:<>{I.copy(10)} Copy</>}
                </button>
                <button onClick={doSaveFile} style={{fontFamily:F.sans,fontSize:10,padding:"3px 10px",borderRadius:4,border:`1px solid ${C.b1}`,background:"transparent",color:C.t3,cursor:"pointer",display:"flex",alignItems:"center",gap:4}}>
                  {I.dl(10)} Save file
                </button>
              </div>
              <pre style={{fontFamily:F.mono,fontSize:10,color:C.t3,padding:"10px 12px",margin:0,maxHeight:160,overflowY:"auto",whiteSpace:"pre-wrap",wordBreak:"break-all"}}>
                {outputBundle}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Safe API */}
      {sigTab==="api"&&(
        <SafeApiTab safeAddr={safeAddr} network={network} settings={settings} addresses={addresses} addrName={addrName} txs={txs} nonce={nonce} currentNonce={initialNonce}/>
      )}
    </div>
  );
}

function RateBar({rateLimit}) {
  const fmt=(s)=>{
    if(!s||s<=0) return "—";
    const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60);
    if(d>0) return `${d}d ${h}h`;
    if(h>0) return `${h}h ${m}m`;
    return `${m}m`;
  };
  const remaining=rateLimit?.remaining;
  const limit=rateLimit?.limit;
  const low=remaining!=null&&limit!=null&&remaining/limit<0.1;
  return (
    <div style={{
      height:22,borderTop:`1px solid ${C.b1}`,padding:"0 12px",display:"flex",alignItems:"center",
      justifyContent:"flex-end",gap:10,background:C.s1+"66",flexShrink:0,
    }}>
      <span style={{fontFamily:F.sans,fontSize:9,color:C.t4,textTransform:"uppercase",letterSpacing:"0.08em"}}>Safe API</span>
      {rateLimit?(<>
        <span style={{fontFamily:F.mono,fontSize:10,color:low?C.red:C.t3}}>
          {remaining?.toLocaleString()}/{limit?.toLocaleString()}
        </span>
        <span style={{fontFamily:F.mono,fontSize:9,color:C.t4}}>resets in {fmt(rateLimit.reset)}</span>
      </>):(
        <span style={{fontFamily:F.mono,fontSize:10,color:C.t4}}>—</span>
      )}
    </div>
  );
}

// ── About modal ──
function AboutModal({info,onClose}) {
  useEffect(()=>{
    const h=e=>{if(e.key==="Escape")onClose()};
    document.addEventListener("keydown",h);
    return ()=>document.removeEventListener("keydown",h);
  },[onClose]);
  return (
    <div onClick={onClose} style={{
      position:"fixed",inset:0,zIndex:1000,background:"rgba(0,0,0,0.6)",
      display:"flex",alignItems:"center",justifyContent:"center",
    }}>
      <div onClick={e=>e.stopPropagation()} style={{
        background:C.s1,border:`1px solid ${C.b2}`,borderRadius:10,padding:"22px 26px",
        minWidth:340,maxWidth:420,boxShadow:"0 20px 80px rgba(0,0,0,0.8)",
        position:"relative",fontFamily:F.sans,color:C.t1,
      }}>
        <button onClick={onClose} title="Close" style={{
          position:"absolute",top:10,right:10,background:"none",border:"none",
          color:C.t3,cursor:"pointer",padding:4,display:"flex",borderRadius:4,
        }}
          onMouseEnter={e=>{e.currentTarget.style.color=C.t1;e.currentTarget.style.background=C.s2}}
          onMouseLeave={e=>{e.currentTarget.style.color=C.t3;e.currentTarget.style.background="none"}}
        >{I.x(13)}</button>
        <div style={{fontFamily:F.mono,fontWeight:800,fontSize:18,color:C.acc,letterSpacing:"0.04em",marginBottom:4}}>
          {info?.name||"TX·BUILDER"}
        </div>
        <div style={{fontFamily:F.mono,fontSize:12,color:C.t2,marginBottom:18}}>
          v{info?.version||"0.0.0"}
        </div>
        <div style={{fontFamily:F.sans,fontSize:11,color:C.t3,lineHeight:1.55,marginBottom:14}}>
          Transaction Builder for Safe wallets.
        </div>
        <div style={{display:"grid",gridTemplateColumns:"auto 1fr",gap:"4px 12px",fontFamily:F.mono,fontSize:10,color:C.t4}}>
          {info?.electron&&(<><span>Electron</span><span style={{color:C.t2}}>{info.electron}</span></>)}
          {info?.chrome&&(<><span>Chromium</span><span style={{color:C.t2}}>{info.chrome}</span></>)}
          {info?.node&&(<><span>Node</span><span style={{color:C.t2}}>{info.node}</span></>)}
        </div>
      </div>
    </div>
  );
}

// ── Main ──
export default function App() {
  const [screen,setScreen]=useState("main"); // "main" | "settings"
  const [signing,setSigning]=useState(false);
  const [safeNonce,setSafeNonce]=useState(null);
  const [pendingCount,setPendingCount]=useState(null);
  const [settings,setSettingsRaw]=useState({apiKey:"",keys:[]});
  const [settingsLoaded,setSettingsLoaded]=useState(false);
  const setSettings=useCallback((s)=>{
    setSettingsRaw(s);
    if(window.electronAPI?.saveSettings) window.electronAPI.saveSettings(s);
  },[]);
  const [txs,setTxs]=useState([]);
  const [expanded,setExpanded]=useState(null);
  const [networks,setNetworks]=useState(FALLBACK_NETWORKS);
  const [network,setNetwork]=useState(FALLBACK_NETWORKS[0]);
  const [addresses,setAddresses]=useState([]);
  const [safeAddr,setSafeAddr]=useState("");
  const safeCheck=useMemo(()=>{
    if(!safeAddr||safeAddr.length!==42||!safeAddr.startsWith("0x")) return null;
    return isValidAddress(safeAddr);
  },[safeAddr]);
  const [batchName,setBatchName]=useState("");
  const [batchId,setBatchId]=useState(null);
  const [savedBatches,setSavedBatches]=useState([]);
  const [batchMenuOpen,setBatchMenuOpen]=useState(false);
  const batchMenuRef=useRef(null);
  const [netOpen,setNetOpen]=useState(false);
  const [simulating,setSimulating]=useState(false);
  const [simResult,setSimResult]=useState(null);
  const [dragIdx,setDragIdx]=useState(null);
  const [dragOverIdx,setDragOverIdx]=useState(null);
  const [dragOverPos,setDragOverPos]=useState(null);
  const netRef=useRef(null);
  const safeRef=useRef(null);
  const [safeBookOpen,setSafeBookOpen]=useState(false);
  const [rateLimit,setRateLimit]=useState(null);
  const [aboutInfo,setAboutInfo]=useState(null);

  useEffect(()=>{
    if(!window.electronAPI?.onSafeRateLimit) return;
    return window.electronAPI.onSafeRateLimit(setRateLimit);
  },[]);

  useEffect(()=>{
    if(!window.electronAPI?.onShowAbout) return;
    return window.electronAPI.onShowAbout(setAboutInfo);
  },[]);

  const [availableBooks,setAvailableBooks]=useState([]);

  useEffect(()=>{
    if(!window.electronAPI) return;
    window.electronAPI.loadSettings().then(s=>{
      if(s&&typeof s==="object") setSettingsRaw(s.apiKey||s.keys?s:{apiKey:"",keys:[],...s});
      setSettingsLoaded(true);
    }).catch(()=>setSettingsLoaded(true));
    window.electronAPI.listBatches().then(b=>{if(b?.length)setSavedBatches(b)}).catch(()=>{});
    window.electronAPI.getChains().then(chains=>{
      if(!chains||!chains.length) return;
      const mapped=chains.filter(c=>c.status===1&&c.enabled!==false).map(c=>({
        id:Number(c.chainid),name:c.chainname,color:CHAIN_COLORS[Number(c.chainid)]||C.t3,
        rpcurl:c.rpcurl,apiurl:c.apiurl,blockexplorer:c.blockexplorer,
      }));
      if(mapped.length>0){setNetworks(mapped);setNetwork(mapped[0])}
    });
    if(window.electronAPI.listBooks) {
      window.electronAPI.listBooks().then(books=>{
        if(Array.isArray(books)&&books.length) setAvailableBooks(books);
      }).catch(()=>{});
    }
  },[]);

  // Re-load addresses whenever the set of enabled books changes (or once settings load).
  const enabledBooks=useMemo(()=>{
    const e=settings.enabledBooks;
    if(Array.isArray(e)&&e.length) return e;
    return ["Default"];
  },[settings.enabledBooks]);

  const toggleBook=useCallback((name)=>{
    const cur=Array.isArray(settings.enabledBooks)&&settings.enabledBooks.length?settings.enabledBooks:["Default"];
    const next=cur.includes(name)?cur.filter(b=>b!==name):[...cur,name];
    // Don't allow zero books — fall back to Default if user unchecks last one.
    setSettings({...settings,enabledBooks:next.length?next:["Default"]});
  },[settings,setSettings]);

  useEffect(()=>{
    if(!settingsLoaded||!window.electronAPI?.getAddressesMulti) return;
    window.electronAPI.getAddressesMulti(enabledBooks).then(addrs=>{
      if(Array.isArray(addrs)) setAddresses(addrs);
    }).catch(()=>{});
  },[settingsLoaded,enabledBooks]);

  const enterSigning=()=>{
    setSigning(true);
  };

  const addTx=tx=>setTxs(p=>[...p,tx]);
  const rmTx=id=>setTxs(p=>p.filter(t=>t.id!==id));
  const moveTx=(i,d)=>{
    setTxs(p=>{const n=[...p];const t=i+d;if(t<0||t>=n.length)return p;[n[i],n[t]]=[n[t],n[i]];return n});
    setExpanded(null);
  };

  const handleDragStart=idx=>{setDragIdx(idx);setExpanded(null)};
  const handleDragOver=(idx,pos)=>{
    if(dragIdx===null)return;
    if(idx===dragIdx){setDragOverIdx(null);setDragOverPos(null);return}
    setDragOverIdx(idx);setDragOverPos(pos);
  };
  const handleDragEnd=()=>{setDragIdx(null);setDragOverIdx(null);setDragOverPos(null)};
  const handleDrop=(dropIdx)=>{
    if(dragIdx===null||dragIdx===dropIdx)return;
    setTxs(prev=>{
      const n=[...prev];
      const [dragged]=n.splice(dragIdx,1);
      let insertAt=dropIdx;
      if(dragOverPos==="below") insertAt=dragIdx<dropIdx?dropIdx:dropIdx+1;
      else insertAt=dragIdx<dropIdx?dropIdx-1:dropIdx;
      insertAt=Math.max(0,Math.min(insertAt,n.length));
      n.splice(insertAt,0,dragged);
      return n;
    });
    setDragIdx(null);setDragOverIdx(null);setDragOverPos(null);
  };

  const exportBatch=()=>{
    const batch={version:"1.0",chainId:String(network.id),createdAt:Date.now(),
      meta:{name:batchName||"Untitled Batch"},
      transactions:txs.map(tx=>({to:tx.to,value:tx.ethValue||"0",data:tx.data,
        contractMethod:tx.method!=="(custom)"?{name:tx.method,inputs:tx.inputs}:null,
        contractInputsValues:tx.params}))};
    const b=new Blob([JSON.stringify(batch,null,2)],{type:"application/json"});
    const u=URL.createObjectURL(b);const a=document.createElement("a");a.href=u;
    a.download=`${(batchName||"batch").replace(/\s+/g,"_")}.json`;a.click();URL.revokeObjectURL(u);
  };

  const handleSimulate=()=>{
    setSimulating(true);setSimResult(null);
    setTimeout(()=>{
      setSimulating(false);
      setSimResult({
        success:Math.random()>0.3,gasUsed:Math.floor(Math.random()*500000+80000),blockNumber:19847523,
        logs:txs.map((_,i)=>({index:i,status:Math.random()>0.2?"success":"reverted",gasUsed:Math.floor(Math.random()*150000+21000)})),
      });
    },1800);
  };

  useEffect(()=>{
    const h=e=>{
      if(netRef.current&&!netRef.current.contains(e.target))setNetOpen(false);
      if(batchMenuRef.current&&!batchMenuRef.current.contains(e.target))setBatchMenuOpen(false);
    };
    document.addEventListener("mousedown",h);return()=>document.removeEventListener("mousedown",h);
  },[]);
  useEffect(()=>{setSimResult(null)},[txs]);

  // Fetch the Safe's current nonce via RPC (no Safe API cost). Used to filter
  // out pending transactions whose nonce has already been consumed (rejected/
  // executed on-chain).
  useEffect(()=>{
    setSafeNonce(null);
    if(!safeCheck?.valid||!network?.rpcurl||!window.electronAPI?.ethCall) return;
    let cancelled=false;
    window.electronAPI.ethCall(network.rpcurl,safeAddr,"0xaffed0e0").then(res=>{
      if(cancelled) return;
      if(res?.result&&res.result!=="0x") {
        try { const n=Number(BigInt(res.result)); if(!isNaN(n)) setSafeNonce(n); } catch {}
      }
    }).catch(()=>{});
    return ()=>{cancelled=true};
  },[safeCheck?.valid,safeAddr,network?.rpcurl]);

  // Fetch pending transaction count when Safe address, API key, and nonce are ready
  useEffect(()=>{
    setPendingCount(null);
    if(!safeCheck?.valid||!settings.safeApiKey||!network?.id||!window.electronAPI?.safeApiPending) return;
    if(safeNonce==null) return;
    let cancelled=false;
    window.electronAPI.safeApiPending(network.id,safeAddr,safeNonce).then(res=>{
      if(cancelled) return;
      if(!res.error) setPendingCount(res.results?.length||0);
    }).catch(()=>{});
    return ()=>{cancelled=true};
  },[safeCheck?.valid,safeAddr,settings.safeApiKey,network?.id,safeNonce]);

  // Re-fetch nonce + pending count without nulling current values first.
  // Used on click of the pending badge, on return from the pending screen,
  // and on a background interval. Reads nonce fresh from chain RPC (free)
  // so the count reflects executed/rejected on-chain state.
  const refreshSafeState=useCallback(async()=>{
    if(!safeCheck?.valid||!network?.rpcurl||!window.electronAPI?.ethCall) return;
    let nonce=null;
    try {
      const r=await window.electronAPI.ethCall(network.rpcurl,safeAddr,"0xaffed0e0");
      if(r?.result&&r.result!=="0x") {
        const n=Number(BigInt(r.result));
        if(!isNaN(n)) { nonce=n; setSafeNonce(n); }
      }
    } catch {}
    if(nonce==null) return;
    if(!settings.safeApiKey||!network?.id||!window.electronAPI?.safeApiPending) return;
    try {
      const res=await window.electronAPI.safeApiPending(network.id,safeAddr,nonce);
      if(!res.error) setPendingCount(res.results?.length||0);
    } catch {}
  },[safeCheck?.valid,safeAddr,network?.id,network?.rpcurl,settings.safeApiKey]);

  // Periodic background refresh while the badge is visible. 120s keeps the
  // count near-live without burning much of the 50k/month Safe API budget.
  useEffect(()=>{
    if(screen!=="main") return;
    if(!safeCheck?.valid||!settings.safeApiKey) return;
    const id=setInterval(refreshSafeState,120000);
    return ()=>clearInterval(id);
  },[screen,safeCheck?.valid,settings.safeApiKey,refreshSafeState]);

  const booksContextValue=useMemo(()=>({availableBooks,enabledBooks,onToggleBook:toggleBook}),[availableBooks,enabledBooks,toggleBook]);

  if(screen==="settings") return (
    <BooksContext.Provider value={booksContextValue}>
      <SettingsScreen onBack={()=>setScreen("main")} settings={settings} setSettings={setSettings} rateLimit={rateLimit}/>
      {aboutInfo&&<AboutModal info={aboutInfo} onClose={()=>setAboutInfo(null)}/>}
    </BooksContext.Provider>
  );

  if(screen==="pending") return (
    <BooksContext.Provider value={booksContextValue}>
    <div style={{fontFamily:F.sans,background:C.bg,height:"100vh",color:C.t1,display:"flex",flexDirection:"column"}}>
      <div style={{height:44,borderBottom:`1px solid ${C.b1}`,display:"flex",alignItems:"center",padding:"0 16px",gap:12,flexShrink:0,background:C.s1+"88"}}>
        <button onClick={()=>{refreshSafeState();setScreen("main")}} style={{
          background:"none",border:"none",color:C.t2,cursor:"pointer",display:"flex",alignItems:"center",gap:4,
          fontFamily:F.sans,fontSize:12,fontWeight:500,padding:"4px 8px",borderRadius:5,
        }}
          onMouseEnter={e=>e.currentTarget.style.color=C.t1}
          onMouseLeave={e=>e.currentTarget.style.color=C.t2}
        >{I.back(14)} Back</button>
        <div style={{width:1,height:18,background:C.b1}}/>
        <span style={{fontFamily:F.mono,fontWeight:800,fontSize:12.5,color:C.acc,letterSpacing:"0.04em"}}>TX·BUILDER</span>
        <span style={{fontFamily:F.sans,fontSize:12,color:C.t3,fontWeight:500}}>Pending Transactions</span>
        <div style={{flex:1}}/>
        <span style={{fontFamily:F.mono,fontSize:10.5,color:C.t3}}>{shorten(safeAddr)}</span>
        <span style={{width:7,height:7,borderRadius:"50%",background:network.color}}/>
        <span style={{fontFamily:F.sans,fontSize:11,color:C.t3}}>{network.name}</span>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:24}}>
        <div style={{maxWidth:700}}>
          <SafeApiTab safeAddr={safeAddr} network={network} settings={settings} addresses={addresses}
            addrName={(addr)=>{const e=addresses.find(a=>a.address.toLowerCase()===addr.toLowerCase());return e?e.description:null}}
            txs={txs} nonce={String(safeNonce||"")} currentNonce={safeNonce}/>
        </div>
      </div>
      <RateBar rateLimit={rateLimit}/>
    </div>
    {aboutInfo&&<AboutModal info={aboutInfo} onClose={()=>setAboutInfo(null)}/>}
    </BooksContext.Provider>
  );

  return (
    <BooksContext.Provider value={booksContextValue}>
    <div style={{fontFamily:F.sans,background:C.bg,height:"100vh",color:C.t1,display:"flex",flexDirection:"column"}}>
      {/* Top bar */}
      <div style={{height:44,borderBottom:`1px solid ${C.b1}`,display:"flex",alignItems:"center",padding:"0 16px",gap:12,flexShrink:0,background:C.s1+"88"}}>
        <span style={{fontFamily:F.mono,fontWeight:800,fontSize:12.5,color:C.acc,letterSpacing:"0.04em"}}>TX·BUILDER</span>
        <div style={{width:1,height:18,background:C.b1}}/>
        <div ref={netRef} style={{position:"relative"}}>
          <button onClick={()=>setNetOpen(!netOpen)} style={{
            fontFamily:F.sans,fontSize:11,display:"flex",alignItems:"center",gap:5,
            padding:"4px 10px",borderRadius:5,border:`1px solid ${C.b1}`,background:"transparent",color:C.t1,cursor:"pointer",
          }}>
            <span style={{width:7,height:7,borderRadius:"50%",background:network.color}}/>
            {network.name}
            <span style={{fontFamily:F.mono,fontSize:9,color:C.t4}}>{network.id}</span>
            {I.chev(9)}
          </button>
          {netOpen&&(
            <div style={{position:"absolute",top:"calc(100% + 3px)",left:0,background:C.s1,border:`1px solid ${C.b2}`,borderRadius:7,overflow:"hidden",zIndex:200,boxShadow:"0 8px 32px rgba(0,0,0,0.6)",minWidth:150,maxHeight:340,overflowY:"auto"}}>
              {networks.map(n=>(
                <button key={n.id} onClick={()=>{setNetwork(n);setNetOpen(false)}} style={{
                  fontFamily:F.sans,fontSize:11,width:"100%",textAlign:"left",padding:"7px 12px",border:"none",
                  background:network.id===n.id?C.s3:"transparent",color:C.t1,cursor:"pointer",display:"flex",alignItems:"center",gap:7,
                }}>
                  <span style={{width:7,height:7,borderRadius:"50%",background:n.color}}/>{n.name}
                  <span style={{fontFamily:F.mono,fontSize:9,color:C.t4,marginLeft:"auto"}}>{n.id}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div style={{width:1,height:18,background:C.b1}}/>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{fontFamily:F.sans,fontSize:10,color:C.t4}}>Safe</span>
          <div style={{position:"relative",display:"flex",alignItems:"center",gap:4}}>
            <input value={safeAddr} onChange={e=>setSafeAddr(e.target.value)} placeholder="0x… Safe address"
              style={{
                fontFamily:F.mono,fontSize:10.5,padding:"4px 8px",borderRadius:5,
                border:`1px solid ${safeCheck&&!safeCheck.valid?C.red+"55":safeCheck?.valid?C.acc+"44":C.b1}`,
                background:"transparent",color:C.t1,outline:"none",width:370,transition:"border-color 0.15s",
              }}
              onFocus={e=>e.target.style.borderColor=safeCheck&&!safeCheck.valid?C.red+"55":C.acc+"55"}
              onBlur={e=>e.target.style.borderColor=safeCheck&&!safeCheck.valid?C.red+"55":safeCheck?.valid?C.acc+"44":C.b1}/>
            {safeCheck?.valid&&<>
              <SafeTag info={getSafeInfo(addresses,safeAddr,network.id)}/>
              <span style={{color:C.acc,display:"flex"}}>{I.check(11)}</span>
            </>}
            {safeCheck&&!safeCheck.valid&&<span style={{color:C.red,display:"flex",cursor:"default"}} title="Checksum failed">{I.err(12)}</span>}
            <AddressBookPicker compact addresses={addresses} onSelect={v=>setSafeAddr(v)}/>
            {safeCheck?.valid&&(
              <button onClick={()=>{if(settings.safeApiKey){refreshSafeState();setScreen("pending")}}}
                disabled={!settings.safeApiKey}
                title={!settings.safeApiKey?"Safe API key required":"Pending transactions"}
                style={{
                  background:"none",border:`1px solid ${settings.safeApiKey?C.blue+"55":C.b1}`,borderRadius:5,
                  color:settings.safeApiKey?C.blue:C.t4,cursor:settings.safeApiKey?"pointer":"not-allowed",
                  padding:"3px 7px",display:"flex",alignItems:"center",gap:4,transition:"all 0.15s",
                  opacity:settings.safeApiKey?1:0.4,position:"relative",
                }}
                onMouseEnter={e=>{if(settings.safeApiKey){e.currentTarget.style.borderColor=C.blue;e.currentTarget.style.color=C.t1}}}
                onMouseLeave={e=>{if(settings.safeApiKey){e.currentTarget.style.borderColor=C.blue+"55";e.currentTarget.style.color=C.blue}}}
              >
                {I.queue(12)}
                {pendingCount!=null&&pendingCount>0&&(
                  <span style={{
                    fontFamily:F.mono,fontSize:8,fontWeight:700,color:"#fff",background:C.blue,
                    borderRadius:7,padding:"1px 4px",minWidth:14,textAlign:"center",lineHeight:"12px",
                  }}>{pendingCount}</span>
                )}
              </button>
            )}
          </div>
        </div>
        <div style={{flex:1}}/>
        <div style={{display:"flex",alignItems:"center",gap:4}}>
          <div ref={batchMenuRef} style={{position:"relative"}}>
            <button onClick={()=>{
              if(window.electronAPI)window.electronAPI.listBatches().then(b=>setSavedBatches(b||[]));
              setBatchMenuOpen(!batchMenuOpen);
            }} style={{
              background:"none",border:`1px solid ${C.b1}`,borderRadius:5,color:C.t3,cursor:"pointer",
              padding:"4px 6px",display:"flex",alignItems:"center",transition:"all 0.15s",
            }}
              onMouseEnter={e=>{e.currentTarget.style.borderColor=C.acc+"55";e.currentTarget.style.color=C.t1}}
              onMouseLeave={e=>{e.currentTarget.style.borderColor=C.b1;e.currentTarget.style.color=C.t3}}
              title="Saved batches"
            >{I.folder(12)}</button>
            {batchMenuOpen&&(
              <div style={{
                position:"absolute",top:"calc(100% + 4px)",right:0,zIndex:200,minWidth:260,
                background:C.s1,border:`1px solid ${C.b2}`,borderRadius:8,
                boxShadow:"0 12px 48px rgba(0,0,0,0.7)",overflow:"hidden",display:"flex",flexDirection:"column",maxHeight:300,
              }}>
                <div style={{padding:"8px 12px",borderBottom:`1px solid ${C.b1}`,fontFamily:F.sans,fontSize:10,color:C.t4,textTransform:"uppercase",letterSpacing:"0.1em"}}>
                  Saved Batches
                </div>
                <div style={{overflowY:"auto",flex:1}}>
                  {savedBatches.length===0&&(
                    <div style={{padding:"14px 12px",fontFamily:F.sans,fontSize:11,color:C.t4,textAlign:"center"}}>No saved batches</div>
                  )}
                  {savedBatches.map(b=>(
                    <div key={b.id} style={{
                      display:"flex",alignItems:"center",gap:6,padding:"7px 12px",
                      borderBottom:`1px solid ${C.b1}11`,transition:"background 0.1s",cursor:"pointer",
                      background:batchId===b.id?C.s3:"transparent",
                    }}
                      onMouseEnter={e=>e.currentTarget.style.background=C.s2}
                      onMouseLeave={e=>e.currentTarget.style.background=batchId===b.id?C.s3:"transparent"}
                      onClick={()=>{
                        setBatchId(b.id);setBatchName(b.name||"");
                        setTxs(b.transactions||[]);
                        if(b.safeAddr)setSafeAddr(b.safeAddr);
                        if(b.chainId){const n=networks.find(n=>n.id===b.chainId);if(n)setNetwork(n)}
                        setSimResult(null);setBatchMenuOpen(false);
                      }}
                    >
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontFamily:F.sans,fontSize:11,color:C.t1,fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{b.name||"Untitled"}</div>
                        <div style={{fontFamily:F.mono,fontSize:9,color:C.t4}}>
                          {b.transactions?.length||0} tx{(b.transactions?.length||0)!==1?"s":""} · {new Date(b.updatedAt||b.createdAt).toLocaleDateString()}
                        </div>
                      </div>
                      <button onClick={e=>{
                        e.stopPropagation();
                        if(window.electronAPI)window.electronAPI.deleteBatch(b.id).then(()=>{
                          setSavedBatches(p=>p.filter(x=>x.id!==b.id));
                          if(batchId===b.id)setBatchId(null);
                        });
                      }} style={{background:"none",border:"none",color:C.red,cursor:"pointer",padding:3,opacity:0.5,flexShrink:0}}
                        onMouseEnter={e=>e.currentTarget.style.opacity="1"}
                        onMouseLeave={e=>e.currentTarget.style.opacity="0.5"}
                      >{I.trash(10)}</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <input value={batchName} onChange={e=>setBatchName(e.target.value)} placeholder="Untitled batch…"
            style={{fontFamily:F.sans,fontSize:11,padding:"4px 8px",borderRadius:5,border:"1px solid transparent",background:"transparent",color:C.t3,outline:"none",width:160,textAlign:"right"}}
            onFocus={e=>e.target.style.borderColor=C.b1} onBlur={e=>e.target.style.borderColor="transparent"}/>
          <button onClick={()=>{
            if(!window.electronAPI) return;
            const id=batchId||Date.now().toString();
            const batch={id,name:batchName||"Untitled",chainId:network.id,safeAddr,
              transactions:txs,createdAt:batchId?savedBatches.find(b=>b.id===batchId)?.createdAt||Date.now():Date.now(),
              updatedAt:Date.now()};
            window.electronAPI.saveBatch(batch).then(()=>{
              setBatchId(id);
              setSavedBatches(p=>{const idx=p.findIndex(b=>b.id===id);if(idx>=0){const n=[...p];n[idx]=batch;return n}return[...p,batch]});
            });
          }} title="Save batch" style={{
            background:"none",border:`1px solid ${C.b1}`,borderRadius:5,color:C.t3,cursor:"pointer",
            padding:"4px 6px",display:"flex",alignItems:"center",transition:"all 0.15s",
          }}
            onMouseEnter={e=>{e.currentTarget.style.borderColor=C.acc+"55";e.currentTarget.style.color=C.t1}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor=C.b1;e.currentTarget.style.color=C.t3}}
          >{I.save(12)}</button>
        </div>
        <button onClick={()=>setScreen("settings")} style={{
          background:"none",border:`1px solid ${C.b1}`,borderRadius:5,color:C.t3,cursor:"pointer",
          padding:"4px 6px",display:"flex",alignItems:"center",transition:"all 0.15s",
        }}
          onMouseEnter={e=>{e.currentTarget.style.borderColor=C.acc+"55";e.currentTarget.style.color=C.t1}}
          onMouseLeave={e=>{e.currentTarget.style.borderColor=C.b1;e.currentTarget.style.color=C.t3}}
        >{I.gear(13)}</button>
      </div>

      {/* Main */}
      <div style={{flex:1,display:"grid",gridTemplateColumns:"1fr 1fr",overflow:"hidden"}}>
        {/* Left */}
        <div style={{borderRight:`1px solid ${C.b1}`,padding:"20px",overflowY:"auto"}}>
          {signing?(
            <div style={{maxWidth:560,height:"100%"}}>
              <SigningScreen safeAddr={safeAddr} network={network} settings={settings} addresses={addresses}
                initialNonce={safeNonce} txs={txs} onCancel={()=>setSigning(false)}/>
            </div>
          ):(
            <div style={{maxWidth:520}}>
              <div style={{fontSize:14,fontWeight:600,color:C.t1,marginBottom:16}}>New Transaction</div>
              <TransactionForm onAdd={addTx} addresses={addresses} chainId={network.id} network={network}
                onRescanAddresses={()=>{if(window.electronAPI?.getAddressesMulti)window.electronAPI.getAddressesMulti(enabledBooks).then(a=>{if(Array.isArray(a))setAddresses(a)})}}/>
            </div>
          )}
        </div>

        {/* Right */}
        <div style={{display:"flex",flexDirection:"column",overflow:"hidden"}}>
          <div style={{padding:"12px 16px",borderBottom:`1px solid ${C.b1}`,display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontFamily:F.mono,fontSize:10,fontWeight:700,color:C.bg,background:txs.length>0?C.acc:C.t4,borderRadius:5,padding:"2px 8px",transition:"background 0.15s"}}>{txs.length}</span>
            <span style={{fontSize:13,fontWeight:600}}>Batch</span>
            <div style={{flex:1}}/>
            <button onClick={exportBatch} disabled={txs.length===0} style={{
              fontFamily:F.sans,fontSize:10,display:"flex",alignItems:"center",gap:4,
              padding:"5px 10px",borderRadius:5,border:`1px solid ${C.b1}`,background:"transparent",
              color:txs.length>0?C.t3:C.t4,cursor:txs.length>0?"pointer":"not-allowed",opacity:txs.length>0?1:0.4,
            }}>{I.dl(11)} Export</button>
            <button onClick={()=>{setTxs([]);setSimResult(null)}} disabled={txs.length===0||signing} style={{
              fontFamily:F.sans,fontSize:10,display:"flex",alignItems:"center",gap:4,
              padding:"5px 10px",borderRadius:5,border:`1px solid ${txs.length>0?C.redD:C.b1}`,background:"transparent",
              color:txs.length>0?C.red:C.t4,cursor:txs.length>0?"pointer":"not-allowed",opacity:txs.length>0?0.7:0.4,
            }}>{I.trash(10)} Clear</button>
          </div>

          <div style={{flex:1,overflowY:"auto",padding:"10px 16px",display:"flex",flexDirection:"column",gap:6}}
            onDragOver={e=>e.preventDefault()}>
            {txs.length===0&&(
              <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center"}}>
                <span style={{fontFamily:F.sans,fontSize:12,color:C.t4}}>No transactions yet</span>
              </div>
            )}
            {txs.map((tx,i)=>(
              <TxRow key={tx.id} tx={tx} i={i} total={txs.length}
                onRemove={()=>rmTx(tx.id)} onUp={()=>moveTx(i,-1)} onDown={()=>moveTx(i,1)}
                expanded={expanded===tx.id} onToggle={()=>setExpanded(expanded===tx.id?null:tx.id)}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
                onDrop={handleDrop}
                isDragOver={dragOverIdx===i}
                dragOverPos={dragOverIdx===i?dragOverPos:null}
                isDragging={dragIdx===i}
                locked={signing}
              />
            ))}

            {/* Sim results */}
            {simResult&&(
              <div style={{
                background:simResult.success?C.accD:C.redD,
                border:`1px solid ${simResult.success?C.acc+"33":C.red+"33"}`,
                borderRadius:8,padding:"12px 14px",marginTop:4,
              }}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                  <span style={{fontFamily:F.mono,fontSize:10,fontWeight:700,color:simResult.success?C.acc:C.red,textTransform:"uppercase"}}>
                    {simResult.success?"Simulation Passed":"Simulation Failed"}
                  </span>
                  <span style={{fontFamily:F.mono,fontSize:10,color:C.t4}}>Block #{simResult.blockNumber}</span>
                  <span style={{fontFamily:F.mono,fontSize:10,color:C.t4}}>Total gas: {simResult.gasUsed.toLocaleString()}</span>
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:3}}>
                  {simResult.logs.map((log,li)=>(
                    <div key={li} style={{display:"flex",alignItems:"center",gap:6}}>
                      <span style={{fontFamily:F.mono,fontSize:9,fontWeight:700,color:C.bg,background:log.status==="success"?C.acc:C.red,borderRadius:3,padding:"1px 5px",minWidth:14,textAlign:"center"}}>{li+1}</span>
                      <span style={{fontFamily:F.mono,fontSize:10,color:C.t2}}>{txs[li]?.method}</span>
                      <span style={{fontFamily:F.mono,fontSize:9,color:log.status==="success"?C.acc:C.red}}>{log.status}</span>
                      <span style={{fontFamily:F.mono,fontSize:9,color:C.t4,marginLeft:"auto"}}>{log.gasUsed.toLocaleString()} gas</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {!signing&&(
              <div style={{marginTop:"auto",padding:"10px 0 0"}}>
                <div style={{padding:12,border:`1px dashed ${C.b1}`,borderRadius:8,textAlign:"center"}}>
                  <div style={{color:C.t4,fontSize:11,display:"flex",alignItems:"center",justifyContent:"center",gap:5}}>
                    {I.ul(12)} Drop JSON batch or <span style={{color:C.acc,cursor:"pointer",textDecoration:"underline",textUnderlineOffset:2}}>browse</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Bottom actions */}
          {!signing&&(()=>{const ready=txs.length>0&&safeCheck?.valid;return(
          <div style={{padding:"12px 16px",borderTop:`1px solid ${C.b1}`,display:"flex",gap:8,alignItems:"center"}}>
            <button onClick={handleSimulate} disabled={simulating||!ready} style={{
              fontFamily:F.sans,fontSize:12,fontWeight:500,padding:"10px 18px",borderRadius:7,
              border:`1px solid ${C.b2}`,background:simulating?C.s2:"transparent",
              color:ready?(simulating?C.t4:C.t2):C.t4,
              cursor:ready?(simulating?"wait":"pointer"):"not-allowed",
              opacity:ready?1:0.4,
              display:"flex",alignItems:"center",gap:6,transition:"all 0.15s",
            }}>
              {simulating?<span style={{fontFamily:F.mono,fontSize:11,color:C.t4}}>Simulating…</span>:<>{I.play(13)} Simulate</>}
            </button>
            <button disabled={!ready} onClick={enterSigning} style={{
              fontFamily:F.sans,fontSize:12.5,fontWeight:600,flex:1,padding:"10px 0",borderRadius:7,
              border:"none",background:ready?C.acc:C.s3,color:ready?C.bg:C.t4,
              cursor:ready?"pointer":"not-allowed",
              display:"flex",alignItems:"center",justifyContent:"center",gap:7,
            }}>{I.send(13)} Create Batch</button>
          </div>)})()}
        </div>
      </div>

      <RateBar rateLimit={rateLimit}/>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:${C.b1};border-radius:3px}
        ::-webkit-scrollbar-thumb:hover{background:${C.b2}}
        input::placeholder,textarea::placeholder{color:${C.t4}}
        @keyframes pulse{0%,100%{opacity:0.5}50%{opacity:1}}
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
      `}</style>
    </div>
    {aboutInfo&&<AboutModal info={aboutInfo} onClose={()=>setAboutInfo(null)}/>}
    </BooksContext.Provider>
  );
}
