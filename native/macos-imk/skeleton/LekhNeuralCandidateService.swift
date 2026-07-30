import Carbon
import CoreML
import CryptoKit
import Foundation

private func finiteMultiArrayValue(
  _ array: MLMultiArray,
  indices: [Int]
) -> Double? {
  let shape = array.shape.map(\.intValue)
  guard indices.count == shape.count,
        zip(indices, shape).allSatisfy({
          $0.0 >= 0 && $0.0 < $0.1
        }) else {
    return nil
  }
  let value = array[indices.map { NSNumber(value: $0) }].doubleValue
  return value.isFinite ? value : nil
}

/// Pure, model-independent admission policy for the optional neural tail.
///
/// The deterministic engine owns exact shared tokens. Neural input must also
/// leave room for an explicit EOS token and be fully representable by the
/// verified character vocabulary. Rejecting any unknown character is stricter
/// than an unknown-token-ratio threshold and prevents the model from guessing
/// from a lossy `<unk>`-heavy encoding.
public struct LekhNeuralInputAdmissionPolicy {
  private static let minimumTokenLength = 3
  private let maxLength: Int
  private let representableTokens: Set<String>
  private let deterministicTokenInputs: Set<String>

  public init(
    maxLength: Int,
    representableTokens: Set<String>,
    deterministicTokenInputs: Set<String>
  ) {
    self.maxLength = maxLength
    self.representableTokens = representableTokens
    self.deterministicTokenInputs = deterministicTokenInputs
  }

  public func accepts(_ normalizedInput: String) -> Bool {
    let inputTokens = Array(normalizedInput).map(String.init)
    guard inputTokens.count >= Self.minimumTokenLength,
          inputTokens.count < maxLength,
          !LekhMixedScriptPolicy.isProtectedToken(normalizedInput),
          !deterministicTokenInputs.contains(normalizedInput) else {
      return false
    }
    return inputTokens.allSatisfy { representableTokens.contains($0) }
  }
}

/// Scalar-order grammar shared by neural prefix masking and final validation.
///
/// This deliberately does not decide whether a spelling is good Nepali. It
/// rejects only structurally impossible Devanagari word sequences while
/// preserving legal syllables, conjuncts, nukta, modifiers, terminal VIRAMA,
/// and VIRAMA+ZWJ/ZWNJ+consonant sequences.
public enum LekhDevanagariOutputSequence {
  public struct Analysis: Equatable {
    public let validPrefix: Bool
    public let terminable: Bool
    public let issueCodes: [String]
  }

  public static func analyze(_ value: String) -> Analysis {
    let scalars = Array(value.unicodeScalars)
    var issues: [String] = []
    var baseKind: BaseKind?
    var dependentVowelSeen = false
    var nuktaSeen = false
    var afterVirama = false
    var modifierSeen = false
    var syllableModifierSeen = false
    var precedingMark: UInt32?
    var pendingJoiner = false

    func issue(_ code: String) {
      if !issues.contains(code) { issues.append(code) }
    }
    func resetUnit() {
      baseKind = nil
      dependentVowelSeen = false
      nuktaSeen = false
      afterVirama = false
      modifierSeen = false
      syllableModifierSeen = false
      precedingMark = nil
      pendingJoiner = false
    }

    // Swift String equality is canonical-equivalence aware, so comparing the
    // two Strings would incorrectly treat a non-NFC scalar sequence as equal
    // to its NFC form. Compare Unicode scalars to enforce byte-stable output.
    if scalars != Array(
      value.precomposedStringWithCanonicalMapping.unicodeScalars
    ) {
      issue("not-nfc")
    }

    for (index, scalar) in scalars.enumerated() {
      let codePoint = scalar.value
      let previous = index > 0 ? scalars[index - 1].value : nil
      let following = index + 1 < scalars.count ? scalars[index + 1] : nil

      if scalar.properties.isWhitespace {
        issue("whitespace")
        resetUnit()
        continue
      }
      if isNumber(scalar) {
        issue("digit")
        resetUnit()
        continue
      }
      if isPunctuation(scalar) {
        issue("punctuation")
        resetUnit()
        continue
      }

      if codePoint == 0x200C || codePoint == 0x200D {
        if previous != 0x094D { issue("joiner-not-after-virama") }
        if let following, !isConsonant(following) {
          issue("joiner-not-before-consonant")
        }
        pendingJoiner = true
        continue
      }

      guard (0x0900...0x097F).contains(codePoint) else {
        issue("unsupported-scalar")
        resetUnit()
        continue
      }

      if isLetter(scalar) {
        if pendingJoiner && !isConsonant(scalar) {
          issue("joiner-not-before-consonant")
        }
        baseKind = isConsonant(scalar) ? .consonant : .otherLetter
        dependentVowelSeen = false
        nuktaSeen = false
        afterVirama = false
        modifierSeen = false
        syllableModifierSeen = false
        precedingMark = nil
        pendingJoiner = false
        continue
      }

      if pendingJoiner {
        issue("joiner-not-before-consonant")
        pendingJoiner = false
      }

      if codePoint == 0x093C {
        if baseKind != .consonant || afterVirama || dependentVowelSeen || modifierSeen {
          issue("orphan-or-misordered-nukta")
        } else if nuktaSeen {
          issue("duplicate-nukta")
        }
        nuktaSeen = true
        precedingMark = codePoint
        continue
      }

      if codePoint == 0x094D {
        if baseKind != .consonant || afterVirama { issue("virama-without-consonant") }
        if dependentVowelSeen { issue("virama-after-dependent-vowel-sign") }
        if modifierSeen { issue("virama-after-syllable-modifier") }
        afterVirama = true
        precedingMark = codePoint
        continue
      }

      if isDependentVowelSign(codePoint) {
        if afterVirama { issue("dependent-vowel-sign-after-virama") }
        if baseKind != .consonant { issue("dependent-vowel-sign-without-consonant") }
        if dependentVowelSeen { issue("multiple-dependent-vowel-signs") }
        if modifierSeen { issue("dependent-vowel-sign-after-syllable-modifier") }
        dependentVowelSeen = true
        precedingMark = codePoint
        continue
      }

      if (0x0900...0x0903).contains(codePoint) || isMark(scalar) {
        if afterVirama {
          issue("mark-after-virama")
        } else if baseKind == nil {
          issue("mark-without-base")
        }
        if precedingMark == codePoint { issue("duplicate-mark") }
        if (0x0900...0x0903).contains(codePoint) && syllableModifierSeen {
          issue("multiple-syllable-modifiers")
        }
        modifierSeen = true
        if (0x0900...0x0903).contains(codePoint) {
          syllableModifierSeen = true
        }
        precedingMark = codePoint
        continue
      }

      issue("unsupported-devanagari-scalar")
      resetUnit()
    }

    let validPrefix = issues.isEmpty
    return Analysis(
      validPrefix: validPrefix,
      terminable: validPrefix && !scalars.isEmpty && !pendingJoiner,
      issueCodes: issues
    )
  }

  public static func isSupportedScalarToken(_ value: String) -> Bool {
    let scalars = Array(value.unicodeScalars)
    guard scalars.count == 1, let codePoint = scalars.first?.value else { return false }
    return (0x0900...0x097F).contains(codePoint) || codePoint == 0x200C || codePoint == 0x200D
  }

  private enum BaseKind {
    case consonant
    case otherLetter
  }

  private static func isConsonant(_ scalar: Unicode.Scalar) -> Bool {
    let value = scalar.value
    return (0x0915...0x0939).contains(value) ||
      (0x0958...0x095F).contains(value) ||
      (0x0978...0x097F).contains(value)
  }

  private static func isDependentVowelSign(_ value: UInt32) -> Bool {
    (0x093A...0x093B).contains(value) ||
      (0x093E...0x094C).contains(value) ||
      value == 0x094E ||
      value == 0x094F ||
      (0x0955...0x0957).contains(value) ||
      value == 0x0962 ||
      value == 0x0963
  }

  private static func isLetter(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.properties.generalCategory {
    case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter:
      return true
    default:
      return false
    }
  }

  private static func isMark(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.properties.generalCategory {
    case .nonspacingMark, .spacingMark, .enclosingMark:
      return true
    default:
      return false
    }
  }

  private static func isNumber(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.properties.generalCategory {
    case .decimalNumber, .letterNumber, .otherNumber:
      return true
    default:
      return false
    }
  }

  private static func isPunctuation(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.properties.generalCategory {
    case .connectorPunctuation, .dashPunctuation, .openPunctuation,
         .closePunctuation, .initialPunctuation, .finalPunctuation, .otherPunctuation:
      return true
    default:
      return false
    }
  }
}

public struct LekhNeuralBeamHypothesis: Equatable {
  public let tokenIds: [Int]
  public let accumulatedLogProbability: Double

  public init(tokenIds: [Int], accumulatedLogProbability: Double) {
    self.tokenIds = tokenIds
    self.accumulatedLogProbability = accumulatedLogProbability
  }

  /// Length normalization includes the leading SOS identifier. This mirrors
  /// the training-side decoder contract and prevents a hidden native-only
  /// preference for shorter prefixes.
  public var normalizedScore: Double {
    guard !tokenIds.isEmpty else { return -.infinity }
    return accumulatedLogProbability / Double(tokenIds.count)
  }
}

public enum LekhNeuralBeamSearchFailure: Error, Equatable {
  case cancelled
  case invalidConfiguration
  case invalidLogitCount(expected: Int, actual: Int)
  case nonFiniteLogit
}

/// Pure beam search shared by the Core ML runtime and its cross-language
/// contract probe. The logit provider is the only model-specific boundary.
public enum LekhNeuralBeamSearch {
  public static func rank(
    vocabularySize: Int,
    sosTokenId: Int,
    eosTokenId: Int,
    invalidTokenIds: Set<Int>,
    beamWidth: Int,
    maxSteps: Int,
    shouldCancel: () -> Bool = { false },
    permitsToken: (_ prefixTokenIds: [Int], _ tokenId: Int) -> Bool = { _, _ in true },
    logitsForPrefix: (_ tokenIds: [Int], _ step: Int) throws -> [Double]
  ) throws -> [LekhNeuralBeamHypothesis] {
    guard vocabularySize > 0,
          (0..<vocabularySize).contains(sosTokenId),
          (0..<vocabularySize).contains(eosTokenId),
          sosTokenId != eosTokenId,
          !invalidTokenIds.contains(eosTokenId),
          invalidTokenIds.allSatisfy({ (0..<vocabularySize).contains($0) }),
          beamWidth > 0,
          (0...47).contains(maxSteps) else {
      throw LekhNeuralBeamSearchFailure.invalidConfiguration
    }

    var active = [LekhNeuralBeamHypothesis(
      tokenIds: [sosTokenId],
      accumulatedLogProbability: 0
    )]
    var completed: [LekhNeuralBeamHypothesis] = []

    for step in 0..<maxSteps {
      guard !shouldCancel() else { throw LekhNeuralBeamSearchFailure.cancelled }
      var next: [LekhNeuralBeamHypothesis] = []

      for hypothesis in active {
        guard !shouldCancel() else { throw LekhNeuralBeamSearchFailure.cancelled }
        if hypothesis.tokenIds.last == eosTokenId {
          completed.append(hypothesis)
          continue
        }

        let logits = try logitsForPrefix(hypothesis.tokenIds, step)
        guard logits.count == vocabularySize else {
          throw LekhNeuralBeamSearchFailure.invalidLogitCount(
            expected: vocabularySize,
            actual: logits.count
          )
        }
        guard logits.allSatisfy(\.isFinite) else {
          throw LekhNeuralBeamSearchFailure.nonFiniteLogit
        }
        let logProbabilities = logSoftmax(logits)
        let selectedTokenIds = (0..<vocabularySize)
          .filter {
            !invalidTokenIds.contains($0) &&
              logProbabilities[$0].isFinite &&
              ($0 == eosTokenId || step + 1 < maxSteps) &&
              permitsToken(hypothesis.tokenIds, $0)
          }
          .sorted { left, right in
            if logProbabilities[left] != logProbabilities[right] {
              return logProbabilities[left] > logProbabilities[right]
            }
            return left < right
          }
          .prefix(beamWidth)

        for tokenId in selectedTokenIds {
          next.append(LekhNeuralBeamHypothesis(
            tokenIds: hypothesis.tokenIds + [tokenId],
            accumulatedLogProbability: hypothesis.accumulatedLogProbability + logProbabilities[tokenId]
          ))
        }
      }

      guard !next.isEmpty else {
        active = []
        break
      }
      active = Array(next.sorted(by: ranksBefore).prefix(beamWidth))
      // Completed beams are intentionally not an early-stop signal. A live
      // prefix may still outrank them once its conditional probabilities are
      // normalized, so every configured step remains available.
    }

    guard !shouldCancel() else { throw LekhNeuralBeamSearchFailure.cancelled }
    completed.append(contentsOf: active.filter { $0.tokenIds.last == eosTokenId })
    var seen = Set<[Int]>()
    return completed
      .sorted(by: ranksBefore)
      .filter { seen.insert($0.tokenIds).inserted }
      .prefix(beamWidth)
      .map { $0 }
  }

  private static func logSoftmax(_ logits: [Double]) -> [Double] {
    guard let maximum = logits.max() else {
      return Array(repeating: -.infinity, count: logits.count)
    }
    let exponentialSum = logits.reduce(0) { partial, value in
      partial + Foundation.exp(value - maximum)
    }
    guard exponentialSum.isFinite, exponentialSum > 0 else {
      return Array(repeating: -.infinity, count: logits.count)
    }
    let normalizer = maximum + Foundation.log(exponentialSum)
    return logits.map { $0 - normalizer }
  }

  private static func ranksBefore(
    _ left: LekhNeuralBeamHypothesis,
    _ right: LekhNeuralBeamHypothesis
  ) -> Bool {
    if left.normalizedScore != right.normalizedScore {
      return left.normalizedScore > right.normalizedScore
    }
    return left.tokenIds.lexicographicallyPrecedes(right.tokenIds)
  }
}

public enum LekhNeuralCTCPrefixBeamSearchFailure: Error, Equatable {
  case cancelled
  case invalidConfiguration
  case inconsistentLogitShape
  case nonFiniteLogit
}

/// Deterministic log-domain CTC prefix beam search.
///
/// This is a direct native implementation of the training-side decoder:
/// blank and non-blank path probabilities remain separate, repeated labels
/// extend a prefix only after a blank, and score ties are resolved by lexical
/// token-id order. Keeping this algorithm model-independent makes the exact
/// Python/Swift contract testable without loading Core ML.
public enum LekhNeuralCTCPrefixBeamSearch {
  private struct ProbabilityPair {
    var blank: Double
    var nonBlank: Double
  }

