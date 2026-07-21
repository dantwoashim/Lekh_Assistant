const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lekhDesktop", {
  kind: "companion",
  platform: process.platform,
  arch: process.arch,
  versions: {
    app: process.env.npm_package_version || "1.0.0"
  },
  productBoundary:
    "This desktop shell manages settings, privacy, diagnostics, and install status. Native TSF/IMK input methods handle keystrokes.",
  getStatus: () => ipcRenderer.invoke("lekh:status"),
  readPreferences: () => ipcRenderer.invoke("lekh:preferences:read"),
  updatePreferences: (patch) => ipcRenderer.invoke("lekh:preferences:update", patch),
  openKeyboardSettings: () => ipcRenderer.invoke("lekh:open-keyboard-settings"),
  revealInputMethod: () => ipcRenderer.invoke("lekh:reveal-input-method"),
  chooseExcludedApplications: () => ipcRenderer.invoke("lekh:privacy:choose-excluded-applications"),
  checkForUpdates: () => ipcRenderer.invoke("lekh:updates:check"),
  downloadVerifiedUpdate: () => ipcRenderer.invoke("lekh:updates:download")
});
