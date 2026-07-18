import Foundation

#if canImport(CryptoKit)
import CryptoKit
#endif

/// A provenance-bearing, explicit-accept completion. Ranking scores are
/// deterministic build-time integers; they are not probabilities and must
/// never authorize passive Space/Return/punctuation commit.
public struct LekhTokenCompletionCandidate: Equatable {
  public let source: String
  public let target: String
  public let score: Int
  public let seedId: String
  public let sourceId: String
  public let license: String
  public let reviewTier: String
}

/// Immutable token-completion lookup kept deliberately separate from the
/// transliteration lexicon. The complete artifact is authenticated and parsed
/// once during engine construction; the per-keystroke path is one dictionary
/// lookup over at most three pre-ranked rows.
public final class LekhTokenCompletionIndex {
  private struct Policy: Decodable, Equatable {
    let minimumPrefixLength: Int
    let maximumSourceSuffixLength: Int
    let maximumResultsPerPrefix: Int
    let minimumWinnerMargin: Int
    let explicitAcceptanceOnly: Bool
    let singleTokenOnly: Bool
    let namesAllowed: Bool
    let phrasesAllowed: Bool
  }

  private struct Artifact: Decodable {
    struct Entry: Decodable {
      struct Candidate: Decodable {
        let source: String
        let target: String
        let score: Int
        let seedId: String
        let sourceId: String
        let license: String
        let reviewTier: String
      }

      let prefix: String
      let candidates: [Candidate]
    }

    let schemaVersion: Int
    let artifactId: String
    let normalization: String
    let runtimePolicy: Policy
    let entries: [Entry]
  }

  private struct Manifest: Decodable {
    struct ArtifactRecord: Decodable {
      let path: String
      let sha256: String
      let bytes: Int
      let schemaVersion: Int
      let entryCount: Int
      let candidateCount: Int
    }

    struct Quality: Decodable {
      let explicitSuggestionRuntimeEligible: Bool
      let productionQualityClaimEligible: Bool
    }

    let schemaVersion: Int
    let manifestId: String
    let artifact: ArtifactRecord
    let runtimePolicy: Policy
    let quality: Quality
  }

  private static let requiredPolicy = Policy(
    minimumPrefixLength: 4,
    maximumSourceSuffixLength: 12,
    maximumResultsPerPrefix: 3,
    minimumWinnerMargin: 40,
    explicitAcceptanceOnly: true,
    singleTokenOnly: true,
    namesAllowed: false,
    phrasesAllowed: false
  )
  private static let artifactFileName = "lekh-token-completions.v1.json"
  private static let manifestFileName = "lekh-token-completions.v1.manifest.json"
  private static let maximumArtifactBytes = 1_048_576
  private static let allowedSourceId = "lekh-repository-curated-completion-v1"
  private static let allowedLicense = "MIT"
  private static let allowedReviewTier = "repository-curated-regression"
  private static let protectedPrefixes: Set<String> = [
    "api", "email", "github", "gmail", "http", "https", "icloud", "login",
    "macos", "npm", "postgresql", "otp", "password", "pdf", "pin", "readme",
    "swiftui", "url", "username", "wifi"
  ]

  private let rowsByPrefix: [String: [LekhTokenCompletionCandidate]]
  public let status: String
  public let isReady: Bool
  public let entryCount: Int

  private init(
    rowsByPrefix: [String: [LekhTokenCompletionCandidate]],
    status: String,
    isReady: Bool
  ) {
    self.rowsByPrefix = rowsByPrefix
    self.status = status
    self.isReady = isReady
    self.entryCount = rowsByPrefix.count
  }