  public static func rank(
    logits: [[Double]],
    blankTokenId: Int,
    beamWidth: Int,
    maximumCandidates: Int,
    shouldCancel: () -> Bool = { false },
    permitsToken: (_ prefixTokenIds: [Int], _ tokenId: Int) -> Bool = { _, _ in true },
    permitsSequence: (_ tokenIds: [Int]) -> Bool = { _ in true }
  ) throws -> [[Int]] {
    guard (1...48).contains(logits.count),
          let vocabularySize = logits.first?.count,
          (2...4_096).contains(vocabularySize),
          logits.allSatisfy({ $0.count == vocabularySize }),
          (0..<vocabularySize).contains(blankTokenId),
          (1...64).contains(beamWidth),
          (1...64).contains(maximumCandidates) else {
      throw LekhNeuralCTCPrefixBeamSearchFailure.invalidConfiguration
    }
    guard logits.flatMap({ $0 }).allSatisfy(\.isFinite) else {
      throw LekhNeuralCTCPrefixBeamSearchFailure.nonFiniteLogit
    }

    var beams: [(prefix: [Int], probability: ProbabilityPair)] = [
      (
        prefix: [],
        probability: ProbabilityPair(blank: 0, nonBlank: -.infinity)
      )
    ]

    for (timeStep, row) in logits.enumerated() {
      guard !shouldCancel() else {
        throw LekhNeuralCTCPrefixBeamSearchFailure.cancelled
      }
      let logProbabilities = logSoftmax(row)
      guard logProbabilities.count == vocabularySize else {
        throw LekhNeuralCTCPrefixBeamSearchFailure.inconsistentLogitShape
      }
      var next: [[Int]: ProbabilityPair] = [:]

      func update(
        _ prefix: [Int],
        blank: Double = -.infinity,
        nonBlank: Double = -.infinity
      ) {
        let previous = next[prefix] ?? ProbabilityPair(
          blank: -.infinity,
          nonBlank: -.infinity
        )
        next[prefix] = ProbabilityPair(
          blank: logAdd(previous.blank, blank),
          nonBlank: logAdd(previous.nonBlank, nonBlank)
        )
      }

      for beam in beams {
        guard !shouldCancel() else {
          throw LekhNeuralCTCPrefixBeamSearchFailure.cancelled
        }
        let prefix = beam.prefix
        let probability = beam.probability
        let total = logAdd(probability.blank, probability.nonBlank)
        update(
          prefix,
          blank: total + logProbabilities[blankTokenId]
        )

        for tokenId in 0..<vocabularySize where tokenId != blankTokenId {
          let tokenProbability = logProbabilities[tokenId]
          if prefix.last == tokenId {
            update(
              prefix,
              nonBlank: probability.nonBlank + tokenProbability
            )
            if permitsToken(prefix, tokenId) {
              update(
                prefix + [tokenId],
                nonBlank: probability.blank + tokenProbability
              )
            }
          } else if permitsToken(prefix, tokenId) {
            update(
              prefix + [tokenId],
              nonBlank: total + tokenProbability
            )
          }
        }
      }

      let isFinalTimeStep = timeStep == logits.count - 1
      let ranked = next
        .filter { entry in
          let score = logAdd(
            entry.value.blank,
            entry.value.nonBlank
          )
          return score.isFinite
        }
        .sorted(by: ranksBefore)
      var selected: [(prefix: [Int], probability: ProbabilityPair)] = []
      selected.reserveCapacity(beamWidth)
      for entry in ranked {
        if isFinalTimeStep &&
            (entry.key.isEmpty || !permitsSequence(entry.key)) {
          continue
        }
        selected.append((
          prefix: entry.key,
          probability: entry.value
        ))
        if selected.count == beamWidth { break }
      }
      beams = selected
    }

    guard !shouldCancel() else {
      throw LekhNeuralCTCPrefixBeamSearchFailure.cancelled
    }
    return beams
      .map {
        (
          prefix: $0.prefix,
          score: logAdd($0.probability.blank, $0.probability.nonBlank)
        )
      }
      .filter {
        !$0.prefix.isEmpty &&
          $0.score.isFinite
      }
      .sorted {
        if $0.score != $1.score { return $0.score > $1.score }
        return $0.prefix.lexicographicallyPrecedes($1.prefix)
      }
      .prefix(maximumCandidates)
      .map(\.prefix)
  }

  private static func ranksBefore(
    _ left: Dictionary<[Int], ProbabilityPair>.Element,
    _ right: Dictionary<[Int], ProbabilityPair>.Element
  ) -> Bool {
    let leftScore = logAdd(left.value.blank, left.value.nonBlank)
    let rightScore = logAdd(right.value.blank, right.value.nonBlank)
    if leftScore != rightScore { return leftScore > rightScore }
    return left.key.lexicographicallyPrecedes(right.key)
  }

  private static func logSoftmax(_ logits: [Double]) -> [Double] {
    guard let maximum = logits.max() else { return [] }
    let exponentialSum = logits.reduce(0) {
      $0 + Foundation.exp($1 - maximum)
    }
    guard exponentialSum.isFinite, exponentialSum > 0 else {
      return Array(repeating: -.infinity, count: logits.count)
    }
    let normalizer = maximum + Foundation.log(exponentialSum)
    return logits.map { $0 - normalizer }
  }

  private static func logAdd(_ left: Double, _ right: Double) -> Double {
    if left == -.infinity { return right }
    if right == -.infinity { return left }
    let maximum = max(left, right)
    return maximum + Foundation.log1p(
      Foundation.exp(min(left, right) - maximum)
    )
  }
}

public protocol LekhNeuralModelPredicting: AnyObject {
  func prediction(from input: MLFeatureProvider) throws -> MLFeatureProvider
}

public struct LekhNeuralCTCContract: Equatable {
  public let maxInputLength: Int
  public let outputTimeSteps: Int
  public let vocabularySize: Int
  public let blankTokenId: Int
  public let beamWidth: Int
  public let maximumCandidates: Int

  public init(
    maxInputLength: Int,
    outputTimeSteps: Int,
    vocabularySize: Int,
    blankTokenId: Int,
    beamWidth: Int,
    maximumCandidates: Int
  ) {
    self.maxInputLength = maxInputLength
    self.outputTimeSteps = outputTimeSteps
    self.vocabularySize = vocabularySize
    self.blankTokenId = blankTokenId
    self.beamWidth = beamWidth
    self.maximumCandidates = maximumCandidates
  }

  fileprivate var isValid: Bool {
    (4...128).contains(maxInputLength) &&
      (8...48).contains(outputTimeSteps) &&
      (2...4_096).contains(vocabularySize) &&
      (0..<vocabularySize).contains(blankTokenId) &&
      (1...64).contains(beamWidth) &&
      (1...beamWidth).contains(maximumCandidates)
  }
}

public enum LekhNeuralCTCRuntimeFailure: Error, Equatable {
  case cancelled
  case invalidConfiguration
  case inputInvalid
  case modelOutputInvalid
}

/// One-shot fixed-shape Transformer CTC inference. Core ML runs exactly once;
/// only the small prefix-beam decoder remains on CPU.
public enum LekhNeuralCTCRuntime {
  public static func rank(
    model: any LekhNeuralModelPredicting,
    contract: LekhNeuralCTCContract,
    inputIds: MLMultiArray,
    shouldCancel: () -> Bool = { false },
    permitsToken: (_ prefixTokenIds: [Int], _ tokenId: Int) -> Bool = { _, _ in true },
    permitsSequence: (_ tokenIds: [Int]) -> Bool = { _ in true }
  ) throws -> [[Int]] {
    guard contract.isValid else {
      throw LekhNeuralCTCRuntimeFailure.invalidConfiguration
    }
    guard validArray(
      inputIds,
      shape: [1, contract.maxInputLength],
      dataType: .int32
    ) else {
      throw LekhNeuralCTCRuntimeFailure.inputInvalid
    }
    guard !shouldCancel() else {
      throw LekhNeuralCTCRuntimeFailure.cancelled
    }
    let provider = try MLDictionaryFeatureProvider(dictionary: [
      "inputIds": MLFeatureValue(multiArray: inputIds)
    ])
    guard !shouldCancel() else {
      throw LekhNeuralCTCRuntimeFailure.cancelled
    }
    let prediction = try model.prediction(from: provider)
    guard !shouldCancel() else {
      throw LekhNeuralCTCRuntimeFailure.cancelled
    }
    guard Set(prediction.featureNames) == Set(["logits"]),
          let logits = prediction.featureValue(for: "logits")?.multiArrayValue,
          validArray(
            logits,
            shape: [
              1,
              contract.outputTimeSteps,
              contract.vocabularySize
            ],
            dataType: .float16
          ) else {
      throw LekhNeuralCTCRuntimeFailure.modelOutputInvalid
    }
    var rows: [[Double]] = []
    rows.reserveCapacity(contract.outputTimeSteps)
    for timeStep in 0..<contract.outputTimeSteps {
      var row: [Double] = []
      row.reserveCapacity(contract.vocabularySize)
      for tokenId in 0..<contract.vocabularySize {
        guard let value = finiteMultiArrayValue(
          logits,
          indices: [0, timeStep, tokenId]
        ) else {
          throw LekhNeuralCTCRuntimeFailure.modelOutputInvalid
        }
        row.append(value)
      }
      rows.append(row)
    }
    do {
      return try LekhNeuralCTCPrefixBeamSearch.rank(
        logits: rows,
        blankTokenId: contract.blankTokenId,
        beamWidth: contract.beamWidth,
        maximumCandidates: contract.maximumCandidates,
        shouldCancel: shouldCancel,
        permitsToken: permitsToken,
        permitsSequence: permitsSequence
      )
    } catch LekhNeuralCTCPrefixBeamSearchFailure.cancelled {
      throw LekhNeuralCTCRuntimeFailure.cancelled
    } catch {
      throw LekhNeuralCTCRuntimeFailure.modelOutputInvalid
    }
  }

  private static func validArray(
    _ array: MLMultiArray,
    shape: [Int],
    dataType: MLMultiArrayDataType
  ) -> Bool {
    array.dataType == dataType && array.shape.map(\.intValue) == shape
  }
}

public struct LekhNeuralSplitAttentionModels {
  public let encoder: any LekhNeuralModelPredicting
  public let decoderStep: any LekhNeuralModelPredicting

  public init(
    encoder: any LekhNeuralModelPredicting,
    decoderStep: any LekhNeuralModelPredicting
  ) {
    self.encoder = encoder
    self.decoderStep = decoderStep
  }
}

public struct LekhNeuralSplitAttentionContract: Equatable {
  public let maxInputLength: Int
  public let encoderWidth: Int
  public let attentionWidth: Int
  public let decoderLayers: Int
  public let beamWidth: Int
  public let hiddenWidth: Int
  public let vocabularySize: Int

  public init(
    maxInputLength: Int,
    encoderWidth: Int,
    attentionWidth: Int,
    decoderLayers: Int,
    beamWidth: Int,
    hiddenWidth: Int,
    vocabularySize: Int
  ) {
    self.maxInputLength = maxInputLength
    self.encoderWidth = encoderWidth
    self.attentionWidth = attentionWidth
    self.decoderLayers = decoderLayers
    self.beamWidth = beamWidth
    self.hiddenWidth = hiddenWidth
    self.vocabularySize = vocabularySize
  }

  fileprivate var isValid: Bool {
    (4...128).contains(maxInputLength) &&
      (1...2_048).contains(encoderWidth) &&
      (1...2_048).contains(attentionWidth) &&
      (1...8).contains(decoderLayers) &&
      (2...8).contains(beamWidth) &&
      (1...1_024).contains(hiddenWidth) &&
      (5...4_096).contains(vocabularySize)
  }
}

public enum LekhNeuralSplitAttentionFailure: Error, Equatable {
  case cancelled
  case invalidConfiguration
  case inputInvalid
  case encoderOutputInvalid
  case decoderOutputInvalid
}

/// Fixed-width recurrent decoder for the split attention Core ML contract.
/// The encoder runs once. Every live step packs up to `beamWidth` hypotheses
/// into stable lanes and zero-fills unused lanes, matching the Python exporter.
public enum LekhNeuralSplitAttentionRuntime {
  private struct StatefulHypothesis {
    let hypothesis: LekhNeuralBeamHypothesis
    let hidden: [Double]
  }

  public static func rank(
    models: LekhNeuralSplitAttentionModels,
    contract: LekhNeuralSplitAttentionContract,
    inputIds: MLMultiArray,
    padTokenId: Int,
    sosTokenId: Int,
    eosTokenId: Int,
    invalidTokenIds: Set<Int>,
    maxSteps: Int,
    shouldCancel: () -> Bool = { false },
    permitsToken: (_ prefixTokenIds: [Int], _ tokenId: Int) -> Bool = { _, _ in true }
  ) throws -> [LekhNeuralBeamHypothesis] {
    guard contract.isValid,
          (0...47).contains(maxSteps),
          validArray(inputIds, shape: [1, contract.maxInputLength], dataType: .int32),
          (0..<contract.vocabularySize).contains(padTokenId),
          (0..<contract.vocabularySize).contains(sosTokenId),
          (0..<contract.vocabularySize).contains(eosTokenId),
          sosTokenId != eosTokenId,
          !invalidTokenIds.contains(eosTokenId),
          invalidTokenIds.allSatisfy({ (0..<contract.vocabularySize).contains($0) }) else {
      throw LekhNeuralSplitAttentionFailure.invalidConfiguration
    }

    let encoderInput = try MLDictionaryFeatureProvider(dictionary: [
      "inputIds": MLFeatureValue(multiArray: inputIds)
    ])
    let encoderPrediction = try checkedPrediction(
      model: models.encoder,
      input: encoderInput,
      shouldCancel: shouldCancel
    )
    guard Set(encoderPrediction.featureNames) == Set([
      "encoderOutputs", "encoderEnergy", "validMask", "initialDecoderHidden"
    ]),
      let encoderOutputs = encoderPrediction.featureValue(for: "encoderOutputs")?.multiArrayValue,
      let encoderEnergy = encoderPrediction.featureValue(for: "encoderEnergy")?.multiArrayValue,
      let validMask = encoderPrediction.featureValue(for: "validMask")?.multiArrayValue,
      let initialHidden = encoderPrediction.featureValue(for: "initialDecoderHidden")?.multiArrayValue,
      validArray(
        encoderOutputs,
        shape: [1, contract.maxInputLength, contract.encoderWidth],
        dataType: .float16
      ),
      validArray(
        encoderEnergy,
        shape: [1, contract.maxInputLength, contract.attentionWidth],
        dataType: .float16
      ),
      validArray(validMask, shape: [1, contract.maxInputLength], dataType: .float16),
      validArray(
        initialHidden,
        shape: [contract.decoderLayers, 1, contract.hiddenWidth],
        dataType: .float16
      ),
      finiteArray(encoderOutputs),
      finiteArray(encoderEnergy),
      finiteArray(validMask),
      finiteArray(initialHidden) else {
      throw LekhNeuralSplitAttentionFailure.encoderOutputInvalid
    }
    let initialState = (0..<(contract.decoderLayers * contract.hiddenWidth)).map {
      initialHidden[$0].doubleValue
    }
    guard initialState.allSatisfy(\.isFinite) else {
      throw LekhNeuralSplitAttentionFailure.encoderOutputInvalid
    }

    var active = [StatefulHypothesis(
      hypothesis: LekhNeuralBeamHypothesis(
        tokenIds: [sosTokenId],
        accumulatedLogProbability: 0
      ),
      hidden: initialState
    )]
    var completed: [LekhNeuralBeamHypothesis] = []

    for step in 0..<maxSteps {
      guard !shouldCancel() else { throw LekhNeuralSplitAttentionFailure.cancelled }
      var live: [StatefulHypothesis] = []
      for item in active {
        if item.hypothesis.tokenIds.last == eosTokenId {
          completed.append(item.hypothesis)
        } else {
          live.append(item)
        }
      }
      guard !live.isEmpty else {
        active = []
        break
      }
      guard live.count <= contract.beamWidth else {
        throw LekhNeuralSplitAttentionFailure.invalidConfiguration
      }

      let decoderTokenIds = try MLMultiArray(
        shape: [NSNumber(value: contract.beamWidth), 1],
        dataType: .int32
      )
      let decoderHidden = try MLMultiArray(
        shape: [
          NSNumber(value: contract.decoderLayers),
          NSNumber(value: contract.beamWidth),
          NSNumber(value: contract.hiddenWidth)
        ],
        dataType: .float16
      )
      for lane in 0..<contract.beamWidth {
        decoderTokenIds[lane] = NSNumber(value: padTokenId)
      }
      for index in 0..<decoderHidden.count {
        decoderHidden[index] = 0
      }
      for (lane, item) in live.enumerated() {
        guard let tokenId = item.hypothesis.tokenIds.last,
              item.hidden.count == contract.decoderLayers * contract.hiddenWidth else {
          throw LekhNeuralSplitAttentionFailure.invalidConfiguration
        }
        decoderTokenIds[lane] = NSNumber(value: tokenId)
        for layer in 0..<contract.decoderLayers {
          for unit in 0..<contract.hiddenWidth {
            decoderHidden[hiddenOffset(
              layer: layer,
              lane: lane,
              unit: unit,
              contract: contract
            )] = NSNumber(value: item.hidden[layer * contract.hiddenWidth + unit])
          }
        }
      }

      let decoderInput = try MLDictionaryFeatureProvider(dictionary: [
        "decoderTokenIds": MLFeatureValue(multiArray: decoderTokenIds),
        "decoderHidden": MLFeatureValue(multiArray: decoderHidden),
        "encoderOutputs": MLFeatureValue(multiArray: encoderOutputs),
        "encoderEnergy": MLFeatureValue(multiArray: encoderEnergy),
        "validMask": MLFeatureValue(multiArray: validMask)
      ])
      let decoderPrediction = try checkedPrediction(
        model: models.decoderStep,
        input: decoderInput,
        shouldCancel: shouldCancel
      )
      guard Set(decoderPrediction.featureNames) == Set(["stepLogits", "nextDecoderHidden"]),
            let stepLogits = decoderPrediction.featureValue(for: "stepLogits")?.multiArrayValue,
            let nextDecoderHidden = decoderPrediction.featureValue(
              for: "nextDecoderHidden"
            )?.multiArrayValue,
            validArray(
              stepLogits,
              shape: [contract.beamWidth, contract.vocabularySize],
              dataType: .float16
            ),
            validArray(
              nextDecoderHidden,
              shape: [contract.decoderLayers, contract.beamWidth, contract.hiddenWidth],
              dataType: .float16
            ) else {
        throw LekhNeuralSplitAttentionFailure.decoderOutputInvalid
      }

      var next: [StatefulHypothesis] = []
      for (lane, item) in live.enumerated() {
        let logits = (0..<contract.vocabularySize).map {
          stepLogits[lane * contract.vocabularySize + $0].doubleValue
        }
        guard logits.allSatisfy(\.isFinite) else {
          throw LekhNeuralSplitAttentionFailure.decoderOutputInvalid
        }
        let logProbabilities = logSoftmax(logits)
        let selectedTokenIds = (0..<contract.vocabularySize)
          .filter {
            !invalidTokenIds.contains($0) &&
              logProbabilities[$0].isFinite &&
              ($0 == eosTokenId || step + 1 < maxSteps) &&
              permitsToken(item.hypothesis.tokenIds, $0)
          }
          .sorted { left, right in
            if logProbabilities[left] != logProbabilities[right] {
              return logProbabilities[left] > logProbabilities[right]
            }
            return left < right
          }
          .prefix(contract.beamWidth)
        let laneState = (0..<contract.decoderLayers).flatMap { layer in
          (0..<contract.hiddenWidth).map { unit in
            nextDecoderHidden[hiddenOffset(
              layer: layer,
              lane: lane,
              unit: unit,
              contract: contract
            )].doubleValue
          }
        }
        guard laneState.allSatisfy(\.isFinite) else {
          throw LekhNeuralSplitAttentionFailure.decoderOutputInvalid
        }
        for tokenId in selectedTokenIds {
          next.append(StatefulHypothesis(
            hypothesis: LekhNeuralBeamHypothesis(
              tokenIds: item.hypothesis.tokenIds + [tokenId],
              accumulatedLogProbability:
                item.hypothesis.accumulatedLogProbability + logProbabilities[tokenId]
            ),
            hidden: laneState
          ))
        }
      }
      guard !next.isEmpty else {
        active = []
        break
      }
      active = Array(next.sorted(by: statefulRanksBefore).prefix(contract.beamWidth))
    }

    guard !shouldCancel() else { throw LekhNeuralSplitAttentionFailure.cancelled }
    completed.append(
      contentsOf: active.map(\.hypothesis).filter { $0.tokenIds.last == eosTokenId }
    )
    var seen = Set<[Int]>()
    return completed
      .sorted(by: ranksBefore)
      .filter { seen.insert($0.tokenIds).inserted }
      .prefix(contract.beamWidth)
      .map { $0 }
  }

