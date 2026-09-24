// Renderer-side Tenderly helpers. Simulation requests are built in the main
// process (src/lib/tenderly-sim.cjs), which also owns the access key usage.
//
// Two places a simulation can run:
// - "safe" (default): Safe's public Tenderly project (safe/safe-apps) via the
//   endpoint the safe.global web app uses. No account needed, and Tenderly's
//   dashboard shows its Safe hash panel (domain / message / Safe tx hash) only
//   for simulations in that project. Simulations there are public.
// - "own": the user's own Tenderly account/project/access key.

export function tenderlyConfigured(settings) {
  return !!(settings && settings.tenderlyAccount && settings.tenderlyProject && settings.tenderlyKey);
}

export function simulationTarget(settings) {
  return settings?.simulationTarget === "own" ? "own" : "safe";
}

// Whether Simulate can run with the current settings.
export function simulationAvailable(settings) {
  return simulationTarget(settings) === "safe" || tenderlyConfigured(settings);
}

// The target-specific arguments for window.electronAPI.tenderlySimulate.
export function simulationArgs(settings) {
  return simulationTarget(settings) === "own"
    ? { target: "own", account: settings.tenderlyAccount, project: settings.tenderlyProject, accessKey: settings.tenderlyKey }
    : { target: "safe" };
}
