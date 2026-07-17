import CryptoKit
import Foundation

private enum VerificationFailure: Error, CustomStringConvertible {
  case invalidArguments
  case unreadableManifest
  case unreadableSignature
  case invalidPublicKey
  case invalidSignaturePacket
  case keyIdentifierMismatch
  case signatureRejected

  var description: String {
    switch self {
    case .invalidArguments:
      return "usage: verify-release-manifest <manifest> <signature> <minisign-public-key>"
    case .unreadableManifest:
      return "manifest could not be read"
    case .unreadableSignature:
      return "signature could not be read"
    case .invalidPublicKey:
      return "pinned Minisign public key is invalid"
    case .invalidSignaturePacket:
      return "Minisign signature is not a legacy Ed25519 packet"
    case .keyIdentifierMismatch:
      return "signature key identifier does not match the pinned key"
    case .signatureRejected:
      return "release-manifest Ed25519 signature is invalid"
    }
  }
}

private func verify() throws {
  guard CommandLine.arguments.count == 4 else { throw VerificationFailure.invalidArguments }
  let manifestURL = URL(fileURLWithPath: CommandLine.arguments[1])
  let signatureURL = URL(fileURLWithPath: CommandLine.arguments[2])
  let encodedPublicKey = CommandLine.arguments[3]

  guard let manifest = try? Data(contentsOf: manifestURL) else {
    throw VerificationFailure.unreadableManifest
  }
  guard let publicKeyPacket = Data(base64Encoded: encodedPublicKey),
        publicKeyPacket.count == 42,
        publicKeyPacket[0] == 0x45,
        publicKeyPacket[1] == 0x64 else {
    throw VerificationFailure.invalidPublicKey
  }
  guard let signatureText = try? String(contentsOf: signatureURL, encoding: .utf8),
        let encodedSignature = signatureText
          .split(whereSeparator: \.isNewline)
          .map(String.init)
          .first(where: { !$0.hasPrefix("untrusted comment:") && !$0.hasPrefix("trusted comment:") }),
        let signaturePacket = Data(base64Encoded: encodedSignature) else {
    throw VerificationFailure.unreadableSignature
  }
  guard signaturePacket.count == 74,
        signaturePacket[0] == 0x45,
        signaturePacket[1] == 0x64 else {
    throw VerificationFailure.invalidSignaturePacket
  }

  let publicKeyIdentifier = publicKeyPacket.subdata(in: 2..<10)
  let signatureKeyIdentifier = signaturePacket.subdata(in: 2..<10)
  guard publicKeyIdentifier == signatureKeyIdentifier else {
    throw VerificationFailure.keyIdentifierMismatch
  }

  let publicKeyBytes = publicKeyPacket.subdata(in: 10..<42)
  let signatureBytes = signaturePacket.subdata(in: 10..<74)
  guard let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKeyBytes) else {
    throw VerificationFailure.invalidPublicKey
  }
  guard publicKey.isValidSignature(signatureBytes, for: manifest) else {
    throw VerificationFailure.signatureRejected
  }
}

do {
  try verify()
  print("release-manifest-signature=valid")
} catch {
  fputs("Lekh release signature verification failed: \(error)\n", stderr)
  exit(1)
}
