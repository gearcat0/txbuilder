import "./polyfills.js"; // must run before any Ledger (hw-app-eth) import
import React from "react";
import { createRoot } from "react-dom/client";
import App from "../transaction-builder.jsx";
import "evm-ui/styles.css";
// Fonts are vendored (bundled woff2, no Google Fonts request) — the app must
// not touch the network for its own chrome.
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource/dm-sans/800.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/jetbrains-mono/800.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