  public static func loadDefault(
    bundle: Bundle = .main,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> LekhTokenCompletionIndex {
    let testArtifact = environment["LEKH_TEST_TOKEN_COMPLETIONS_PATH"]
    let testManifest = environment["LEKH_TEST_TOKEN_COMPLETIONS_MANIFEST_PATH"]
    if testArtifact != nil || testManifest != nil {
      guard let testArtifact, let testManifest else {
        return rejected("rejected-test-path-pair")
      }
      return load(
        artifactURL: URL(fileURLWithPath: testArtifact),
        manifestURL: URL(fileURLWithPath: testManifest)
      )
    }

    guard let artifactURL = bundle.url(
      forResource: "lekh-token-completions.v1",
      withExtension: "json"
    ), let manifestURL = bundle.url(
      forResource: "lekh-token-completions.v1.manifest",
      withExtension: "json"
    ) else {
      return rejected("unavailable")
    }
    return load(artifactURL: artifactURL, manifestURL: manifestURL)
  }

  public static func load(
    artifactURL: URL,
    manifestURL: URL
  ) -> LekhTokenCompletionIndex {
    #if canImport(CryptoKit)
    guard artifactURL.lastPathComponent == artifactFileName,
          manifestURL.lastPathComponent == manifestFileName,
          let manifestData = try? Data(contentsOf: manifestURL, options: [.mappedIfSafe]),
          let artifactData = try? Data(contentsOf: artifactURL, options: [.mappedIfSafe]),
          !manifestData.isEmpty,
          !artifactData.isEmpty,
          artifactData.count <= maximumArtifactBytes,
          let manifest = try? JSONDecoder().decode(Manifest.self, from: manifestData),
          let artifact = try? JSONDecoder().decode(Artifact.self, from: artifactData) else {
      return rejected("rejected-unreadable")
    }
    guard manifest.schemaVersion == 1,
          manifest.manifestId == "lekh-token-completions-v1-manifest",
          manifest.artifact.path == artifactFileName,
          manifest.artifact.schemaVersion == 1,
          manifest.artifact.bytes == artifactData.count,
          manifest.runtimePolicy == requiredPolicy,
          manifest.quality.explicitSuggestionRuntimeEligible,
          artifact.schemaVersion == 1,
          artifact.artifactId == "lekh-token-completions-v1",
          artifact.normalization == "nfc-lower-ascii-apostrophe-v1",
          artifact.runtimePolicy == requiredPolicy else {
      return rejected("rejected-contract")
    }
    let digest = SHA256.hash(data: artifactData).map { String(format: "%02x", $0) }.joined()
    guard digest == manifest.artifact.sha256.lowercased() else {
      return rejected("rejected-sha256")
    }

    var rowsByPrefix: [String: [LekhTokenCompletionCandidate]] = [:]
    var previousPrefix: String?
    var candidateCount = 0
    for entry in artifact.entries {
      guard isNormalizedRomanToken(entry.prefix),
            entry.prefix.count >= requiredPolicy.minimumPrefixLength,
            !isProtectedOrSensitive(entry.prefix),
            previousPrefix.map({ $0 < entry.prefix }) ?? true,
            rowsByPrefix[entry.prefix] == nil,
            !entry.candidates.isEmpty,
            entry.candidates.count <= requiredPolicy.maximumResultsPerPrefix else {
        return rejected("rejected-entry")
      }
      previousPrefix = entry.prefix

      var rows: [LekhTokenCompletionCandidate] = []
      var previousScore: Int?
      var identities = Set<String>()
      for candidate in entry.candidates {
        let suffixLength = candidate.source.count - entry.prefix.count
        let identity = "\(candidate.source)\u{0}\(candidate.target)"
        guard isNormalizedRomanToken(candidate.source),
              candidate.source.hasPrefix(entry.prefix),
              candidate.source != entry.prefix,
              suffixLength >= 1,
              suffixLength <= requiredPolicy.maximumSourceSuffixLength,
              isDevanagariToken(candidate.target),
              candidate.score >= 1,
              candidate.score <= 1000,
              previousScore.map({ $0 >= candidate.score }) ?? true,
              identities.insert(identity).inserted,
              candidate.seedId.hasPrefix("completion-"),
              candidate.sourceId == allowedSourceId,
              candidate.license == allowedLicense,
              candidate.reviewTier == allowedReviewTier else {
          return rejected("rejected-candidate")
        }
        previousScore = candidate.score
        rows.append(LekhTokenCompletionCandidate(
          source: candidate.source,
          target: candidate.target,
          score: candidate.score,
          seedId: candidate.seedId,
          sourceId: candidate.sourceId,
          license: candidate.license,
          reviewTier: candidate.reviewTier
        ))
      }
      if rows.count > 1,
         rows[0].score - rows[1].score < requiredPolicy.minimumWinnerMargin {
        return rejected("rejected-winner-margin")
      }
      candidateCount += rows.count
      rowsByPrefix[entry.prefix] = rows
    }

    guard manifest.artifact.entryCount == rowsByPrefix.count,
          manifest.artifact.candidateCount == candidateCount else {
      return rejected("rejected-count")
    }
    // This wording intentionally preserves the distinction between safe
    // explicit runtime eligibility and the still-blocked production-quality
    // claim recorded in the manifest.
    let promotion = manifest.quality.productionQualityClaimEligible ? "promoted" : "unpromoted"
    return LekhTokenCompletionIndex(
      rowsByPrefix: rowsByPrefix,
      status: "ready-explicit-only-\(promotion)",
      isReady: true
    )
    #else
    return rejected("rejected-cryptokit-unavailable")
    #endif
  }

  public func candidates(for rawPrefix: String) -> [LekhTokenCompletionCandidate] {
    let prefix = Self.normalize(rawPrefix)
    guard prefix.count >= Self.requiredPolicy.minimumPrefixLength,
          Self.isNormalizedRomanToken(prefix),
          !Self.isProtectedOrSensitive(prefix) else {
      return []
    }
    return rowsByPrefix[prefix] ?? []
  }

  private static func rejected(_ status: String) -> LekhTokenCompletionIndex {
    LekhTokenCompletionIndex(rowsByPrefix: [:], status: status, isReady: false)
  }

  private static func normalize(_ value: String) -> String {
    value.precomposedStringWithCanonicalMapping
      .lowercased()
      .replacingOccurrences(of: "’", with: "'")
      .replacingOccurrences(of: "‘", with: "'")
      .replacingOccurrences(of: "ʼ", with: "'")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func isNormalizedRomanToken(_ value: String) -> Bool {
    guard !value.isEmpty,
          value == normalize(value),
          let first = value.unicodeScalars.first,
          (97...122).contains(Int(first.value)) else {
      return false
    }
    return value.unicodeScalars.allSatisfy {
      (97...122).contains(Int($0.value)) || $0.value == 39 || $0.value == 45
    }
  }

  private static func isDevanagariToken(_ value: String) -> Bool {
    guard !value.isEmpty,
          value == value.precomposedStringWithCanonicalMapping else {
      return false
    }
    return value.unicodeScalars.allSatisfy {
      (0x0900...0x097F).contains(Int($0.value)) ||
        (0xA8E0...0xA8FF).contains(Int($0.value))
    }
  }

  private static func isProtectedOrSensitive(_ value: String) -> Bool {
    protectedPrefixes.contains(value) ||
      protectedPrefixes.contains(where: { value.hasPrefix("\($0)-") }) ||
      value.contains("@") ||
      value.range(of: #"\d{4,}"#, options: .regularExpression) != nil ||
      value.range(of: #"^(?:otp|pin|cvv|password|username)"#, options: .regularExpression) != nil
  }
}
