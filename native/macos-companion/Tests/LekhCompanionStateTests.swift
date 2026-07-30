import Foundation

@main
private struct LekhCompanionStateTests {
  private struct ExpectedState {
    let installed: Bool
    let registered: Bool
    let enabled: Bool
    let selected: Bool
    let running: Bool
    let build: KeyboardBuildVerification
    let action: KeyboardPrimaryAction
    let recovery: KeyboardRecoveryPlan
  }

  static func main() {
    let healthy = KeyboardReadiness.healthy(
      processIdentifier: 4242,
      controllerInitializedAt: Date(timeIntervalSince1970: 1)
    )
    let truthTable: [(String, KeyboardReadiness, ExpectedState)] = [
      (
        "missing bundle",
        .missing,
        ExpectedState(
          installed: false, registered: false, enabled: false, selected: false, running: false,
          build: .notChecked, action: .showInstallLocation, recovery: .install
        )
      ),
      (
        "bundle only",
        .installedUnregistered,
        ExpectedState(
          installed: true, registered: false, enabled: false, selected: false, running: false,
          build: .notChecked, action: .register, recovery: .register
        )
      ),
      (
        "registered but disabled",
        .approvalRequired,
        ExpectedState(
          installed: true, registered: true, enabled: false, selected: false, running: false,
          build: .notChecked, action: .enable, recovery: .enable
        )
      ),
      (
        "enabled but not selected",
        .enabledNotSelected,
        ExpectedState(
          installed: true, registered: true, enabled: true, selected: false, running: false,
          build: .notChecked, action: .select, recovery: .select
        )
      ),
      (
        "selected without live evidence",
        .selectedUntested,
        ExpectedState(
          installed: true, registered: true, enabled: true, selected: true, running: false,
          build: .notChecked, action: .verify, recovery: .verify
        )
      ),
      (
        "healthy matching runtime",
        healthy,
        ExpectedState(
          installed: true, registered: true, enabled: true, selected: true, running: true,
          build: .matched, action: .write, recovery: .ready
        )
      ),
      (
        "stale runtime build",
        .degraded(.wrongBuild),
        ExpectedState(
          installed: true, registered: true, enabled: true, selected: true, running: false,
          build: .mismatched, action: .replaceBuild, recovery: .replaceBuild
        )
      )
    ]

    for (name, readiness, expected) in truthTable {
      check(readiness.installed == expected.installed, "\(name): installed")
      check(readiness.registered == expected.registered, "\(name): registered")
      check(readiness.enabled == expected.enabled, "\(name): enabled")
      check(readiness.selected == expected.selected, "\(name): selected")
      check(readiness.running == expected.running, "\(name): running")
      check(readiness.buildVerification == expected.build, "\(name): build")
      check(readiness.primaryAction == expected.action, "\(name): primary action")
      check(readiness.recoveryPlan == expected.recovery, "\(name): recovery")
    }

    let reconnectFailures: [KeyboardFailure] = [
      .unreadableHealth, .wrongConnection, .processExited, .controllerMissing
    ]
    for failure in reconnectFailures {
      let readiness = KeyboardReadiness.degraded(failure)
      check(readiness.primaryAction == .reconnect, "\(failure.rawValue): reconnect action")
      check(readiness.recoveryPlan == .reconnect, "\(failure.rawValue): reconnect recovery")
      check(!readiness.running, "\(failure.rawValue): must not claim running")
      check(readiness.buildVerification == .notChecked, "\(failure.rawValue): build must be unverified")
    }

    for failure in [KeyboardFailure.wrongSchema, .wrongBundle, .wrongBuild] {
      let readiness = KeyboardReadiness.degraded(failure)
      check(readiness.primaryAction == .replaceBuild, "\(failure.rawValue): replace action")
      check(readiness.recoveryPlan == .replaceBuild, "\(failure.rawValue): replace recovery")
    }

    let bundleOnly = NativeKeyboardStatus(readiness: .installedUnregistered)
    check(bundleOnly.installed, "bundle-only snapshot must report installed")
    check(!bundleOnly.registered, "bundle-only snapshot must not report registered")
    check(!bundleOnly.enabled, "bundle-only snapshot must never report enabled")
    check(!bundleOnly.selected, "bundle-only snapshot must never report selected")
    check(!bundleOnly.running, "bundle-only snapshot must never report running")

    let offeredAt = Date(timeIntervalSince1970: 50)
    let acceptedAt = Date(timeIntervalSince1970: 51)
    let ghostEvidence = GhostRuntimeEvidence(
      lastOfferedAt: offeredAt,
      lastAcceptedAt: acceptedAt,
      controllerIsActive: true,
      rawSuppressionCounts: [
        GhostSuppressionReason.noEligibleCompletion.rawValue: 99_999,
        GhostSuppressionReason.presentationUnavailable.rawValue: -7,
        "untrusted-dynamic-reason": 200
      ]
    )
    check(ghostEvidence.lastOfferedAt == offeredAt, "ghost offer evidence must retain its content-free timestamp")
    check(ghostEvidence.lastAcceptedAt == acceptedAt, "ghost acceptance evidence must retain its content-free timestamp")
    check(ghostEvidence.controllerIsActive, "ghost evidence must expose whether its controller activation is still current")
    let acceptedBeforeLatestOffer = GhostRuntimeEvidence(
      lastOfferedAt: acceptedAt,
      lastAcceptedAt: offeredAt
    )
    check(
      acceptedBeforeLatestOffer.lastAcceptedAt == offeredAt,
      "a later unaccepted offer must not erase a valid earlier acceptance"
    )
    check(
      GhostRuntimeEvidence(lastAcceptedAt: acceptedAt).lastAcceptedAt == nil,
      "acceptance evidence must not exist without any verified offer in the activation"
    )
    check(!GhostRuntimeEvidence.none.controllerIsActive, "empty ghost evidence must not claim an active controller")
    check(
      ghostEvidence.suppressionCounts[.noEligibleCompletion] == GhostRuntimeEvidence.maximumCountPerReason,
      "ghost suppression counters must saturate at their fixed privacy bound"
    )
    check(
      ghostEvidence.suppressionCounts[.presentationUnavailable] == 0,
      "negative ghost suppression counters must clamp to zero"
    )
    check(
      ghostEvidence.suppressionCounts.count == 2,
      "unknown runtime-health keys must not enter the companion evidence model"
    )
    let healthyWithEvidence = NativeKeyboardStatus(ghostEvidence: ghostEvidence, readiness: healthy)
    check(
      healthyWithEvidence.ghostEvidence.lastOfferedAt == offeredAt,
      "a validated healthy snapshot must expose its ghost evidence"
    )

    testNeuralRuntimeAssetContracts()

    print("LekhCompanionStateTests passed: authoritative lifecycle truth table and neural asset contracts")
  }

