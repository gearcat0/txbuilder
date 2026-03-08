# TX Builder — Electron App

## What this is
A standalone Electron app reimagining Safe Wallet's Transaction Builder with better information density and UX.

## Key design decisions already made
- Dark theme, JetBrains Mono + DM Sans fonts
- Split panel: form left, batch list right (batch panel appears after first tx added)
- ABI collapsed into a single summary strip (expandable), not a textarea
- Proxy contracts: both ABIs loaded with inline toggle, implementation default, no modal
- Method selector dropdown shows full parameter signatures with color-coded type badges
- Batch rows show inline param=value pairs without expanding
- Drag-and-drop reordering on batch items (HTML5 drag API) plus up/down arrow buttons
- Simulate button available as soon as 1+ transactions exist, results inline in batch list
- Custom data toggle for raw hex calldata entry

## Tech
- React (currently single-file JSX artifact)
- No external state management, just useState/useRef
- No localStorage — all in-memory
- Styling: inline styles with design token objects (C for colors, F for fonts)

## What's next
- Convert to proper Electron app structure
- Wire up real ABI fetching from Etherscan/Sourcify
- Real calldata encoding (ethers.js or viem)
- Tenderly simulation integration
- JSON batch import/export with Safe-compatible format
