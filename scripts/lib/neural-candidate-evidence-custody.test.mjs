import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { describe, it } from "vitest";
import {
  inspectContainedDirectoryTree,
  inspectContainedRegularFile
} from "./neural-artifact-filesystem.mjs";
import {
  inspectNeuralCandidateEvidenceCustody,
  NeuralCandidateEvidenceCustodyError
} from "./neural-candidate-evidence-custody.mjs";

const TRAINING_RUN_ID = "1".repeat(32);
const EXPORT_RUN_ID = "2".repeat(32);

describe("neural candidate evidence custody", () => {
  it("binds every baseline candidate file and closed artifact directory", () => {
    withFixture("baseline", (fixture) => {
      const custody = inspect(fixture);
      assert.equal(custody.runtimeModelContract, "single-seq2seq-v1");
      assert.equal(custody.predictionsBackend, "coreml-compiled-model");
      assert.deepEqual(Object.keys(custody.compiledArtifacts), ["model"]);
      assert.deepEqual(Object.keys(custody.exportPackages), ["model"]);
      assert.equal(
        custody.files.checkpoint.sha256,
        fixture.evidence.checkpoint.sha256
      );
      assert.equal(
        custody.files.goldPredictions.sha256,
        fixture.evidence.goldPredictions.sha256
      );
      assert.equal(
        custody.files.officialPredictions.sha256,
        fixture.evidence.officialPredictions.sha256
      );
      assert.match(custody.custodySetSha256, /^[a-f0-9]{64}$/u);
      assert.equal(Object.isFrozen(custody), true);
      assert.equal(Object.isFrozen(custody.custodySetIdentity.files), true);
    });
  });

  it("binds the CTC runtime branch and source checkpoint", () => {
    withFixture("ctc", (fixture) => {
      const custody = inspect(fixture);
      assert.equal(
        custody.runtimeModelContract,
        "single-transformer-ctc-v1"
      );
      assert.equal(
        custody.predictionsBackend,
        "coreml-compiled-transformer-ctc"
      );
      assert.deepEqual(Object.keys(custody.compiledArtifacts), ["model"]);
    });
  });

  it("binds the exact encoder and decoder-step split inventories", () => {
    withFixture("split", (fixture) => {
      const custody = inspect(fixture);
      assert.equal(
        custody.runtimeModelContract,
        "split-attention-incremental-v1"
      );
      assert.deepEqual(
        Object.keys(custody.compiledArtifacts),
        ["encoder", "decoderStep"]
      );
      assert.deepEqual(
        Object.keys(custody.exportPackages),
        ["encoder", "decoderStep"]
      );
      for (const role of ["encoder", "decoderStep"]) {
        assert.equal(
          custody.compiledArtifacts[role].sha256,
          fixture.artifacts.compiled[role].sha256
        );
        assert.equal(
          custody.exportPackages[role].sha256,
          fixture.artifacts.packages[role].sha256
        );
      }
    });
  });

  it("rejects candidate evidence paths that escape candidateRoot", () => {
    withFixture("baseline", (fixture) => {
      const outside = join(fixture.root, "outside-predictions.jsonl");
      write(outside, "{\"id\":\"outside\"}\n");
      mutateJson(fixture.paths.exportReport, (report) => {
        report.predictions = portable(fixture.root, outside);
        report.predictionsSha256 = sha256File(fixture.root, outside);
      });
      assertCustodyFailure(
        () => inspect(fixture),
        /predictions.*strictly inside candidateRoot/u
      );
    });
  });

  it("rejects a symlink leaf even when it points to identical bytes", () => {
    withFixture("baseline", (fixture) => {
      const outside = join(fixture.root, "outside-checkpoint.pt");
      write(outside, readFileSync(fixture.paths.checkpoint));
      rmSync(fixture.paths.checkpoint);
      symlinkSync(outside, fixture.paths.checkpoint);
      assertCustodyFailure(
        () => inspect(fixture),
        /symbolic link|symbolic-link/u
      );
    });
  });

  it("rejects a symlink nested inside a compiled directory", () => {
    withFixture("baseline", (fixture) => {
      const outside = join(fixture.root, "outside-model.bin");
      write(outside, "outside-model");
      symlinkSync(
        outside,
        join(fixture.paths.compiled.model, "linked-model.bin")
      );
      assertCustodyFailure(
        () => inspect(fixture),
        /contains a symbolic link/u
      );
    });
  });

  it("rejects checkpoint and prediction bytes changed after declaration", () => {
    withFixture("baseline", (fixture) => {
      write(fixture.paths.checkpoint, "tampered-checkpoint");
      assertCustodyFailure(
        () => inspect(fixture),
        /checkpointSha256.*verified bytes/u
      );
    });
    withFixture("baseline", (fixture) => {
      write(fixture.paths.goldPredictions, "{\"id\":\"changed\"}\n");
      assertCustodyFailure(
        () => inspect(fixture),
        /predictionsSha256.*verified bytes/u
      );
    });
  });

  it("rejects retained JSON containing malformed UTF-8 bytes", () => {
    withFixture("baseline", (fixture) => {
      writeFileSync(
        fixture.paths.trainingReport,
        Buffer.concat([
          Buffer.from('{"trainingRunId":"'),
          Buffer.from([0xff]),
          Buffer.from('"}\n')
        ])
      );
      mutateJson(fixture.paths.exportReport, (report) => {
        report.trainingReportSha256 = inspectFile(
          fixture.root,
          fixture.paths.trainingReport
        ).sha256;
      });
      assertCustodyFailure(
        () => inspect(fixture),
        /training report is invalid UTF-8/u
      );
    });
  });

  it("rejects official predictions detached from the compiled artifact identity", () => {
    withFixture("baseline", (fixture) => {
      mutateJson(fixture.paths.exportReport, (report) => {
        report.comparisonBenchmark.predictionArtifactIdentity
          .compiledArtifacts.model.sha256 = "f".repeat(64);
      });
      assertCustodyFailure(
        () => inspect(fixture),
        /not bound to the exact compiled artifact set/u
      );
    });
  });

  it("rejects stale single-model and Core ML package declarations", () => {
    withFixture("ctc", (fixture) => {
      mutateJson(fixture.paths.exportReport, (report) => {
        report.coremlExport.mlpackageSha256 = "e".repeat(64);
      });
      assertCustodyFailure(
        () => inspect(fixture),
        /coremlExport\.mlpackageSha256.*verified bytes/u
      );
    });
    withFixture("ctc", (fixture) => {
      mutateJson(fixture.paths.exportReport, (report) => {
        report.coremlExport.sourceCheckpointSha256 = "e".repeat(64);
      });
      assertCustodyFailure(
        () => inspect(fixture),
        /sourceCheckpointSha256.*verified bytes/u
      );
    });
  });

  it("rejects missing, extra, or swapped split roles", () => {
    withFixture("split", (fixture) => {
      mutateJson(fixture.paths.exportReport, (report) => {
        delete report.compiledModels.decoderStep;
      });
      assertCustodyFailure(
        () => inspect(fixture),
        /must contain exactly decoderStep, encoder/u
      );
    });
    withFixture("split", (fixture) => {
      mutateJson(fixture.paths.exportReport, (report) => {
        report.compiledModels.extra = structuredClone(
          report.compiledModels.encoder
        );
      });
      assertCustodyFailure(
        () => inspect(fixture),
        /must contain exactly decoderStep, encoder/u
      );
    });
    withFixture("split", (fixture) => {
      mutateJson(fixture.paths.exportReport, (report) => {
        const encoder = report.compiledModels.encoder;
        report.compiledModels.encoder = report.compiledModels.decoderStep;
        report.compiledModels.decoderStep = encoder;
      });
      assertCustodyFailure(
        () => inspect(fixture),
        /export and manifest artifact declarations differ/u
      );
    });
  });

  it("rejects closed artifact directories changed after publication", () => {
    withFixture("split", (fixture) => {
      write(
        join(fixture.paths.compiled.encoder, "unlisted.bin"),
        "late mutation"
      );
      assertCustodyFailure(
        () => inspect(fixture),
        /bytes do not match all manifest identities/u
      );
    });
  });

  it("rejects nested compiled-model and package directory trees", () => {
    withFixture("baseline", (fixture) => {
      const nestedPackage = join(
        fixture.paths.compiled.model,
        "Embedded.mlpackage"
      );
      renameSync(fixture.paths.packages.model, nestedPackage);
      const compiled = inspectDirectory(
        fixture.root,
        fixture.paths.compiled.model
      );
      const packageEvidence = inspectDirectory(
        fixture.root,
        nestedPackage
      );
      mutateJson(fixture.paths.manifest, (manifest) => {
        manifest.modelBytes = compiled.bytes;
        manifest.sha256.compiledModel = compiled.sha256;
      });
      const manifestEvidence = inspectFile(
        fixture.root,
        fixture.paths.manifest
      );
      mutateJson(fixture.paths.exportReport, (report) => {
        report.manifestSha256 = manifestEvidence.sha256;
        report.compiledModelSha256 = compiled.sha256;
        report.mlpackage = portable(fixture.root, nestedPackage);
        report.mlpackageSha256 = packageEvidence.sha256;
        report.coremlExport.compiledSha256 = compiled.sha256;
        report.coremlExport.mlpackage =
          portable(fixture.root, nestedPackage);
        report.coremlExport.mlpackageSha256 = packageEvidence.sha256;
        const identity =
          report.comparisonBenchmark.predictionArtifactIdentity
            .compiledArtifacts.model;
        identity.sha256 = compiled.sha256;
        identity.bytes = compiled.bytes;
      });
      assertCustodyFailure(
        () => inspect(fixture),
        /must not contain nested or overlapping artifact trees/u
      );
    });
  });

  it("rejects retained evidence files nested inside artifact trees", () => {
    withFixture("baseline", (fixture) => {
      const nestedMeasurements = join(
        fixture.paths.packages.model,
        "Data",
        "measurements.json"
      );
      renameSync(fixture.paths.measurements, nestedMeasurements);
      const packageEvidence = inspectDirectory(
        fixture.root,
        fixture.paths.packages.model
      );
      mutateJson(fixture.paths.exportReport, (report) => {
        report.measurements =
          portable(fixture.root, nestedMeasurements);
        report.measurementsSha256 = inspectFile(
          fixture.root,
          nestedMeasurements
        ).sha256;
        report.mlpackageSha256 = packageEvidence.sha256;
        report.coremlExport.mlpackageSha256 = packageEvidence.sha256;
      });
      assertCustodyFailure(
        () => inspect(fixture),
        /retained evidence files and artifact trees must not overlap/u
      );
    });
  });

  it("rejects non-canonical path aliases and candidateRoot symlinks", () => {
    withFixture("baseline", (fixture) => {
      mutateJson(fixture.paths.exportReport, (report) => {
        report.predictions = report.predictions.replace(
          "/gold-predictions.jsonl",
          "/nested/../gold-predictions.jsonl"
        );
      });
      assertCustodyFailure(
        () => inspect(fixture),
        /not a canonical repository-relative path/u
      );
    });
    withFixture("baseline", (fixture) => {
      const alias = join(fixture.root, "candidate-alias");
      symlinkSync(fixture.candidate, alias);
      assertCustodyFailure(
        () => inspectNeuralCandidateEvidenceCustody({
          repoRoot: fixture.root,
          candidateRoot: alias,
          manifestPath: fixture.paths.manifest,
          vocabPath: fixture.paths.vocabulary,
          exportReportPath: fixture.paths.exportReport
        }),
        /symbolic-link path component/u
      );
    });
  });
});

