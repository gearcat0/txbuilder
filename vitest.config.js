import { defineConfig } from "vitest/config";

// Standalone vitest config — tests don't need vite.config.js's React plugin
// or the events/buffer browser shims.
export default defineConfig({
  test: {
    environment: "node",
  },
});
