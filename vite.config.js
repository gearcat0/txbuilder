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
    include: ["events"],
  },
  server: {
    port: 5173,
  },
});
