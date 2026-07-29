// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "LekhInputMethod",
  defaultLocalization: "en",
  platforms: [.macOS(.v13)],
  products: [
    .library(name: "LekhInputMethod", targets: ["LekhInputMethod"]),
    .executable(name: "LekhInputMethodApp", targets: ["LekhInputMethodApp"]),
    .executable(name: "LekhInputMethodBehaviorProbe", targets: ["LekhInputMethodBehaviorProbe"]),
    .executable(name: "LekhInputMethodUnitProbe", targets: ["LekhInputMethodUnitProbe"]),
    .executable(name: "LekhBehaviorContractRunner", targets: ["LekhBehaviorContractRunner"]),
    .executable(name: "LekhNeuralComputePlanProbe", targets: ["LekhNeuralComputePlanProbe"])
  ],
  dependencies: [],
  targets: [
    .target(
      name: "LekhInputMethod",
      path: ".",
      exclude: [
        "App",
        "atomic-install-swap.swift",
        "detect-quarantine.sh",
        "Info.plist",
        "PkgInfo",
        "Resources",
        "install-dev.sh",
        "lekh_imk_contract.md",
        "macosImkSource.test.ts",
        "manual-host-textedit-test.sh",
        "purge-lekh-input-sources.swift",
        "register-dev.swift",
        "restore-system-keyboard.sh",
        "restore-system-keyboard.swift",
        "terminate-exact-processes.swift",
        "uninstall-dev.sh",
        "verify-release-manifest.swift",
        "Tests"
      ],
      sources: [
        "LekhCandidatePanel.swift",
        "LekhInlinePreviewPanel.swift",
        "LekhCandidateController.swift",
        "LekhDictionaryPackVerifier.swift",
        "LekhDictionaryPackWatcher.swift",
        "LekhDiagnostics.swift",
        "LekhFont.swift",
        "LekhInputController.swift",
        "LekhKeyboardLayoutTranslator.swift",
        "LekhLocalization.swift",
        "LekhMetricReporter.swift",
        "LekhIPCProtocol.generated.swift",
        "LekhNativePreferences.swift",
        "LekhNeuralCandidateService.swift",
        "LekhPreferencesWindow.swift",
        "LekhRuntimeHealth.swift",
        "LekhTokenCompletionIndex.swift",
        "LekhEngineCore.swift"
      ],
      linkerSettings: [
        .linkedFramework("CoreML"),
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
    ),
    .executableTarget(
      name: "LekhInputMethodUnitProbe",
      dependencies: [
        "LekhInputMethod"
      ],
      path: "Tests/LekhInputMethodUnitProbe",
      sources: ["main.swift"]
    ),
    .executableTarget(
      name: "LekhBehaviorContractRunner",
      dependencies: [
        "LekhInputMethod"
      ],
      path: "Tests/LekhBehaviorContractRunner",
      sources: ["main.swift"]
    ),
    .executableTarget(
      name: "LekhNeuralComputePlanProbe",
      path: "Tests/LekhNeuralComputePlanProbe",
      sources: ["LekhNeuralComputePlanProbe.swift"],
      linkerSettings: [
        .linkedFramework("CoreML")
      ]
    )
  ]
)
