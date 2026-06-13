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
    guard isValidBinaryPack(packData) else {
      return rejected("dictionary update rejected: invalid or truncated pack layout")
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
  private static func isValidBinaryPack(_ data: Data) -> Bool {
    let magic = Array("LEKHBLX1".utf8)
    guard data.count >= 64, Array(data.prefix(8)) == magic else { return false }
    let version = Int(u32(data, 8))
    let headerSize = Int(u32(data, 12))
    let entryCount = Int(u32(data, 16))
    let entryOffset = Int(u32(data, 20))
    let entryStride = Int(u32(data, 24))
    let prefixCount = Int(u32(data, 28))
    let prefixOffset = Int(u32(data, 32))
    let prefixStride = Int(u32(data, 36))
    let refCount = Int(u32(data, 40))
    let refOffset = Int(u32(data, 44))
    let stringOffset = Int(u32(data, 48))
    let stringBytes = Int(u32(data, 52))
    let maxPrefixLength = Int(u32(data, 56))

    guard version == 1,
          headerSize == 64,
          entryStride >= 24,
          prefixStride >= 16,
          maxPrefixLength >= 1,
          maxPrefixLength <= 12,
          64 <= entryOffset,
          entryOffset <= prefixOffset,
          prefixOffset <= refOffset,
          refOffset <= stringOffset,
          sectionFits(offset: entryOffset, count: entryCount, stride: entryStride, fileBytes: data.count),
          sectionFits(offset: prefixOffset, count: prefixCount, stride: prefixStride, fileBytes: data.count),
          sectionFits(offset: refOffset, count: refCount, stride: 4, fileBytes: data.count),
          sectionFits(offset: stringOffset, count: stringBytes, stride: 1, fileBytes: data.count) else {
      return false
    }

    for index in 0..<entryCount {
      let offset = entryOffset + index * entryStride
      let romanOffset = Int(u32(data, offset))
      let romanLength = Int(u16(data, offset + 4))
      let unicodeLength = Int(u16(data, offset + 6))
      let unicodeOffset = Int(u32(data, offset + 8))
      guard rangeFits(offset: romanOffset, length: romanLength, limit: stringBytes),
            rangeFits(offset: unicodeOffset, length: unicodeLength, limit: stringBytes) else {
        return false
      }
    }

    for index in 0..<prefixCount {
      let offset = prefixOffset + index * prefixStride
      let prefixStringOffset = Int(u32(data, offset))
      let prefixStringLength = Int(u16(data, offset + 4))
      let startRef = Int(u32(data, offset + 8))
      let count = Int(u32(data, offset + 12))
      guard rangeFits(offset: prefixStringOffset, length: prefixStringLength, limit: stringBytes),
            rangeFits(offset: startRef, length: count, limit: refCount) else {
        return false
      }
    }

    for index in 0..<refCount {
      let offset = refOffset + index * 4
      guard offset + 4 <= data.count else { return false }
      guard Int(u32(data, offset)) < entryCount else { return false }
    }
    return true
  }

  private static func sectionFits(offset: Int, count: Int, stride: Int, fileBytes: Int) -> Bool {
    guard offset >= 64, count >= 0, stride > 0 else { return false }
    let byteCount = UInt64(count) * UInt64(stride)
    let end = UInt64(offset) + byteCount
    return end <= UInt64(fileBytes)
  }

  private static func rangeFits(offset: Int, length: Int, limit: Int) -> Bool {
    guard offset >= 0, length >= 0 else { return false }
    return UInt64(offset) + UInt64(length) <= UInt64(limit)
  }

  private static func u16(_ data: Data, _ offset: Int) -> UInt16 {
    data.withUnsafeBytes { rawBuffer in
      UInt16(littleEndian: rawBuffer.loadUnaligned(fromByteOffset: offset, as: UInt16.self))
    }
  }

  private static func u32(_ data: Data, _ offset: Int) -> UInt32 {
    data.withUnsafeBytes { rawBuffer in
      UInt32(littleEndian: rawBuffer.loadUnaligned(fromByteOffset: offset, as: UInt32.self))
    }
  }

  private static func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data)
      .map { String(format: "%02x", $0) }
      .joined()
  }
  #endif
}
