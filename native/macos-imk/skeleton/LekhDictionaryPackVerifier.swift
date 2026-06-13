import Foundation

#if canImport(CryptoKit)
import CryptoKit
#endif

public enum LekhDictionaryPackVerifier {
  public struct Result {
    public let url: URL?
    public let warning: String?
    public let source: String

    public static let disabled = Result(url: nil, warning: nil, source: "bundle")
    public static let noInstalledPack = Result(url: nil, warning: nil, source: "bundle")
  }

  private struct Manifest: Decodable {
    struct Delta: Decodable {
      let sha256: String?
    }

    struct Signature: Decodable {
      let algorithm: String
      let valueBase64: String
    }

    let version: String
    let binaryFormat: String
    let binaryFormatVersion: Int?
    let sha256: String
    let bytes: Int
    let minAppVersion: String
    let minAppBuild: Int?
    let maxAppBuild: Int?
    let path: String?
    let delta: Delta?
    let signature: Signature?
  }

  public static let activeManifestURL = LekhDictionaryPackWatcher.packsDirectory.appendingPathComponent("runtime-suggestions.current.json")

  public static func hasUsableEmbeddedPublicKey() -> Bool {
    guard Bundle.main.object(forInfoDictionaryKey: "LekhDictionaryPackUpdatesEnabled") as? Bool == true,
          let publicKeyBase64 = Bundle.main.object(forInfoDictionaryKey: "LekhDictionaryPackEd25519PublicKeyBase64") as? String,
          !publicKeyBase64.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          let publicKeyBytes = Data(base64Encoded: publicKeyBase64.trimmingCharacters(in: .whitespacesAndNewlines)),
          publicKeyBytes.count == 32 else {
      return false
    }
    return true
  }

  public static func verifiedInstalledPackURL() -> URL? {
    installedPackStatus().url
  }

  public static func installedPackStatus() -> Result {
    #if canImport(CryptoKit)
    guard hasUsableEmbeddedPublicKey() else {
      return .disabled
    }
    guard FileManager.default.fileExists(atPath: LekhDictionaryPackWatcher.activePackURL.path) ||
            FileManager.default.fileExists(atPath: activeManifestURL.path) else {
      return .noInstalledPack
    }
    guard FileManager.default.fileExists(atPath: LekhDictionaryPackWatcher.activePackURL.path),
          FileManager.default.fileExists(atPath: activeManifestURL.path) else {
      return rejected("dictionary update rejected: missing pack or manifest")
    }
    guard let publicKeyBase64 = Bundle.main.object(forInfoDictionaryKey: "LekhDictionaryPackEd25519PublicKeyBase64") as? String,
          let publicKeyBytes = Data(base64Encoded: publicKeyBase64.trimmingCharacters(in: .whitespacesAndNewlines)) else {
      return rejected("dictionary update rejected: missing public key")
    }
    guard let manifestData = try? Data(contentsOf: activeManifestURL),
          let manifest = try? JSONDecoder().decode(Manifest.self, from: manifestData) else {
      return rejected("dictionary update rejected: invalid manifest")
    }
    guard let packData = try? Data(contentsOf: LekhDictionaryPackWatcher.activePackURL, options: [.mappedIfSafe]) else {
      return rejected("dictionary update rejected: pack unreadable")
    }

    guard manifest.binaryFormat == "LEKHBLX1" else {
      return rejected("dictionary update rejected: invalid binary format")
    }
    guard (manifest.binaryFormatVersion ?? 1) == 1 else {
      return rejected("dictionary update rejected: unsupported binary format version")
    }
    guard isCompatible(manifest) else {
      return rejected("dictionary update rejected: incompatible app version")
    }
    guard manifest.bytes == packData.count else {
      return rejected("dictionary update rejected: byte count mismatch")
    }
    guard packData.starts(with: Array("LEKHBLX1".utf8)) else {
      return rejected("dictionary update rejected: invalid pack header")
    }
    guard sha256Hex(packData) == manifest.sha256.lowercased() else {
      return rejected("dictionary update rejected: sha256 mismatch")
    }
    guard let signature = manifest.signature,
          signature.algorithm == "Ed25519",
          let signatureData = Data(base64Encoded: signature.valueBase64) else {
      return rejected("dictionary update rejected: unsigned pack")
    }

    guard let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKeyBytes),
          publicKey.isValidSignature(signatureData, for: signatureMessage(manifest)) else {
      return rejected("dictionary update rejected: invalid signature")
    }
    return Result(url: LekhDictionaryPackWatcher.activePackURL, warning: nil, source: "signed-update")
    #else
    return rejected("dictionary update rejected: CryptoKit unavailable")
    #endif
  }

  private static func rejected(_ warning: String) -> Result {
    Result(url: nil, warning: warning, source: "bundle")
  }

  private static func signatureMessage(_ manifest: Manifest) -> Data {
    let formatVersion = String(manifest.binaryFormatVersion ?? 1)
    let minBuild = manifest.minAppBuild.map(String.init) ?? ""
    let maxBuild = manifest.maxAppBuild.map(String.init) ?? ""
    let path = manifest.path ?? ""
    let deltaSha256 = manifest.delta?.sha256?.lowercased() ?? ""
    let components: [String] = [
      "LEKH_PACK_V2",
      manifest.version,
      manifest.sha256.lowercased(),
      String(manifest.bytes),
      manifest.binaryFormat,
      formatVersion,
      manifest.minAppVersion,
      minBuild,
      maxBuild,
      path,
      deltaSha256
    ]
    return Data(components.joined(separator: "\n").utf8)
  }

  private static func isCompatible(_ manifest: Manifest) -> Bool {
    let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    let appBuild = Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 0
    if compareVersion(appVersion, manifest.minAppVersion) == .orderedAscending {
      return false
    }
    if let minBuild = manifest.minAppBuild, appBuild < minBuild {
      return false
    }
    if let maxBuild = manifest.maxAppBuild, appBuild > maxBuild {
      return false
    }
    return true
  }

  private static func compareVersion(_ left: String, _ right: String) -> ComparisonResult {
    let leftParts = left.split(separator: ".").map { Int($0) ?? 0 }
    let rightParts = right.split(separator: ".").map { Int($0) ?? 0 }
    let count = max(leftParts.count, rightParts.count)
    for index in 0..<count {
      let leftValue = index < leftParts.count ? leftParts[index] : 0
      let rightValue = index < rightParts.count ? rightParts[index] : 0
      if leftValue < rightValue { return .orderedAscending }
      if leftValue > rightValue { return .orderedDescending }
    }
    return .orderedSame
  }

  #if canImport(CryptoKit)
  private static func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data)
      .map { String(format: "%02x", $0) }
      .joined()
  }
  #endif
}
