const { app, BrowserWindow, ipcMain } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const isDev = !app.isPackaged;

function getDataDir() {
  const platform = process.platform;
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "txbuilder");
  if (platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "txbuilder");
  return path.join(os.homedir(), ".local", "txbuilder");
}

const settingsPath = path.join(getDataDir(), "settings.json");

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath, "utf-8")); }
  catch { return {}; }
}

function saveSettings(data) {
  const dir = path.dirname(settingsPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));
}

ipcMain.handle("load-settings", () => loadSettings());
ipcMain.handle("save-settings", (_event, data) => { saveSettings(data); return true; });

function runAddressbook(args) {
  return new Promise((resolve, reject) => {
    execFile("evmaddressbook", args, { timeout: 10000 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(e); }
    });
  });
}

ipcMain.handle("get-chains", () => runAddressbook(["--chains"]).catch(() => []));
ipcMain.handle("get-addresses", () => runAddressbook(["--addresses"]).catch(() => []));
ipcMain.handle("get-abi", (_event, { address, chainId }) =>
  runAddressbook(["--abi", address, String(chainId)]).catch(() => null)
);
ipcMain.handle("scan-address", (_event, { address, chainId }) =>
  runAddressbook(["--scan", address, String(chainId)]).catch(() => null)
);

ipcMain.handle("check-code", async (_event, { rpcUrl, address }) => {
  if (!rpcUrl || !address) return { hasCode: null };
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
    });
    const json = await res.json();
    if (json.error) return { hasCode: null };
    const code = json.result;
    return { hasCode: !!(code && code !== "0x" && code !== "0x0") };
  } catch (e) {
    return { hasCode: null };
  }
});

ipcMain.handle("eth-call", async (_event, { rpcUrl, to, data }) => {
  if (!rpcUrl || !to) return { error: "Missing params" };
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    });
    const json = await res.json();
    if (json.error) return { error: json.error.message };
    return { result: json.result };
  } catch (e) {
    return { error: e.message };
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 2560,
    height: 1640,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#08080A",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 14 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  const devServer = process.env.VITE_DEV_SERVER === "1";
  if (devServer) {
    win.loadURL("http://localhost:5173");
  } else {
    win.loadFile(path.join(__dirname, "dist", "index.html"));
  }
  win.webContents.on("did-finish-load", () => {
    win.webContents.setZoomFactor(2);
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