  private static func checkedPrediction(
    model: any LekhNeuralModelPredicting,
    input: MLFeatureProvider,
    shouldCancel: () -> Bool
  ) throws -> MLFeatureProvider {
    guard !shouldCancel() else { throw LekhNeuralSplitAttentionFailure.cancelled }
    let prediction = try model.prediction(from: input)
    guard !shouldCancel() else { throw LekhNeuralSplitAttentionFailure.cancelled }
    return prediction
  }

  private static func validArray(
    _ array: MLMultiArray,
    shape: [Int],
    dataType: MLMultiArrayDataType
  ) -> Bool {
    array.dataType == dataType && array.shape.map(\.intValue) == shape
  }

  private static func finiteArray(_ array: MLMultiArray) -> Bool {
    (0..<array.count).allSatisfy { array[$0].doubleValue.isFinite }
  }

  private static func hiddenOffset(
    layer: Int,
    lane: Int,
    unit: Int,
    contract: LekhNeuralSplitAttentionContract
  ) -> Int {
    (layer * contract.beamWidth + lane) * contract.hiddenWidth + unit
  }

  private static func logSoftmax(_ logits: [Double]) -> [Double] {
    guard let maximum = logits.max() else { return [] }
    let exponentialSum = logits.reduce(0) { $0 + Foundation.exp($1 - maximum) }
    guard exponentialSum.isFinite, exponentialSum > 0 else {
      return Array(repeating: -.infinity, count: logits.count)
    }
    let normalizer = maximum + Foundation.log(exponentialSum)
    return logits.map { $0 - normalizer }
  }

  private static func statefulRanksBefore(
    _ left: StatefulHypothesis,
    _ right: StatefulHypothesis
  ) -> Bool {
    ranksBefore(left.hypothesis, right.hypothesis)
  }

  private static func ranksBefore(
    _ left: LekhNeuralBeamHypothesis,
    _ right: LekhNeuralBeamHypothesis
  ) -> Bool {
    if left.normalizedScore != right.normalizedScore {
      return left.normalizedScore > right.normalizedScore
    }
    return left.tokenIds.lexicographicallyPrecedes(right.tokenIds)
  }
}

private final class LekhCoreMLModelPredictor: LekhNeuralModelPredicting {
  let model: MLModel

  init(_ model: MLModel) {
    self.model = model
  }

  func prediction(from input: MLFeatureProvider) throws -> MLFeatureProvider {
    try model.prediction(from: input)
  }
}

/// Controller-facing boundary for the optional neural candidate tail.
///
/// Keeping this interface smaller than the Core ML implementation lets the
/// controller prove lifecycle safety with a deliberately delayed service. A
/// production controller receives its own scoped view of the shared model, so
/// cancellation in one host client cannot invalidate another controller's
/// request generation.
public protocol LekhNeuralCandidateServing: AnyObject {
  func candidates(
    for rawInput: String,
    secureInputActive: Bool,
    completion: @escaping ([String]) -> Void
  )

  func cancelPending()
}

/// Combines the secure-input state observed by the caller with a live,
/// thread-safe predicate that is re-read on the neural worker.
///
/// Secure Event Input can become active after a keystroke leaves the main
/// thread but before Core ML begins. Treating either observation as active
/// closes that transition window. Callers supplying a live predicate must make
/// it safe to invoke from the service's serial worker queue.
public struct LekhNeuralSecureInputGuard {
  private let observedActive: Bool
  private let liveIsActive: () -> Bool

  public init(
    observedActive: Bool,
    liveIsActive: @escaping () -> Bool = { false }
  ) {
    self.observedActive = observedActive
    self.liveIsActive = liveIsActive
  }

  public func isActive() -> Bool {
    observedActive || liveIsActive()
  }
}

public final class LekhNeuralCandidateService: LekhNeuralCandidateServing {
  public static let shared = LekhNeuralCandidateService()

  private let queue = DispatchQueue(label: "com.lekh.inputmethod.neural-candidate-tail", qos: .userInitiated)
  private let requestLock = NSLock()
  private let defaultRequestScope = UUID()
  private let defaultLiveSecureInputActive: () -> Bool
  private var requestGenerations: [UUID: UInt64] = [:]
  private let predictorInvocationLock = NSLock()
  private var predictorInvocations = 0
  private let runtimeStateLock = NSLock()
  private var runtimeState: LekhNeuralRuntimeState = .loading
  private var modelRuntime: LekhNeuralModelRuntime?
  private var vocab: LekhNeuralVocabMetadata?
  private var inputAdmissionPolicy: LekhNeuralInputAdmissionPolicy?

  public var status: String {
    runtimeStateLock.lock()
    let status = runtimeState.status
    runtimeStateLock.unlock()
    return status
  }

  /// Number of admitted public requests that reached the model predictor
  /// boundary. The behavior probe snapshots this counter around secure and
  /// bypass requests instead of publishing an assumed constant.
  public var predictorInvocationCount: Int {
    predictorInvocationLock.lock()
    let count = predictorInvocations
    predictorInvocationLock.unlock()
    return count
  }

  /// Pure parser/contract seam used by native probes before any Core ML model
  /// is opened. Production loading runs these same closed-shape checks.
  public static func validatesSplitManifestContract(
    manifestData: Data,
    vocabData: Data
  ) -> Bool {
    do {
      try validateResourceJSONShape(manifestData: manifestData, vocabData: vocabData)
      let manifest = try JSONDecoder().decode(LekhNeuralManifest.self, from: manifestData)
      let vocab = try JSONDecoder().decode(LekhNeuralVocabMetadata.self, from: vocabData)
      guard manifest.runtimeModelContract == "split-attention-incremental-v1" else { return false }
      try validateArtifactContract(manifest: manifest, vocab: vocab)
      return true
    } catch {
      return false
    }
  }

  /// Pure closed-shape parser seam for the single-model Transformer CTC
  /// contract. Native probes use this before any compiled model is opened.
  public static func validatesCTCManifestContract(
    manifestData: Data,
    vocabData: Data
  ) -> Bool {
    do {
      try validateResourceJSONShape(
        manifestData: manifestData,
        vocabData: vocabData
      )
      let manifest = try JSONDecoder().decode(
        LekhNeuralManifest.self,
        from: manifestData
      )
      let vocab = try JSONDecoder().decode(
        LekhNeuralVocabMetadata.self,
        from: vocabData
      )
      guard manifest.runtimeModelContract == "single-transformer-ctc-v1" else {
        return false
      }
      try validateArtifactContract(manifest: manifest, vocab: vocab)
      return true
    } catch {
      return false
    }
  }

  public init(
    bundle: Bundle = .main,
    liveSecureInputActive: @escaping () -> Bool = {
      IsSecureEventInputEnabled()
    }
  ) {
    defaultLiveSecureInputActive = liveSecureInputActive
    // Controller construction and the first deterministic keystroke must not
    // hash resources, instantiate Core ML, or build neural indexes. While this
    // worker verifies the optional artifact, requests fail open with no neural
    // tail and the in-process deterministic engine remains fully available.
    queue.async { [weak self, bundle] in
      self?.loadVerifiedRuntime(bundle: bundle)
    }
  }

  /// Returns an independently cancellable view over the verified shared model.
  /// The wrapper owns only request-generation state; model loading and compiled
  /// weights remain shared across every controller.
  public func makeScopedClient(
    liveSecureInputActive: (() -> Bool)? = nil
  ) -> any LekhNeuralCandidateServing {
    LekhScopedNeuralCandidateService(
      service: self,
      liveSecureInputActive:
        liveSecureInputActive ?? defaultLiveSecureInputActive
    )
  }

  public func candidates(
    for rawInput: String,
    secureInputActive: Bool,
    completion: @escaping ([String]) -> Void
  ) {
    candidates(
      for: rawInput,
      secureInputActive: secureInputActive,
      requestScope: defaultRequestScope,
      liveSecureInputActive: defaultLiveSecureInputActive,
      completion: completion
    )
  }

  fileprivate func candidates(
    for rawInput: String,
    secureInputActive: Bool,
    requestScope: UUID,
    liveSecureInputActive: @escaping () -> Bool,
    completion: @escaping ([String]) -> Void
  ) {
    // Every request, including a secure-field transition, invalidates work for
    // the previous composition. This prevents a queue of stale per-keystroke
    // beam decodes from accumulating behind the user's current token.
    let generation = beginRequest(in: requestScope)
    let secureInputGuard = LekhNeuralSecureInputGuard(
      observedActive: secureInputActive,
      liveIsActive: liveSecureInputActive
    )
    // neverInvokeInSecureFields: secure fields never run model inference, log,
    // learn, or retain typed content. Re-read live state because it can change
    // after the caller's initial observation.
    guard !secureInputGuard.isActive() else {
      completion([])
      return
    }
    let normalized = Self.normalize(rawInput)
    guard let runtime = inferenceSnapshot(),
          LekhMixedScriptPolicy.preserveCandidate(for: rawInput) == nil,
          Self.isSafeToken(normalized),
          runtime.inputAdmissionPolicy.accepts(normalized) else {
      completion([])
      return
    }

    queue.async { [weak self, modelRuntime = runtime.modelRuntime, vocab = runtime.vocab] in
      guard let self,
            self.isCurrentRequest(generation, in: requestScope),
            !secureInputGuard.isActive() else { return }
      let started = DispatchTime.now().uptimeNanoseconds
      let budgetNanoseconds: UInt64 = 45_000_000
      let shouldCancel = { [weak self] in
        guard let self, self.isCurrentRequest(generation, in: requestScope) else { return true }
        return secureInputGuard.isActive() ||
          DispatchTime.now().uptimeNanoseconds - started >= budgetNanoseconds
      }
      self.recordPredictorInvocation()
      let result = (try? Self.predictCandidates(
        modelRuntime: modelRuntime,
        vocab: vocab,
        input: normalized,
        shouldCancel: shouldCancel
      )) ?? []
      guard self.isCurrentRequest(generation, in: requestScope),
            !secureInputGuard.isActive() else { return }
      DispatchQueue.main.async {
        guard self.isCurrentRequest(generation, in: requestScope),
              !secureInputGuard.isActive() else { return }
        completion(result)
      }
    }
  }

  /// Invalidates queued or in-progress decoding without retaining a token or
  /// invoking a completion. Controllers call this on composition cancellation,
  /// deactivation, and before entering secure input.
  public func cancelPending() {
    cancelPending(in: defaultRequestScope)
  }

  fileprivate func cancelPending(in requestScope: UUID) {
    _ = beginRequest(in: requestScope)
  }

  fileprivate func releaseRequestScope(_ requestScope: UUID) {
    requestLock.lock()
    requestGenerations.removeValue(forKey: requestScope)
    requestLock.unlock()
  }

  private func inferenceSnapshot() -> (
    modelRuntime: LekhNeuralModelRuntime,
    vocab: LekhNeuralVocabMetadata,
    inputAdmissionPolicy: LekhNeuralInputAdmissionPolicy
  )? {
    runtimeStateLock.lock()
    defer { runtimeStateLock.unlock() }
    guard runtimeState.canInfer, let modelRuntime, let vocab, let inputAdmissionPolicy else { return nil }
    return (modelRuntime, vocab, inputAdmissionPolicy)
  }

  private func loadVerifiedRuntime(bundle: Bundle) {
    let deterministicInputs = Self.loadDeterministicTokenInputs(bundle: bundle)
    let experimentalEnabled = Self.experimentalOverrideEnabled(bundle: bundle)
    var verifiedArtifact: LekhVerifiedNeuralArtifact?
    var loadedState: LekhNeuralRuntimeState = .gated(.resourceMissing)
    var requiresKnownAnswerAttestation = false
    do {
      guard !deterministicInputs.isEmpty else {
        throw LekhNeuralGateFailure.deterministicTokenPackUnavailable
      }
      let artifact = try Self.loadVerifiedArtifact(bundle: bundle)
      verifiedArtifact = artifact
      if experimentalEnabled {
        // The override is deliberately labeled experimental even if the same
        // bytes later become production-qualified. A development bundle must
        // never emit a production-ready claim. Experimental inference is also
        // fail-closed until the packaged Core ML model passes the same bounded
        // semantic known-answer attestation as a production artifact; hashes
        // and model I/O shape alone do not prove that inference is usable.
        loadedState = Self.verifyKnownAnswers(
          modelRuntime: artifact.modelRuntime,
          vocab: artifact.vocab,
          cases: artifact.manifest.requiredCases
        ) ? .experimentalReady : .gated(.knownAnswerAttestationFailed)
      } else if artifact.manifest.productionEligible {
        try Self.validateProductionContract(artifact)
        loadedState = .productionAttestationPending
        requiresKnownAnswerAttestation = true
      } else {
        loadedState = .gated(.manifestNotProductionEligible)
      }
    } catch let failure as LekhNeuralGateFailure {
      loadedState = .gated(failure)
    } catch {
      loadedState = .gated(.artifactVerificationFailed)
    }

    runtimeStateLock.lock()
    modelRuntime = verifiedArtifact?.modelRuntime
    vocab = verifiedArtifact?.vocab
    inputAdmissionPolicy = verifiedArtifact.flatMap { artifact in
      Self.makeInputAdmissionPolicy(
        vocab: artifact.vocab,
        deterministicTokenInputs: deterministicInputs
      )
    }
    runtimeState = loadedState
    runtimeStateLock.unlock()

    if requiresKnownAnswerAttestation, let artifact = verifiedArtifact {
      // This method already runs on the neural worker. Until semantic
      // attestation completes, deterministic typing remains available and
      // neural requests continue to fail open with no candidates.
      let passed = Self.verifyKnownAnswers(
        modelRuntime: artifact.modelRuntime,
        vocab: artifact.vocab,
        cases: artifact.manifest.requiredCases
      )
      finishProductionAttestation(passed: passed)
    }
  }

