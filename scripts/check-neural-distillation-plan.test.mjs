import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { it } from "vitest";

const checkerPath = join(process.cwd(), "scripts", "check-neural-distillation-plan.mjs");

it("development reports an honest not-implemented distillation status", () => {
  withFixture({ implemented: false, teacherDownloaded: false }, (root) => {
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const report = readJson(join(root, "reports", "neural-distillation-plan-report.json"));
    assert.equal(report.status, "passed-phase3-distillation-contract-not-implemented");
    assert.equal(report.distillationConfigured, false);
    assert.equal(report.distillationImplemented, false);
    assert.ok(report.warnings.some((warning) => warning.includes("explicitly disabled")));
  });
});

it("production treats disabled distillation as an optional non-gate", () => {
  withFixture({ implemented: false, teacherDownloaded: true }, (root) => {
    const result = runChecker(root, "--production");
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const report = readJson(join(root, "reports", "neural-distillation-plan-production-report.json"));
    assert.equal(report.status, "passed-production-phase3-distillation-not-required");
    assert.equal(report.distillationImplemented, false);
    assert.deepEqual(report.failures, []);
    assert.ok(report.warnings.some((warning) => warning.includes("optional offline optimization")));
  });
});

it("production rejects hand-authored coexisting artifacts without an approved runner", () => {
  withFixture({ implemented: true, teacherDownloaded: true }, (root) => {
    const result = runChecker(root, "--production");
    assert.equal(result.status, 1, result.stderr || result.stdout);

    const report = readJson(join(root, "reports", "neural-distillation-plan-production-report.json"));
    assert.equal(report.artifactCoexistenceValid, true);
    assert.equal(report.distillationEvidenceValid, false);
    assert.equal(report.distillationImplemented, false);
    assert.ok(report.failures.some((failure) => failure.includes("artifact-coexistence only")));
  });
});

it("production rejects a student checkpoint changed after evidence capture", () => {
  withFixture({ implemented: true, teacherDownloaded: true }, (root) => {
    writeFile(join(root, "data", "generated", "neural-open-vocab-model", "lekh-open-vocab-seq2seq-v1", "checkpoint.pt"), "tampered-student");

    const result = runChecker(root, "--production");
    assert.equal(result.status, 1, result.stderr || result.stdout);

    const report = readJson(join(root, "reports", "neural-distillation-plan-production-report.json"));
    assert.equal(report.distillationImplemented, false);
    assert.ok(report.failures.includes("Distillation evidence student.checkpointSha256 does not match the bound artifact."));
  });
});

it("production rejects a digest-matching teacher artifact reached through a symbolic link", () => {
  withFixture({ implemented: true, teacherDownloaded: true }, (root) => {
    const teacherPath = join(root, "data", "generated", "neural-teacher-models", "ai4bharat-indicxlit", "v1.0", "teacher.zip");
    const indirectTarget = join(root, "indirect-teacher.zip");
    writeFile(indirectTarget, "teacher-weights");
    rmSync(teacherPath);
    symlinkSync(indirectTarget, teacherPath);

    const result = runChecker(root, "--production");
    assert.equal(result.status, 1, result.stderr || result.stdout);

    const report = readJson(join(root, "reports", "neural-distillation-plan-production-report.json"));
    assert.ok(report.failures.some((failure) => failure.includes("must not be a symbolic link")));
  });
});

