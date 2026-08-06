// Electron stub for tests. main.js is loaded as native CJS, so tests inject
// this via a Module._resolveFilename patch (see main-handlers.test.js) —
// vi.mock and vite aliases never see native require("electron"). Captures
// every ipcMain.handle registration so tests can invoke handlers directly.
const __handlers = new Map();

module.exports = {
  __handlers,
  ipcMain: {
    handle: (channel, fn) => __handlers.set(channel, fn),
  },
  app: {
    isPackaged: false,
    whenReady: () => new Promise(() => {}), // never resolves — no window in tests
    on: () => {},
    getVersion: () => "0.0.0-test",
    name: "txbuilder-test",
  },
  BrowserWindow: class BrowserWindow {},
  Menu: {
    buildFromTemplate: () => ({}),
    setApplicationMenu: () => {},
  },
};