  private func finishProductionAttestation(passed: Bool) {
    runtimeStateLock.lock()
    if case .productionAttestationPending = runtimeState {
      runtimeState = passed ? .productionReady : .gated(.knownAnswerAttestationFailed)
    }
    runtimeStateLock.unlock()
  }

  private func beginRequest(in requestScope: UUID) -> UInt64 {
    requestLock.lock()
    let generation = (requestGenerations[requestScope] ?? 0) &+ 1
    requestGenerations[requestScope] = generation
    requestLock.unlock()
    return generation
  }

  private func recordPredictorInvocation() {
    predictorInvocationLock.lock()
    predictorInvocations += 1
    predictorInvocationLock.unlock()
  }

  private func isCurrentRequest(_ generation: UInt64, in requestScope: UUID) -> Bool {
    requestLock.lock()
    let current = requestGenerations[requestScope] == generation
    requestLock.unlock()
    return current
  }

  private static func predictCandidates(
    modelRuntime: LekhNeuralModelRuntime,
    vocab: LekhNeuralVocabMetadata,
    input: String,
    shouldCancel: () -> Bool
  ) throws -> [String] {
    switch modelRuntime {
    case .legacy(let model):
      return try predictLegacyCandidates(
        model: model,
        vocab: vocab,
        input: input,
        shouldCancel: shouldCancel
      )
    case .splitAttention(let models, let contract):
      return try predictSplitAttentionCandidates(
        models: models,
        contract: contract,
        vocab: vocab,
        input: input,
        shouldCancel: shouldCancel
      )
    case .ctc(let model, let contract):
      return try predictCTCCandidates(
        model: model,
        contract: contract,
        vocab: vocab,
        input: input,
        shouldCancel: shouldCancel
      )
    }
  }

  private static func predictLegacyCandidates(
    model: MLModel,
    vocab: LekhNeuralVocabMetadata,
    input: String,
    shouldCancel: () -> Bool
  ) throws -> [String] {
    let inputIds = try encodedInput(input, vocab: vocab)
    let outputContract = try legacyOutputContract(vocab)
    let maxSteps = decoderMaximumSteps(
      input: input,
      vocab: vocab,
      outputContract: outputContract
    )
    let beamWidth = vocab.decoder.beamWidth
    let hypotheses = try LekhNeuralBeamSearch.rank(
      vocabularySize: vocab.output.tokensById.count,
      sosTokenId: outputContract.sosTokenId,
      eosTokenId: outputContract.eosTokenId,
      invalidTokenIds: [
        outputContract.padTokenId,
        outputContract.unkTokenId,
        outputContract.sosTokenId
      ],
      beamWidth: beamWidth,
      maxSteps: maxSteps,
      shouldCancel: shouldCancel,
      permitsToken: { prefix, tokenId in
        outputTokenPermitted(
          prefix: prefix,
          tokenId: tokenId,
          vocab: vocab,
          outputContract: outputContract
        )
      }
    ) { prefixTokenIds, step in
        let decoderIds = try encodedDecoder(
          prefixTokenIds,
          outputContract: outputContract
        )
        let provider = try MLDictionaryFeatureProvider(dictionary: [
          "inputIds": MLFeatureValue(multiArray: inputIds),
          "decoderInputIds": MLFeatureValue(multiArray: decoderIds)
        ])
        guard !shouldCancel() else {
          throw LekhNeuralBeamSearchFailure.cancelled
        }
        let prediction = try model.prediction(from: provider)
        guard !shouldCancel() else { throw LekhNeuralBeamSearchFailure.cancelled }
        guard let logits = multiArrayOutput(from: prediction) else {
          throw LekhNeuralInferenceFailure.modelOutputInvalid
        }
        return try logitsRow(
          logits,
          step: step,
          vocabularySize: vocab.output.tokensById.count
        )
    }

    guard !shouldCancel() else { return [] }
    var output: [String] = []
    for hypothesis in hypotheses {
      let candidate = decodeLegacy(
        ids: hypothesis.tokenIds,
        vocab: vocab,
        outputContract: outputContract
      )
      guard isSafeCandidate(candidate),
            !output.contains(candidate) else { continue }
      output.append(candidate)
      if output.count >= beamWidth { break }
    }
    return output
  }

  private static func predictSplitAttentionCandidates(
    models: LekhNeuralSplitAttentionModels,
    contract: LekhNeuralSplitAttentionContract,
    vocab: LekhNeuralVocabMetadata,
    input: String,
    shouldCancel: () -> Bool
  ) throws -> [String] {
    let inputIds = try encodedInput(input, vocab: vocab)
    let outputContract = try legacyOutputContract(vocab)
    let maxSteps = decoderMaximumSteps(
      input: input,
      vocab: vocab,
      outputContract: outputContract
    )
    let hypotheses = try LekhNeuralSplitAttentionRuntime.rank(
      models: models,
      contract: contract,
      inputIds: inputIds,
      padTokenId: outputContract.padTokenId,
      sosTokenId: outputContract.sosTokenId,
      eosTokenId: outputContract.eosTokenId,
      invalidTokenIds: [
        outputContract.padTokenId,
        outputContract.unkTokenId,
        outputContract.sosTokenId
      ],
      maxSteps: maxSteps,
      shouldCancel: shouldCancel,
      permitsToken: { prefix, tokenId in
        outputTokenPermitted(
          prefix: prefix,
          tokenId: tokenId,
          vocab: vocab,
          outputContract: outputContract
        )
      }
    )
    guard !shouldCancel() else { return [] }
    var output: [String] = []
    for hypothesis in hypotheses {
      let candidate = decodeLegacy(
        ids: hypothesis.tokenIds,
        vocab: vocab,
        outputContract: outputContract
      )
      guard isSafeCandidate(candidate), !output.contains(candidate) else { continue }
      output.append(candidate)
      if output.count >= contract.beamWidth { break }
    }
    return output
  }

  private static func inputVocabularyContract(
    _ vocab: LekhNeuralVocabMetadata
  ) throws -> LekhInputVocabularyContract {
    guard let maxLength = vocab.input.maxLength,
          let padTokenId = vocab.input.padId,
          let eosTokenId = vocab.input.eosId,
          let unkTokenId = vocab.input.unkId else {
      throw LekhNeuralInferenceFailure.modelOutputInvalid
    }
    return LekhInputVocabularyContract(
      maxLength: maxLength,
      padTokenId: padTokenId,
      eosTokenId: eosTokenId,
      unkTokenId: unkTokenId
    )
  }

  private static func legacyOutputContract(
    _ vocab: LekhNeuralVocabMetadata
  ) throws -> LekhLegacyOutputVocabularyContract {
    guard let maxLength = vocab.output.maxLength,
          let padTokenId = vocab.output.padId,
          let sosTokenId = vocab.output.sosId,
          let eosTokenId = vocab.output.eosId,
          let unkTokenId = vocab.output.unkId else {
      throw LekhNeuralInferenceFailure.modelOutputInvalid
    }
    return LekhLegacyOutputVocabularyContract(
      maxLength: maxLength,
      padTokenId: padTokenId,
      sosTokenId: sosTokenId,
      eosTokenId: eosTokenId,
      unkTokenId: unkTokenId
    )
  }

  private static func predictCTCCandidates(
    model: any LekhNeuralModelPredicting,
    contract: LekhNeuralCTCContract,
    vocab: LekhNeuralVocabMetadata,
    input: String,
    shouldCancel: () -> Bool
  ) throws -> [String] {
    let inputIds = try encodedInput(input, vocab: vocab)
    let tokenSequences = try LekhNeuralCTCRuntime.rank(
      model: model,
      contract: contract,
      inputIds: inputIds,
      shouldCancel: shouldCancel,
      permitsToken: { prefix, tokenId in
        guard tokenId != contract.blankTokenId,
              vocab.output.tokensById.indices.contains(tokenId) else {
          return false
        }
        let prefixText = decodeCTC(
          ids: prefix,
          tokensById: vocab.output.tokensById,
          blankTokenId: contract.blankTokenId
        )
        let token = vocab.output.tokensById[tokenId]
        return LekhDevanagariOutputSequence.isSupportedScalarToken(token) &&
          LekhDevanagariOutputSequence.analyze(prefixText + token).validPrefix
      },
      permitsSequence: { tokenIds in
        LekhDevanagariOutputSequence.analyze(
          decodeCTC(
            ids: tokenIds,
            tokensById: vocab.output.tokensById,
            blankTokenId: contract.blankTokenId
          )
        ).terminable
      }
    )
    guard !shouldCancel() else { return [] }
    var output: [String] = []
    for tokenIds in tokenSequences {
      let candidate = decodeCTC(
        ids: tokenIds,
        tokensById: vocab.output.tokensById,
        blankTokenId: contract.blankTokenId
      )
      guard isSafeCandidate(candidate), !output.contains(candidate) else {
        continue
      }
      output.append(candidate)
      if output.count >= contract.maximumCandidates { break }
    }
    return output
  }

  private static func encodedInput(_ input: String, vocab: LekhNeuralVocabMetadata) throws -> MLMultiArray {
    let inputContract = try inputVocabularyContract(vocab)
    let chars = Array(input).map(String.init)
    guard chars.count < inputContract.maxLength,
          chars.allSatisfy({ character in
            guard let tokenId = vocab.input.idsByToken[character] else { return false }
            return tokenId != inputContract.unkTokenId
          }) else {
      throw LekhNeuralInferenceFailure.inputNotRepresentable
    }
    let array = try MLMultiArray(
      shape: [1, NSNumber(value: inputContract.maxLength)],
      dataType: .int32
    )
    for index in 0..<inputContract.maxLength {
      let value: Int
      if index < chars.count {
        value = vocab.input.idsByToken[chars[index]]
          ?? inputContract.unkTokenId
      } else if index == chars.count {
        value = inputContract.eosTokenId
      } else {
        value = inputContract.padTokenId
      }
      array[index] = NSNumber(value: value)
    }
    return array
  }

  private static func encodedDecoder(
    _ ids: [Int],
    outputContract: LekhLegacyOutputVocabularyContract
  ) throws -> MLMultiArray {
    let decoderLength = max(1, outputContract.maxLength - 1)
    let array = try MLMultiArray(shape: [1, NSNumber(value: decoderLength)], dataType: .int32)
    for index in 0..<decoderLength {
      array[index] = NSNumber(
        value: index < ids.count
          ? ids[index]
          : outputContract.padTokenId
      )
    }
    return array
  }

  private static func logitsRow(
    _ logits: MLMultiArray,
    step: Int,
    vocabularySize: Int
  ) throws -> [Double] {
    let shape = logits.shape.map(\.intValue)
    guard shape.count == 3,
          shape[0] == 1,
          shape[2] == vocabularySize,
          vocabularySize > 0,
          step >= 0,
          step < shape[1] else {
      throw LekhNeuralInferenceFailure.modelOutputInvalid
    }
    return try (0..<vocabularySize).map { tokenId in
      guard let value = finiteMultiArrayValue(
        logits,
        indices: [0, step, tokenId]
      ) else {
        throw LekhNeuralInferenceFailure.modelOutputInvalid
      }
      return value
    }
  }

  private static func decodeLegacy(
    ids: [Int],
    vocab: LekhNeuralVocabMetadata,
    outputContract: LekhLegacyOutputVocabularyContract
  ) -> String {
    var output = ""
    for tokenId in ids {
      if tokenId == outputContract.padTokenId ||
          tokenId == outputContract.sosTokenId ||
          tokenId == outputContract.unkTokenId {
        continue
      }
      if tokenId == outputContract.eosTokenId { break }
      guard tokenId >= 0, tokenId < vocab.output.tokensById.count else { continue }
      output += vocab.output.tokensById[tokenId]
    }
    return output
  }

  private static func decodeCTC(
    ids: [Int],
    tokensById: [String],
    blankTokenId: Int
  ) -> String {
    ids.compactMap { tokenId in
      guard tokenId != blankTokenId,
            tokensById.indices.contains(tokenId) else {
        return nil
      }
      return tokensById[tokenId]
    }.joined()
  }

  private static func decoderMaximumSteps(
    input: String,
    vocab: LekhNeuralVocabMetadata,
    outputContract: LekhLegacyOutputVocabularyContract
  ) -> Int {
    if vocab.tokenization == "unicode-scalar-character" {
      return max(0, outputContract.maxLength - 1)
    }
    // Historical grapheme artifacts remain development-only and retain their
    // original latency bound. They can never satisfy the production contract.
    return max(
      0,
      min(outputContract.maxLength - 1, input.count + 8)
    )
  }

  private static func outputTokenPermitted(
    prefix: [Int],
    tokenId: Int,
    vocab: LekhNeuralVocabMetadata,
    outputContract: LekhLegacyOutputVocabularyContract
  ) -> Bool {
    guard vocab.tokenization == "unicode-scalar-character" else { return true }
    let prefixText = decodeLegacy(
      ids: prefix,
      vocab: vocab,
      outputContract: outputContract
    )
    if tokenId == outputContract.eosTokenId {
      return LekhDevanagariOutputSequence.analyze(prefixText).terminable
    }
    guard tokenId >= 0, tokenId < vocab.output.tokensById.count else { return false }
    let token = vocab.output.tokensById[tokenId]
    guard LekhDevanagariOutputSequence.isSupportedScalarToken(token) else { return false }
    return LekhDevanagariOutputSequence.analyze(prefixText + token).validPrefix
  }

  private static func normalize(_ value: String) -> String {
    value.trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()
      .precomposedStringWithCanonicalMapping
  }

