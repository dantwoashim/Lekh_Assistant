// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "LekhInputMethodPlaceholder",
  platforms: [.macOS(.v13)],
  products: [
    .library(name: "LekhInputMethodPlaceholder", targets: ["LekhInputMethodPlaceholder"])
  ],
  targets: [
    .target(
      name: "LekhInputMethodPlaceholder",
      path: ".",
      exclude: ["lekh_imk_contract.md"],
      sources: ["LekhInputController.placeholder.swift"]
    )
  ]
)
