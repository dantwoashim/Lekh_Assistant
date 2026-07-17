import CoreML
import CryptoKit
import Foundation

/// Pure, model-independent admission policy for the optional neural tail.
///
/// The deterministic engine owns exact shared tokens. Neural input must also
/// leave room for an explicit EOS token and be fully representable by the
/// verified character vocabulary. Rejecting any unknown character is stricter
/// than an unknown-token-ratio threshold and prevents the model from guessing
/// from a lossy `<unk>`-heavy encoding.
public struct LekhNeuralInputAdmissionPolicy {
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
    guard !inputTokens.isEmpty,
          inputTokens.count < maxLength,
          !deterministicTokenInputs.contains(normalizedInput) else {
      return false
    }
    return inputTokens.allSatisfy { representableTokens.contains($0) }
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
    logitsForPrefix: (_ tokenIds: [Int], _ step: Int) throws -> [Double]
  ) throws -> [LekhNeuralBeamHypothesis] {
    guard vocabularySize > 0,
          (0..<vocabularySize).contains(sosTokenId),
          (0..<vocabularySize).contains(eosTokenId),
          sosTokenId != eosTokenId,
          !invalidTokenIds.contains(eosTokenId),
          invalidTokenIds.allSatisfy({ (0..<vocabularySize).contains($0) }),
          beamWidth > 0,
          maxSteps >= 0 else {
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
          .filter { !invalidTokenIds.contains($0) && logProbabilities[$0].isFinite }
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
    completed.append(contentsOf: active)
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

public final class LekhNeuralCandidateService {
  public static let shared = LekhNeuralCandidateService()

  // The candidate service currently receives one active token and returns an
  // unranked neural tail. The manifest's runtime-next-context-pack rescorer is
  // not yet invoked on that tail. Keep production fail-closed until the native
  // context handoff and its host-matrix proof exist; experimental inference is
  // still available through the explicit override.
  private static let verifiedContextRescorerContractVersion: Int? = nil

  private let queue = DispatchQueue(label: "com.lekh.inputmethod.neural-candidate-tail", qos: .userInitiated)
  private let requestLock = NSLock()
  private var requestGeneration: UInt64 = 0
  private let runtimeStateLock = NSLock()
  private var runtimeState: LekhNeuralRuntimeState = .loading
  private var model: MLModel?
  private var vocab: LekhNeuralVocabMetadata?
  private var inputAdmissionPolicy: LekhNeuralInputAdmissionPolicy?

  public var status: String {
    runtimeStateLock.lock()
    let status = runtimeState.status
    runtimeStateLock.unlock()
    return status
  }

  public init(bundle: Bundle = .main) {
    // Controller construction and the first deterministic keystroke must not
    // hash resources, instantiate Core ML, or build neural indexes. While this
    // worker verifies the optional artifact, requests fail open with no neural
    // tail and the in-process deterministic engine remains fully available.
    queue.async { [weak self, bundle] in
      self?.loadVerifiedRuntime(bundle: bundle)
    }
  }

  public func candidates(
    for rawInput: String,
    secureInputActive: Bool,
    completion: @escaping ([String]) -> Void
  ) {
    // Every request, including a secure-field transition, invalidates work for
    // the previous composition. This prevents a queue of stale per-keystroke
    // beam decodes from accumulating behind the user's current token.
    let generation = beginRequest()
    // neverInvokeInSecureFields: secure fields never run model inference, log, learn, or retain typed content.
    guard !secureInputActive else {
      completion([])
      return
    }
    let normalized = Self.normalize(rawInput)
    guard let runtime = inferenceSnapshot(),
          LekhMixedScriptPolicy.preserveCandidate(for: rawInput) == nil,
          Self.isSafeToken(normalized),
          runtime.inputAdmissionPolicy.accepts(normalized),
          normalized.count >= 3 else {
      completion([])
      return
    }

    queue.async { [weak self, model = runtime.model, vocab = runtime.vocab] in
      guard let self, self.isCurrentRequest(generation) else { return }
      let started = DispatchTime.now().uptimeNanoseconds
      let budgetNanoseconds: UInt64 = 45_000_000
      let shouldCancel = { [weak self] in
        guard let self, self.isCurrentRequest(generation) else { return true }
        return DispatchTime.now().uptimeNanoseconds - started >= budgetNanoseconds
      }
      let result = (try? Self.predictCandidates(
        model: model,
        vocab: vocab,
        input: normalized,
        shouldCancel: shouldCancel
      )) ?? []
      guard self.isCurrentRequest(generation) else { return }
      DispatchQueue.main.async {
        guard self.isCurrentRequest(generation) else { return }
        completion(result)
      }
    }
  }

  /// Invalidates queued or in-progress decoding without retaining a token or
  /// invoking a completion. Controllers call this on composition cancellation,
  /// deactivation, and before entering secure input.
  public func cancelPending() {
    _ = beginRequest()
  }

  private func inferenceSnapshot() -> (
    model: MLModel,
    vocab: LekhNeuralVocabMetadata,
    inputAdmissionPolicy: LekhNeuralInputAdmissionPolicy
  )? {
    runtimeStateLock.lock()
    defer { runtimeStateLock.unlock() }
    guard runtimeState.canInfer, let model, let vocab, let inputAdmissionPolicy else { return nil }
    return (model, vocab, inputAdmissionPolicy)
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
          model: artifact.model,
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
    model = verifiedArtifact?.model
    vocab = verifiedArtifact?.vocab
    inputAdmissionPolicy = verifiedArtifact.map { artifact in
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
        model: artifact.model,
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

  private func beginRequest() -> UInt64 {
    requestLock.lock()
    requestGeneration &+= 1
    let generation = requestGeneration
    requestLock.unlock()
    return generation
  }

  private func isCurrentRequest(_ generation: UInt64) -> Bool {
    requestLock.lock()
    let current = requestGeneration == generation
    requestLock.unlock()
    return current
  }

  private static func predictCandidates(
    model: MLModel,
    vocab: LekhNeuralVocabMetadata,
    input: String,
    shouldCancel: () -> Bool
  ) throws -> [String] {
    let inputIds = try encodedInput(input, vocab: vocab)
    let maxSteps = min(vocab.output.maxLength - 1, input.count + 8)
    let beamWidth = vocab.decoder.beamWidth
    let hypotheses = try LekhNeuralBeamSearch.rank(
      vocabularySize: vocab.output.tokensById.count,
      sosTokenId: vocab.output.sosId,
      eosTokenId: vocab.output.eosId,
      invalidTokenIds: [vocab.output.padId, vocab.output.unkId, vocab.output.sosId],
      beamWidth: beamWidth,
      maxSteps: maxSteps,
      shouldCancel: shouldCancel
    ) { prefixTokenIds, step in
        let decoderIds = try encodedDecoder(prefixTokenIds, vocab: vocab)
        let provider = try MLDictionaryFeatureProvider(dictionary: [
          "inputIds": MLFeatureValue(multiArray: inputIds),
          "decoderInputIds": MLFeatureValue(multiArray: decoderIds)
        ])
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
      let candidate = decode(ids: hypothesis.tokenIds, vocab: vocab)
      guard isSafeCandidate(candidate),
            !output.contains(candidate) else { continue }
      output.append(candidate)
      if output.count >= beamWidth { break }
    }
    return output
  }

  private static func encodedInput(_ input: String, vocab: LekhNeuralVocabMetadata) throws -> MLMultiArray {
    let chars = Array(input).map(String.init)
    guard chars.count < vocab.input.maxLength,
          chars.allSatisfy({ character in
            guard let tokenId = vocab.input.idsByToken[character] else { return false }
            return tokenId != vocab.input.unkId
          }) else {
      throw LekhNeuralInferenceFailure.inputNotRepresentable
    }
    let array = try MLMultiArray(shape: [1, NSNumber(value: vocab.input.maxLength)], dataType: .int32)
    for index in 0..<vocab.input.maxLength {
      let value: Int
      if index < chars.count {
        value = vocab.input.idsByToken[chars[index]] ?? vocab.input.unkId
      } else if index == chars.count {
        value = vocab.input.eosId
      } else {
        value = vocab.input.padId
      }
      array[index] = NSNumber(value: value)
    }
    return array
  }

  private static func encodedDecoder(_ ids: [Int], vocab: LekhNeuralVocabMetadata) throws -> MLMultiArray {
    let decoderLength = max(1, vocab.output.maxLength - 1)
    let array = try MLMultiArray(shape: [1, NSNumber(value: decoderLength)], dataType: .int32)
    for index in 0..<decoderLength {
      array[index] = NSNumber(value: index < ids.count ? ids[index] : vocab.output.padId)
    }
    return array
  }

  private static func logitsRow(
    _ logits: MLMultiArray,
    step: Int,
    vocabularySize: Int
  ) throws -> [Double] {
    guard vocabularySize > 0,
          step >= 0,
          logits.count.isMultiple(of: vocabularySize),
          step < logits.count / vocabularySize else {
      throw LekhNeuralInferenceFailure.modelOutputInvalid
    }
    let offset = step * vocabularySize
    return (0..<vocabularySize).map { logits[offset + $0].doubleValue }
  }

  private static func decode(ids: [Int], vocab: LekhNeuralVocabMetadata) -> String {
    var output = ""
    for tokenId in ids {
      if tokenId == vocab.output.padId || tokenId == vocab.output.sosId || tokenId == vocab.output.unkId {
        continue
      }
      if tokenId == vocab.output.eosId { break }
      guard tokenId >= 0, tokenId < vocab.output.tokensById.count else { continue }
      output += vocab.output.tokensById[tokenId]
    }
    return output
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
          value == value.precomposedStringWithCanonicalMapping else { return false }
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
  ) -> LekhNeuralInputAdmissionPolicy {
    let specialTokenIds = Set([
      vocab.input.padId,
      vocab.input.sosId,
      vocab.input.eosId,
      vocab.input.unkId
    ])
    let representableTokens = Set(vocab.input.idsByToken.compactMap { entry in
      specialTokenIds.contains(entry.value) ? nil : entry.key
    })
    return LekhNeuralInputAdmissionPolicy(
      maxLength: vocab.input.maxLength,
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
    ), let modelURL = bundle.url(
      forResource: "LekhNeuralTransliterator",
      withExtension: "mlmodelc"
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
    let modelIdentity = try sha256Directory(modelURL)
    guard modelIdentity.bytes == manifest.modelBytes else {
      throw LekhNeuralGateFailure.modelSizeMismatch
    }
    guard modelIdentity.digest == manifest.sha256.compiledModel else {
      throw LekhNeuralGateFailure.modelHashMismatch
    }

    let model: MLModel
    do {
      let configuration = MLModelConfiguration()
      configuration.computeUnits = .all
      model = try MLModel(contentsOf: modelURL, configuration: configuration)
    } catch {
      throw LekhNeuralGateFailure.modelLoadFailed
    }
    try validateModelContract(model: model, vocab: vocab)
    return LekhVerifiedNeuralArtifact(manifest: manifest, vocab: vocab, model: model)
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
    guard manifest.selectedArtifact == "lekh-open-vocab-seq2seq-v1",
          manifest.runtime == "CoreML",
          manifest.localOnly,
          manifest.neuralTailOnly,
          manifest.architecture == "gru-encoder-decoder-seq2seq",
          manifest.openVocabulary,
          manifest.tokenization == "unicode-grapheme-character",
          manifest.decoder == "beam-search",
          manifest.beamSearch.enabled,
          (2...8).contains(manifest.beamSearch.beamWidth),
          (8...48).contains(manifest.beamSearch.maxOutputGraphemes),
          (1_000_000...5_000_000).contains(manifest.parameterCount),
          (1...16_777_216).contains(manifest.modelBytes),
          manifest.requiredCases == expectedCases,
          isSHA256(manifest.sha256.compiledModel),
          isSHA256(manifest.sha256.sourceCheckpoint),
          isSHA256(manifest.sha256.trainingDatasetManifest),
          isSHA256(manifest.sha256.vocabMetadata) else {
      throw LekhNeuralGateFailure.artifactContractInvalid
    }

    guard vocab.schemaVersion == 1,
          vocab.modelId == manifest.selectedArtifact,
          vocab.tokenization == manifest.tokenization,
          ISO8601DateFormatter().date(from: vocab.generatedAt) != nil,
          vocab.decoder.type == manifest.decoder,
          vocab.decoder.beamWidth == manifest.beamSearch.beamWidth,
          vocab.decoder.rejectWhitespaceCandidates,
          vocab.decoder.rejectLatinCandidates,
          vocab.output.maxLength == manifest.beamSearch.maxOutputGraphemes,
          vocab.dataset.manifestSha256 == manifest.sha256.trainingDatasetManifest,
          vocab.nativeRuntimePolicy.asyncOnly,
          vocab.nativeRuntimePolicy.neverInvokeInSecureFields,
          vocab.nativeRuntimePolicy.failOpenRawTypingOnError,
          vocab.nativeRuntimePolicy.neuralTailOnly else {
      throw LekhNeuralGateFailure.runtimePolicyInvalid
    }
    try validateVocabulary(vocab.input, inputSide: true)
    try validateVocabulary(vocab.output, inputSide: false)
  }

  private static func validateVocabulary(
    _ vocabulary: LekhNeuralVocabMetadata.Vocabulary,
    inputSide: Bool
  ) throws {
    guard (4...128).contains(vocabulary.maxLength),
          vocabulary.tokensById.count >= 5,
          vocabulary.tokensById.count == vocabulary.idsByToken.count,
          Set(vocabulary.tokensById).count == vocabulary.tokensById.count else {
      throw LekhNeuralGateFailure.vocabContractInvalid
    }
    for (id, token) in vocabulary.tokensById.enumerated() {
      guard vocabulary.idsByToken[token] == id else {
        throw LekhNeuralGateFailure.vocabContractInvalid
      }
    }
    let special = [
      (vocabulary.padId, "<pad>"),
      (vocabulary.sosId, "<s>"),
      (vocabulary.eosId, "</s>"),
      (vocabulary.unkId, "<unk>")
    ]
    guard Set(special.map(\.0)).count == special.count,
          special.allSatisfy({ id, token in
            id >= 0 && id < vocabulary.tokensById.count && vocabulary.tokensById[id] == token
          }) else {
      throw LekhNeuralGateFailure.vocabContractInvalid
    }
    let lexicalTokens = vocabulary.tokensById.enumerated().compactMap { id, token in
      special.contains(where: { $0.0 == id }) ? nil : token
    }
    if inputSide {
      guard lexicalTokens.allSatisfy({ token in
        token.count == 1 && token.range(of: #"^[a-z]$"#, options: .regularExpression) != nil
      }) else {
        throw LekhNeuralGateFailure.vocabContractInvalid
      }
    } else {
      guard lexicalTokens.allSatisfy({ token in
        !token.isEmpty && token.unicodeScalars.allSatisfy { scalar in
          (0x0900...0x097F).contains(scalar.value) || scalar.value == 0x200C || scalar.value == 0x200D
        }
      }) else {
        throw LekhNeuralGateFailure.vocabContractInvalid
      }
    }
  }

  private static func validateProductionContract(_ artifact: LekhVerifiedNeuralArtifact) throws {
    let manifest = artifact.manifest
    let requiredSources: Set<String> = [
      "syubraj-roman2nepali-transliteration",
      "human-reviewed-lekh-gold-v1",
      "lekh-chat-conventions-v1",
      "lekh-name-lexicon-v1"
    ]
    guard manifest.schemaVersion == LekhNeuralManifestIdentityPolicy.currentSchemaVersion,
          LekhNeuralManifestIdentityPolicy.isValidRunIdentifier(manifest.trainingRunId),
          LekhNeuralManifestIdentityPolicy.isValidRunIdentifier(manifest.exportRunId),
          manifest.productionEligible,
          requiredSources.isSubset(of: Set(manifest.trainingSources)),
          validReportPaths(manifest.datasetReports),
          validReportPaths(manifest.evaluationReports),
          validReportPaths(manifest.benchmarkReports),
          manifest.languageModelRescorer.enabled,
          manifest.languageModelRescorer.source == "runtime-next-context-pack",
          (0...1).contains(manifest.languageModelRescorer.weight),
          (2...4).contains(manifest.contextWindowWords),
          verifiedContextRescorerContractVersion == 1 else {
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
          performance.targetP99Ms == 3,
          performance.p50Ms >= 0, performance.p50Ms <= 3,
          performance.p95Ms >= 0, performance.p95Ms <= 3,
          performance.p99Ms >= 0, performance.p99Ms <= 3,
          performance.devices.count >= 2,
          architectures.contains("arm64"),
          architectures.contains("x86_64"),
          performance.devices.allSatisfy({ device in
            device.packagedApp &&
              device.p50Ms >= 0 && device.p50Ms <= 3 &&
              device.p95Ms >= 0 && device.p95Ms <= 3 &&
              device.p99Ms >= 0 && device.p99Ms <= 3 &&
              device.secureFieldInferenceCount == 0 &&
              !device.name.isEmpty && !device.macOS.isEmpty && !device.artifact.isEmpty
          }) else {
      throw LekhNeuralGateFailure.productionBenchmarkInvalid
    }

    let blockingLanguage = #"(?i)(not production|experimental|missing|absent|below production|not implemented)"#
    guard manifest.limitations.allSatisfy({ limitation in
      limitation.range(of: blockingLanguage, options: .regularExpression) == nil
    }) else {
      throw LekhNeuralGateFailure.productionLimitationsPresent
    }
  }

  private static func verifyKnownAnswers(
    model: MLModel,
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
        candidates = try predictCandidates(model: model, vocab: vocab, input: input) {
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

  private static func validateModelContract(model: MLModel, vocab: LekhNeuralVocabMetadata) throws {
    let description = model.modelDescription
    guard Set(description.inputDescriptionsByName.keys) == Set(["inputIds", "decoderInputIds"]),
          Set(description.outputDescriptionsByName.keys) == Set(["logits"]),
          validMultiArrayFeature(
            description.inputDescriptionsByName["inputIds"],
            shape: [1, vocab.input.maxLength],
            dataType: .int32
          ),
          validMultiArrayFeature(
            description.inputDescriptionsByName["decoderInputIds"],
            shape: [1, vocab.output.maxLength - 1],
            dataType: .int32
          ),
          validMultiArrayFeature(
            description.outputDescriptionsByName["logits"],
            shape: [1, vocab.output.maxLength - 1, vocab.output.tokensById.count],
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
    switch schemaVersion {
    case 1:
      try requireExactKeys(manifest, legacyManifestKeys)
    case LekhNeuralManifestIdentityPolicy.currentSchemaVersion:
      try requireExactKeys(manifest, legacyManifestKeys.union(["trainingRunId", "exportRunId"]))
    default:
      throw LekhNeuralGateFailure.manifestSchemaInvalid
    }
    try requireExactKeys(try childObject(manifest, "beamSearch"), [
      "enabled", "beamWidth", "maxOutputGraphemes"
    ])
    try requireExactKeys(try childObject(manifest, "languageModelRescorer"), [
      "enabled", "source", "weight"
    ])
    try requireExactKeys(try childObject(manifest, "metrics"), [
      "tailTop1Accuracy", "tailTop3Accuracy", "chatConventionTop1Accuracy",
      "chatConventionTop3Accuracy", "namesTop3Accuracy", "protectedFalseConversionRate",
      "singleTokenPhraseExpansionRate", "secureFieldInferenceCount"
    ])
    let performance = try childObject(manifest, "performance")
    try requireExactKeys(performance, [
      "p50Ms", "p95Ms", "p99Ms", "targetP99Ms", "measuredOnDevice", "devices"
    ])
    guard let devices = performance["devices"] as? [Any], !devices.isEmpty else {
      throw LekhNeuralGateFailure.manifestSchemaInvalid
    }
    let deviceKeys: Set<String> = [
      "name", "macOS", "architecture", "packagedApp", "secureFieldInferenceCount",
      "p50Ms", "p95Ms", "p99Ms", "artifact"
    ]
    for value in devices {
      guard let device = value as? [String: Any] else {
        throw LekhNeuralGateFailure.manifestSchemaInvalid
      }
      try requireExactKeys(device, deviceKeys)
    }
    try requireExactKeys(try childObject(manifest, "sha256"), [
      "compiledModel", "sourceCheckpoint", "trainingDatasetManifest", "vocabMetadata"
    ])

    let vocab = try jsonObject(vocabData)
    try requireExactKeys(vocab, [
      "schemaVersion", "modelId", "generatedAt", "tokenization", "input", "output",
      "decoder", "dataset", "nativeRuntimePolicy"
    ])
    let vocabularyKeys: Set<String> = [
      "maxLength", "tokensById", "idsByToken", "padId", "sosId", "eosId", "unkId"
    ]
    try requireExactKeys(try childObject(vocab, "input"), vocabularyKeys)
    try requireExactKeys(try childObject(vocab, "output"), vocabularyKeys)
    try requireExactKeys(try childObject(vocab, "decoder"), [
      "type", "beamWidth", "rejectWhitespaceCandidates", "rejectLatinCandidates"
    ])
    let dataset = try childObject(vocab, "dataset")
    try requireExactKeys(dataset, ["manifest", "manifestSha256", "splitSha256"])
    try requireExactKeys(try childObject(dataset, "splitSha256"), ["train", "dev", "test"])
    try requireExactKeys(try childObject(vocab, "nativeRuntimePolicy"), [
      "asyncOnly", "neverInvokeInSecureFields", "failOpenRawTypingOnError", "neuralTailOnly"
    ])
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
  case productionLimitationsPresent = "production-limitations-present"
  case knownAnswerAttestationFailed = "known-answer-attestation-failed"
  case artifactVerificationFailed = "artifact-verification-failed"
}

private enum LekhNeuralInferenceFailure: Error {
  case inputNotRepresentable
  case modelOutputInvalid
}

private struct LekhVerifiedNeuralArtifact {
  let manifest: LekhNeuralManifest
  let vocab: LekhNeuralVocabMetadata
  let model: MLModel
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

private struct LekhNeuralManifest: Decodable {
  let schemaVersion: Int
  let trainingRunId: String?
  let exportRunId: String?
  let selectedArtifact: String
  let runtime: String
  let localOnly: Bool
  let neuralTailOnly: Bool
  let productionEligible: Bool
  let architecture: String
  let openVocabulary: Bool
  let tokenization: String
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
  }

  struct Hashes: Decodable {
    let compiledModel: String
    let sourceCheckpoint: String
    let trainingDatasetManifest: String
    let vocabMetadata: String
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
  let input: Vocabulary
  let output: Vocabulary
  let decoder: DecoderPolicy
  let dataset: Dataset
  let nativeRuntimePolicy: NativeRuntimePolicy

  struct Vocabulary: Decodable {
    let maxLength: Int
    let tokensById: [String]
    let idsByToken: [String: Int]
    let padId: Int
    let sosId: Int
    let eosId: Int
    let unkId: Int
  }

  struct DecoderPolicy: Decodable {
    let type: String
    let beamWidth: Int
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
