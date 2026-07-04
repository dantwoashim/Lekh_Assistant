// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "LekhInputMethod",
  platforms: [.macOS(.v13)],
  products: [
    .library(name: "LekhInputMethod", targets: ["LekhInputMethod"]),
    .executable(name: "LekhInputMethodApp", targets: ["LekhInputMethodApp"]),
    .executable(name: "LekhInputMethodBehaviorProbe", targets: ["LekhInputMethodBehaviorProbe"])
  ],
  dependencies: [],
  targets: [
    .target(
      name: "LekhInputMethod",
      path: ".",
      exclude: [
        "App",
        "atomic-install-swap.swift",
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
        "uninstall-dev.sh",
        "Tests"
      ],
      sources: [
        "LekhCandidatePanel.swift",
        "LekhCandidateController.swift",
        "LekhDictionaryPackVerifier.swift",
        "LekhDictionaryPackWatcher.swift",
        "LekhDiagnostics.swift",
        "LekhFont.swift",
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
        "LekhInputMethod"
      ],
      path: "App",
      sources: ["main.swift"]
    ),
    .executableTarget(
      name: "LekhInputMethodBehaviorProbe",
      dependencies: [
        "LekhInputMethod"
      ],
      path: "Tests/LekhInputMethodBehaviorProbe",
      sources: ["main.swift"]
    )
  ]
)
