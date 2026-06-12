import Foundation

#if canImport(CryptoKit)
import CryptoKit
#endif

public enum LekhDictionaryPackVerifier {
  private struct Manifest: Decodable {
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
    #if canImport(CryptoKit)
    guard hasUsableEmbeddedPublicKey(),
          FileManager.default.fileExists(atPath: LekhDictionaryPackWatcher.activePackURL.path),
          FileManager.default.fileExists(atPath: activeManifestURL.path),
          let publicKeyBase64 = Bundle.main.object(forInfoDictionaryKey: "LekhDictionaryPackEd25519PublicKeyBase64") as? String,
          let publicKeyBytes = Data(base64Encoded: publicKeyBase64.trimmingCharacters(in: .whitespacesAndNewlines)),
          let manifestData = try? Data(contentsOf: activeManifestURL),
          let manifest = try? JSONDecoder().decode(Manifest.self, from: manifestData),
          let packData = try? Data(contentsOf: LekhDictionaryPackWatcher.activePackURL, options: [.mappedIfSafe]) else {
      return nil
    }

    guard manifest.binaryFormat == "LEKHBLX1",
          (manifest.binaryFormatVersion ?? 1) == 1,
          isCompatible(manifest),
          manifest.bytes == packData.count,
          packData.starts(with: Array("LEKHBLX1".utf8)),
          sha256Hex(packData) == manifest.sha256.lowercased(),
          let signature = manifest.signature,
          signature.algorithm == "Ed25519",
          let signatureData = Data(base64Encoded: signature.valueBase64) else {
      return nil
    }

    let message = signatureMessage(version: manifest.version, sha256: manifest.sha256.lowercased(), bytes: manifest.bytes, format: manifest.binaryFormat)
    guard let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKeyBytes),
          publicKey.isValidSignature(signatureData, for: message) else {
      return nil
    }
    return LekhDictionaryPackWatcher.activePackURL
    #else
    return nil
    #endif
  }

  private static func signatureMessage(version: String, sha256: String, bytes: Int, format: String) -> Data {
    Data("LEKH_PACK_V1\n\(version)\n\(sha256)\n\(bytes)\n\(format)".utf8)
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
