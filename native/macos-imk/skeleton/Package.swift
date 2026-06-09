// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "LekhInputMethod",
  platforms: [.macOS(.v13)],
  products: [
    .library(name: "LekhInputMethod", targets: ["LekhInputMethod"])
  ],
  targets: [
    .target(
      name: "LekhInputMethod",
      path: ".",
      exclude: ["lekh_imk_contract.md"],
      sources: [
        "LekhCandidateController.swift",
        "LekhInputController.swift",
        "LekhXpcClient.swift"
      ]
    )
  ]
)