function withFixture(kind, callback) {
  const temporary = realpathSync(
    mkdtempSync(join(tmpdir(), "lekh-neural-custody-"))
  );
  try {
    callback(buildFixture(temporary, kind));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function buildFixture(root, kind) {
  const candidate = join(root, "candidate");
  mkdirSync(candidate, { recursive: true });
  const paths = {
    manifest: join(candidate, "manifest.json"),
    vocabulary: join(candidate, "LekhNeuralTransliterator.vocab.json"),
    exportReport: join(candidate, "export-report.json"),
    trainingReport: join(candidate, "training-report.json"),
    checkpoint: join(candidate, "checkpoint.pt"),
    goldPredictions: join(candidate, "gold-predictions.jsonl"),
    officialPredictions: join(candidate, "official-predictions.jsonl"),
    measurements: join(candidate, "measurements.json"),
    compiled: {},
    packages: {}
  };
  writeJson(paths.vocabulary, {
    inputVocabulary: ["<pad>", "b", "a"],
    outputVocabulary: ["<pad>", "ब", "ा"]
  });
  write(paths.checkpoint, "checkpoint-bytes");
  write(paths.goldPredictions, "{\"id\":\"gold\",\"prediction\":\"बाटो\"}\n");
  write(
    paths.officialPredictions,
    "{\"id\":\"official\",\"prediction\":\"छ\"}\n"
  );
  writeJson(paths.measurements, { status: "passed" });

  const evidence = {
    vocabulary: inspectFile(root, paths.vocabulary),
    checkpoint: inspectFile(root, paths.checkpoint),
    goldPredictions: inspectFile(root, paths.goldPredictions),
    officialPredictions: inspectFile(root, paths.officialPredictions),
    measurements: inspectFile(root, paths.measurements)
  };
  const artifacts = buildArtifacts(root, candidate, paths, kind);
  const manifest = buildManifest(kind, evidence, artifacts);
  writeJson(paths.manifest, manifest);
  evidence.manifest = inspectFile(root, paths.manifest);

  const trainingReport = {
    status: "passed-training-checkpoint",
    modelId: manifest.selectedArtifact,
    trainingRunId: TRAINING_RUN_ID,
    checkpoint: portable(root, paths.checkpoint),
    checkpointSha256: evidence.checkpoint.sha256,
    vocabMetadata: portable(root, paths.vocabulary),
    vocabMetadataSha256: evidence.vocabulary.sha256
  };
  writeJson(paths.trainingReport, trainingReport);
  evidence.trainingReport = inspectFile(root, paths.trainingReport);

  const runtimeModelContract = kind === "split"
    ? "split-attention-incremental-v1"
    : kind === "ctc"
      ? "single-transformer-ctc-v1"
      : "single-seq2seq-v1";
  const predictionsBackend = kind === "split"
    ? "coreml-compiled-split-attention-models"
    : kind === "ctc"
      ? "coreml-compiled-transformer-ctc"
      : "coreml-compiled-model";
  const predictionArtifactIdentity = {
    runtimeModelContract,
    compiledArtifacts: Object.fromEntries(
      Object.entries(artifacts.compiled).map(([role, item]) => [
        role,
        {
          path: portable(root, paths.compiled[role]),
          sha256: item.sha256,
          bytes: item.bytes
        }
      ])
    )
  };
  const exportReport = {
    status: "passed",
    modelId: manifest.selectedArtifact,
    trainingRunId: TRAINING_RUN_ID,
    exportRunId: EXPORT_RUN_ID,
    checkpoint: portable(root, paths.checkpoint),
    checkpointSha256: evidence.checkpoint.sha256,
    trainingReport: portable(root, paths.trainingReport),
    trainingReportSha256: evidence.trainingReport.sha256,
    manifest: portable(root, paths.manifest),
    manifestSha256: evidence.manifest.sha256,
    predictions: portable(root, paths.goldPredictions),
    predictionsSha256: evidence.goldPredictions.sha256,
    predictionsBackend,
    comparisonBenchmark: {
      predictions: portable(root, paths.officialPredictions),
      predictionsSha256: evidence.officialPredictions.sha256,
      predictionsBackend,
      predictionArtifactIdentity
    },
    measurements: portable(root, paths.measurements),
    measurementsSha256: evidence.measurements.sha256,
    ...artifacts.exportFields
  };
  writeJson(paths.exportReport, exportReport);
  evidence.exportReport = inspectFile(root, paths.exportReport);
  return {
    root,
    candidate,
    kind,
    paths,
    evidence,
    artifacts,
    manifest,
    exportReport
  };
}

function buildArtifacts(root, candidate, paths, kind) {
  if (kind === "split") {
    const compiled = {};
    const packages = {};
    const declarations = {};
    let modelBytes = 0;
    for (const role of ["encoder", "decoderStep"]) {
      const suffix = role === "encoder" ? "Encoder" : "DecoderStep";
      paths.compiled[role] = join(
        candidate,
        `LekhNeuralTransliterator${suffix}.mlmodelc`
      );
      paths.packages[role] = join(
        candidate,
        `LekhNeuralTransliterator${suffix}.mlpackage`
      );
      write(join(paths.compiled[role], "model.bin"), `compiled-${role}`);
      write(join(paths.packages[role], "Data", "model.bin"), `package-${role}`);
      compiled[role] = inspectDirectory(root, paths.compiled[role]);
      packages[role] = inspectDirectory(root, paths.packages[role]);
      modelBytes += compiled[role].bytes;
      declarations[role] = {
        role,
        compiledModel: portable(root, paths.compiled[role]),
        compiledBytes: compiled[role].bytes,
        compiledSha256: compiled[role].sha256,
        mlpackage: portable(root, paths.packages[role]),
        mlpackageBytes: packages[role].bytes,
        mlpackageSha256: packages[role].sha256
      };
    }
    return {
      compiled,
      packages,
      declarations,
      modelBytes,
      exportFields: {
        runtimeModelContract: "split-attention-incremental-v1",
        sourceCheckpointSha256: sha256File(root, paths.checkpoint),
        tensorContract: { encoder: {}, decoderStep: {} },
        compiledModels: structuredClone(declarations),
        coremlExport: {
          runtimeModelContract: "split-attention-incremental-v1",
          tensorContract: { encoder: {}, decoderStep: {} },
          artifacts: structuredClone(declarations)
        }
      }
    };
  }

  paths.compiled.model = join(
    candidate,
    "LekhNeuralTransliterator.mlmodelc"
  );
  paths.packages.model = join(
    candidate,
    "LekhNeuralTransliterator.mlpackage"
  );
  write(join(paths.compiled.model, "model.bin"), `compiled-${kind}`);
  write(join(paths.packages.model, "Data", "model.bin"), `package-${kind}`);
  const compiled = {
    model: inspectDirectory(root, paths.compiled.model)
  };
  const packages = {
    model: inspectDirectory(root, paths.packages.model)
  };
  const coremlExport = {
    compiledModel: portable(root, paths.compiled.model),
    compiledSha256: compiled.model.sha256,
    mlpackage: portable(root, paths.packages.model),
    mlpackageSha256: packages.model.sha256
  };
  const exportFields = {
    compiledModel: portable(root, paths.compiled.model),
    compiledModelSha256: compiled.model.sha256,
    mlpackage: portable(root, paths.packages.model),
    mlpackageSha256: packages.model.sha256,
    coremlExport
  };
  if (kind === "ctc") {
    exportFields.runtimeModelContract = "single-transformer-ctc-v1";
    coremlExport.runtimeModelContract = "single-transformer-ctc-v1";
    coremlExport.sourceCheckpointSha256 = sha256File(root, paths.checkpoint);
    coremlExport.tensorContract = { input: {}, output: {} };
  }
  return {
    compiled,
    packages,
    declarations: null,
    modelBytes: compiled.model.bytes,
    exportFields
  };
}

function buildManifest(kind, evidence, artifacts) {
  const common = {
    schemaVersion: 2,
    trainingRunId: TRAINING_RUN_ID,
    exportRunId: EXPORT_RUN_ID,
    modelBytes: artifacts.modelBytes
  };
  if (kind === "split") {
    return {
      ...common,
      selectedArtifact: "lekh-open-vocab-bigru-attention-v1",
      architecture: "bidirectional-gru-additive-attention-seq2seq",
      runtimeModelContract: "split-attention-incremental-v1",
      tensorContract: { encoder: {}, decoderStep: {} },
      compiledModels: structuredClone(artifacts.declarations),
      sha256: {
        sourceCheckpoint: evidence.checkpoint.sha256,
        vocabMetadata: evidence.vocabulary.sha256,
        compiledModels: Object.fromEntries(
          Object.entries(artifacts.compiled).map(([role, item]) => [
            role,
            item.sha256
          ])
        ),
        mlpackages: Object.fromEntries(
          Object.entries(artifacts.packages).map(([role, item]) => [
            role,
            item.sha256
          ])
        )
      }
    };
  }
  return {
    ...common,
    selectedArtifact: kind === "ctc"
      ? "lekh-open-vocab-ctc-transformer-v2"
      : "lekh-open-vocab-seq2seq-v1",
    architecture: kind === "ctc"
      ? "fixed-shape-transformer-ctc"
      : "gru-encoder-decoder-seq2seq",
    ...(kind === "ctc"
      ? {
          runtimeModelContract: "single-transformer-ctc-v1",
          tensorContract: { input: {}, output: {} }
        }
      : {}),
    sha256: {
      sourceCheckpoint: evidence.checkpoint.sha256,
      vocabMetadata: evidence.vocabulary.sha256,
      compiledModel: artifacts.compiled.model.sha256
    }
  };
}

function inspect(fixture) {
  return inspectNeuralCandidateEvidenceCustody({
    repoRoot: fixture.root,
    candidateRoot: fixture.candidate,
    manifestPath: fixture.paths.manifest,
    vocabPath: fixture.paths.vocabulary,
    exportReportPath: fixture.paths.exportReport
  });
}

function assertCustodyFailure(callback, pattern) {
  assert.throws(
    callback,
    (error) =>
      error instanceof NeuralCandidateEvidenceCustodyError &&
      pattern.test(error.message)
  );
}

function mutateJson(path, mutate) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  mutate(value);
  writeJson(path, value);
}

function inspectFile(root, path) {
  return inspectContainedRegularFile(root, path);
}

function inspectDirectory(root, path) {
  return inspectContainedDirectoryTree(root, path);
}

function sha256File(root, path) {
  return inspectFile(root, path).sha256;
}

function writeJson(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function portable(root, path) {
  return relative(root, path).split(sep).join("/");
}
