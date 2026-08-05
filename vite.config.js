import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  // @trezor/connect-web (and friends) `require("events")`; Vite's default
  // would externalize the Node builtin, leaving EventEmitter undefined.
  // Force resolution to the browser-compatible `events` npm package.
  resolve: {
    alias: {
      events: "events/events.js",
    },
  },
  optimizeDeps: {
    include: ["events", "buffer"],
  },
  server: {
    port: 5173,
  },
  build: {
    // Electron renderer loads from disk, so chunk size only matters as a
    // canary for accidental bloat — warn on order-of-magnitude jumps only.
    chunkSizeWarningLimit: 1500,
  },
});
