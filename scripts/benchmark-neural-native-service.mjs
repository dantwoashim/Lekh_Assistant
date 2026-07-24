#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import {
  inspectContainedRegularFile
} from "./lib/neural-artifact-filesystem.mjs";
import {
  resolveNeuralArtifactDescriptor
} from "./lib/neural-artifact-descriptor.mjs";
import { validateNeuralDeviceMeasurements } from "./lib/neural-device-measurements.mjs";

const root = process.cwd();
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (!argument.startsWith("--")) continue;
  const next = process.argv[index + 1];
  if (next !== undefined && !next.startsWith("--")) {
    args.set(argument.slice(2), next);
    index += 1;
  } else {
    args.set(argument.slice(2), "1");
  }
}
const bundle = resolve(args.get("bundle") ?? process.env.LEKH_NEURAL_BENCH_BUNDLE ?? join(
  homedir(),
  "Library",
  "Caches",
  "LekhKeyboardBuild",
  "native",
  "macos",
  "Lekh Keyboard.imkdevbundle"
));
const production = args.has("production");
const promotionEvidence = args.has("promotion-evidence");
if (production && promotionEvidence) {
  console.error("--production and --promotion-evidence are mutually exclusive.");
  process.exit(2);
}
const runNonce = randomUUID();
const report = resolve(args.get("report") ?? join(
  root,
  "reports",
  production
    ? "neural-native-service-e2e-production-report.json"
    : promotionEvidence
      ? "neural-native-service-e2e-candidate-promotion-report.json"
      : "neural-native-service-e2e-report.json"
));
assertContainedOutput(root, report);
const stagedReport = `${report}.${runNonce}.staging`;
assertContainedOutput(root, stagedReport);
if (existsSync(stagedReport)) {
  console.error(`Refusing pre-existing neural benchmark staging path: ${stagedReport}`);
  process.exit(2);
}
let reportPublished = false;
process.on("exit", () => {
  if (!reportPublished && existsSync(stagedReport)) {
    try {
      unlinkSync(stagedReport);
    } catch {
      // A failed run must never promote its staging file. Cleanup is best-effort.
    }
  }
});
const resources = join(bundle, "Contents", "Resources");
const manifest = join(resources, "LekhNeuralTransliterator.manifest.json");
const vocab = join(resources, "LekhNeuralTransliterator.vocab.json");
for (const required of [bundle, manifest, vocab]) {
  if (!existsSync(required)) {
    console.error(`Missing packaged neural benchmark input: ${required}`);
    process.exit(2);
  }
}
const bundleStat = lstatSync(bundle);
if (bundleStat.isSymbolicLink() || !bundleStat.isDirectory()) {
  console.error(`Packaged neural benchmark bundle must be a real directory: ${bundle}`);
  process.exit(2);
}

