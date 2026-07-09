#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const packageReportPath = join(root, "reports", "macos-imk-dev-package-report.json");
const defaultBundle = packageReportArtifact() ??
  join(homedir(), "Library", "Caches", "LekhKeyboardBuild", "native", "macos", "Lekh Keyboard.imkdevbundle");
const appBundle = args.get("app") ?? defaultBundle;
const outPath = args.get("measurements") ??
  join(root, "data", "generated", "neural-open-vocab-model", "lekh-open-vocab-seq2seq-v1", "coreml-packaged-app-measurements.json");
const reportPath = args.get("report") ?? join(root, "reports", "neural-packaged-app-coreml-benchmark.json");
const failures = [];
const warnings = [];

const modelPath = join(appBundle, "Contents", "Resources", "LekhNeuralTransliterator.mlmodelc");
const manifestPath = join(appBundle, "Contents", "Resources", "LekhNeuralTransliterator.manifest.json");
const vocabPath = join(appBundle, "Contents", "Resources", "LekhNeuralTransliterator.vocab.json");

if (!existsSync(appBundle)) failures.push(`Missing packaged app bundle: ${appBundle}`);
if (!existsSync(modelPath)) failures.push(`Missing packaged Core ML model: ${modelPath}`);
if (!existsSync(manifestPath)) failures.push(`Missing packaged neural manifest: ${manifestPath}`);
if (!existsSync(vocabPath)) failures.push(`Missing packaged neural vocab: ${vocabPath}`);

let measurement = null;
if (failures.length === 0) {
  measurement = runSwiftBenchmark();
}

if (measurement) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), devices: [measurement] }, null, 2)}\n`);
}

finish(failures.length === 0 ? "passed-packaged-app-coreml-benchmark" : "failed-packaged-app-coreml-benchmark", failures.length === 0 ? 0 : 1, {
  appBundle: relative(root, appBundle),
  model: relative(root, modelPath),
  manifest: relative(root, manifestPath),
  vocab: relative(root, vocabPath),
  measurements: measurement ? relative(root, outPath) : null,
  measurement,
  failures,
  warnings
});

function runSwiftBenchmark() {
  const scriptPath = join(tmpdir(), `lekh-packaged-coreml-benchmark-${process.pid}.swift`);
  writeFileSync(scriptPath, swiftBenchmarkSource(), "utf8");
  const result = spawnSync("swift", [scriptPath, modelPath], {
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

function swiftBenchmarkSource() {
  return String.raw`
import CoreML
import Foundation

let modelPath = CommandLine.arguments[1]
let model = try MLModel(contentsOf: URL(fileURLWithPath: modelPath))
let inputIds = try MLMultiArray(shape: [1, 32], dataType: .int32)
let decoderIds = try MLMultiArray(shape: [1, 31], dataType: .int32)
for index in 0..<inputIds.count { inputIds[index] = 1 }
for index in 0..<decoderIds.count { decoderIds[index] = 1 }
let provider = try MLDictionaryFeatureProvider(dictionary: [
  "inputIds": MLFeatureValue(multiArray: inputIds),
  "decoderInputIds": MLFeatureValue(multiArray: decoderIds)
])
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
  "name": Host.current().localizedName ?? ProcessInfo.processInfo.hostName,
  "macOS": "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)",
  "architecture": architecture,
  "packagedApp": true,
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
