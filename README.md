# TX Builder

A standalone Electron desktop app for building Safe-compatible transaction batches. A reimagining of Safe Wallet's Transaction Builder with denser information and tighter UX.

## Features

- Build multi-step transaction batches against any EVM chain configured via [`evmaddressbook`](https://github.com/) (chains, addresses, RPCs, ABIs)
- Type-aware Solidity argument validation with EIP-55 checksum checks and on-chain code verification
- Proxy/implementation ABI handling with inline toggle
- Read/Write/Events/Custom-data tabs per contract
- Local signing of Safe transactions (private keys never leave the machine)
- Safe Transaction Service integration: propose, view pending, view history, reject
- Pending screen filtered by on-chain nonce so rejected proposals are dropped
- History pagination, date/block filters, and CSV/JSON export
- Per-second + monthly Safe API rate-limit awareness with a status footer
- Drag-and-drop batch reordering, simulate, save/load batches

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

`electron-builder` configuration lives in the `build` block of `package.json`. Add an icon by dropping `icon.icns` (mac), `icon.ico` (win), and a 512×512 `icon.png` (linux) into a `build/` directory at the repo root — `electron-builder` will pick them up automatically (`directories.buildResources` is set to `build`).

## Project layout

```
main.js                   # Electron main process: IPC handlers, Safe API, throttle
preload.js                # contextBridge — exposes electronAPI to renderer
transaction-builder.jsx   # Single-file React renderer
src/main.jsx              # React entry that mounts transaction-builder.jsx
vite.config.js            # Vite config
index.html                # Renderer entry HTML
```

User data (settings, saved batches) is stored under the platform's standard data directory:

- macOS: `~/Library/Application Support/txbuilder/`
- Windows: `%APPDATA%/txbuilder/`
- Linux: `~/.local/txbuilder/`

## License

MIT
