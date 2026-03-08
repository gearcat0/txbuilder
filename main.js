const { app, BrowserWindow } = require("electron");
const path = require("path");

const isDev = !app.isPackaged;

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
    },
  });

  win.loadFile(path.join(__dirname, "dist", "index.html"));
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
