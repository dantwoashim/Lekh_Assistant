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
      from: "native/windows-tsf/skeleton",
      to: "native/windows-tsf",
      filter: [
        "build/bin/Release/LekhTextService.dll",
        "build/bin/Release/LekhPipeBroker.exe"
      ]
    },
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
  npmRebuild: false,
  win: {
    executableName: "Lekh Keyboard Companion",
    artifactName: "Lekh-Keyboard-Companion-${version}-Setup-${arch}.${ext}",
    icon: "build/icon.ico",
    target: [
      {
        target: "nsis",
        arch: ["x64"]
      }
    ]
  },
  nsis: {
    oneClick: false,
    perMachine: false,
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
