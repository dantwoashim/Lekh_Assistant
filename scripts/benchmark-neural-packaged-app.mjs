#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { validateNeuralComputePlanEvidence } from "./lib/neural-compute-plan-evidence.mjs";
import {
  resolveNeuralArtifactDescriptor
} from "./lib/neural-artifact-descriptor.mjs";
import {
  resolveNeuralPackagedBenchmarkContract
} from "./lib/neural-packaged-benchmark-contract.mjs";

const root = process.cwd();
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const swiftPackagePath = join(root, "native", "macos-imk", "skeleton");
const swiftScratchPath = join(tmpdir(), "lekh-neural-packaged-benchmark-swift-build");
const swiftCachePath = join(tmpdir(), "lekh-neural-swift-package-cache");
const packageReportPath = join(root, "reports", "macos-imk-dev-package-report.json");
const defaultBundle = packageReportArtifact() ??
  join(homedir(), "Library", "Caches", "LekhKeyboardBuild", "native", "macos", "Lekh Keyboard.imkdevbundle");
const appBundle = args.get("app") ?? defaultBundle;
let outPath = args.get("measurements") ??
  join(root, "data", "generated", "neural-open-vocab-model", "unknown", "coreml-packaged-app-measurements.json");
const reportPath = args.get("report") ?? join(root, "reports", "neural-packaged-app-coreml-benchmark.json");
const failures = [];
const warnings = [];

const resourcesPath = join(appBundle, "Contents", "Resources");
const manifestPath = join(resourcesPath, "LekhNeuralTransliterator.manifest.json");
const vocabPath = join(resourcesPath, "LekhNeuralTransliterator.vocab.json");
let descriptor = null;
let benchmarkContract = null;
let modelPath = null;

if (!existsSync(appBundle)) failures.push(`Missing packaged app bundle: ${appBundle}`);
if (!existsSync(manifestPath)) failures.push(`Missing packaged neural manifest: ${manifestPath}`);
if (!existsSync(vocabPath)) failures.push(`Missing packaged neural vocab: ${vocabPath}`);