  private static func testNeuralRuntimeAssetContracts() {
    let fileManager = FileManager.default
    let root = fileManager.temporaryDirectory
      .appendingPathComponent("lekh-companion-neural-\(UUID().uuidString)", isDirectory: true)
    let resources = root.appendingPathComponent("Resources", isDirectory: true)
    let vocabulary = resources.appendingPathComponent("LekhNeuralTransliterator.vocab.json")
    let singleModel = resources.appendingPathComponent(
      "LekhNeuralTransliterator.mlmodelc",
      isDirectory: true
    )
    defer { try? fileManager.removeItem(at: root) }

    do {
      try fileManager.createDirectory(at: resources, withIntermediateDirectories: true)
      try Data("{}".utf8).write(to: vocabulary, options: .atomic)
      try fileManager.createDirectory(
        at: resources.appendingPathComponent("WrongNeuralModel.mlmodelc", isDirectory: true),
        withIntermediateDirectories: true
      )
    } catch {
      fatalError("could not create neural asset test fixture: \(error)")
    }

    let ctcManifest: [String: Any] = [
      "selectedArtifact": "lekh-open-vocab-ctc-transformer-v2",
      "runtimeModelContract": "single-transformer-ctc-v1"
    ]
    check(
      !LekhCompanionModel.neuralRuntimeAssetsPresent(
        manifest: ctcManifest,
        resources: resources,
        vocabulary: vocabulary
      ),
      "CTC assets must require the canonical compiled-model bundle name"
    )

    do {
      try fileManager.createDirectory(at: singleModel, withIntermediateDirectories: true)
    } catch {
      fatalError("could not create canonical neural model fixture: \(error)")
    }
    check(
      LekhCompanionModel.neuralRuntimeAssetsPresent(
        manifest: ctcManifest,
        resources: resources,
        vocabulary: vocabulary
      ),
      "the exact single-transformer CTC package must be recognized"
    )
    check(
      !LekhCompanionModel.neuralRuntimeAssetsPresent(
        manifest: [
          "selectedArtifact": "lekh-open-vocab-ctc-transformer-v2",
          "runtimeModelContract": "split-attention-incremental-v1"
        ],
        resources: resources,
        vocabulary: vocabulary
      ),
      "the CTC artifact must reject a mismatched runtime contract"
    )
    check(
      !LekhCompanionModel.neuralRuntimeAssetsPresent(
        manifest: [
          "selectedArtifact": "lekh-open-vocab-ctc-transformer-v2",
          "runtimeModelContract": "single-transformer-ctc-v1",
          "compiledModels": ["encoder": [:]]
        ],
        resources: resources,
        vocabulary: vocabulary
      ),
      "the single-model CTC contract must reject split-model metadata"
    )

    check(
      LekhCompanionModel.neuralRuntimeAssetsPresent(
        manifest: ["selectedArtifact": "lekh-open-vocab-seq2seq-v1"],
        resources: resources,
        vocabulary: vocabulary
      ),
      "legacy single-model packages must remain recognized"
    )
    check(
      !LekhCompanionModel.neuralRuntimeAssetsPresent(
        manifest: [
          "selectedArtifact": "lekh-open-vocab-seq2seq-v1",
          "runtimeModelContract": "single-transformer-ctc-v1"
        ],
        resources: resources,
        vocabulary: vocabulary
      ),
      "legacy packages must still reject runtime-contract metadata"
    )

    let encoderName = "LekhNeuralTransliteratorEncoder.mlmodelc"
    let decoderName = "LekhNeuralTransliteratorDecoderStep.mlmodelc"
    do {
      try fileManager.createDirectory(
        at: resources.appendingPathComponent(encoderName, isDirectory: true),
        withIntermediateDirectories: true
      )
      try fileManager.createDirectory(
        at: resources.appendingPathComponent(decoderName, isDirectory: true),
        withIntermediateDirectories: true
      )
    } catch {
      fatalError("could not create split neural model fixtures: \(error)")
    }
    let splitManifest: [String: Any] = [
      "selectedArtifact": "lekh-open-vocab-bigru-attention-v1",
      "runtimeModelContract": "split-attention-incremental-v1",
      "compiledModels": [
        "encoder": ["compiledModel": "/staging/\(encoderName)"],
        "decoderStep": ["compiledModel": "/staging/\(decoderName)"]
      ]
    ]
    check(
      LekhCompanionModel.neuralRuntimeAssetsPresent(
        manifest: splitManifest,
        resources: resources,
        vocabulary: vocabulary
      ),
      "the exact split-attention package must remain recognized"
    )
    check(
      !LekhCompanionModel.neuralRuntimeAssetsPresent(
        manifest: [
          "selectedArtifact": "lekh-open-vocab-bigru-attention-v1",
          "runtimeModelContract": "split-attention-incremental-v1",
          "compiledModels": [
            "encoder": ["compiledModel": "/staging/\(encoderName)"],
            "decoderStep": ["compiledModel": "/staging/\(decoderName)"],
            "unexpected": ["compiledModel": "/staging/Unexpected.mlmodelc"]
          ]
        ],
        resources: resources,
        vocabulary: vocabulary
      ),
      "the split-attention package must still reject extra model roles"
    )
  }

  private static func check(
    _ condition: @autoclosure () -> Bool,
    _ message: @autoclosure () -> String
  ) {
    guard condition() else { fatalError(message()) }
  }
}
