import CoreML
import CryptoKit
import Darwin
import Foundation

@main
enum LekhNeuralComputePlanProbe {
  static func main() async {
    guard CommandLine.arguments.count == 2 else {
      emit([
        "schemaVersion": 1,
        "status": "failed",
        "failure": "usage: LekhNeuralComputePlanProbe <compiled-model.mlmodelc>"
      ])
      exit(2)
    }

    let modelURL = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
    do {
      let values = try modelURL.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
      guard values.isDirectory == true, values.isSymbolicLink != true else {
        throw ProbeFailure.modelPathInvalid
      }
      let modelIdentity = try directoryIdentity(modelURL)
      guard #available(macOS 14.4, *) else {
        emit(basePayload(
          status: "compute-plan-api-unavailable",
          modelURL: modelURL,
          modelIdentity: modelIdentity
        ))
        exit(3)
      }
      let payload = try await computePlanPayload(modelURL: modelURL, modelIdentity: modelIdentity)
      emit(payload)
    } catch {
      var payload = basePayload(status: "failed", modelURL: modelURL)
      payload["failure"] = String(describing: error)
      emit(payload)
      exit(1)
    }
  }

  @available(macOS 14.4, *)
  private static func computePlanPayload(
    modelURL: URL,
    modelIdentity: (sha256: String, bytes: Int)
  ) async throws -> [String: Any] {
    let configuration = MLModelConfiguration()
    configuration.computeUnits = .all
    let computePlan = try await MLComputePlan.load(contentsOf: modelURL, configuration: configuration)
    var preferredCounts = emptyDeviceCounts()
    var supportedCounts = emptyDeviceCounts()
    var operationCount = 0
    var usageUnavailableCount = 0
    var modelKinds = Set<String>()

    func record(_ usage: MLComputePlan.DeviceUsage?) {
      operationCount += 1
      guard let usage else {
        usageUnavailableCount += 1
        return
      }
      preferredCounts[deviceKind(usage.preferred), default: 0] += 1
      for device in Set(usage.supported) {
        supportedCounts[deviceKind(device), default: 0] += 1
      }
    }

    func visit(_ block: MLModelStructure.Program.Block) {
      for operation in block.operations {
        record(computePlan.deviceUsage(for: operation))
        for nested in operation.blocks { visit(nested) }
      }
    }

    func visit(_ structure: MLModelStructure) {
      switch structure {
      case .program(let program):
        modelKinds.insert("program")
        for functionName in program.functions.keys.sorted() {
          if let function = program.functions[functionName] { visit(function.block) }
        }
      case .neuralNetwork(let network):
        modelKinds.insert("neural-network")
        for layer in network.layers { record(computePlan.deviceUsage(for: layer)) }
      case .pipeline(let pipeline):
        modelKinds.insert("pipeline")
        for submodel in pipeline.subModels { visit(submodel) }
      case .unsupported:
        modelKinds.insert("unsupported")
      @unknown default:
        modelKinds.insert("unknown")
      }
    }

    visit(computePlan.modelStructure)
    guard operationCount > 0 else { throw ProbeFailure.noOperations }
    let availableDevices = Set(MLComputeDevice.allComputeDevices.map(deviceKind)).sorted()
    let neuralEngineAvailable = availableDevices.contains("neural-engine")
    let neuralEnginePreferredCount = preferredCounts["neural-engine", default: 0]
    let neuralEngineSupportedCount = supportedCounts["neural-engine", default: 0]
    var payload = basePayload(
      status: "passed",
      modelURL: modelURL,
      modelIdentity: modelIdentity
    )
    payload.merge([
      "evidenceKind": "coreml-compute-plan-anticipated-device-usage",
      "configurationComputeUnits": "all",
      "availableComputeDevices": availableDevices,
      "modelKinds": modelKinds.sorted(),
      "operationCount": operationCount,
      "usageUnavailableCount": usageUnavailableCount,
      "preferredComputeDeviceCounts": preferredCounts,
      "supportedComputeDeviceCounts": supportedCounts,
      "neuralEngineAvailable": neuralEngineAvailable,
      "neuralEnginePreferredOperationCount": neuralEnginePreferredCount,
      "neuralEngineSupportedOperationCount": neuralEngineSupportedCount,
      "neuralEnginePlanEvidence": neuralEngineAvailable && neuralEnginePreferredCount > 0
    ]) { _, replacement in replacement }
    return payload
  }

  private static func basePayload(
    status: String,
    modelURL: URL,
    modelIdentity: (sha256: String, bytes: Int)? = nil
  ) -> [String: Any] {
    let version = ProcessInfo.processInfo.operatingSystemVersion
    var payload: [String: Any] = [
      "schemaVersion": 1,
      "recordType": "lekh-neural-compute-plan-evidence",
      "status": status,
      "generatedAt": ISO8601DateFormatter().string(from: Date()),
      "architecture": architecture,
      "macOS": "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)",
      "modelPath": modelURL.path
    ]
    if let modelIdentity {
      payload["modelSha256"] = modelIdentity.sha256
      payload["modelBytes"] = modelIdentity.bytes
    }
    return payload
  }

  @available(macOS 14.0, *)
  private static func deviceKind(_ device: MLComputeDevice) -> String {
    switch device {
    case .cpu: return "cpu"
    case .gpu: return "gpu"
    case .neuralEngine: return "neural-engine"
    @unknown default: return "unknown"
    }
  }

  private static func emptyDeviceCounts() -> [String: Int] {
    ["cpu": 0, "gpu": 0, "neural-engine": 0, "unknown": 0]
  }

  private static func directoryIdentity(_ root: URL) throws -> (sha256: String, bytes: Int) {
    let keys: Set<URLResourceKey> = [
      .isDirectoryKey,
      .isRegularFileKey,
      .isSymbolicLinkKey,
      .fileSizeKey
    ]
    guard let enumerator = FileManager.default.enumerator(
      at: root,
      includingPropertiesForKeys: Array(keys),
      options: [],
      errorHandler: { _, _ in false }
    ) else {
      throw ProbeFailure.modelUnreadable
    }
    let rootPath = root.standardizedFileURL.path
    var files: [(relativePath: String, url: URL, bytes: Int)] = []
    for case let url as URL in enumerator {
      let values = try url.resourceValues(forKeys: keys)
      guard values.isSymbolicLink != true else { throw ProbeFailure.modelPathInvalid }
      if values.isDirectory == true { continue }
      guard values.isRegularFile == true,
            let bytes = values.fileSize,
            bytes >= 0,
            url.standardizedFileURL.path.hasPrefix(rootPath + "/") else {
        throw ProbeFailure.modelPathInvalid
      }
      let relativePath = String(url.standardizedFileURL.path.dropFirst(rootPath.count + 1))
      guard !relativePath.isEmpty, !relativePath.contains("..") else {
        throw ProbeFailure.modelPathInvalid
      }
      files.append((relativePath, url, bytes))
    }
    guard !files.isEmpty else { throw ProbeFailure.modelUnreadable }
    var hasher = SHA256()
    var totalBytes = 0
    let separator = Data([0])
    for file in files.sorted(by: { $0.relativePath < $1.relativePath }) {
      let data = try Data(contentsOf: file.url, options: [.mappedIfSafe])
      guard data.count == file.bytes else { throw ProbeFailure.modelUnreadable }
      totalBytes += data.count
      hasher.update(data: Data(file.relativePath.utf8))
      hasher.update(data: separator)
      hasher.update(data: data)
      hasher.update(data: separator)
    }
    let sha256 = hasher.finalize().map { String(format: "%02x", $0) }.joined()
    return (sha256, totalBytes)
  }

  private static var architecture: String {
    #if arch(arm64)
    return "arm64"
    #elseif arch(x86_64)
    return "x86_64"
    #else
    return "unknown"
    #endif
  }

  private static func emit(_ payload: [String: Any]) {
    do {
      let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
      print(String(data: data, encoding: .utf8) ?? "{}")
    } catch {
      print("{\"schemaVersion\":1,\"status\":\"failed-to-encode\"}")
    }
  }
}

private enum ProbeFailure: String, Error, CustomStringConvertible {
  case modelPathInvalid = "model-path-invalid"
  case modelUnreadable = "model-unreadable"
  case noOperations = "compute-plan-has-no-operations"

  var description: String { rawValue }
}