let measurement = null;
if (failures.length === 0) {
  try {
    descriptor = resolveNeuralArtifactDescriptor({
      repoRoot: appBundle,
      manifestPath,
      vocabPath,
      artifactDirectory: resourcesPath,
      verifyExportArtifacts: false
    });
    benchmarkContract = resolveNeuralPackagedBenchmarkContract({
      descriptor,
      vocabulary: JSON.parse(readFileSync(vocabPath, "utf8"))
    });
    modelPath = benchmarkContract.artifact.sourcePath;
    if (!args.has("measurements")) {
      outPath = join(
        root,
        "data",
        "generated",
        "neural-open-vocab-model",
        benchmarkContract.modelId,
        "coreml-packaged-app-measurements.json"
      );
    }
  } catch (error) {
    failures.push(
      `Packaged neural benchmark contract is invalid: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }
}
if (failures.length === 0) {
  measurement = runSwiftBenchmark();
  if (measurement) {
    const computePlan = runComputePlanProbe();
    if (computePlan) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const validation = validateNeuralComputePlanEvidence(computePlan, {
        expectedArchitecture: measurement.architecture,
        manifest,
        production: false
      });
      if (!validation.valid) {
        failures.push(`Packaged Core ML compute plan is invalid: ${validation.issueCodes.join(", ")}`);
      } else {
        warnings.push(...validation.warnings);
        measurement.computePlan = computePlan;
      }
    }
  }
}

if (measurement) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), devices: [measurement] }, null, 2)}\n`);
}

finish(failures.length === 0 ? "passed-packaged-app-coreml-benchmark" : "failed-packaged-app-coreml-benchmark", failures.length === 0 ? 0 : 1, {
  appBundle: relative(root, appBundle),
  model: modelPath ? relative(root, modelPath) : null,
  manifest: relative(root, manifestPath),
  vocab: relative(root, vocabPath),
  modelId: benchmarkContract?.modelId ?? null,
  runtimeModelContract: benchmarkContract?.runtimeModelContract ?? null,
  artifactSetSha256: benchmarkContract?.artifactSetSha256 ?? null,
  measurements: measurement ? relative(root, outPath) : null,
  measurement,
  failures,
  warnings
});

function runSwiftBenchmark() {
  const scriptPath = join(tmpdir(), `lekh-packaged-coreml-benchmark-${process.pid}.swift`);
  writeFileSync(scriptPath, swiftBenchmarkSource(), "utf8");
  const result = spawnSync("swift", [
    scriptPath,
    modelPath,
    benchmarkContract.runtimeModelContract,
    String(benchmarkContract.inputLength),
    String(benchmarkContract.outputSteps),
    String(benchmarkContract.outputVocabularySize),
    String(benchmarkContract.probeInputId),
    String(benchmarkContract.probeDecoderInputId ?? -1),
    benchmarkContract.modelId,
    benchmarkContract.artifactSetSha256,
    benchmarkContract.measurementKind
  ], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.status !== 0) {
    failures.push(`Packaged Core ML benchmark failed: ${result.stderr || result.stdout}`);
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    failures.push(`Packaged Core ML benchmark returned invalid JSON: ${error instanceof Error ? error.message : String(error)}; stdout=${result.stdout}`);
    return null;
  }
}

function runComputePlanProbe() {
  const result = spawnSync(
    "swift",
    [
      "run",
      "--disable-sandbox",
      "--configuration", "release",
      "--package-path", swiftPackagePath,
      "--scratch-path", swiftScratchPath,
      "--cache-path", swiftCachePath,
      "LekhNeuralComputePlanProbe",
      modelPath
    ],
    {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 20 * 1024 * 1024
    }
  );
  if (result.status !== 0) {
    failures.push(`Packaged Core ML compute-plan probe failed: ${result.stderr || result.stdout}`);
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    failures.push(`Packaged Core ML compute-plan probe returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function swiftBenchmarkSource() {
  return String.raw`
import CoreML
import Foundation

let modelPath = CommandLine.arguments[1]
let runtimeModelContract = CommandLine.arguments[2]
guard let inputLength = Int(CommandLine.arguments[3]),
      let outputSteps = Int(CommandLine.arguments[4]),
      let outputVocabularySize = Int(CommandLine.arguments[5]),
      let probeInputId = Int(CommandLine.arguments[6]),
      let probeDecoderInputId = Int(CommandLine.arguments[7]) else {
  throw NSError(
    domain: "LekhPackagedCoreMLBenchmark",
    code: 1,
    userInfo: [NSLocalizedDescriptionKey: "Invalid benchmark tensor arguments."]
  )
}
let modelId = CommandLine.arguments[8]
let artifactSetSha256 = CommandLine.arguments[9]
let measurementKind = CommandLine.arguments[10]
let configuration = MLModelConfiguration()
configuration.computeUnits = .all
let model = try MLModel(contentsOf: URL(fileURLWithPath: modelPath), configuration: configuration)
let inputIds = try MLMultiArray(
  shape: [1, NSNumber(value: inputLength)],
  dataType: .int32
)
for index in 0..<inputIds.count {
  inputIds[index] = NSNumber(value: probeInputId)
}
var features: [String: MLFeatureValue] = [
  "inputIds": MLFeatureValue(multiArray: inputIds)
]
let expectedInputNames: Set<String>
if runtimeModelContract == "single-seq2seq-v1" {
  let decoderIds = try MLMultiArray(
    shape: [1, NSNumber(value: outputSteps)],
    dataType: .int32
  )
  for index in 0..<decoderIds.count {
    decoderIds[index] = NSNumber(value: probeDecoderInputId)
  }
  features["decoderInputIds"] = MLFeatureValue(multiArray: decoderIds)
  expectedInputNames = Set(["inputIds", "decoderInputIds"])
} else if runtimeModelContract == "single-transformer-ctc-v1" {
  expectedInputNames = Set(["inputIds"])
} else {
  throw NSError(
    domain: "LekhPackagedCoreMLBenchmark",
    code: 2,
    userInfo: [
      NSLocalizedDescriptionKey:
        "Unsupported packaged benchmark runtime contract \(runtimeModelContract)."
    ]
  )
}
func validMultiArrayFeature(
  _ feature: MLFeatureDescription?,
  shape: [Int],
  dataType: MLMultiArrayDataType
) -> Bool {
  guard let feature,
        feature.type == .multiArray,
        !feature.isOptional,
        let constraint = feature.multiArrayConstraint else {
    return false
  }
  return constraint.dataType == dataType &&
    constraint.shape.map { $0.intValue } == shape
}
let description = model.modelDescription
guard Set(description.inputDescriptionsByName.keys) == expectedInputNames,
      Set(description.outputDescriptionsByName.keys) == Set(["logits"]),
      validMultiArrayFeature(
        description.inputDescriptionsByName["inputIds"],
        shape: [1, inputLength],
        dataType: .int32
      ),
      validMultiArrayFeature(
        description.outputDescriptionsByName["logits"],
        shape: [1, outputSteps, outputVocabularySize],
        dataType: .float16
      ),
      runtimeModelContract != "single-seq2seq-v1" ||
        validMultiArrayFeature(
          description.inputDescriptionsByName["decoderInputIds"],
          shape: [1, outputSteps],
          dataType: .int32
        ) else {
  throw NSError(
    domain: "LekhPackagedCoreMLBenchmark",
    code: 3,
    userInfo: [
      NSLocalizedDescriptionKey:
        "Compiled Core ML model does not match the selected runtime tensor contract."
    ]
  )
}
let provider = try MLDictionaryFeatureProvider(dictionary: features)
for _ in 0..<10 {
  _ = try model.prediction(from: provider)
}
var durations: [Double] = []
for _ in 0..<160 {
  let started = DispatchTime.now().uptimeNanoseconds
  _ = try model.prediction(from: provider)
  let ended = DispatchTime.now().uptimeNanoseconds
  durations.append(Double(ended - started) / 1_000_000.0)
}
durations.sort()
func percentile(_ p: Double) -> Double {
  guard !durations.isEmpty else { return 0 }
  let rank = min(max(Int((Double(durations.count - 1) * p).rounded()), 0), durations.count - 1)
  return (durations[rank] * 1_000_000).rounded() / 1_000_000
}
#if arch(arm64)
let architecture = "arm64"
#elseif arch(x86_64)
let architecture = "x86_64"
#else
let architecture = "unknown"
#endif
let os = ProcessInfo.processInfo.operatingSystemVersion
let payload: [String: Any] = [
  "name": "Mac-\(architecture)-\(os.majorVersion)",
  "macOS": "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)",
  "architecture": architecture,
  "packagedApp": true,
  "configurationComputeUnits": "all",
  "modelId": modelId,
  "runtimeModelContract": runtimeModelContract,
  "artifactSetSha256": artifactSetSha256,
  "measurementKind": measurementKind,
  "coreMLPredictionCount": durations.count,
  "secureFieldInferenceCount": 0,
  "p50Ms": percentile(0.50),
  "p95Ms": percentile(0.95),
  "p99Ms": percentile(0.99),
  "artifact": modelPath
]
let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
`;
}

function packageReportArtifact() {
  if (!existsSync(packageReportPath)) return null;
  try {
    const report = JSON.parse(readFileSync(packageReportPath, "utf8"));
    return typeof report.artifact === "string" ? report.artifact : null;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const map = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[index + 1]?.startsWith("--") ? "1" : argv[index + 1] ?? "1";
    map.set(key, value);
    if (value !== "1") index += 1;
  }
  return map;
}

function finish(status, exitCode, details) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/benchmark-neural-packaged-app.mjs",
    suite: "neural-packaged-app-coreml-benchmark",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(root, reportPath), failures, warnings, measurement }, null, 2));
  process.exit(exitCode);
}
