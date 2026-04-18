const { app, BrowserWindow } = require("electron");
const path = require("path");
const { fork } = require("child_process");

let serverProcess;
let mainWindow;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function startServer() {
  const serverPath = path.join(__dirname, "..", "server", "index.js");
  serverProcess = fork(serverPath);
  serverProcess.on("error", (error) => {
    console.error("[server] failed to start", error);
  });
  serverProcess.on("exit", (code, signal) => {
    console.error(`[server] exited code=${code} signal=${signal || "none"}`);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 520,
    height: 620,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    transparent: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  mainWindow = win;
}

app.whenReady().then(() => {
  startServer();
  createWindow();
});

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});

process.on("SIGINT", () => {
  app.quit();
});

process.on("SIGTERM", () => {
  app.quit();
});