const result = spawnSync(
  "swift",
  ["run", "--configuration", "release", "LekhInputMethodBehaviorProbe"],
  {
    cwd: join(root, "native", "macos-imk", "skeleton"),
    env: {
      ...process.env,
      LEKH_NEURAL_BENCH_BUNDLE: bundle,
      LEKH_NEURAL_BENCH_REPORT: stagedReport,
      LEKH_NEURAL_BENCH_PRODUCTION: production ? "1" : "0",
      LEKH_NEURAL_BENCH_NONCE: runNonce
    },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  }
);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(stagedReport)) {
  console.error("Behavior probe passed but did not create the end-to-end neural report.");
  process.exit(1);
}
const reportEvidence = inspectContainedRegularFile(root, stagedReport, {
  label: "Fresh native neural benchmark report",
  includeContents: true,
  maxBytes: 4 * 1024 * 1024
});
const parsed = JSON.parse(reportEvidence.contents.toString("utf8"));
if (parsed.runNonce !== runNonce || resolve(String(parsed.bundle ?? "")) !== bundle) {
  console.error("Behavior probe report is stale or bound to a different packaged bundle.");
  process.exit(1);
}
const manifestEvidence = inspectContainedRegularFile(bundle, manifest, {
  label: "Packaged neural manifest",
  includeContents: true,
  maxBytes: 1024 * 1024
});
const manifestPayload = JSON.parse(manifestEvidence.contents.toString("utf8"));
let artifactDescriptor;
try {
  artifactDescriptor = resolveNeuralArtifactDescriptor({
    repoRoot: bundle,
    manifest: manifestPayload,
    manifestPath: manifest,
    vocabPath: vocab,
    artifactDirectory: resources,
    verifyExportArtifacts: false
  });
} catch (error) {
  console.error(
    `Packaged neural artifact inventory is invalid: ` +
    `${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
}
parsed.artifactIdentity = {
  trainingRunId: manifestPayload.trainingRunId ?? null,
  exportRunId: manifestPayload.exportRunId ?? null,
  manifestSha256: manifestEvidence.sha256,
  vocabSha256: inspectContainedRegularFile(bundle, vocab, {
    label: "Packaged neural vocabulary",
    maxBytes: 8 * 1024 * 1024
  }).sha256,
  artifactSetSha256: artifactDescriptor.artifactSetSha256
};
if (artifactDescriptor.runtimeModelContract === "single-seq2seq-v1") {
  parsed.artifactIdentity.compiledModelSha256 =
    artifactDescriptor.artifacts[0].compiledSha256;
} else {
  parsed.artifactIdentity.compiledModels = Object.fromEntries(
    artifactDescriptor.artifacts.map((artifact) => [
      artifact.role,
      artifact.compiledSha256
    ])
  );
}
const expectedStatus = production ? "passed-production" : "passed-experimental";
if (parsed.status !== expectedStatus ||
    parsed.performance?.p95Ms >= parsed.targetP95Ms ||
    parsed.performance?.p99Ms >= 50) {
  console.error(`End-to-end neural service gate failed: ${JSON.stringify(parsed.performance)}`);
  process.exit(1);
}
if (production || promotionEvidence) {
  if (production && manifestPayload.productionEligible !== true) {
    console.error("Production service evidence requires a productionEligible=true packaged manifest.");
    process.exit(1);
  }
  if (promotionEvidence && manifestPayload.productionEligible !== false) {
    console.error("Candidate promotion evidence requires an unpromoted productionEligible=false manifest.");
    process.exit(1);
  }
  const computePlans = Object.fromEntries(
    artifactDescriptor.artifacts.map((artifact) => [
      artifact.role,
      runComputePlanProbe(artifact.sourcePath)
    ])
  );
  if (Object.values(computePlans).some((plan) => !plan) ||
      !Array.isArray(parsed.devices) ||
      parsed.devices.length !== 1) {
    console.error(
      "Production end-to-end evidence requires one device record and a " +
      "Core ML compute plan for every runtime model."
    );
    process.exit(1);
  }
  parsed.devices[0].artifact = bundle;
  parsed.devices[0].artifactSetSha256 = artifactDescriptor.artifactSetSha256;
  parsed.devices[0].configurationComputeUnits = "all";
  parsed.devices[0].computePlans = computePlans;
  const validation = validateNeuralDeviceMeasurements(parsed.devices, {
    artifactDescriptor,
    production: true
  });
  if (!validation.valid) {
    console.error(`Production device evidence failed: ${validation.issueCodes.join(", ")}`);
    process.exit(1);
  }
  parsed.computePlacement = {
    architectures: validation.architectures,
    neuralEngineClaimAllowed: validation.neuralEngineClaimAllowed,
    runtimeRoles: artifactDescriptor.artifacts.map((artifact) => artifact.role),
    artifactSetSha256: artifactDescriptor.artifactSetSha256
  };
}
parsed.proofMode = production
  ? "production"
  : promotionEvidence ? "candidate-promotion" : "experimental";
if (promotionEvidence) parsed.status = "passed-candidate-promotion-evidence";
writeFileSync(stagedReport, `${JSON.stringify(parsed, null, 2)}\n`);
renameSync(stagedReport, report);
reportPublished = true;
console.log(JSON.stringify({
  status: parsed.status,
  report: relative(root, report),
  performance: parsed.performance,
  singleForwardBenchmarkIsConsumerLatency: parsed.singleForwardBenchmarkIsConsumerLatency
}, null, 2));

function assertContainedOutput(parent, candidate) {
  const child = relative(resolve(parent), resolve(candidate));
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    console.error(`Neural benchmark report must remain inside the repository: ${candidate}`);
    process.exit(2);
  }
}

function runComputePlanProbe(modelPath) {
  const result = spawnSync(
    "swift",
    [
      "run",
      "--configuration", "release",
      "--package-path", join(root, "native", "macos-imk", "skeleton"),
      "LekhNeuralComputePlanProbe",
      modelPath
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024
    }
  );
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout || "Core ML compute-plan probe failed.");
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    console.error(`Core ML compute-plan probe returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
