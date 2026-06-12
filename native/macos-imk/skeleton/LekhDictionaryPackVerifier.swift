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
    let sha256: String
    let bytes: Int
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

  #if canImport(CryptoKit)
  private static func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data)
      .map { String(format: "%02x", $0) }
      .joined()
  }
  #endif
}
