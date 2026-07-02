import "./polyfills.js"; // must run before any Ledger (hw-app-eth) import
import React from "react";
import { createRoot } from "react-dom/client";
import App from "../transaction-builder.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