  private static func isSafeToken(_ value: String) -> Bool {
    guard !value.isEmpty,
          value.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
          value.count <= 64 else { return false }
    return value.range(of: #"^[a-z0-9.'/-]+$"#, options: .regularExpression) != nil &&
      value.range(of: #"[a-z]"#, options: .regularExpression) != nil
  }

  private static func isSafeCandidate(_ value: String) -> Bool {
    guard !value.isEmpty,
          value.count <= 48,
          value.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
          value == value.precomposedStringWithCanonicalMapping,
          LekhDevanagariOutputSequence.analyze(value).terminable else { return false }
    var containsDevanagari = false
    for scalar in value.unicodeScalars {
      let codePoint = scalar.value
      if (0x0900...0x097F).contains(codePoint) {
        // A neural token candidate must not smuggle sentence punctuation into
        // a single-token surface, even though danda is in the Devanagari block.
        guard codePoint != 0x0964, codePoint != 0x0965 else { return false }
        containsDevanagari = true
      } else if codePoint != 0x200C, codePoint != 0x200D {
        return false
      }
    }
    return containsDevanagari
  }

  private static func makeInputAdmissionPolicy(
    vocab: LekhNeuralVocabMetadata,
    deterministicTokenInputs: Set<String>
  ) -> LekhNeuralInputAdmissionPolicy? {
    guard let inputContract = try? inputVocabularyContract(vocab) else {
      return nil
    }
    let specialTokenIds = Set(
      [
        vocab.input.padId,
        vocab.input.sosId,
        vocab.input.eosId,
        vocab.input.unkId
      ].compactMap { $0 }
    )
    let representableTokens = Set(vocab.input.idsByToken.compactMap { entry in
      specialTokenIds.contains(entry.value) ? nil : entry.key
    })
    return LekhNeuralInputAdmissionPolicy(
      maxLength: inputContract.maxLength,
      representableTokens: representableTokens,
      deterministicTokenInputs: deterministicTokenInputs
    )
  }

  private static func loadVerifiedArtifact(bundle: Bundle) throws -> LekhVerifiedNeuralArtifact {
    guard let manifestURL = bundle.url(
      forResource: "LekhNeuralTransliterator.manifest",
      withExtension: "json"
    ), let vocabURL = bundle.url(
      forResource: "LekhNeuralTransliterator.vocab",
      withExtension: "json"
    ) else {
      throw LekhNeuralGateFailure.resourceMissing
    }

    let manifestData = try readRegularResource(manifestURL)
    let vocabData = try readRegularResource(vocabURL)
    try validateResourceJSONShape(manifestData: manifestData, vocabData: vocabData)

    let manifest: LekhNeuralManifest
    let vocab: LekhNeuralVocabMetadata
    do {
      manifest = try JSONDecoder().decode(LekhNeuralManifest.self, from: manifestData)
      vocab = try JSONDecoder().decode(LekhNeuralVocabMetadata.self, from: vocabData)
    } catch {
      throw LekhNeuralGateFailure.manifestOrVocabMalformed
    }
    try validateArtifactContract(manifest: manifest, vocab: vocab)

    guard sha256(vocabData) == manifest.sha256.vocabMetadata else {
      throw LekhNeuralGateFailure.vocabHashMismatch
    }
    let modelRuntime: LekhNeuralModelRuntime
    if manifest.runtimeModelContract == "split-attention-incremental-v1" {
      guard let compiledModels = manifest.compiledModels,
            let tensorContract = manifest.tensorContract else {
        throw LekhNeuralGateFailure.artifactContractInvalid
      }
      let encoderURL = try compiledModelResourceURL(
        bundle: bundle,
        recordedPath: compiledModels.encoder.compiledModel
      )
      let decoderURL = try compiledModelResourceURL(
        bundle: bundle,
        recordedPath: compiledModels.decoderStep.compiledModel
      )
      guard encoderURL.standardizedFileURL != decoderURL.standardizedFileURL else {
        throw LekhNeuralGateFailure.artifactContractInvalid
      }
      let encoderIdentity = try sha256Directory(encoderURL)
      let decoderIdentity = try sha256Directory(decoderURL)
      guard encoderIdentity.bytes == compiledModels.encoder.compiledBytes,
            decoderIdentity.bytes == compiledModels.decoderStep.compiledBytes,
            encoderIdentity.bytes + decoderIdentity.bytes == manifest.modelBytes else {
        throw LekhNeuralGateFailure.modelSizeMismatch
      }
      guard encoderIdentity.digest == compiledModels.encoder.compiledSha256,
            decoderIdentity.digest == compiledModels.decoderStep.compiledSha256 else {
        throw LekhNeuralGateFailure.modelHashMismatch
      }
      let encoderModel = try loadCoreMLModel(encoderURL)
      let decoderModel = try loadCoreMLModel(decoderURL)
      let runtimeContract = try splitRuntimeContract(
        tensorContract,
        vocab: vocab,
        manifest: manifest
      )
      try validateSplitModelContract(
        encoder: encoderModel,
        decoderStep: decoderModel,
        contract: runtimeContract
      )
      modelRuntime = .splitAttention(
        models: LekhNeuralSplitAttentionModels(
          encoder: LekhCoreMLModelPredictor(encoderModel),
          decoderStep: LekhCoreMLModelPredictor(decoderModel)
        ),
        contract: runtimeContract
      )
    } else if manifest.runtimeModelContract == "single-transformer-ctc-v1" {
      guard let modelURL = bundle.url(
        forResource: "LekhNeuralTransliterator",
        withExtension: "mlmodelc"
      ), let expectedModelHash = manifest.sha256.compiledModel,
      let tensorContract = manifest.tensorContract else {
        throw LekhNeuralGateFailure.resourceMissing
      }
      let modelIdentity = try sha256Directory(modelURL)
      guard modelIdentity.bytes == manifest.modelBytes else {
        throw LekhNeuralGateFailure.modelSizeMismatch
      }
      guard modelIdentity.digest == expectedModelHash else {
        throw LekhNeuralGateFailure.modelHashMismatch
      }
      let model = try loadCoreMLModel(modelURL)
      let runtimeContract = try ctcRuntimeContract(
        tensorContract,
        vocab: vocab,
        manifest: manifest
      )
      try validateCTCModelContract(
        model: model,
        contract: runtimeContract
      )
      modelRuntime = .ctc(
        model: LekhCoreMLModelPredictor(model),
        contract: runtimeContract
      )
    } else {
      guard let modelURL = bundle.url(
        forResource: "LekhNeuralTransliterator",
        withExtension: "mlmodelc"
      ), let expectedModelHash = manifest.sha256.compiledModel else {
        throw LekhNeuralGateFailure.resourceMissing
      }
      let modelIdentity = try sha256Directory(modelURL)
      guard modelIdentity.bytes == manifest.modelBytes else {
        throw LekhNeuralGateFailure.modelSizeMismatch
      }
      guard modelIdentity.digest == expectedModelHash else {
        throw LekhNeuralGateFailure.modelHashMismatch
      }
      let model = try loadCoreMLModel(modelURL)
      try validateModelContract(model: model, vocab: vocab)
      modelRuntime = .legacy(model)
    }
    return LekhVerifiedNeuralArtifact(
      manifest: manifest,
      vocab: vocab,
      modelRuntime: modelRuntime
    )
  }

  private static func validateArtifactContract(
    manifest: LekhNeuralManifest,
    vocab: LekhNeuralVocabMetadata
  ) throws {
    let expectedCases = [
      "vato": "बाटो",
      "bato": "बाटो",
      "baato": "बाटो",
      "chha": "छ",
      "cha": "छ",
      "xa": "छ",
      "xaina": "छैन"
    ]
    guard LekhNeuralManifestIdentityPolicy.permits(
      schemaVersion: manifest.schemaVersion,
      trainingRunId: manifest.trainingRunId,
      exportRunId: manifest.exportRunId,
      productionEligible: manifest.productionEligible
    ) else {
      throw LekhNeuralGateFailure.manifestIdentityInvalid
    }
    let isCTC = manifest.runtimeModelContract == "single-transformer-ctc-v1"
    let scalarOutputContract =
      manifest.tokenization == "unicode-scalar-character" &&
      manifest.outputSequenceValidation == "devanagari-word-sequence-v1" &&
      hasCompleteScalarDecoderRange(
        runtimeModelContract: manifest.runtimeModelContract,
        maxOutputLength: manifest.beamSearch.maxOutputGraphemes,
        maxSteps: manifest.beamSearch.maxSteps
      )
    let quarantinedLegacyOutputContract =
      manifest.tokenization == "unicode-grapheme-character" &&
      manifest.outputSequenceValidation == nil &&
      manifest.beamSearch.maxSteps == nil &&
      !manifest.productionEligible
    guard manifest.runtime == "CoreML",
          manifest.localOnly,
          manifest.neuralTailOnly,
          manifest.openVocabulary,
          (scalarOutputContract || quarantinedLegacyOutputContract),
          manifest.decoder == (
            isCTC
              ? "ctc-prefix-beam-search"
              : "beam-search"
          ),
          manifest.beamSearch.enabled,
          (2...8).contains(manifest.beamSearch.beamWidth),
          (8...48).contains(manifest.beamSearch.maxOutputGraphemes),
          (1_000_000...5_000_000).contains(manifest.parameterCount),
          (1...16_777_216).contains(manifest.modelBytes),
          manifest.requiredCases == expectedCases,
          isSHA256(manifest.sha256.sourceCheckpoint),
          isSHA256(manifest.sha256.trainingDatasetManifest),
          isSHA256(manifest.sha256.vocabMetadata) else {
      throw LekhNeuralGateFailure.artifactContractInvalid
    }

    if manifest.runtimeModelContract == "split-attention-incremental-v1" {
      guard manifest.selectedArtifact == "lekh-open-vocab-bigru-attention-v1",
            manifest.architecture == "bidirectional-gru-additive-attention-seq2seq",
            manifest.sha256.compiledModel == nil,
            let compiledModels = manifest.compiledModels,
            let tensorContract = manifest.tensorContract,
            let compiledHashes = manifest.sha256.compiledModels,
            let packageHashes = manifest.sha256.mlpackages,
            Set(compiledHashes.keys) == Set(["encoder", "decoderStep"]),
            Set(packageHashes.keys) == Set(["encoder", "decoderStep"]),
            validSplitArtifact(
              compiledModels.encoder,
              role: "encoder",
              compiledHash: compiledHashes["encoder"],
              packageHash: packageHashes["encoder"]
            ),
            validSplitArtifact(
              compiledModels.decoderStep,
              role: "decoderStep",
              compiledHash: compiledHashes["decoderStep"],
              packageHash: packageHashes["decoderStep"]
            ),
            compiledModels.encoder.compiledModel != compiledModels.decoderStep.compiledModel,
            compiledModels.encoder.compiledBytes <= Int.max - compiledModels.decoderStep.compiledBytes,
            compiledModels.encoder.compiledBytes + compiledModels.decoderStep.compiledBytes == manifest.modelBytes,
            (try? splitRuntimeContract(tensorContract, vocab: vocab, manifest: manifest)) != nil else {
        throw LekhNeuralGateFailure.artifactContractInvalid
      }
    } else if isCTC {
      guard manifest.selectedArtifact == "lekh-open-vocab-ctc-transformer-v2",
            manifest.architecture == "fixed-shape-transformer-ctc",
            manifest.compiledModels == nil,
            manifest.sha256.compiledModels == nil,
            manifest.sha256.mlpackages == nil,
            let compiledModelHash = manifest.sha256.compiledModel,
            isSHA256(compiledModelHash),
            let tensorContract = manifest.tensorContract,
            (try? ctcRuntimeContract(
              tensorContract,
              vocab: vocab,
              manifest: manifest
            )) != nil else {
        throw LekhNeuralGateFailure.artifactContractInvalid
      }
    } else {
      guard manifest.runtimeModelContract == nil,
            manifest.tensorContract == nil,
            manifest.compiledModels == nil,
            manifest.sha256.compiledModels == nil,
            manifest.sha256.mlpackages == nil,
            manifest.selectedArtifact == "lekh-open-vocab-seq2seq-v1",
            manifest.architecture == "gru-encoder-decoder-seq2seq",
            let compiledModelHash = manifest.sha256.compiledModel,
            isSHA256(compiledModelHash) else {
        throw LekhNeuralGateFailure.artifactContractInvalid
      }
    }

    guard vocab.modelId == manifest.selectedArtifact,
          vocab.tokenization == manifest.tokenization,
          ISO8601DateFormatter().date(from: vocab.generatedAt) != nil,
          vocab.decoder.type == manifest.decoder,
          vocab.decoder.beamWidth == manifest.beamSearch.beamWidth,
          vocab.decoder.rejectWhitespaceCandidates,
          vocab.decoder.rejectLatinCandidates,
          vocab.dataset.manifestSha256 == manifest.sha256.trainingDatasetManifest,
          vocab.nativeRuntimePolicy.asyncOnly,
          vocab.nativeRuntimePolicy.neverInvokeInSecureFields,
          vocab.nativeRuntimePolicy.failOpenRawTypingOnError,
          vocab.nativeRuntimePolicy.neuralTailOnly else {
      throw LekhNeuralGateFailure.runtimePolicyInvalid
    }
    if isCTC {
      guard vocab.schemaVersion == 2,
            vocab.runtimeModelContract == manifest.runtimeModelContract,
            vocab.decoder.maximumCandidates != nil,
            (1...manifest.beamSearch.beamWidth).contains(
              vocab.decoder.maximumCandidates ?? 0
            ),
            vocab.decoder.maxSteps == nil,
            vocab.decoder.outputSequenceValidation ==
              "devanagari-word-sequence-v1",
            vocab.output.timeSteps ==
              manifest.beamSearch.maxOutputGraphemes else {
        throw LekhNeuralGateFailure.runtimePolicyInvalid
      }
      try validateInputVocabulary(
        vocab.input,
        requiresSOSToken: false
      )
      try validateCTCOutputVocabulary(vocab.output)
    } else {
      guard vocab.schemaVersion == 1,
            vocab.runtimeModelContract == nil,
            vocab.decoder.maximumCandidates == nil,
            (
              quarantinedLegacyOutputContract ||
              (
                vocab.output.maxLength != nil &&
                hasCompleteScalarDecoderRange(
                  runtimeModelContract: manifest.runtimeModelContract,
                  maxOutputLength: vocab.output.maxLength ?? 0,
                  maxSteps: vocab.decoder.maxSteps
                ) &&
                vocab.decoder.outputSequenceValidation ==
                  "devanagari-word-sequence-v1"
              )
            ),
            vocab.output.maxLength ==
              manifest.beamSearch.maxOutputGraphemes else {
        throw LekhNeuralGateFailure.runtimePolicyInvalid
      }
      try validateInputVocabulary(
        vocab.input,
        requiresSOSToken: true
      )
      try validateLegacyOutputVocabulary(
        vocab.output,
        scalarOutput: scalarOutputContract
      )
    }
  }

  private static func validSplitArtifact(
    _ artifact: LekhNeuralManifest.CompiledArtifact,
    role: String,
    compiledHash: String?,
    packageHash: String?
  ) -> Bool {
    artifact.role == role &&
      (1...16_777_216).contains(artifact.compiledBytes) &&
      (1...16_777_216).contains(artifact.mlpackageBytes) &&
      isSafeRecordedArtifactPath(artifact.compiledModel, suffix: ".mlmodelc") &&
      isSafeRecordedArtifactPath(artifact.mlpackage, suffix: ".mlpackage") &&
      isSHA256(artifact.compiledSha256) &&
      isSHA256(artifact.mlpackageSha256) &&
      artifact.compiledSha256 == compiledHash &&
      artifact.mlpackageSha256 == packageHash
  }

  private static func isSafeRecordedArtifactPath(_ path: String, suffix: String) -> Bool {
    guard !path.isEmpty,
          !path.hasPrefix("/"),
          path.hasSuffix(suffix),
          !path.contains("\\") else { return false }
    let components = path.split(separator: "/", omittingEmptySubsequences: false)
    return !components.isEmpty && components.allSatisfy { component in
      !component.isEmpty && component != "." && component != ".."
    }
  }

  private static func validateVocabularyMapping(
    _ vocabulary: LekhNeuralVocabMetadata.Vocabulary,
    minimumTokenCount: Int
  ) throws {
    guard vocabulary.tokensById.count >= minimumTokenCount,
          vocabulary.tokensById.count == vocabulary.idsByToken.count,
          Set(vocabulary.tokensById).count == vocabulary.tokensById.count else {
      throw LekhNeuralGateFailure.vocabContractInvalid
    }
    for (id, token) in vocabulary.tokensById.enumerated() {
      guard vocabulary.idsByToken[token] == id else {
        throw LekhNeuralGateFailure.vocabContractInvalid
      }
    }
  }

  private static func validateInputVocabulary(
    _ vocabulary: LekhNeuralVocabMetadata.Vocabulary,
    requiresSOSToken: Bool
  ) throws {
    try validateVocabularyMapping(
      vocabulary,
      minimumTokenCount: requiresSOSToken ? 5 : 4
    )
    guard let maxLength = vocabulary.maxLength,
          (4...128).contains(maxLength),
          vocabulary.timeSteps == nil,
          vocabulary.blankId == nil,
          let padId = vocabulary.padId,
          let eosId = vocabulary.eosId,
          let unkId = vocabulary.unkId,
          requiresSOSToken == (vocabulary.sosId != nil) else {
      throw LekhNeuralGateFailure.vocabContractInvalid
    }
    var special = [
      (padId, "<pad>"),
      (eosId, "</s>"),
      (unkId, "<unk>")
    ]
    if let sosId = vocabulary.sosId {
      special.append((sosId, "<s>"))
    }
    guard Set(special.map(\.0)).count == special.count,
          special.allSatisfy({ id, token in
            id >= 0 && id < vocabulary.tokensById.count && vocabulary.tokensById[id] == token
          }) else {
      throw LekhNeuralGateFailure.vocabContractInvalid
    }
    let lexicalTokens = vocabulary.tokensById.enumerated().compactMap { id, token in
      special.contains(where: { $0.0 == id }) ? nil : token
    }
    guard lexicalTokens.allSatisfy({ token in
      token.count == 1 &&
        token.range(of: #"^[a-z]$"#, options: .regularExpression) != nil
    }) else {
      throw LekhNeuralGateFailure.vocabContractInvalid
    }
  }

  private static func validateLegacyOutputVocabulary(
    _ vocabulary: LekhNeuralVocabMetadata.Vocabulary,
    scalarOutput: Bool
  ) throws {
    try validateVocabularyMapping(vocabulary, minimumTokenCount: 5)
    guard let maxLength = vocabulary.maxLength,
          (4...128).contains(maxLength),
          vocabulary.timeSteps == nil,
          vocabulary.blankId == nil,
          let padId = vocabulary.padId,
          let sosId = vocabulary.sosId,
          let eosId = vocabulary.eosId,
          let unkId = vocabulary.unkId else {
      throw LekhNeuralGateFailure.vocabContractInvalid
    }
    let special = [
      (padId, "<pad>"),
      (sosId, "<s>"),
      (eosId, "</s>"),
      (unkId, "<unk>")
    ]
    guard Set(special.map(\.0)).count == special.count,
          special.allSatisfy({ id, token in
            vocabulary.tokensById.indices.contains(id) &&
              vocabulary.tokensById[id] == token
          }) else {
      throw LekhNeuralGateFailure.vocabContractInvalid
    }
    let lexicalTokens = vocabulary.tokensById.enumerated().compactMap {
      id, token in
      special.contains(where: { $0.0 == id }) ? nil : token
    }
    guard lexicalTokens.allSatisfy({ token in
      scalarOutput
        ? LekhDevanagariOutputSequence.isSupportedScalarToken(token)
        : !token.isEmpty && token.unicodeScalars.allSatisfy { scalar in
          (0x0900...0x097F).contains(scalar.value) ||
            scalar.value == 0x200C ||
            scalar.value == 0x200D
        }
    }) else {
      throw LekhNeuralGateFailure.vocabContractInvalid
    }
  }

  private static func validateCTCOutputVocabulary(
    _ vocabulary: LekhNeuralVocabMetadata.Vocabulary
  ) throws {
    try validateVocabularyMapping(vocabulary, minimumTokenCount: 2)
    guard vocabulary.maxLength == nil,
          let timeSteps = vocabulary.timeSteps,
          (8...48).contains(timeSteps),
          vocabulary.padId == nil,
          vocabulary.sosId == nil,
          vocabulary.eosId == nil,
          vocabulary.unkId == nil,
          let blankId = vocabulary.blankId,
          blankId == 0,
          vocabulary.tokensById.indices.contains(blankId),
          vocabulary.tokensById[blankId] == "<ctc-blank>" else {
      throw LekhNeuralGateFailure.vocabContractInvalid
    }
    let lexicalTokens = vocabulary.tokensById.enumerated().compactMap {
      $0.offset == blankId ? nil : $0.element
    }
    guard !lexicalTokens.isEmpty,
          lexicalTokens.allSatisfy(
            LekhDevanagariOutputSequence.isSupportedScalarToken
          ) else {
      throw LekhNeuralGateFailure.vocabContractInvalid
    }
  }

  private static func validateProductionContract(_ artifact: LekhVerifiedNeuralArtifact) throws {
    let manifest = artifact.manifest
    let requiredSources: Set<String> = [
      "ai4bharat-aksharantar-nepali"
    ]
    guard manifest.schemaVersion == LekhNeuralManifestIdentityPolicy.currentSchemaVersion,
          LekhNeuralManifestIdentityPolicy.isValidRunIdentifier(manifest.trainingRunId),
          LekhNeuralManifestIdentityPolicy.isValidRunIdentifier(manifest.exportRunId),
          manifest.productionEligible,
          manifest.tokenization == "unicode-scalar-character",
          manifest.outputSequenceValidation == "devanagari-word-sequence-v1",
          hasCompleteScalarDecoderRange(
            runtimeModelContract: manifest.runtimeModelContract,
            maxOutputLength: manifest.beamSearch.maxOutputGraphemes,
            maxSteps: manifest.beamSearch.maxSteps
          ),
          requiredSources.isSubset(of: Set(manifest.trainingSources)),
          validReportPaths(manifest.datasetReports),
          validReportPaths(manifest.evaluationReports),
          validReportPaths(manifest.benchmarkReports),
          !manifest.languageModelRescorer.enabled,
          manifest.languageModelRescorer.source == "none",
          manifest.languageModelRescorer.weight == 0,
          manifest.contextWindowWords == 0 else {
      throw LekhNeuralGateFailure.productionProvenanceInvalid
    }

    let metrics = manifest.metrics
    guard metrics.tailTop1Accuracy >= 0.88,
          metrics.tailTop3Accuracy >= 0.96,
          metrics.chatConventionTop1Accuracy >= 0.92,
          metrics.chatConventionTop3Accuracy >= 0.98,
          metrics.namesTop3Accuracy >= 0.90,
          metrics.protectedFalseConversionRate == 0,
          metrics.singleTokenPhraseExpansionRate == 0,
          metrics.secureFieldInferenceCount == 0 else {
      throw LekhNeuralGateFailure.productionQualityInvalid
    }

    let performance = manifest.performance
    let architectures = Set(performance.devices.map(\.architecture))
    guard performance.measuredOnDevice,
          performance.targetP99Ms == 50,
          performance.p50Ms >= 0, performance.p50Ms < 50,
          performance.p95Ms >= 0, performance.p95Ms < 50,
          performance.p99Ms >= 0, performance.p99Ms < 50,
          LekhNeuralProductionMemoryPolicy.permits(
            summary: performance.memory,
            devices: performance.devices.map(\.memory)
          ),
          !performance.devices.isEmpty,
          architectures.contains("arm64"),
          performance.devices.allSatisfy({ device in
            device.packagedApp &&
              device.measurementKind == "full-candidate-generation" &&
              device.p50Ms >= 0 && device.p50Ms < 50 &&
              device.p95Ms >= 0 && device.p95Ms < 50 &&
              device.p99Ms >= 0 && device.p99Ms < 50 &&
              device.secureFieldInferenceCount == 0 &&
              !device.name.isEmpty && !device.macOS.isEmpty && !device.artifact.isEmpty
          }) else {
      throw LekhNeuralGateFailure.productionBenchmarkInvalid
    }

  }

  private static func hasCompleteScalarDecoderRange(
    runtimeModelContract: String?,
    maxOutputLength: Int,
    maxSteps: Int?
  ) -> Bool {
    guard (8...48).contains(maxOutputLength) else { return false }
    if runtimeModelContract == "single-transformer-ctc-v1" {
      return maxSteps == maxOutputLength
    }
    return maxSteps == maxOutputLength - 1
  }

  private static func verifyKnownAnswers(
    modelRuntime: LekhNeuralModelRuntime,
    vocab: LekhNeuralVocabMetadata,
    cases: [String: String]
  ) -> Bool {
    let suiteStarted = DispatchTime.now().uptimeNanoseconds
    let suiteBudget: UInt64 = 2_000_000_000
    for input in cases.keys.sorted() {
      guard let expected = cases[input], isSafeCandidate(expected) else { return false }
      let caseStarted = DispatchTime.now().uptimeNanoseconds
      let caseBudget: UInt64 = 250_000_000
      let candidates: [String]
      do {
        candidates = try predictCandidates(modelRuntime: modelRuntime, vocab: vocab, input: input) {
          let now = DispatchTime.now().uptimeNanoseconds
          return now - caseStarted >= caseBudget || now - suiteStarted >= suiteBudget
        }
      } catch {
        return false
      }
      guard candidates.first == expected else { return false }
    }
    return true
  }

  private static func loadCoreMLModel(_ url: URL) throws -> MLModel {
    do {
      let configuration = MLModelConfiguration()
      configuration.computeUnits = .all
      return try MLModel(contentsOf: url, configuration: configuration)
    } catch {
      throw LekhNeuralGateFailure.modelLoadFailed
    }
  }

  private static func compiledModelResourceURL(
    bundle: Bundle,
    recordedPath: String
  ) throws -> URL {
    guard isSafeRecordedArtifactPath(recordedPath, suffix: ".mlmodelc") else {
      throw LekhNeuralGateFailure.artifactContractInvalid
    }
    let filename = String(recordedPath.split(separator: "/").last ?? "")
    let resourceName = String(filename.dropLast(".mlmodelc".count))
    guard !resourceName.isEmpty,
          let url = bundle.url(forResource: resourceName, withExtension: "mlmodelc") else {
      throw LekhNeuralGateFailure.resourceMissing
    }
    return url
  }

  private static func splitRuntimeContract(
    _ tensorContract: LekhNeuralManifest.TensorContract,
    vocab: LekhNeuralVocabMetadata,
    manifest: LekhNeuralManifest
  ) throws -> LekhNeuralSplitAttentionContract {
    guard let encoder = tensorContract.encoder,
          let decoderStep = tensorContract.decoderStep,
          tensorContract.inputIds == nil,
          tensorContract.logits == nil,
          let inputLength = vocab.input.maxLength else {
      throw LekhNeuralGateFailure.modelIOContractInvalid
    }
    let encoderInputs = encoder.inputs
    let encoderOutputs = encoder.outputs
    let decoderInputs = decoderStep.inputs
    let decoderOutputs = decoderStep.outputs
    guard Set(encoderInputs.keys) == Set(["inputIds"]),
          Set(encoderOutputs.keys) == Set([
            "encoderOutputs", "encoderEnergy", "validMask", "initialDecoderHidden"
          ]),
          Set(decoderInputs.keys) == Set([
            "decoderTokenIds", "decoderHidden", "encoderOutputs", "encoderEnergy", "validMask"
          ]),
          Set(decoderOutputs.keys) == Set(["stepLogits", "nextDecoderHidden"]),
          let inputIds = encoderInputs["inputIds"],
          let encoded = encoderOutputs["encoderOutputs"],
          let energy = encoderOutputs["encoderEnergy"],
          let mask = encoderOutputs["validMask"],
          let initialHidden = encoderOutputs["initialDecoderHidden"],
          inputIds.dataType == "INT32", inputIds.shape == [1, inputLength],
          encoded.dataType == "FLOAT16", encoded.shape.count == 3,
          encoded.shape[0] == 1, encoded.shape[1] == inputLength,
          encoded.shape[2] > 0,
          energy.dataType == "FLOAT16", energy.shape.count == 3,
          energy.shape[0] == 1, energy.shape[1] == inputLength,
          energy.shape[2] > 0,
          mask.dataType == "FLOAT16", mask.shape == [1, inputLength],
          initialHidden.dataType == "FLOAT16", initialHidden.shape.count == 3,
          initialHidden.shape[0] > 0, initialHidden.shape[1] == 1,
          initialHidden.shape[2] > 0 else {
      throw LekhNeuralGateFailure.modelIOContractInvalid
    }
    let contract = LekhNeuralSplitAttentionContract(
      maxInputLength: inputLength,
      encoderWidth: encoded.shape[2],
      attentionWidth: energy.shape[2],
      decoderLayers: initialHidden.shape[0],
      beamWidth: manifest.beamSearch.beamWidth,
      hiddenWidth: initialHidden.shape[2],
      vocabularySize: vocab.output.tokensById.count
    )
    guard contract.isValid,
          contract.encoderWidth == contract.hiddenWidth * 2,
          decoderInputs["decoderTokenIds"] == .init(
            shape: [contract.beamWidth, 1],
            dataType: "INT32"
          ),
          decoderInputs["decoderHidden"] == .init(
            shape: [contract.decoderLayers, contract.beamWidth, contract.hiddenWidth],
            dataType: "FLOAT16"
          ),
          decoderInputs["encoderOutputs"] == encoded,
          decoderInputs["encoderEnergy"] == energy,
          decoderInputs["validMask"] == mask,
          decoderOutputs["stepLogits"] == .init(
            shape: [contract.beamWidth, contract.vocabularySize],
            dataType: "FLOAT16"
          ),
          decoderOutputs["nextDecoderHidden"] == .init(
            shape: [contract.decoderLayers, contract.beamWidth, contract.hiddenWidth],
            dataType: "FLOAT16"
          ),
          vocab.decoder.beamWidth == contract.beamWidth else {
      throw LekhNeuralGateFailure.modelIOContractInvalid
    }
    return contract
  }

  private static func ctcRuntimeContract(
    _ tensorContract: LekhNeuralManifest.TensorContract,
    vocab: LekhNeuralVocabMetadata,
    manifest: LekhNeuralManifest
  ) throws -> LekhNeuralCTCContract {
    guard tensorContract.encoder == nil,
          tensorContract.decoderStep == nil,
          let inputIds = tensorContract.inputIds,
          let logits = tensorContract.logits,
          let inputLength = vocab.input.maxLength,
          let outputTimeSteps = vocab.output.timeSteps,
          let blankTokenId = vocab.output.blankId,
          let maximumCandidates = vocab.decoder.maximumCandidates,
          inputIds == .init(
            shape: [1, inputLength],
            dataType: "INT32"
          ),
          logits == .init(
            shape: [
              1,
              outputTimeSteps,
              vocab.output.tokensById.count
            ],
            dataType: "FLOAT16"
          ),
          manifest.beamSearch.maxOutputGraphemes == outputTimeSteps,
          manifest.beamSearch.maxSteps == outputTimeSteps else {
      throw LekhNeuralGateFailure.modelIOContractInvalid
    }
    let contract = LekhNeuralCTCContract(
      maxInputLength: inputLength,
      outputTimeSteps: outputTimeSteps,
      vocabularySize: vocab.output.tokensById.count,
      blankTokenId: blankTokenId,
      beamWidth: manifest.beamSearch.beamWidth,
      maximumCandidates: maximumCandidates
    )
    guard contract.isValid,
          vocab.decoder.beamWidth == contract.beamWidth else {
      throw LekhNeuralGateFailure.modelIOContractInvalid
    }
    return contract
  }

  private static func validateSplitModelContract(
    encoder: MLModel,
    decoderStep: MLModel,
    contract: LekhNeuralSplitAttentionContract
  ) throws {
    let encoderDescription = encoder.modelDescription
    let decoderDescription = decoderStep.modelDescription
    guard Set(encoderDescription.inputDescriptionsByName.keys) == Set(["inputIds"]),
          Set(encoderDescription.outputDescriptionsByName.keys) == Set([
            "encoderOutputs", "encoderEnergy", "validMask", "initialDecoderHidden"
          ]),
          validMultiArrayFeature(
            encoderDescription.inputDescriptionsByName["inputIds"],
            shape: [1, contract.maxInputLength],
            dataType: .int32
          ),
          validMultiArrayFeature(
            encoderDescription.outputDescriptionsByName["encoderOutputs"],
            shape: [1, contract.maxInputLength, contract.encoderWidth],
            dataType: .float16
          ),
          validMultiArrayFeature(
            encoderDescription.outputDescriptionsByName["encoderEnergy"],
            shape: [1, contract.maxInputLength, contract.attentionWidth],
            dataType: .float16
          ),
          validMultiArrayFeature(
            encoderDescription.outputDescriptionsByName["validMask"],
            shape: [1, contract.maxInputLength],
            dataType: .float16
          ),
          validMultiArrayFeature(
            encoderDescription.outputDescriptionsByName["initialDecoderHidden"],
            shape: [contract.decoderLayers, 1, contract.hiddenWidth],
            dataType: .float16
          ),
          Set(decoderDescription.inputDescriptionsByName.keys) == Set([
            "decoderTokenIds", "decoderHidden", "encoderOutputs", "encoderEnergy", "validMask"
          ]),
          Set(decoderDescription.outputDescriptionsByName.keys) == Set([
            "stepLogits", "nextDecoderHidden"
          ]),
          validMultiArrayFeature(
            decoderDescription.inputDescriptionsByName["decoderTokenIds"],
            shape: [contract.beamWidth, 1],
            dataType: .int32
          ),
          validMultiArrayFeature(
            decoderDescription.inputDescriptionsByName["decoderHidden"],
            shape: [contract.decoderLayers, contract.beamWidth, contract.hiddenWidth],
            dataType: .float16
          ),
          validMultiArrayFeature(
            decoderDescription.inputDescriptionsByName["encoderOutputs"],
            shape: [1, contract.maxInputLength, contract.encoderWidth],
            dataType: .float16
          ),
          validMultiArrayFeature(
            decoderDescription.inputDescriptionsByName["encoderEnergy"],
            shape: [1, contract.maxInputLength, contract.attentionWidth],
            dataType: .float16
          ),
          validMultiArrayFeature(
            decoderDescription.inputDescriptionsByName["validMask"],
            shape: [1, contract.maxInputLength],
            dataType: .float16
          ),
          validMultiArrayFeature(
            decoderDescription.outputDescriptionsByName["stepLogits"],
            shape: [contract.beamWidth, contract.vocabularySize],
            dataType: .float16
          ),
          validMultiArrayFeature(
            decoderDescription.outputDescriptionsByName["nextDecoderHidden"],
            shape: [contract.decoderLayers, contract.beamWidth, contract.hiddenWidth],
            dataType: .float16
          ) else {
      throw LekhNeuralGateFailure.modelIOContractInvalid
    }
  }

  private static func validateModelContract(model: MLModel, vocab: LekhNeuralVocabMetadata) throws {
    guard let inputLength = vocab.input.maxLength,
          let outputLength = vocab.output.maxLength else {
      throw LekhNeuralGateFailure.modelIOContractInvalid
    }
    let description = model.modelDescription
    guard Set(description.inputDescriptionsByName.keys) == Set(["inputIds", "decoderInputIds"]),
          Set(description.outputDescriptionsByName.keys) == Set(["logits"]),
          validMultiArrayFeature(
            description.inputDescriptionsByName["inputIds"],
            shape: [1, inputLength],
            dataType: .int32
          ),
          validMultiArrayFeature(
            description.inputDescriptionsByName["decoderInputIds"],
            shape: [1, outputLength - 1],
            dataType: .int32
          ),
          validMultiArrayFeature(
            description.outputDescriptionsByName["logits"],
            shape: [
              1,
              outputLength - 1,
              vocab.output.tokensById.count
            ],
            dataType: .float16
          ) else {
      throw LekhNeuralGateFailure.modelIOContractInvalid
    }
  }

  private static func validateCTCModelContract(
    model: MLModel,
    contract: LekhNeuralCTCContract
  ) throws {
    let description = model.modelDescription
    guard Set(description.inputDescriptionsByName.keys) == Set(["inputIds"]),
          Set(description.outputDescriptionsByName.keys) == Set(["logits"]),
          validMultiArrayFeature(
            description.inputDescriptionsByName["inputIds"],
            shape: [1, contract.maxInputLength],
            dataType: .int32
          ),
          validMultiArrayFeature(
            description.outputDescriptionsByName["logits"],
            shape: [
              1,
              contract.outputTimeSteps,
              contract.vocabularySize
            ],
            dataType: .float16
          ) else {
      throw LekhNeuralGateFailure.modelIOContractInvalid
    }
  }

  private static func validMultiArrayFeature(
    _ feature: MLFeatureDescription?,
    shape: [Int],
    dataType: MLMultiArrayDataType
  ) -> Bool {
    guard let feature,
          feature.type == .multiArray,
          !feature.isOptional,
          let constraint = feature.multiArrayConstraint else { return false }
    return constraint.dataType == dataType && constraint.shape.map { $0.intValue } == shape
  }

  private static func validReportPaths(_ paths: [String]) -> Bool {
    !paths.isEmpty && paths.allSatisfy { path in
      path.hasPrefix("reports/") && path.hasSuffix(".json") && !path.contains("..")
    }
  }

  private static func readRegularResource(_ url: URL) throws -> Data {
    do {
      let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
      guard values.isRegularFile == true, values.isSymbolicLink != true else {
        throw LekhNeuralGateFailure.resourceTypeInvalid
      }
      return try Data(contentsOf: url, options: [.mappedIfSafe])
    } catch let failure as LekhNeuralGateFailure {
      throw failure
    } catch {
      throw LekhNeuralGateFailure.resourceUnreadable
    }
  }

  private static func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private static func sha256Directory(_ root: URL) throws -> (digest: String, bytes: Int) {
    let maximumFiles = 10_000
    let maximumBytes = 16_777_216
    let rootValues = try root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    guard rootValues.isDirectory == true, rootValues.isSymbolicLink != true else {
      throw LekhNeuralGateFailure.resourceTypeInvalid
    }
    let keys: Set<URLResourceKey> = [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
    var enumerationFailed = false
    guard let enumerator = FileManager.default.enumerator(
      at: root,
      includingPropertiesForKeys: Array(keys),
      options: [],
      errorHandler: { _, _ in
        enumerationFailed = true
        return false
      }
    ) else {
      throw LekhNeuralGateFailure.resourceUnreadable
    }
    let rootPath = root.standardizedFileURL.path
    var files: [(relativePath: String, url: URL, bytes: Int)] = []
    var declaredBytes = 0
    for case let url as URL in enumerator {
      let values = try url.resourceValues(forKeys: keys)
      guard values.isSymbolicLink != true else { throw LekhNeuralGateFailure.resourceTypeInvalid }
      if values.isDirectory == true { continue }
      guard values.isRegularFile == true,
            let size = values.fileSize,
            size >= 0,
            files.count < maximumFiles,
            declaredBytes <= maximumBytes - size,
            url.standardizedFileURL.path.hasPrefix(rootPath + "/") else {
        throw LekhNeuralGateFailure.resourceTypeInvalid
      }
      let relativePath = String(url.standardizedFileURL.path.dropFirst(rootPath.count + 1))
      guard !relativePath.isEmpty, !relativePath.contains("..") else {
        throw LekhNeuralGateFailure.resourceTypeInvalid
      }
      files.append((relativePath, url, size))
      declaredBytes += size
    }
    guard !enumerationFailed, !files.isEmpty else {
      throw LekhNeuralGateFailure.resourceUnreadable
    }
    var hasher = SHA256()
    var totalBytes = 0
    let zero = Data([0])
    for file in files.sorted(by: { $0.relativePath < $1.relativePath }) {
      let data = try readRegularResource(file.url)
      guard data.count == file.bytes else { throw LekhNeuralGateFailure.resourceUnreadable }
      totalBytes += data.count
      hasher.update(data: Data(file.relativePath.utf8))
      hasher.update(data: zero)
      hasher.update(data: data)
      hasher.update(data: zero)
    }
    guard totalBytes == declaredBytes else {
      throw LekhNeuralGateFailure.resourceUnreadable
    }
    return (hasher.finalize().map { String(format: "%02x", $0) }.joined(), totalBytes)
  }

  private static func isSHA256(_ value: String) -> Bool {
    value.count == 64 && value.unicodeScalars.allSatisfy { scalar in
      (48...57).contains(scalar.value) || (97...102).contains(scalar.value)
    }
  }

  private static func validateResourceJSONShape(manifestData: Data, vocabData: Data) throws {
    let manifest = try jsonObject(manifestData)
    let legacyManifestKeys: Set<String> = [
      "schemaVersion", "selectedArtifact", "runtime", "localOnly", "neuralTailOnly",
      "productionEligible", "architecture", "openVocabulary", "tokenization", "decoder",
      "beamSearch", "languageModelRescorer", "contextWindowWords", "parameterCount",
      "modelBytes", "trainingSources", "datasetReports", "evaluationReports",
      "benchmarkReports", "metrics", "performance", "requiredCases", "sha256", "limitations"
    ]
    guard let schemaVersion = manifest["schemaVersion"] as? Int else {
      throw LekhNeuralGateFailure.manifestSchemaInvalid
    }
    let scalarOutputContract = manifest["tokenization"] as? String == "unicode-scalar-character"
    let manifestKeys = scalarOutputContract
      ? legacyManifestKeys.union(["outputSequenceValidation"])
      : legacyManifestKeys
    switch schemaVersion {
    case 1:
      try requireExactKeys(manifest, manifestKeys)
    case LekhNeuralManifestIdentityPolicy.currentSchemaVersion:
      if manifest["runtimeModelContract"] as? String == "split-attention-incremental-v1" {
        try requireExactKeys(
          manifest,
          manifestKeys.union([
            "trainingRunId", "exportRunId", "runtimeModelContract", "tensorContract",
            "compiledModels"
          ])
        )
      } else if manifest["runtimeModelContract"] as? String ==
          "single-transformer-ctc-v1" {
        try requireExactKeys(
          manifest,
          manifestKeys.union([
            "trainingRunId", "exportRunId", "runtimeModelContract",
            "tensorContract"
          ])
        )
      } else {
        try requireExactKeys(manifest, manifestKeys.union(["trainingRunId", "exportRunId"]))
      }
    default:
      throw LekhNeuralGateFailure.manifestSchemaInvalid
    }
    try requireExactKeys(
      try childObject(manifest, "beamSearch"),
      scalarOutputContract
        ? ["enabled", "beamWidth", "maxOutputGraphemes", "maxSteps"]
        : ["enabled", "beamWidth", "maxOutputGraphemes"]
    )
    try requireExactKeys(try childObject(manifest, "languageModelRescorer"), [
      "enabled", "source", "weight"
    ])
    try requireExactKeys(try childObject(manifest, "metrics"), [
      "tailTop1Accuracy", "tailTop3Accuracy", "chatConventionTop1Accuracy",
      "chatConventionTop3Accuracy", "namesTop3Accuracy", "protectedFalseConversionRate",
      "singleTokenPhraseExpansionRate", "secureFieldInferenceCount"
    ])
    let performance = try childObject(manifest, "performance")
    let productionEligible = manifest["productionEligible"] as? Bool == true
    let legacyPerformanceKeys: Set<String> = [
      "p50Ms", "p95Ms", "p99Ms", "targetP99Ms", "measuredOnDevice", "devices"
    ]
    try requireExactKeys(
      performance,
      productionEligible
        ? legacyPerformanceKeys.union(["memory"])
        : legacyPerformanceKeys
    )
    if productionEligible {
      try validateProductionMemoryJSONShape(
        try childObject(performance, "memory")
      )
    }
    guard let devices = performance["devices"] as? [Any], !devices.isEmpty else {
      throw LekhNeuralGateFailure.manifestSchemaInvalid
    }
    let legacyDeviceKeys: Set<String> = [
      "name", "macOS", "architecture", "packagedApp", "secureFieldInferenceCount",
      "p50Ms", "p95Ms", "p99Ms", "artifact"
    ]
    let fullCandidateDeviceKeys = legacyDeviceKeys.union(["measurementKind"])
    let productionDeviceKeys = fullCandidateDeviceKeys.union(["memory"])
    for value in devices {
      guard let device = value as? [String: Any] else {
        throw LekhNeuralGateFailure.manifestSchemaInvalid
      }
      let keys = Set(device.keys)
      guard productionEligible
        ? keys == productionDeviceKeys
        : keys == legacyDeviceKeys || keys == fullCandidateDeviceKeys else {
        throw LekhNeuralGateFailure.manifestSchemaInvalid
      }
      if productionEligible {
        try validateProductionMemoryJSONShape(
          try childObject(device, "memory")
        )
      }
    }
    if manifest["runtimeModelContract"] as? String == "split-attention-incremental-v1" {
      let compiledModels = try childObject(manifest, "compiledModels")
      try requireExactKeys(compiledModels, ["encoder", "decoderStep"])
      let artifactKeys: Set<String> = [
        "role", "mlpackage", "mlpackageBytes", "mlpackageSha256",
        "compiledModel", "compiledBytes", "compiledSha256"
      ]
      try requireExactKeys(try childObject(compiledModels, "encoder"), artifactKeys)
      try requireExactKeys(try childObject(compiledModels, "decoderStep"), artifactKeys)
      let tensorContract = try childObject(manifest, "tensorContract")
      try requireExactKeys(tensorContract, ["encoder", "decoderStep"])
      let encoder = try childObject(tensorContract, "encoder")
      let decoderStep = try childObject(tensorContract, "decoderStep")
      try requireExactKeys(encoder, ["inputs", "outputs"])
      try requireExactKeys(decoderStep, ["inputs", "outputs"])
      try validateTensorGroup(
        try childObject(encoder, "inputs"),
        names: ["inputIds"]
      )
      try validateTensorGroup(
        try childObject(encoder, "outputs"),
        names: ["encoderOutputs", "encoderEnergy", "validMask", "initialDecoderHidden"]
      )
      try validateTensorGroup(
        try childObject(decoderStep, "inputs"),
        names: ["decoderTokenIds", "decoderHidden", "encoderOutputs", "encoderEnergy", "validMask"]
      )
      try validateTensorGroup(
        try childObject(decoderStep, "outputs"),
        names: ["stepLogits", "nextDecoderHidden"]
      )
      let hashes = try childObject(manifest, "sha256")
      try requireExactKeys(hashes, [
        "compiledModels", "mlpackages", "sourceCheckpoint", "trainingDatasetManifest",
        "vocabMetadata"
      ])
      try requireExactKeys(try childObject(hashes, "compiledModels"), ["encoder", "decoderStep"])
      try requireExactKeys(try childObject(hashes, "mlpackages"), ["encoder", "decoderStep"])
    } else if manifest["runtimeModelContract"] as? String ==
        "single-transformer-ctc-v1" {
      let tensorContract = try childObject(manifest, "tensorContract")
      try validateTensorGroup(
        tensorContract,
        names: ["inputIds", "logits"]
      )
      try requireExactKeys(try childObject(manifest, "sha256"), [
        "compiledModel", "sourceCheckpoint", "trainingDatasetManifest",
        "vocabMetadata"
      ])
    } else {
      try requireExactKeys(try childObject(manifest, "sha256"), [
        "compiledModel", "sourceCheckpoint", "trainingDatasetManifest", "vocabMetadata"
      ])
    }

    let vocab = try jsonObject(vocabData)
    let isCTCVocabulary = vocab["runtimeModelContract"] as? String ==
      "single-transformer-ctc-v1"
    let vocabularyRootKeys: Set<String> = [
      "schemaVersion", "modelId", "generatedAt", "tokenization", "input",
      "output", "decoder", "dataset", "nativeRuntimePolicy"
    ]
    try requireExactKeys(
      vocab,
      isCTCVocabulary
        ? vocabularyRootKeys.union(["runtimeModelContract"])
        : vocabularyRootKeys
    )
    if isCTCVocabulary {
      try requireExactKeys(try childObject(vocab, "input"), [
        "maxLength", "tokensById", "idsByToken", "padId", "eosId",
        "unkId"
      ])
      try requireExactKeys(try childObject(vocab, "output"), [
        "timeSteps", "tokensById", "idsByToken", "blankId"
      ])
    } else {
      let vocabularyKeys: Set<String> = [
        "maxLength", "tokensById", "idsByToken", "padId", "sosId",
        "eosId", "unkId"
      ]
      try requireExactKeys(try childObject(vocab, "input"), vocabularyKeys)
      try requireExactKeys(try childObject(vocab, "output"), vocabularyKeys)
    }
    let scalarVocabContract = vocab["tokenization"] as? String == "unicode-scalar-character"
    try requireExactKeys(
      try childObject(vocab, "decoder"),
      isCTCVocabulary
        ? [
          "type", "beamWidth", "maximumCandidates",
          "outputSequenceValidation", "rejectWhitespaceCandidates",
          "rejectLatinCandidates"
        ]
        : scalarVocabContract
        ? [
          "type", "beamWidth", "maxSteps", "outputSequenceValidation",
          "rejectWhitespaceCandidates", "rejectLatinCandidates"
        ]
        : ["type", "beamWidth", "rejectWhitespaceCandidates", "rejectLatinCandidates"]
    )
    let dataset = try childObject(vocab, "dataset")
    try requireExactKeys(dataset, ["manifest", "manifestSha256", "splitSha256"])
    try requireExactKeys(try childObject(dataset, "splitSha256"), ["train", "dev", "test"])
    try requireExactKeys(try childObject(vocab, "nativeRuntimePolicy"), [
      "asyncOnly", "neverInvokeInSecureFields", "failOpenRawTypingOnError", "neuralTailOnly"
    ])
  }

  private static func validateProductionMemoryJSONShape(
    _ memory: [String: Any]
  ) throws {
    try requireExactKeys(memory, [
      "schemaVersion",
      "measurementKind",
      "api",
      "units",
      "baselinePhysicalFootprintBytes",
      "lifetimePeakPhysicalFootprintBytes",
      "peakIncreaseFromBaselineBytes"
    ])
  }

  private static func validateTensorGroup(
    _ group: [String: Any],
    names: Set<String>
  ) throws {
    try requireExactKeys(group, names)
    for name in names {
      try requireExactKeys(try childObject(group, name), ["shape", "dataType"])
    }
  }

  private static func jsonObject(_ data: Data) throws -> [String: Any] {
    do {
      guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw LekhNeuralGateFailure.manifestSchemaInvalid
      }
      return object
    } catch let failure as LekhNeuralGateFailure {
      throw failure
    } catch {
      throw LekhNeuralGateFailure.manifestOrVocabMalformed
    }
  }

  private static func childObject(_ parent: [String: Any], _ key: String) throws -> [String: Any] {
    guard let child = parent[key] as? [String: Any] else {
      throw LekhNeuralGateFailure.manifestSchemaInvalid
    }
    return child
  }

  private static func requireExactKeys(_ object: [String: Any], _ expected: Set<String>) throws {
    guard Set(object.keys) == expected else {
      throw LekhNeuralGateFailure.manifestSchemaInvalid
    }
  }

  private static func loadDeterministicTokenInputs(bundle: Bundle) -> Set<String> {
    let url: URL?
    if let bundled = bundle.url(forResource: "lekh-token-candidates.v1", withExtension: "json") {
      url = bundled
    } else if ProcessInfo.processInfo.processName == "LekhInputMethodBehaviorProbe",
              let testPath = ProcessInfo.processInfo.environment["LEKH_TEST_CANONICAL_TOKEN_PACK_PATH"],
              FileManager.default.isReadableFile(atPath: testPath) {
      // The behavior probe may exercise an older staged bundle without
      // repackaging or installing it. Keep this override process-gated so a
      // production input method can never redirect a trusted engine asset via
      // ambient environment state.
      url = URL(fileURLWithPath: testPath)
    } else {
      url = nil
    }
    guard let url,
          let data = try? Data(contentsOf: url),
          let pack = try? JSONDecoder().decode(LekhCanonicalTokenInputPack.self, from: data),
          pack.schemaVersion == 1,
          pack.scope == "single-active-token" else {
      return []
    }
    return Set(pack.rows.compactMap { row in
      let input = normalize(row.input)
      return isSafeToken(input) ? input : nil
    })
  }

  private static func experimentalOverrideEnabled(bundle: Bundle) -> Bool {
    if ProcessInfo.processInfo.processName == "LekhInputMethodBehaviorProbe",
       ProcessInfo.processInfo.environment["LEKH_EXPERIMENTAL_NEURAL_TYPING"] == "1" {
      return true
    }
    return bundle.object(forInfoDictionaryKey: "LekhExperimentalNeuralTypingEnabled") as? Bool == true
  }

  private static func multiArrayOutput(from prediction: MLFeatureProvider) -> MLMultiArray? {
    prediction.featureValue(for: "logits")?.multiArrayValue
  }
}

private final class LekhScopedNeuralCandidateService: LekhNeuralCandidateServing {
  private let service: LekhNeuralCandidateService
  private let requestScope = UUID()
  private let liveSecureInputActive: () -> Bool

  init(
    service: LekhNeuralCandidateService,
    liveSecureInputActive: @escaping () -> Bool
  ) {
    self.service = service
    self.liveSecureInputActive = liveSecureInputActive
  }

  deinit {
    service.releaseRequestScope(requestScope)
  }

  func candidates(
    for rawInput: String,
    secureInputActive: Bool,
    completion: @escaping ([String]) -> Void
  ) {
    service.candidates(
      for: rawInput,
      secureInputActive: secureInputActive,
      requestScope: requestScope,
      liveSecureInputActive: liveSecureInputActive,
      completion: completion
    )
  }

  func cancelPending() {
    service.cancelPending(in: requestScope)
  }
}

private enum LekhNeuralRuntimeState {
  case loading
  case gated(LekhNeuralGateFailure)
  case experimentalReady
  case productionAttestationPending
  case productionReady

  var canInfer: Bool {
    switch self {
    case .experimentalReady, .productionReady: return true
    case .loading, .gated, .productionAttestationPending: return false
    }
  }

  var status: String {
    switch self {
    case .loading:
      return "async-coreml-tail-loading"
    case .gated(let failure):
      return "async-coreml-tail-gated-\(failure.rawValue)"
    case .experimentalReady:
      return "experimental-async-coreml-tail-artifact-verified-ready"
    case .productionAttestationPending:
      return "production-async-coreml-tail-attestation-pending"
    case .productionReady:
      return "production-async-coreml-tail-attested-ready"
    }
  }
}

private enum LekhNeuralGateFailure: String, Error {
  case resourceMissing = "resource-missing"
  case resourceUnreadable = "resource-unreadable"
  case resourceTypeInvalid = "resource-type-invalid"
  case manifestOrVocabMalformed = "manifest-vocab-malformed"
  case manifestSchemaInvalid = "manifest-schema-invalid"
  case manifestIdentityInvalid = "manifest-identity-invalid"
  case artifactContractInvalid = "artifact-contract-invalid"
  case runtimePolicyInvalid = "runtime-policy-invalid"
  case vocabContractInvalid = "vocab-contract-invalid"
  case vocabHashMismatch = "vocab-hash-mismatch"
  case modelSizeMismatch = "model-size-mismatch"
  case modelHashMismatch = "model-hash-mismatch"
  case modelLoadFailed = "model-load-failed"
  case modelIOContractInvalid = "model-io-contract-invalid"
  case deterministicTokenPackUnavailable = "deterministic-token-pack-unavailable"
  case manifestNotProductionEligible = "manifest-not-production-eligible"
  case productionProvenanceInvalid = "production-provenance-invalid"
  case productionQualityInvalid = "production-quality-invalid"
  case productionBenchmarkInvalid = "production-benchmark-invalid"
  case knownAnswerAttestationFailed = "known-answer-attestation-failed"
  case artifactVerificationFailed = "artifact-verification-failed"
}

private enum LekhNeuralInferenceFailure: Error {
  case inputNotRepresentable
  case modelOutputInvalid
}

private struct LekhInputVocabularyContract {
  let maxLength: Int
  let padTokenId: Int
  let eosTokenId: Int
  let unkTokenId: Int
}

private struct LekhLegacyOutputVocabularyContract {
  let maxLength: Int
  let padTokenId: Int
  let sosTokenId: Int
  let eosTokenId: Int
  let unkTokenId: Int
}

private struct LekhVerifiedNeuralArtifact {
  let manifest: LekhNeuralManifest
  let vocab: LekhNeuralVocabMetadata
  let modelRuntime: LekhNeuralModelRuntime
}

private enum LekhNeuralModelRuntime {
  case legacy(MLModel)
  case splitAttention(
    models: LekhNeuralSplitAttentionModels,
    contract: LekhNeuralSplitAttentionContract
  )
  case ctc(
    model: any LekhNeuralModelPredicting,
    contract: LekhNeuralCTCContract
  )
}

public enum LekhNeuralManifestIdentityPolicy {
  public static let currentSchemaVersion = 2

  public static func isValidRunIdentifier(_ value: String?) -> Bool {
    guard let value, value.count == 32 else { return false }
    return value.unicodeScalars.allSatisfy { scalar in
      (48...57).contains(scalar.value) || (97...102).contains(scalar.value)
    }
  }

  public static func permits(
    schemaVersion: Int,
    trainingRunId: String?,
    exportRunId: String?,
    productionEligible: Bool
  ) -> Bool {
    switch schemaVersion {
    case 1:
      return !productionEligible && trainingRunId == nil && exportRunId == nil
    case currentSchemaVersion:
      return isValidRunIdentifier(trainingRunId) &&
        isValidRunIdentifier(exportRunId) &&
        trainingRunId != exportRunId
    default:
      return false
    }
  }
}

public enum LekhNeuralProductionMemoryPolicy {
  public static let maximumLifetimePeakPhysicalFootprintBytes: UInt64 =
    128 * 1024 * 1024

  fileprivate struct Evidence: Decodable, Equatable {
    let schemaVersion: Int
    let measurementKind: String
    let api: String
    let units: String
    let baselinePhysicalFootprintBytes: UInt64
    let lifetimePeakPhysicalFootprintBytes: UInt64
    let peakIncreaseFromBaselineBytes: UInt64
  }

  fileprivate static func permits(
    summary: Evidence?,
    devices: [Evidence?]
  ) -> Bool {
    guard let summary,
          validates(summary),
          !devices.isEmpty else {
      return false
    }
    let validDevices = devices.compactMap { device -> Evidence? in
      guard let device, validates(device) else { return nil }
      return device
    }
    guard validDevices.count == devices.count,
          validDevices.contains(summary) else {
      return false
    }
    return validDevices.allSatisfy {
      $0.lifetimePeakPhysicalFootprintBytes <=
        summary.lifetimePeakPhysicalFootprintBytes
    }
  }

  public static func validatesFixture(
    summaryJSON: Data,
    deviceJSON: [Data]
  ) -> Bool {
    let decoder = JSONDecoder()
    guard let summary = try? decoder.decode(
      Evidence.self,
      from: summaryJSON
    ) else {
      return false
    }
    let devices = deviceJSON.map { data in
      try? decoder.decode(Evidence.self, from: data)
    }
    return permits(summary: summary, devices: devices)
  }

  private static func validates(_ evidence: Evidence) -> Bool {
    evidence.schemaVersion == 1 &&
      evidence.measurementKind ==
        "isolated-process-physical-footprint-v1" &&
      evidence.api == "proc_pid_rusage:RUSAGE_INFO_V4" &&
      evidence.units == "bytes" &&
      evidence.baselinePhysicalFootprintBytes > 0 &&
      evidence.lifetimePeakPhysicalFootprintBytes >=
        evidence.baselinePhysicalFootprintBytes &&
      evidence.lifetimePeakPhysicalFootprintBytes <=
        maximumLifetimePeakPhysicalFootprintBytes &&
      evidence.peakIncreaseFromBaselineBytes ==
        evidence.lifetimePeakPhysicalFootprintBytes -
        evidence.baselinePhysicalFootprintBytes
  }
}

private struct LekhNeuralManifest: Decodable {
  let schemaVersion: Int
  let trainingRunId: String?
  let exportRunId: String?
  let selectedArtifact: String
  let runtime: String
  let runtimeModelContract: String?
  let tensorContract: TensorContract?
  let compiledModels: CompiledModels?
  let localOnly: Bool
  let neuralTailOnly: Bool
  let productionEligible: Bool
  let architecture: String
  let openVocabulary: Bool
  let tokenization: String
  let outputSequenceValidation: String?
  let decoder: String
  let beamSearch: BeamSearch
  let languageModelRescorer: LanguageModelRescorer
  let contextWindowWords: Int
  let parameterCount: Int
  let modelBytes: Int
  let trainingSources: [String]
  let datasetReports: [String]
  let evaluationReports: [String]
  let benchmarkReports: [String]
  let metrics: Metrics
  let performance: Performance
  let requiredCases: [String: String]
  let sha256: Hashes
  let limitations: [String]

  struct BeamSearch: Decodable {
    let enabled: Bool
    let beamWidth: Int
    let maxOutputGraphemes: Int
    let maxSteps: Int?
  }

  struct LanguageModelRescorer: Decodable {
    let enabled: Bool
    let source: String
    let weight: Double
  }

  struct Metrics: Decodable {
    let tailTop1Accuracy: Double
    let tailTop3Accuracy: Double
    let chatConventionTop1Accuracy: Double
    let chatConventionTop3Accuracy: Double
    let namesTop3Accuracy: Double
    let protectedFalseConversionRate: Double
    let singleTokenPhraseExpansionRate: Double
    let secureFieldInferenceCount: Int
  }

  struct Performance: Decodable {
    let p50Ms: Double
    let p95Ms: Double
    let p99Ms: Double
    let targetP99Ms: Double
    let measuredOnDevice: Bool
    let memory: LekhNeuralProductionMemoryPolicy.Evidence?
    let devices: [Device]
  }

  struct Device: Decodable {
    let name: String
    let macOS: String
    let architecture: String
    let packagedApp: Bool
    let secureFieldInferenceCount: Int
    let p50Ms: Double
    let p95Ms: Double
    let p99Ms: Double
    let artifact: String
    let measurementKind: String?
    let memory: LekhNeuralProductionMemoryPolicy.Evidence?
  }

  struct Hashes: Decodable {
    let compiledModel: String?
    let compiledModels: [String: String]?
    let mlpackages: [String: String]?
    let sourceCheckpoint: String
    let trainingDatasetManifest: String
    let vocabMetadata: String
  }

  struct CompiledModels: Decodable {
    let encoder: CompiledArtifact
    let decoderStep: CompiledArtifact
  }

  struct CompiledArtifact: Decodable {
    let role: String
    let mlpackage: String
    let mlpackageBytes: Int
    let mlpackageSha256: String
    let compiledModel: String
    let compiledBytes: Int
    let compiledSha256: String
  }

  struct TensorContract: Decodable {
    let encoder: TensorStage?
    let decoderStep: TensorStage?
    let inputIds: Tensor?
    let logits: Tensor?
  }

  struct TensorStage: Decodable {
    let inputs: [String: Tensor]
    let outputs: [String: Tensor]
  }

  struct Tensor: Decodable, Equatable {
    let shape: [Int]
    let dataType: String
  }
}

private struct LekhCanonicalTokenInputPack: Decodable {
  struct Row: Decodable { let input: String }
  let schemaVersion: Int
  let scope: String
  let rows: [Row]
}

private struct LekhNeuralVocabMetadata: Decodable {
  let schemaVersion: Int
  let modelId: String
  let generatedAt: String
  let tokenization: String
  let runtimeModelContract: String?
  let input: Vocabulary
  let output: Vocabulary
  let decoder: DecoderPolicy
  let dataset: Dataset
  let nativeRuntimePolicy: NativeRuntimePolicy

  struct Vocabulary: Decodable {
    let maxLength: Int?
    let timeSteps: Int?
    let tokensById: [String]
    let idsByToken: [String: Int]
    let padId: Int?
    let sosId: Int?
    let eosId: Int?
    let unkId: Int?
    let blankId: Int?
  }

  struct DecoderPolicy: Decodable {
    let type: String
    let beamWidth: Int
    let maxSteps: Int?
    let maximumCandidates: Int?
    let outputSequenceValidation: String?
    let rejectWhitespaceCandidates: Bool
    let rejectLatinCandidates: Bool
  }

  struct Dataset: Decodable {
    let manifest: String
    let manifestSha256: String
    let splitSha256: SplitHashes

    struct SplitHashes: Decodable {
      let train: String
      let dev: String
      let test: String
    }
  }

  struct NativeRuntimePolicy: Decodable {
    let asyncOnly: Bool
    let neverInvokeInSecureFields: Bool
    let failOpenRawTypingOnError: Bool
    let neuralTailOnly: Bool
  }
}
