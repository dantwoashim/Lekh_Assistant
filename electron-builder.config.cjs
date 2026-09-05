const path = require("node:path");

const windowsArchitecture = (process.env.LEKH_WINDOWS_ARCHITECTURE || "x64").toLowerCase();
if (!["x64", "arm64"].includes(windowsArchitecture)) {
  throw new Error(`Unsupported LEKH_WINDOWS_ARCHITECTURE: ${windowsArchitecture}`);
}
const windowsNativeBuildDirectory = windowsArchitecture === "arm64" ? "build-ARM64" : "build";
const windowsCompatibilityResources = [{
  from: "native/windows-tsf/skeleton/build-Win32/bin/Release/LekhTextService.dll",
  to: "native/windows-tsf/build-x86/bin/Release/LekhTextService.dll"
}];

async function applyHardenedElectronFuses(context) {
  const { applyHardenedElectronFusePolicy } = await import("./scripts/lib/electron-fuse-policy.mjs");
  const extension = {
    darwin: ".app",
    mas: ".app",
    win32: ".exe",
    linux: ""
  }[context.electronPlatformName];
  if (extension === undefined) {
    throw new Error(`Unsupported Electron platform for fuse hardening: ${context.electronPlatformName}`);
  }
  const executable = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}${extension}`
  );
  await applyHardenedElectronFusePolicy(executable);
}

module.exports = {
  appId: "com.lekh.keyboard.companion",
  productName: "Lekh Keyboard Companion",
  copyright: "Copyright © 2026 Lekh",
  directories: {
    output: "release",
    buildResources: "build"
  },
  files: [
    "dist/**/*",
    "electron/**/*",
    "build/icon.ico",
    "native/shared/ipc/**/*",
    "native/shared/storage/**/*",
    "native/daemon/src/**/*",
    "package.json"
  ],
  extraResources: [
    {
      from: "native/daemon/dist",
      to: "native/daemon",
      filter: ["**/*"]
    },
    {
      from: `native/windows-tsf/skeleton/${windowsNativeBuildDirectory}/bin/Release`,
      to: "native/windows-tsf/build/bin/Release",
      filter: [
        "LekhTextService.dll",
        "LekhPipeBroker.exe"
      ]
    },
    ...windowsCompatibilityResources,
    {
      from: "docs/WINDOWS_RELEASE_BUILD.md",
      to: "docs/WINDOWS_RELEASE_BUILD.md"
    },
    {
      from: "docs/SIGNING_AND_NOTARIZATION_CHECKLIST.md",
      to: "docs/SIGNING_AND_NOTARIZATION_CHECKLIST.md"
    }
  ],
  asar: true,
  afterPack: applyHardenedElectronFuses,
  npmRebuild: false,
  win: {
    executableName: "Lekh Keyboard Companion",
    artifactName: "Lekh-Keyboard-Companion-${version}-Setup-${arch}.${ext}",
    icon: "build/icon.ico",
    target: [
      {
        target: "nsis",
        arch: [windowsArchitecture]
      }
    ]
  },
  nsis: {
    oneClick: false,
    perMachine: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: false,
    deleteAppDataOnUninstall: false,
    include: "build/installer/windows/installer.nsh"
  },
  mac: {
    icon: "build/icon.icns",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist"
  }
};
