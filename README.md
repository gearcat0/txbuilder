# TX Builder

[![CI](https://github.com/gearcat0/txbuilder/actions/workflows/ci.yml/badge.svg)](https://github.com/gearcat0/txbuilder/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

A standalone Electron desktop app for building Safe-compatible transaction batches. A reimagining of Safe Wallet's Transaction Builder with denser information and tighter UX.

## Features

- Build multi-step transaction batches against any EVM chain configured via [`evmaddressbook`](https://github.com/) (chains, addresses, RPCs, ABIs)
- Type-aware Solidity argument validation with EIP-55 checksum checks and on-chain code verification
- Contract capability detection without an ABI — classification, proxy resolution, Safe recognition, interface probes, and bytecode-derived method lists (see below)
- On-disk ABI cache: repeat loads of known contracts are instant and offline
- Proxy/implementation ABI handling with inline toggle, proxy chain resolved on-chain (EIP-1967, EIP-1167, beacon, Safe)
- Read/Write/Events/Custom-data tabs per contract
- Local signing of Safe transactions (private keys never leave the machine)
- Safe Transaction Service integration: propose, view pending, view history, reject
- Pending screen filtered by on-chain nonce so rejected proposals are dropped
- History pagination, date/block filters, and CSV/JSON export
- Per-second + monthly Safe API rate-limit awareness with a status footer
- Drag-and-drop batch reordering, simulate, save/load batches

## Capability detection

When you enter a target address, TX Builder works out what it can do even when no ABI is on file, using a layered pipeline (each layer only runs when the ones above it miss):

1. **Classification** — `eth_getCode` distinguishes plain EOAs, EIP-7702 delegated EOAs (shown with their delegate), and contracts.
2. **Proxy resolution** — the proxy chain is walked on-chain (up to 3 hops): EIP-1967 implementation/beacon slots, EIP-1167 minimal-proxy bytecode, and Safe proxies (slot-0 singleton). The resolved implementation drives the ABI lookup, with the impl/proxy toggle and a chain breadcrumb in the ABI strip.
3. **Safe recognition** — deployments from every Safe version (1.0.0–1.5.0, including MultiSend, MultiSendCallOnly, and fallback handlers) are bundled via `@safe-global/safe-deployments` and matched exactly by address, codehash, or `VERSION()`. Recognized Safes get the right version's full ABI offline, tagged `Safe v1.x`.
4. **Interface probes** — ERC-165 (`supportsInterface`, validated with the mandatory `0xffffffff` check) detects ERC-721/1155; ERC-20 is probed via `decimals`/`symbol`/`totalSupply`. Detected interfaces show as chips in the ABI strip.
5. **Bytecode analysis** — as a last resort, function selectors, argument types, and mutability are extracted from the runtime bytecode with [evmole](https://github.com/cdump/evmole). Names come from a bundled signature database (regenerate with `npm run gen:signatures`), then from [openchain.xyz](https://openchain.xyz) for the leftovers (only 4-byte selectors are sent, results are keccak-verified and cached). Methods that stay unnamed appear as `unknown_0x…` with inferred parameter types and still encode with the correct selector. Everything from this layer is badged `detected`/`unknown` as lower-confidence than a fetched ABI.

Probes are batched (single JSON-RPC POST, sequential fallback for endpoints without batch support) and every RPC call has a 10-second timeout; without a working RPC endpoint the app degrades to the addressbook-only flow.

Results and fetched ABIs are cached under `abi-cache/` in the app data directory, invalidated by bytecode codehash rather than TTL — a proxy upgrade or redeploy busts the cache automatically, and the ABI-strip Refresh button forces it. Detected ABIs are content-addressed by codehash, so identical bytecode at other addresses (or on other chains) hits the cache instantly.

## Prerequisites

- **Node.js** 18 or newer
- **npm** (bundled with Node)

Optional, only needed by some workflows:

- [`evmaddressbook`](https://github.com/) CLI on `$PATH` for chain/address/ABI data
- A Safe Transaction Service API key (set in Settings) to use the Safe API features
- An Etherscan-family API key (set in Settings) for ABI fetches

## Development

Install dependencies and start the dev shell (Vite + Electron with hot reload):

```sh
npm install
npm run dev
```

The Vite dev server runs on port `5173`; Electron loads it via `VITE_DEV_SERVER=1`.

## Tests

```sh
npm test            # run once (vitest)
npm run test:watch  # watch mode
```

The suite covers the capability-detection pipeline (`tests/detect.test.js`, with a scripted RPC — no network), Safe deployment matching (`tests/safe-abis.test.js`), the signature DB's integrity (`tests/signatures.test.js`, every selector re-verified against keccak), and the real `main.js` IPC handlers (`tests/main-handlers.test.js` — batch RPC fallback, ABI-cache invalidation, signature-lookup caching). For the last one, `electron` is stubbed via a `Module._resolveFilename` patch and `HOME` is pointed at a temp directory, so tests never touch real user data.

## Building releases

The build pipeline is `vite build` → `electron-builder`. Output goes to `release/`.

| Command              | Targets                                              |
| -------------------- | ---------------------------------------------------- |
| `npm run build`      | The current host platform                            |
| `npm run build:mac`  | macOS — `.dmg` and `.zip`, both `x64` and `arm64`    |
| `npm run build:win`  | Windows — NSIS installer and portable `.exe` (`x64`) |
| `npm run build:linux`| Linux — `AppImage`, `.deb`, `.tar.gz` (`x64`)        |
| `npm run build:all`  | macOS + Windows + Linux in one run                   |

### Cross-compiling notes

`electron-builder` can produce most artifacts from any host, but a few combinations have constraints:

- **macOS builds must run on macOS.** Code signing and `.dmg` creation require macOS tooling. On Apple Silicon, `arm64` and `x64` are produced natively; on Intel Macs, `arm64` cross-builds work but are unsigned.
- **Windows builds from Linux/macOS** work out of the box for the artifacts here (NSIS, portable). Code signing requires the signing tools and a certificate; without them the binary is unsigned.
- **Linux builds from macOS/Windows** also work, though `.deb` packaging benefits from `dpkg`/`fakeroot` being present.

If you only care about your own platform, `npm run build` is the simplest option.

### Output

Artifacts land in `release/`:

```
release/
  TX Builder-0.1.0.dmg
  TX Builder-0.1.0-mac.zip
  TX Builder Setup 0.1.0.exe
  TX Builder 0.1.0.exe         # portable
  TX Builder-0.1.0.AppImage
  tx-builder_0.1.0_amd64.deb
  tx-builder-0.1.0.tar.gz
```

The `release/` directory is git-ignored.

### Customising the build

`electron-builder` configuration lives in the `build` block of `package.json`. The app icon is `build/icon.png` (1024×1024), from which `electron-builder` derives all platform formats; regenerate or tweak it with `python3 build/make_icon.py` (requires Pillow).

## Project layout

```
main.js                   # Electron main process: IPC handlers, Safe API, RPC, ABI cache, evmole
preload.js                # contextBridge — exposes electronAPI to renderer
transaction-builder.jsx   # Single-file React renderer
src/main.jsx              # React entry that mounts transaction-builder.jsx
src/lib/detect.js         # Capability detection pipeline (classification, proxies, probes)
src/lib/safe-abis.js      # Bundled Safe deployment ABIs + address/codehash matching
src/data/signatures.json  # Bundled selector → signature DB (npm run gen:signatures)
scripts/generate-signatures.js  # Generator for the signature DB
vite.config.js            # Vite config
index.html                # Renderer entry HTML
```

User data (settings, saved batches, the ABI cache) is stored under the platform's standard data directory:

- macOS: `~/Library/Application Support/txbuilder/`
- Windows: `%APPDATA%/txbuilder/`
- Linux: `~/.local/txbuilder/`

## License

MIT
