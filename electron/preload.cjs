const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("lekhDesktop", {
  kind: "companion",
  platform: process.platform,
  arch: process.arch,
  versions: {
    app: process.env.npm_package_version || "0.1.0-week1"
  },
  productBoundary:
    "This desktop shell manages settings, privacy, diagnostics, and install status. Native TSF/IMK input methods handle keystrokes."
});
