import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";

const sourceRoot = process.cwd();
const readinessChecker = join(sourceRoot, "scripts", "check-neural-transliteration-readiness.mjs");
const selectionChecker = join(sourceRoot, "scripts", "check-neural-model-selection.mjs");
const sotaChecker = join(sourceRoot, "scripts", "check-neural-sota-worldclass.mjs");
const canonicalSource = "ai4bharat-aksharantar-nepali";
const mirrors = [
  "syubraj-roman2nepali-transliteration",
  "saugatkafley-nepali-roman-transliteration"
];

describe("neural source-lineage release gates", () => {
  it("readiness accepts canonical Aksharantar without requiring a mirror", () => {
    withFixture((root) => {
      const { result, report } = runReadiness(root, manifest([canonicalSource]));
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(report.failures.length, 0);
      assert.equal(report.policy.canonicalTrainingSource, canonicalSource);
      assert.deepEqual(report.policy.blockedMirrorSources, mirrors);
    });
  });

  it("readiness rejects either blocked mirror as training evidence", () => {
    for (const mirror of mirrors) {
      withFixture((root) => {
        const { result, report } = runReadiness(root, manifest([canonicalSource, mirror]));
        assert.equal(result.status, 1, result.stderr || result.stdout);
        assert.ok(report.failures.some((failure) => failure.includes(`blocked lineage mirror ${mirror}`)));
      });
    }
  });

  it("model selection names one canonical source and blocks both mirrors", () => {
    withFixture((root) => {
      const { result, report } = runSelection(root, manifest([canonicalSource]));
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const canonical = report.sources.find((source) => source.id === canonicalSource);
      assert.equal(canonical.role, "primary-training-pairs");
      assert.equal(canonical.independentEvidence, true);
      for (const mirror of mirrors) {
        const source = report.sources.find((candidate) => candidate.id === mirror);
        assert.equal(source.decision, "blocked-lineage-duplicate");
        assert.equal(source.independentEvidence, false);
        assert.equal(source.canonicalTrainingSource, canonicalSource);
        assert.equal(source.rows, 0);
        assert.equal(source.countedTrainingRows, 0);
      }
    });
  });

  it("model selection rejects manifests that count a mirror", () => {
    withFixture((root) => {
      const { result, report } = runSelection(root, manifest([canonicalSource, mirrors[0]]));
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.ok(report.failures.some((failure) => failure.includes(`blocked lineage mirror ${mirrors[0]}`)));
    });
  });

  it("SOTA counts only canonical rows", () => {
    withFixture((root) => {
      prepareSotaFixture(root, { [canonicalSource]: 1_000_000 });
      const { result, report } = runSota(root);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(report.aksharantarRows, 1_000_000);
      assert.deepEqual(report.sourceLineagePolicy.blockedMirrorRows, {
        [mirrors[0]]: 0,
        [mirrors[1]]: 0
      });
      assert.ok(!Object.hasOwn(report, "syubrajRows"));
    });
  });

  it("SOTA rejects nonzero mirror rows as duplicate lineage evidence", () => {
    withFixture((root) => {
      prepareSotaFixture(root, { [canonicalSource]: 1_000_000, [mirrors[1]]: 7 });
      const { result, report } = runSota(root);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.ok(report.failures.some((failure) => failure.includes(`${mirrors[1]} to contribute 0 rows`)));
    });
  });

  it("SOTA rejects a manifest that claims a blocked mirror", () => {
    withFixture((root) => {
      prepareSotaFixture(root, { [canonicalSource]: 1_000_000 });
      writeJson(
        join(root, "models/macos/LekhNeuralTransliterator.manifest.json"),
        manifest([canonicalSource, mirrors[0]])
      );
      const { result, report } = runSota(root);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.ok(report.failures.some((failure) => failure.includes(`blocked lineage mirror ${mirrors[0]}`)));
    });
  });
});

function withFixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "lekh-neural-source-gates-"));
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runReadiness(root, value) {
  const datasetDir = join(root, "dataset");
  writeJson(join(datasetDir, "manifest.json"), { fixture: true });
  for (const split of ["train.jsonl", "dev.jsonl", "test.jsonl"]) write(join(datasetDir, split), "{}\n");
  const manifestPath = join(root, "model.manifest.json");
  const reportPath = join(root, "readiness.json");
  writeJson(manifestPath, value);
  const result = spawnSync(process.execPath, [
    readinessChecker,
    "--dataset-dir", datasetDir,
    "--model", join(root, "missing.mlmodelc"),
    "--manifest", manifestPath,
    "--report", reportPath
  ], { cwd: root, encoding: "utf8" });
  return { result, report: readJson(reportPath) };
}

function runSelection(root, value) {
  const manifestPath = join(root, "model.manifest.json");
  const reportPath = join(root, "selection.json");
  writeJson(manifestPath, value);
  const result = spawnSync(process.execPath, [
    selectionChecker,
    "--model", join(root, "missing.mlmodelc"),
    "--manifest", manifestPath,
    "--report", reportPath
  ], { cwd: root, encoding: "utf8" });
  return { result, report: readJson(reportPath) };
}

function prepareSotaFixture(root, sourceCounts) {
  const statuses = {
    "reports/neural-production-contract-report.json": "passed",
    "reports/neural-gold-eval-report.json": "passed-phase1-gold",
    "reports/neural-open-vocab-dataset-report.json": "passed-phase2-open-vocab-data",
    "reports/neural-training-contract-report.json": "passed-phase4-training-contract",
    "reports/neural-open-vocab-evaluation.json": "passed-phase5-evaluation",
    "reports/neural-coreml-device-benchmark.json": "passed-phase5-benchmark",
    "reports/neural-native-integration-report.json": "passed-phase6-native",
    "reports/neural-runtime-manifest-conformance-report.json": "passed-runtime-conformance",
    "reports/neural-training-run-readiness-report.json": "passed-phase8-training-ready",
    "reports/neural-production-promotion-report.json": "passed-phase9-promotion",
    "reports/neural-model-selection-report.json": "passed",
    "reports/neural-transliteration-readiness-report.json": "passed"
  };
  for (const [path, status] of Object.entries(statuses)) {
    const value = path.endsWith("neural-open-vocab-dataset-report.json")
      ? { status, totalRows: 1_000_000, sourceCounts }
      : { status };
    writeJson(join(root, path), value);
  }
  writeJson(join(root, "models/macos/LekhNeuralTransliterator.manifest.json"), manifest([canonicalSource]));
  writeJson(join(root, "models/rejected/closed-vocabulary-baseline/LekhNeuralTransliterator.rejected.manifest.json"), {});
  write(join(root, "native/macos-imk/skeleton/LekhEngineCore.swift"), "LekhNeuralCandidateService.shared.status\n");
  write(join(root, "scripts/package-macos-imk-dev.mjs"), "LEKH_PACKAGE_NEURAL_MODEL neuralPackagingRequested\n");
  write(join(root, "docs/LEKH_LEVEL5_FORENSIC_TRANSFORMATION_REPORT.md"), "Until every checkbox has evidence, Lekh is not Level 5\n");
}

function runSota(root) {
  const result = spawnSync(process.execPath, [sotaChecker], { cwd: root, encoding: "utf8" });
  const reportPath = join(root, "reports/neural-sota-worldclass-report.json");
  return { result, report: readJson(reportPath) };
}

function manifest(trainingSources) {
  return {
    selectedArtifact: "lekh-open-vocab-seq2seq-v1",
    parameterCount: 1_000_000,
    runtime: "CoreML",
    productionEligible: false,
    openVocabulary: true,
    localOnly: true,
    neuralTailOnly: true,
    trainingSources,
    metrics: {
      tailTop1Accuracy: 0.9,
      chatConventionTop1Accuracy: 0.9
    },
    performance: { p99Ms: 2 },
    requiredCases: {
      vato: "बाटो",
      bato: "बाटो",
      baato: "बाटो",
      chha: "छ",
      cha: "छ",
      xa: "छ",
      xaina: "छैन"
    }
  };
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function writeJson(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
