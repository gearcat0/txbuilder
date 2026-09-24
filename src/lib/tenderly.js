// Renderer-side Tenderly helpers. Simulation requests are built in the main
// process (src/lib/tenderly-sim.cjs), which also owns the access key usage.

export function tenderlyConfigured(settings) {
  return !!(settings && settings.tenderlyAccount && settings.tenderlyProject && settings.tenderlyKey);
}
