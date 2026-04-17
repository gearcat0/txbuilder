import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { keccak256 } from "js-sha3";

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

// ── Address Book Picker ──
function AddressBookPicker({addresses,onSelect,compact=false}) {
  const [open,setOpen]=useState(false);
  const [filter,setFilter]=useState("");
  const ref=useRef(null);
  const inputRef=useRef(null);
  const filtered=useMemo(()=>{
    if(!filter) return addresses;
    const lc=filter.toLowerCase();
    return addresses.filter(a=>a.description.toLowerCase().includes(lc)||a.address.toLowerCase().includes(lc));
  },[addresses,filter]);

  useEffect(()=>{
    const h=e=>{if(ref.current&&!ref.current.contains(e.target))setOpen(false)};
    document.addEventListener("mousedown",h);return()=>document.removeEventListener("mousedown",h);
  },[]);
  useEffect(()=>{if(open&&inputRef.current)inputRef.current.focus()},[open]);

  return (
    <div ref={ref} style={{position:"relative",display:"inline-flex"}}>
      <button onClick={()=>{setOpen(!open);setFilter("")}} title="Address book" style={{
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
          position:"absolute",top:"calc(100% + 4px)",right:0,zIndex:300,width:340,
          background:C.s1,border:`1px solid ${C.b2}`,borderRadius:8,
          boxShadow:"0 12px 48px rgba(0,0,0,0.7)",overflow:"hidden",display:"flex",flexDirection:"column",maxHeight:300,
        }}>
          <div style={{padding:"8px 8px 6px",borderBottom:`1px solid ${C.b1}`}}>
            <input ref={inputRef} value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Search name or address…"
              style={{
                fontFamily:F.mono,fontSize:11,width:"100%",boxSizing:"border-box",padding:"6px 10px",borderRadius:5,
                border:`1px solid ${C.b1}`,background:C.s2,color:C.t1,outline:"none",
              }}/>
          </div>
          <div style={{overflowY:"auto",flex:1}}>
            {filtered.length===0&&(
              <div style={{padding:"14px 12px",fontFamily:F.sans,fontSize:11,color:C.t4,textAlign:"center"}}>
                {addresses.length===0?"Address book unavailable":"No matches"}
              </div>
            )}
            {filtered.slice(0,30).map(a=>(
              <button key={a.address} onClick={()=>{onSelect(a.address);setOpen(false);setFilter("")}} style={{
                width:"100%",textAlign:"left",padding:"7px 12px",border:"none",
                borderBottom:`1px solid ${C.b1}11`,background:"transparent",
                cursor:"pointer",display:"flex",flexDirection:"column",gap:1,transition:"background 0.1s",
              }}
                onMouseEnter={e=>e.currentTarget.style.background=C.s2}
                onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                <div style={{fontFamily:F.sans,fontSize:11,color:C.t1,fontWeight:500}}>{a.description}</div>
                <div style={{fontFamily:F.mono,fontSize:9.5,color:C.t4}}>{a.address}</div>
              </button>
            ))}
          </div>
        </div>
      )}
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
function TransactionForm({onAdd,addresses,chainId,network,onRescanAddresses}) {
  const [address,setAddress]=useState("");
  const [addrStatus,setAddrStatus]=useState(null); // null | "checking" | "valid" | {error:string}
  const [abiLoaded,setAbiLoaded]=useState(false);
  const [refreshing,setRefreshing]=useState(false);
  const [isProxy,setIsProxy]=useState(false);
  const [abiMode,setAbiMode]=useState("impl");
  const [implAbi,setImplAbi]=useState(null);
  const [proxyAbi,setProxyAbi]=useState(null);
  const [selectedMethod,setSelectedMethod]=useState(null);
  const [params,setParams]=useState({});
  const [ethValue,setEthValue]=useState("");
  const [customData,setCustomData]=useState(false);
  const [hexData,setHexData]=useState("");
  const [methodOpen,setMethodOpen]=useState(false);
  const [methodFilter,setMethodFilter]=useState("");
  const dropRef=useRef(null);
  const filterRef=useRef(null);
  const codeCheckRef=useRef(0);

  const [implAddr,setImplAddr]=useState(null);
  const isValid=addrStatus==="valid";
  const activeAbi=abiMode==="impl"?implAbi:proxyAbi;
  const methods=useMemo(()=>(activeAbi||[]).filter(i=>i.type==="function"),[activeAbi]);
  const filteredMethods=methods.filter(m=>m.name.toLowerCase().includes(methodFilter.toLowerCase()));

  function loadAbis(addr,seq) {
    if(!window.electronAPI?.getAbi) { setAbiLoaded(true); setCustomData(true); return; }
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
          setImplAbi(null); setAbiLoaded(true); setCustomData(true);
        }
      } else if(hasFunctions(proxyResult)) {
        setImplAbi(proxyResult); setProxyAbi(null);
        setIsProxy(false); setAbiMode("impl"); setAbiLoaded(true);
      } else {
        setAbiLoaded(true); setCustomData(true);
      }
    });
  }

  function handleRefresh() {
    if(!address||!window.electronAPI?.scanAddress) return;
    setRefreshing(true);
    window.electronAPI.scanAddress(address,chainId).then(()=>{
      if(onRescanAddresses) onRescanAddresses();
      setAbiLoaded(false); setImplAbi(null); setProxyAbi(null); setIsProxy(false);
      setSelectedMethod(null); setParams({}); setCustomData(false);
      const seq=++codeCheckRef.current;
      loadAbis(address,seq);
    }).finally(()=>setRefreshing(false));
  }

  function handleAddr(e) {
    const v=e.target.value; setAddress(v); setSelectedMethod(null); setParams({});
    setAbiLoaded(false); setImplAbi(null); setProxyAbi(null); setIsProxy(false);
    setCustomData(false); setImplAddr(null);
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
    const p={}; m.inputs.forEach(inp=>{p[inp.name]=inp.type==="bool"?"false":""}); setParams(p);
  }

  function handleAdd() {
    if(!isValid||(!selectedMethod&&!customData)) return;
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
  useEffect(()=>{setSelectedMethod(null);setParams({})},[abiMode]);

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

      {/* Custom data divider */}
      {abiLoaded&&(
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{flex:1,height:1,background:C.b1}}/>
          <button onClick={()=>setCustomData(!customData)} style={{
            fontFamily:F.sans,fontSize:10,fontWeight:500,padding:"3px 12px",borderRadius:20,
            border:`1px solid ${customData?C.acc+"44":C.b1}`,
            background:customData?C.accD:"transparent",
            color:customData?C.acc:C.t4,cursor:"pointer",transition:"all 0.15s",
          }}>Custom data</button>
          <div style={{flex:1,height:1,background:C.b1}}/>
        </div>
      )}

      {/* Method selector */}
      {abiLoaded&&!customData&&(
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

      {/* Params */}
      {selectedMethod&&!customData&&(
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {selectedMethod.inputs.map(ip=>(
            <div key={ip.name}>
              <label style={{fontFamily:F.sans,fontSize:10,color:C.t3,marginBottom:4,display:"flex",alignItems:"center",gap:5}}>
                <span>{ip.name}</span><TypeBadge type={ip.type}/>
              </label>
              {ip.type==="bool"?(
                <div style={{display:"flex",gap:6}}>
                  {["true","false"].map(v=>(
                    <button key={v} onClick={()=>setParams({...params,[ip.name]:v})} style={{
                      fontFamily:F.mono,fontSize:11.5,padding:"8px 22px",borderRadius:6,
                      border:`1px solid ${params[ip.name]===v?C.acc+"55":C.b1}`,
                      background:params[ip.name]===v?C.accD:"transparent",
                      color:params[ip.name]===v?C.acc:C.t3,cursor:"pointer",transition:"all 0.12s",
                    }}>{v}</button>
                  ))}
                </div>
              ):ip.type==="address"?(
                <div style={{display:"flex",flexDirection:"column",gap:3}}>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    <div style={{flex:1,position:"relative"}}>
                      {(()=>{const pv=params[ip.name],pc=pv?.length===42?isValidAddress(pv):null;return <>
                        <input value={pv||""} onChange={e=>setParams({...params,[ip.name]:e.target.value})} placeholder={ip.type}
                          {...inp(pc&&!pc.valid?{borderColor:C.red+"55"}:{})}/>
                        <span style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",display:"flex",alignItems:"center",gap:4}}>
                          {pc?.valid&&<SafeTag info={getSafeInfo(addresses,pv,chainId)}/>}
                          {pc?.valid&&<span style={{color:C.acc}}>{I.check(12)}</span>}
                          {pc&&!pc.valid&&<span style={{color:C.red,cursor:"default",display:"flex"}} title="Checksum failed">{I.err(12)}</span>}
                        </span>
                      </>})()}
                    </div>
                    <AddressBookPicker compact addresses={addresses} onSelect={v=>setParams({...params,[ip.name]:v})}/>
                  </div>
                  {(()=>{const pv=params[ip.name],pc=pv?.length===42?isValidAddress(pv):null;
                    return pc&&!pc.valid?<div style={{fontFamily:F.sans,fontSize:10,color:C.red}}>Checksum failed</div>:null})()}
                </div>
              ):(
                <input value={params[ip.name]||""} onChange={e=>setParams({...params,[ip.name]:e.target.value})} placeholder={ip.type} {...inp()}/>
              )}
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
      {customData&&abiLoaded&&(
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

      {/* Add */}
      <button onClick={handleAdd} disabled={!isValid||(!selectedMethod&&!customData)} style={{
        fontFamily:F.sans,fontSize:12.5,fontWeight:600,padding:"10px 0",borderRadius:7,border:"none",width:"100%",
        background:(isValid&&(selectedMethod||customData))?C.acc:C.s3,
        color:(isValid&&(selectedMethod||customData))?C.bg:C.t4,
        cursor:(isValid&&(selectedMethod||customData))?"pointer":"not-allowed",
        display:"flex",alignItems:"center",justifyContent:"center",gap:7,transition:"all 0.15s",
      }}>{I.plus(13)} Add to Batch</button>
    </div>
  );
}

// ── Batch Row ──
function TxRow({tx,i,total,onRemove,onUp,onDown,expanded,onToggle,onDragStart,onDragOver,onDragEnd,onDrop,isDragOver,dragOverPos,isDragging}) {
  const [copied,setCopied]=useState(false);
  const doCopy=e=>{e.stopPropagation();navigator.clipboard?.writeText(tx.data);setCopied(true);setTimeout(()=>setCopied(false),1200)};
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
      draggable
      onDragStart={e=>{
        e.dataTransfer.effectAllowed="move";
        e.dataTransfer.setData("text/plain",i.toString());
        onDragStart(i);
      }}
      onDragEnd={onDragEnd}
      style={{
        background:C.s1,border:`1px solid ${isDragging?C.acc+"44":C.b1}`,borderRadius:8,overflow:"hidden",
        transition:"border-color 0.15s, opacity 0.2s, transform 0.15s",
        opacity:isDragging?0.4:1,
        transform:isDragging?"scale(0.98)":"scale(1)",
      }}
      onMouseEnter={e=>{if(!isDragging)e.currentTarget.style.borderColor=C.b2}}
      onMouseLeave={e=>{if(!isDragging)e.currentTarget.style.borderColor=C.b1}}>
      <div onClick={onToggle} style={{display:"flex",alignItems:"flex-start",gap:8,padding:"9px 12px",cursor:"pointer",userSelect:"none"}}>
        <span style={{color:C.t4,marginTop:2,display:"flex",cursor:"grab"}}
          onMouseDown={e=>e.currentTarget.style.cursor="grabbing"}
          onMouseUp={e=>e.currentTarget.style.cursor="grab"}
        >{I.grip()}</span>
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
          {[{fn:onUp,dis:i===0,d:"up"},{fn:onDown,dis:i===total-1,d:"down"}].map((b,k)=>(
            <button key={k} onClick={e=>{e.stopPropagation();b.fn()}} disabled={b.dis}
              style={{background:"none",border:"none",color:b.dis?C.t4+"33":C.t4,cursor:b.dis?"default":"pointer",padding:3,borderRadius:3}}>
              {I.chev(10,b.d)}
            </button>
          ))}
          <button onClick={e=>{e.stopPropagation();onRemove()}}
            style={{background:"none",border:"none",color:C.red,cursor:"pointer",padding:3,borderRadius:3,opacity:0.5}}>
            {I.trash(11)}
          </button>
          <span style={{color:C.t4,marginLeft:2}}>{I.chev(10,expanded?"up":"down")}</span>
        </div>
      </div>
      {expanded&&(
        <div style={{borderTop:`1px solid ${C.b1}`,padding:"10px 12px 10px 42px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px 16px"}}>
          <div>
            <div style={{fontFamily:F.sans,fontSize:9,color:C.t4,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:2}}>To</div>
            <div style={{fontFamily:F.mono,fontSize:10.5,color:C.t2,wordBreak:"break-all"}}>{tx.to}</div>
          </div>
          {tx.signature&&(
            <div>
              <div style={{fontFamily:F.sans,fontSize:9,color:C.t4,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:2}}>Signature</div>
              <div style={{fontFamily:F.mono,fontSize:10.5,color:C.blue}}>{tx.signature}</div>
            </div>
          )}
          {tx.inputs.map(inp=>(
            <div key={inp.name}>
              <div style={{fontFamily:F.sans,fontSize:9,color:C.t4,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:2,display:"flex",alignItems:"center",gap:4}}>
                {inp.name} <TypeBadge type={inp.type}/>
              </div>
              <div style={{fontFamily:F.mono,fontSize:10.5,color:C.t1,wordBreak:"break-all"}}>{tx.params[inp.name]||"—"}</div>
            </div>
          ))}
          <div style={{gridColumn:"1 / -1"}}>
            <div style={{fontFamily:F.sans,fontSize:9,color:C.t4,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:2,display:"flex",alignItems:"center",gap:5}}>
              Calldata <button onClick={doCopy} style={{background:"none",border:"none",color:C.t4,cursor:"pointer",padding:0,display:"flex"}}>{copied?I.check(9):I.copy(9)}</button>
            </div>
            <div style={{fontFamily:F.mono,fontSize:9.5,color:C.t4,background:C.bg,padding:"6px 8px",borderRadius:5,wordBreak:"break-all",maxHeight:50,overflow:"auto"}}>{tx.data}</div>
          </div>
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

// ── Main ──
export default function App() {
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
  const [netOpen,setNetOpen]=useState(false);
  const [simulating,setSimulating]=useState(false);
  const [simResult,setSimResult]=useState(null);
  const [dragIdx,setDragIdx]=useState(null);
  const [dragOverIdx,setDragOverIdx]=useState(null);
  const [dragOverPos,setDragOverPos]=useState(null);
  const netRef=useRef(null);
  const safeRef=useRef(null);
  const [safeBookOpen,setSafeBookOpen]=useState(false);

  useEffect(()=>{
    if(!window.electronAPI) return;
    window.electronAPI.getChains().then(chains=>{
      if(!chains||!chains.length) return;
      const mapped=chains.filter(c=>c.status===1&&c.enabled!==false).map(c=>({
        id:Number(c.chainid),name:c.chainname,color:CHAIN_COLORS[Number(c.chainid)]||C.t3,
        rpcurl:c.rpcurl,apiurl:c.apiurl,blockexplorer:c.blockexplorer,
      }));
      if(mapped.length>0){setNetworks(mapped);setNetwork(mapped[0])}
    });
    window.electronAPI.getAddresses().then(addrs=>{
      if(addrs&&addrs.length) setAddresses(addrs);
    });
  },[]);

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
    };
    document.addEventListener("mousedown",h);return()=>document.removeEventListener("mousedown",h);
  },[]);
  useEffect(()=>{setSimResult(null)},[txs]);

  return (
    <div style={{fontFamily:F.sans,background:C.bg,minHeight:"100vh",color:C.t1,display:"flex",flexDirection:"column"}}>
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
          </div>
        </div>
        <div style={{flex:1}}/>
        <input value={batchName} onChange={e=>setBatchName(e.target.value)} placeholder="Untitled batch…"
          style={{fontFamily:F.sans,fontSize:11,padding:"4px 8px",borderRadius:5,border:"1px solid transparent",background:"transparent",color:C.t3,outline:"none",width:160,textAlign:"right"}}
          onFocus={e=>e.target.style.borderColor=C.b1} onBlur={e=>e.target.style.borderColor="transparent"}/>
      </div>

      {/* Main */}
      <div style={{flex:1,display:"grid",gridTemplateColumns:"1fr 1fr",overflow:"hidden"}}>
        {/* Left */}
        <div style={{borderRight:`1px solid ${C.b1}`,padding:"20px",overflowY:"auto"}}>
          <div style={{maxWidth:520}}>
            <div style={{fontSize:14,fontWeight:600,color:C.t1,marginBottom:16}}>New Transaction</div>
            <TransactionForm onAdd={addTx} addresses={addresses} chainId={network.id} network={network}
              onRescanAddresses={()=>{if(window.electronAPI)window.electronAPI.getAddresses().then(a=>{if(a?.length)setAddresses(a)})}}/>
            <div style={{marginTop:20,padding:14,border:`1px dashed ${C.b1}`,borderRadius:8,textAlign:"center"}}>
              <div style={{color:C.t4,fontSize:11,display:"flex",alignItems:"center",justifyContent:"center",gap:5}}>
                {I.ul(12)} Drop JSON batch or <span style={{color:C.acc,cursor:"pointer",textDecoration:"underline",textUnderlineOffset:2}}>browse</span>
              </div>
            </div>
          </div>
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
            <button onClick={()=>{setTxs([]);setSimResult(null)}} disabled={txs.length===0} style={{
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
          </div>

          {/* Bottom actions */}
          {(()=>{const ready=txs.length>0&&safeCheck?.valid;return(
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
            <button disabled={!ready} style={{
              fontFamily:F.sans,fontSize:12.5,fontWeight:600,flex:1,padding:"10px 0",borderRadius:7,
              border:"none",background:ready?C.acc:C.s3,color:ready?C.bg:C.t4,
              cursor:ready?"pointer":"not-allowed",
              display:"flex",alignItems:"center",justifyContent:"center",gap:7,
            }}>{I.send(13)} Create Batch</button>
          </div>)})()}
        </div>
      </div>

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
  );
}
