const { app, BrowserWindow, Menu, shell } = require("electron");
const { existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");

const isDevServer = Boolean(process.env.LEKH_COMPANION_DEV_SERVER);
let daemonProcess = null;

function createWindow() {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    title: "Lekh Keyboard Companion",
    backgroundColor: "#f7f4ef",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const appUrl = isDevServer
      ? process.env.LEKH_COMPANION_DEV_SERVER
      : `file://${path.join(__dirname, "..", "dist", "index.html")}`;
    if (!url.startsWith(appUrl) && isSafeExternalUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  if (isDevServer) {
    window.loadURL(process.env.LEKH_COMPANION_DEV_SERVER);
  } else {
    window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

function isSafeExternalUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
}

app.setName("Lekh Keyboard Companion");
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  startDaemonIfAvailable();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (daemonProcess && !daemonProcess.killed) {
    daemonProcess.kill();
    daemonProcess = null;
  }
});

function startDaemonIfAvailable() {
  if (process.platform !== "win32") return;
  const daemonPath = app.isPackaged
    ? path.join(process.resourcesPath, "native", "daemon", "lekh-keyboard-daemon.mjs")
    : path.join(__dirname, "..", "native", "daemon", "dist", "lekh-keyboard-daemon.mjs");

  if (!existsSync(daemonPath)) return;

  daemonProcess = spawn(process.execPath, [daemonPath, "--named-pipe"], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1"
    },
    stdio: "ignore",
    detached: false,
    windowsHide: true
  });
  daemonProcess.once("exit", () => {
    daemonProcess = null;
  });
}
