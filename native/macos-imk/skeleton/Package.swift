// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "LekhInputMethod",
  platforms: [.macOS(.v13)],
  products: [
    .library(name: "LekhInputMethod", targets: ["LekhInputMethod"]),
    .executable(name: "LekhInputMethodApp", targets: ["LekhInputMethodApp"])
  ],
  dependencies: [
    .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.7.0")
  ],
  targets: [
    .target(
      name: "LekhInputMethod",
      path: ".",
      exclude: [
        "App",
        "Info.plist",
        "PkgInfo",
        "install-dev.sh",
        "lekh_imk_contract.md",
        "macosImkSource.test.ts",
        "manual-host-textedit-test.sh",
        "purge-lekh-input-sources.swift",
        "register-dev.swift",
        "restore-system-keyboard.sh",
        "restore-system-keyboard.swift",
        "uninstall-dev.sh"
      ],
      sources: [
        "LekhCandidatePanel.swift",
        "LekhCandidateController.swift",
        "LekhDictionaryPackVerifier.swift",
        "LekhDictionaryPackWatcher.swift",
        "LekhDiagnostics.swift",
        "LekhInputController.swift",
        "LekhLocalization.swift",
        "LekhMetricReporter.swift",
        "LekhNativePreferences.swift",
        "LekhNeuralTransliterator.swift",
        "LekhPreferencesWindow.swift",
        "LekhXpcClient.swift"
      ],
      linkerSettings: [
        .linkedLibrary("sqlite3")
      ]
    ),
    .executableTarget(
      name: "LekhInputMethodApp",
      dependencies: [
        "LekhInputMethod",
        .product(name: "Sparkle", package: "Sparkle")
      ],
      path: "App",
      sources: ["main.swift"]
    )
  ]
)
