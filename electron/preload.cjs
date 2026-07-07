const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lekhDesktop", {
  kind: "companion",
  platform: process.platform,
  arch: process.arch,
  versions: {
    app: process.env.npm_package_version || "0.1.0-week1"
  },
  productBoundary:
    "This desktop shell manages settings, privacy, diagnostics, and install status. Native TSF/IMK input methods handle keystrokes.",
  getStatus: () => ipcRenderer.invoke("lekh:status"),
  readPreferences: () => ipcRenderer.invoke("lekh:preferences:read"),
  updatePreferences: (patch) => ipcRenderer.invoke("lekh:preferences:update", patch),
  openKeyboardSettings: () => ipcRenderer.invoke("lekh:open-keyboard-settings"),
  revealInputMethod: () => ipcRenderer.invoke("lekh:reveal-input-method"),
  checkForUpdates: () => ipcRenderer.invoke("lekh:updates:check"),
  downloadVerifiedUpdate: () => ipcRenderer.invoke("lekh:updates:download")
});