function withFixture(options, callback) {
  const root = mkdtempSync(join(tmpdir(), "lekh-distillation-test-"));
  try {
    createFixture(root, options);
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function createFixture(root, { implemented, teacherDownloaded }) {
  const sources = [
    {
      id: "ai4bharat-indicxlit",
      status: "teacher-only",
      allowedForOpenVocabTokenTraining: false,
      rawDataCommitted: false
    },
    ...[
      "syubraj-roman2nepali-transliteration",
      "human-reviewed-lekh-gold-v1",
      "lekh-chat-conventions-v1",
      "lekh-name-lexicon-v1"
    ].map((id) => ({ id, status: "available" }))
  ];
  writeJson(join(root, "data", "neural", "sources.v1.json"), { schemaVersion: 1, sources });

  const splitFiles = Object.fromEntries(
    ["train", "dev", "test"].map((split) => [split, `data/generated/neural-open-vocab/${split}.jsonl`])
  );
  for (const [split, path] of Object.entries(splitFiles)) {
    writeFile(join(root, path), `{"split":"${split}"}\n`);
  }
  const splitSha256 = Object.fromEntries(
    Object.entries(splitFiles).map(([split, path]) => [split, sha256File(join(root, path))])
  );
  const datasetManifestPath = join(root, "data", "generated", "neural-open-vocab", "manifest.json");
  writeJson(datasetManifestPath, {
    schemaVersion: 2,
    datasetId: "lekh-open-vocab-cleaned-v1",
    datasetContentSha256: sha256("dataset-content"),
    totalRows: 1_000_000,
    counts: { train: 800_000, dev: 100_000, test: 100_000 },
    splitFiles,
    sha256: splitSha256
  });
  writeJson(join(root, "reports", "neural-open-vocab-dataset-report.json"), {
    sourceCounts: Object.fromEntries(sources.map((source) => [source.id, 1]))
  });

  const checkpointPath = "data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1/checkpoint.pt";
  const trainingConfigPath = join(root, "data", "neural", "training", "open-vocab-seq2seq-v1.config.json");
  writeJson(trainingConfigPath, {
    schemaVersion: 2,
    modelId: "lekh-open-vocab-seq2seq-v1",
    training: {
      distillation: {
        enabled: implemented,
        status: implemented ? "implemented" : "not-implemented",
        teacherSources: ["ai4bharat-indicxlit"],
        teacherPolicy: "offline-teacher-only-never-packaged"
      }
    },
    export: { sourceCheckpoint: checkpointPath }
  });

  if (!teacherDownloaded) return;

  const teacherArtifactPath = "data/generated/neural-teacher-models/ai4bharat-indicxlit/v1.0/teacher.zip";
  writeFile(join(root, teacherArtifactPath), "teacher-weights");
  const teacherManifestPath = join(root, "data", "generated", "neural-teacher-models", "ai4bharat-indicxlit", "v1.0", "manifest.json");
  writeJson(teacherManifestPath, {
    role: "teacher-only-not-shipping",
    archive: { path: teacherArtifactPath, sha256: sha256File(join(root, teacherArtifactPath)) },
    productionPolicy: { shippingAllowed: false, coreML: false }
  });

  if (!implemented) return;

  const supervisionPath = "data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1/teacher-supervision.jsonl";
  writeFile(join(root, supervisionPath), "{\"input\":\"namaste\",\"teacher\":\"नमस्ते\"}\n");
  writeFile(join(root, checkpointPath), "student-checkpoint");
  const datasetManifest = readJson(datasetManifestPath);
  writeJson(join(root, "reports", "neural-distillation-run-report.json"), {
    schemaVersion: 1,
    status: "passed-distillation-run",
    distillationImplemented: true,
    modelId: "lekh-open-vocab-seq2seq-v1",
    trainingConfigSha256: sha256File(trainingConfigPath),
    dataset: {
      manifestSha256: sha256File(datasetManifestPath),
      datasetContentSha256: datasetManifest.datasetContentSha256,
      splitSha256
    },
    teacher: {
      sourceId: "ai4bharat-indicxlit",
      manifestSha256: sha256File(teacherManifestPath),
      artifactPath: teacherArtifactPath,
      artifactSha256: sha256File(join(root, teacherArtifactPath))
    },
    teacherSupervision: {
      path: supervisionPath,
      sha256: sha256File(join(root, supervisionPath)),
      rowCount: 1
    },
    student: {
      checkpointPath,
      checkpointSha256: sha256File(join(root, checkpointPath))
    }
  });
}

function runChecker(root, ...args) {
  return spawnSync(process.execPath, [checkerPath, ...args], {
    cwd: root,
    encoding: "utf8"
  });
}

function writeFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function writeJson(path, value) {
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}
