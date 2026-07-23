#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import {
  computeNeuralDatasetContentSha256,
  validateNeuralDatasetManifest
} from "./lib/neural-dataset-manifest.mjs";
import {
  createNeuralOpenVocabAccumulator,
  finalizeNeuralOpenVocabAccumulator,
  mergeNeuralOpenVocabAccumulator,
  validateNeuralOpenVocabRecord
} from "./lib/neural-open-vocab-record.mjs";
import {
  DeterministicTrainCapSelector,
  LeakageSafeSplitPlanner,
  novelSourceIdsForLineages
} from "./lib/neural-source-lineage.mjs";
import {
  DEVANAGARI_WORD_SEQUENCE_VALIDATOR_ID,
  partitionDevanagariWordTargets,
  validateDevanagariWordSequence
} from "./lib/devanagari-word-sequence.mjs";

const root = process.cwd();
const startedAt = performance.now();
const production = process.argv.includes("--production");
const registryPath = join(root, "data", "neural", "sources.v1.json");
const goldManifestPath = join(root, "data", "neural", "gold", "manifest.v2.json");
const legacyDatasetDir = join(root, "data", "generated", "neural-transliteration");
const privateSyubrajPath = join(root, "data", "private", "neural", "syubraj-roman2nepali-transliteration", "syubraj-roman2nepali-transliteration.tsv");
const privateSyubrajManifestPath = join(dirname(privateSyubrajPath), "manifest.json");
const privateAksharantarPath = join(root, "data", "private", "neural", "ai4bharat-aksharantar-nepali", "aksharantar-nepali.tsv");
const privateAksharantarManifestPath = join(dirname(privateAksharantarPath), "manifest.json");
const privateAksharantarTrainRowCapValue = process.env.LEKH_NEURAL_AKSHARANTAR_TRAIN_ROW_CAP ?? "1000000";
const privateAksharantarTrainRowCap = privateAksharantarTrainRowCapValue === "full"
  ? null
  : Number(privateAksharantarTrainRowCapValue);
const outDir = join(root, "data", "generated", "neural-open-vocab");
const reportPath = join(root, "reports", production ? "neural-open-vocab-dataset-production-report.json" : "neural-open-vocab-dataset-report.json");

const failures = [];
const warnings = [];
const rejected = {};
const rowsByKey = new Map();
const sourceConsumption = new Map();
const sourceSelection = new Map();
const goldReservation = { rows: 0, inputIdentities: new Set(), targetIdentities: new Set() };
let generatedManifest = null;

const registry = readJson(registryPath, "source registry");
const goldManifest = readJson(goldManifestPath, "gold manifest");
const sources = new Map((registry?.sources ?? []).map((source) => [source.id, source]));
const splitPlanner = new LeakageSafeSplitPlanner(stableSplitForInput);

validateRegistry(registry);
validateGoldRelease(goldManifest);
loadGoldRows(goldManifest);
loadLegacyTsvRows();
loadPrivateAksharantarRows();
resolveAccumulatorSplits();

const rows = [...rowsByKey.values()]
  .map(finalizeNeuralOpenVocabAccumulator)
  .sort((a, b) => a.id.localeCompare(b.id));
const splitRows = {
  train: rows.filter((row) => row.split === "train"),
  dev: rows.filter((row) => row.split === "dev"),
  test: rows.filter((row) => row.split === "test")
};

validateCleanRows(rows, splitRows);
validateProductionReadiness(rows);

writeOutputs(rows, splitRows);

finish(failures.length === 0
  ? production ? "passed-production-open-vocab-data" : "passed-phase2-open-vocab-data"
  : production ? "failed-production-open-vocab-data" : "failed-phase2-open-vocab-data",
failures.length === 0 ? 0 : 1);

function loadGoldRows(manifest) {
  for (const suite of manifest?.suites ?? []) {
    const path = join(root, suite.path);
    if (!existsSync(path)) {
      failures.push(`Gold suite missing while building open-vocab dataset: ${suite.path}`);
      continue;
    }
    for (const [lineIndex, line] of readLines(path).entries()) {
      let row;
      try {
        row = JSON.parse(line);
      } catch (error) {
        failures.push(`${suite.path}:${lineIndex + 1} invalid JSON: ${error.message}`);
        continue;
      }
      reserveGoldIdentity(row, `${suite.path}:${lineIndex + 1}`);
    }
  }
}

function reserveGoldIdentity(row, location) {
  const input = normalizeInput(row.input);
  if (!input) {
    failures.push(`Gold reservation has an empty input at ${location}.`);
    return;
  }
  goldReservation.rows += 1;
  goldReservation.inputIdentities.add(input);
  const targets = row.expectedAction === "no-neural-candidate"
    ? [null]
    : Array.from(new Set((row.acceptable ?? row.expected ?? []).map(normalizeOutput).filter(Boolean)));
  if (targets.length === 0) {
    failures.push(`Gold reservation has no target at ${location}.`);
    return;
  }
  for (const target of targets) {
    if (target !== null) goldReservation.targetIdentities.add(target);
    // Every committed evaluation identity is held out from train, including
    // foundation rows whose historical metadata used a train/dev split.
    splitPlanner.add(input, target, "test");
  }
}

function loadLegacyTsvRows() {
  if (!existsSync(legacyDatasetDir)) {
    reject("legacy-dataset-missing", 1);
    warnings.push("Legacy neural-transliteration TSV directory is missing; run npm run neural:dataset if silver rows are needed.");
    return;
  }
  for (const split of ["train", "dev", "test"]) {
    const path = join(legacyDatasetDir, `${split}.tsv`);
    if (!existsSync(path)) {
      reject("legacy-split-missing", 1);
      warnings.push(`Legacy neural split is missing: ${relative(root, path)}`);
      continue;
    }
    const lines = readLines(path);
    const header = lines.shift()?.split("\t") ?? [];
    const romanizedIndex = header.indexOf("romanized");
    const devanagariIndex = header.indexOf("devanagari");
    const sourceIndex = header.indexOf("source");
    if (romanizedIndex < 0 || devanagariIndex < 0 || sourceIndex < 0) {
      failures.push(`${relative(root, path)} must have romanized/devanagari/source columns.`);
      continue;
    }
    for (const [lineIndex, line] of lines.entries()) {
      const columns = line.split("\t");
      const sourceId = columns[sourceIndex];
      const source = sources.get(sourceId);
      if (!source) {
        reject(`unknown-source:${sourceId || "<empty>"}`, 1);
        continue;
      }
      if (!source.allowedForOpenVocabTokenTraining) {
        reject(`source-not-token-training:${sourceId}`, 1);
        continue;
      }
      const input = columns[romanizedIndex];
      const target = columns[devanagariIndex];
      addCleanRow({
        action: "produce-candidate",
        input,
        target,
        acceptable: [target],
        split: stableSplitForInput(input),
        category: categoryForSource(sourceId),
        sourceIds: [sourceId],
        sourceTier: source.tier === "dictionary-derived" ? "dictionary-derived" : "runtime-derived",
        reviewTier: source.tier === "dictionary-derived" ? "silver-dictionary-derived" : "silver-runtime-derived",
        license: source.license,
        weight: source.tier === "dictionary-derived" ? 1.4 : 1.8
      }, `${relative(root, path)}:${lineIndex + 2}`);
    }
  }
}

function loadPrivateAksharantarRows() {
  if (!existsSync(privateAksharantarPath)) {
    warnings.push("Private Aksharantar Nepali import is missing; run npm run neural:source:aksharantar:nepali for a large curated public Nepali split.");
    return;
  }
  const sourceId = "ai4bharat-aksharantar-nepali";
  const source = sources.get(sourceId);
  if (!source) {
    failures.push(`Source registry missing ${sourceId}.`);
    return;
  }
  if (!source.allowedForOpenVocabTokenTraining) {
    failures.push(`${sourceId} must be allowed for open-vocabulary token training.`);
    return;
  }
  const lineEntries = readLineEntries(privateAksharantarPath);
  const firstEntry = lineEntries.next();
  const header = firstEntry.done ? [] : firstEntry.value.line.split("\t");
  const romanizedIndex = header.indexOf("romanized");
  const devanagariIndex = header.indexOf("devanagari");
  const sourceIndex = header.indexOf("source");
  const upstreamSplitIndex = header.indexOf("upstreamSplit");
  const upstreamIdIndex = header.indexOf("upstreamId");
  const upstreamSourceIndex = header.indexOf("upstreamSource");
  if (romanizedIndex < 0 || devanagariIndex < 0 || sourceIndex < 0 || upstreamSplitIndex < 0 || upstreamSourceIndex < 0) {
    failures.push(`${relative(root, privateAksharantarPath)} must have romanized/devanagari/source/upstreamSplit/upstreamSource columns.`);
    return;
  }
  if (privateAksharantarTrainRowCap !== null &&
      (!Number.isInteger(privateAksharantarTrainRowCap) || privateAksharantarTrainRowCap < 1)) {
    failures.push("LEKH_NEURAL_AKSHARANTAR_TRAIN_ROW_CAP must be a positive integer or the literal full.");
    return;
  }

  const cappedTrain = privateAksharantarTrainRowCap === null
    ? null
    : new DeterministicTrainCapSelector(privateAksharantarTrainRowCap);
  let availableTrainRows = 0;
  let selectedTrainRows = 0;
  let heldOutRows = 0;
  for (const { line, lineNumber } of lineEntries) {
    const columns = line.split("\t");
    const rowSourceId = columns[sourceIndex];
    if (rowSourceId !== sourceId) {
      reject(`unexpected-private-source:${rowSourceId || "<empty>"}`, 1);
      continue;
    }
    const upstreamSplit = columns[upstreamSplitIndex];
    if (!["train", "validation", "test"].includes(upstreamSplit)) {
      failures.push(`${relative(root, privateAksharantarPath)}:${lineNumber} has unsupported upstream split: ${upstreamSplit || "<empty>"}.`);
      continue;
    }
    const candidate = {
      input: columns[romanizedIndex],
      target: columns[devanagariIndex],
      upstreamSplit,
      upstreamId: upstreamIdIndex >= 0 ? columns[upstreamIdIndex] : "",
      upstreamSource: columns[upstreamSourceIndex],
      location: `${relative(root, privateAksharantarPath)}:${lineNumber}`
    };
    if (upstreamSplit === "train") {
      availableTrainRows += 1;
      if (cappedTrain !== null) {
        cappedTrain.add(candidate);
        continue;
      }
      selectedTrainRows += 1;
    } else {
      heldOutRows += 1;
    }
    addAksharantarCandidate(candidate, sourceId, source);
  }

  if (cappedTrain !== null) {
    const selectedTrain = cappedTrain.selected();
    selectedTrainRows = selectedTrain.length;
    for (const candidate of selectedTrain) addAksharantarCandidate(candidate, sourceId, source);
  }

  const omittedTrainRows = availableTrainRows - selectedTrainRows;
  sourceConsumption.set(sourceId, selectedTrainRows + heldOutRows);
  sourceSelection.set(sourceId, {
    policy: privateAksharantarTrainRowCap === null
      ? "full-official-snapshot-with-upstream-held-out-preserved"
      : "deterministic-hash-ranked-train-cap-with-upstream-held-out-preserved",
    trainCap: privateAksharantarTrainRowCap,
    availableTrainRows,
    selectedTrainRows,
    heldOutRows,
    omittedTrainRows
  });
  if (omittedTrainRows > 0) {
    warnings.push(`Aksharantar train cap omitted ${omittedTrainRows} upstream train rows; all ${heldOutRows} unique cleaned official held-out pairs were preserved with test > validation precedence.`);
  }
}

function addAksharantarCandidate(candidate, sourceId, source) {
  const { input, target, upstreamSplit, upstreamSource } = candidate;
  addCleanRow({
    action: "produce-candidate",
    input,
    target,
    acceptable: [target],
    split: splitFromAksharantar(upstreamSplit, input),
    category: "romanized-token",
    sourceIds: [sourceId],
    sourceTier: "licensed-public",
    reviewTier: reviewTierForAksharantar(upstreamSource),
    license: source.license,
    weight: weightForAksharantar(upstreamSource)
  }, candidate.location);
}

function addCleanRow(candidate, location) {
  const input = normalizeInput(candidate.input);
  const target = candidate.target === null ? null : normalizeOutput(candidate.target);
  if (!input || /\s/.test(input)) return reject("invalid-input-token", 1);
  if (candidate.action === "produce-candidate") {
    if (!target) return reject("missing-target", 1);
    if (/\s/.test(target)) return reject("phrase-output-rejected", 1);
    if (/[A-Za-z]/.test(target)) return reject("latin-output-rejected", 1);
    if (!/[\u0900-\u097F]/.test(target)) return reject("non-devanagari-output-rejected", 1);
    const targetValidation = validateDevanagariWordSequence(target);
    if (!targetValidation.valid) {
      return reject(`invalid-devanagari-word:${targetValidation.primaryIssueCode}`, 1);
    }
  } else if (target !== null) {
    return reject("negative-row-with-target", 1);
  }

  const sourceIds = Array.from(new Set(candidate.sourceIds.map(String))).sort();
  splitPlanner.add(input, target, candidate.split);
  const provisionalSplit = "train";
  const acceptable = candidate.action === "produce-candidate"
    ? validatedAcceptableTargets(target, candidate.acceptable ?? [])
    : [];
  const rowKey = `${candidate.action}\u0000${input}\u0000${target ?? "<NO_NEURAL_CANDIDATE>"}`;
  if (rowsByKey.has(rowKey)) {
    const existing = rowsByKey.get(rowKey);
    const novelSourceIds = novelSourceIdsForLineages([...existing.sourceIds], sourceIds, sources);
    if (novelSourceIds.length === 0) {
      reject("duplicate-same-lineage-row-ignored", 1);
      return;
    }
    mergeNeuralOpenVocabAccumulator(existing, {
      ...candidate,
      input,
      target,
      split: provisionalSplit,
      acceptable,
      sourceIds: novelSourceIds
    });
    reject("duplicate-clean-row-merged", 1);
    return;
  }

  rowsByKey.set(rowKey, createNeuralOpenVocabAccumulator({
    ...candidate,
    split: provisionalSplit,
    input,
    target,
    acceptable,
    sourceIds
  }));
}

function resolveAccumulatorSplits() {
  for (const accumulator of rowsByKey.values()) {
    accumulator.split = splitPlanner.splitFor(accumulator.input);
  }
}

function stableSplitForInput(input) {
  const normalized = normalizeInput(input);
  const bucket = Number.parseInt(sha256(normalized).slice(0, 8), 16) % 100;
  if (bucket < 8) return "test";
  if (bucket < 16) return "dev";
  return "train";
}

function validateCleanRows(rows, splitRows) {
  if (rows.length === 0) failures.push("Open-vocabulary dataset has no rows.");
  for (const split of ["train", "dev", "test"]) {
    if (splitRows[split].length === 0) failures.push(`Open-vocabulary ${split} split is empty.`);
  }
  const seenIds = new Set();
  const splitByPair = new Map();
  const splitsByInput = new Map();
  const splitsByTarget = new Map();
  for (const row of rows) {
    if (seenIds.has(row.id)) failures.push(`Duplicate cleaned row id: ${row.id}`);
    seenIds.add(row.id);
    const recordValidation = validateNeuralOpenVocabRecord(row);
    failures.push(...recordValidation.issueCodes.map((issue) => `${issue}:${row.id}`));
    const inputSplits = splitsByInput.get(row.input) ?? new Set();
    inputSplits.add(row.split);
    splitsByInput.set(row.input, inputSplits);
    if (row.input.normalize("NFC") !== row.input) failures.push(`Non-NFC input in row ${row.id}`);
    if (/\s/.test(row.input)) failures.push(`Whitespace input in row ${row.id}`);
    if (row.action === "produce-candidate") {
      if (!row.target) failures.push(`Missing target in row ${row.id}`);
      if (row.target && row.target.normalize("NFC") !== row.target) failures.push(`Non-NFC target in row ${row.id}`);
      if (row.target && /\s/.test(row.target)) failures.push(`Phrase target escaped cleaning in row ${row.id}`);
      if (row.target && /[A-Za-z]/.test(row.target)) failures.push(`Latin target escaped cleaning in row ${row.id}`);
      const targetValidation = validateDevanagariWordSequence(row.target);
      if (!targetValidation.valid) {
        failures.push(`Invalid Devanagari word target escaped cleaning in row ${row.id}: ${targetValidation.issueCodes.join(",")}`);
      }
      for (const acceptable of row.acceptable) {
        const acceptableValidation = validateDevanagariWordSequence(acceptable);
        if (!acceptableValidation.valid) {
          failures.push(`Invalid acceptable Devanagari target escaped cleaning in row ${row.id}: ${acceptableValidation.issueCodes.join(",")}`);
        }
      }
      const key = `${row.input}\u0000${row.target}`;
      const splits = splitByPair.get(key) ?? new Set();
      splits.add(row.split);
      splitByPair.set(key, splits);
      const targetSplits = splitsByTarget.get(row.target) ?? new Set();
      targetSplits.add(row.split);
      splitsByTarget.set(row.target, targetSplits);
    }
  }
  for (const [key, splits] of splitByPair) {
    if (splits.size > 1) failures.push(`Cleaned input/target pair leaks across splits: ${key.replace("\u0000", " -> ")}`);
  }
  for (const [input, splits] of splitsByInput) {
    if (splits.size > 1) failures.push(`Cleaned normalized input leaks across splits: ${input}`);
  }
  for (const [target, splits] of splitsByTarget) {
    if (splits.size > 1) failures.push(`Cleaned target identity leaks across splits: ${target}`);
  }
}

function validateProductionReadiness(rows) {
  const sourceCountsForRows = new Map();
  for (const row of rows) {
    for (const sourceId of row.sourceIds) {
      sourceCountsForRows.set(sourceId, (sourceCountsForRows.get(sourceId) ?? 0) + 1);
    }
  }
  if (!production) return;
  if (rows.length < 1_000_000) failures.push(`Production open-vocabulary dataset requires at least 1,000,000 cleaned rows; found ${rows.length}.`);
  for (const sourceId of registry?.productionRequiredSources ?? []) {
    if ((sourceCountsForRows.get(sourceId) ?? 0) === 0) {
      failures.push(`Production required source has no cleaned rows: ${sourceId}`);
    }
  }
  const trainProduce = rows.filter((row) => row.split === "train" && row.action === "produce-candidate").length;
  const devProduce = rows.filter((row) => row.split === "dev" && row.action === "produce-candidate").length;
  const testProduce = rows.filter((row) => row.split === "test" && row.action === "produce-candidate").length;
  if (trainProduce < 800_000) failures.push(`Production train produce-candidate rows must be >=800,000; found ${trainProduce}.`);
  if (devProduce < 50_000) failures.push(`Production dev produce-candidate rows must be >=50,000; found ${devProduce}.`);
  if (testProduce < 50_000) failures.push(`Production test produce-candidate rows must be >=50,000; found ${testProduce}.`);
}

function writeOutputs(rows, splitRows) {
  if (failures.length > 0) return;
  mkdirSync(outDir, { recursive: true });
  for (const split of ["train", "dev", "test"]) {
    writeJsonl(join(outDir, `${split}.jsonl`), splitRows[split]);
  }
  const splitPaths = {
    train: join(outDir, "train.jsonl"),
    dev: join(outDir, "dev.jsonl"),
    test: join(outDir, "test.jsonl")
  };
  const manifest = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    contentIdentity: "sha256-canonical-json-v1",
    datasetContentSha256: "",
    datasetId: "lekh-open-vocab-cleaned-v1",
    rowSchema: "data/neural/schema/lekh-neural-open-vocab-row.schema.json",
    sourceRegistry: "data/neural/sources.v1.json",
    splitFiles: {
      train: "data/generated/neural-open-vocab/train.jsonl",
      dev: "data/generated/neural-open-vocab/dev.jsonl",
      test: "data/generated/neural-open-vocab/test.jsonl"
    },
    counts: Object.fromEntries(Object.entries(splitRows).map(([split, value]) => [split, value.length])),
    totalRows: rows.length,
    bytes: Object.fromEntries(Object.entries(splitPaths).map(([split, path]) => [split, statSync(path).size])),
    sha256: {
      train: fileSha256(splitPaths.train),
      dev: fileSha256(splitPaths.dev),
      test: fileSha256(splitPaths.test)
    },
    recordIdentityPolicy: "stable-example-id-and-final-record-sha256-v1",
    cleaningPolicy: cleaningPolicy(),
    provenance: datasetProvenance()
  };
  manifest.datasetContentSha256 = computeNeuralDatasetContentSha256(manifest);
  const manifestValidation = validateNeuralDatasetManifest(manifest);
  failures.push(...manifestValidation.issueCodes);
  if (failures.length > 0) return;
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  generatedManifest = manifest;
}

function writeJsonl(path, rows) {
  const fd = openSync(path, "w");
  try {
    for (const row of rows) {
      writeSync(fd, `${JSON.stringify(row)}\n`, undefined, "utf8");
    }
  } finally {
    closeSync(fd);
  }
}

function validateRegistry(registry) {
  if (!registry) return;
  if (registry.schemaVersion !== 1) failures.push("Neural source registry schemaVersion must be 1.");
  if (registry.phase !== "phase2-source-cleaning") failures.push("Neural source registry phase must be phase2-source-cleaning.");
  const ids = new Set();
  const trainingSourcesByLineage = new Map();
  const requiredSources = new Set(registry.productionRequiredSources ?? []);
  for (const source of registry.sources ?? []) {
    if (ids.has(source.id)) failures.push(`Duplicate source id in registry: ${source.id}`);
    ids.add(source.id);
    if (source.rawDataCommitted && source.tier !== "contract-seed") {
      failures.push(`Only contract seed rows may commit raw data; source ${source.id} violates this policy.`);
    }
    if (source.tier === "teacher-only" && source.allowedForOpenVocabTokenTraining) {
      failures.push(`Teacher-only source must not be marked for token training: ${source.id}`);
    }
    if (source.id === "runtime-phrases" && source.allowedForOpenVocabTokenTraining) {
      failures.push("runtime-phrases must remain excluded from open-vocabulary token training.");
    }
    if (source.productionRequired !== requiredSources.has(source.id)) {
      failures.push(`Source ${source.id} productionRequired must match productionRequiredSources.`);
    }
    if (source.productionRequired && !source.allowedForOpenVocabTokenTraining) {
      failures.push(`Production required source must be allowed for token training: ${source.id}`);
    }
    if ((source.status === "blocked" || source.tier === "local-research-only") &&
        source.allowedForOpenVocabTokenTraining) {
      failures.push(`Blocked/local-research source must not be allowed for token training: ${source.id}`);
    }
    if (source.allowedForOpenVocabTokenTraining) {
      const lineageId = String(source.lineageId ?? source.id);
      const lineageSources = trainingSourcesByLineage.get(lineageId) ?? [];
      lineageSources.push(source.id);
      trainingSourcesByLineage.set(lineageId, lineageSources);
      if (source.canonicalTrainingSource && source.canonicalTrainingSource !== source.id) {
        failures.push(`Allowed training source ${source.id} must be canonical for its lineage.`);
      }
    }
  }
  for (const required of registry.productionRequiredSources ?? []) {
    if (!ids.has(required)) failures.push(`Production required source missing from registry: ${required}`);
  }
  for (const [lineageId, sourceIds] of trainingSourcesByLineage) {
    if (sourceIds.length > 1) {
      failures.push(`Training lineage ${lineageId} has multiple admitted sources: ${sourceIds.sort().join(", ")}`);
    }
  }
  for (const blockedMirror of ["syubraj-roman2nepali-transliteration", "saugatkafley-nepali-roman-transliteration"]) {
    const source = sources.get(blockedMirror);
    if (!source || source.status !== "blocked" || source.allowedForOpenVocabTokenTraining !== false ||
        source.canonicalTrainingSource !== "ai4bharat-aksharantar-nepali") {
      failures.push(`${blockedMirror} must remain blocked behind the canonical Aksharantar source.`);
    }
  }
}

function validateGoldRelease(manifest) {
  if (!manifest) return;
  if (manifest.schemaVersion !== 2 || manifest.releaseId !== "lekh-neural-gold-foundation-v2" ||
      !/^[a-f0-9]{64}$/u.test(String(manifest.corpusSha256 ?? ""))) {
    failures.push("Open-vocabulary dataset requires the locked neural gold v2 release.");
  }
  for (const suite of manifest.suites ?? []) {
    const path = join(root, suite.path ?? "");
    if (!existsSync(path)) continue;
    const rows = readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean).length;
    if (suite.sha256 !== fileSha256(path) || suite.rows !== rows) {
      failures.push(`Locked neural gold suite identity mismatch: ${suite.path}.`);
    }
  }
  const corpusHash = createHash("sha256");
  for (const suite of manifest.suites ?? []) {
    corpusHash.update(String(suite.id));
    corpusHash.update("\0");
    corpusHash.update(String(suite.path));
    corpusHash.update("\0");
    corpusHash.update(String(suite.sha256));
    corpusHash.update("\0");
    corpusHash.update(String(suite.rows));
    corpusHash.update("\n");
  }
  if (manifest.corpusSha256 !== corpusHash.digest("hex")) {
    failures.push("Locked neural gold aggregate corpus digest is stale.");
  }
}

function categoryForSource(sourceId) {
  if (sourceId.includes("name")) return "name";
  if (sourceId.includes("ambiguity")) return "ambiguity";
  if (sourceId.includes("chat")) return "chat-convention";
  return "romanized-token";
}

function splitFromAksharantar(upstreamSplit, input) {
  if (upstreamSplit === "validation") return "dev";
  if (upstreamSplit === "test") return "test";
  return stableSplitForInput(input);
}

function reviewTierForAksharantar(upstreamSource) {
  if (String(upstreamSource).startsWith("AK-")) return "curated-public-aksharantar";
  return "silver-public-transliteration";
}

function weightForAksharantar(upstreamSource) {
  if (upstreamSource === "AK-Freq") return 1.35;
  if (upstreamSource === "AK-Uni") return 1.25;
  if (String(upstreamSource).startsWith("AK-")) return 1.2;
  return 1;
}

function readJson(path, label) {
  if (!existsSync(path)) {
    failures.push(`Missing ${label}: ${relative(root, path)}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`Invalid ${label}: ${relative(root, path)}: ${error.message}`);
    return null;
  }
}

function readLines(path) {
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
}

function* readLineEntries(path) {
  const fd = openSync(path, "r");
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let pending = "";
  let lineNumber = 0;
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      let start = 0;
      let newline = pending.indexOf("\n", start);
      while (newline >= 0) {
        lineNumber += 1;
        let line = pending.slice(start, newline);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line) yield { line, lineNumber };
        start = newline + 1;
        newline = pending.indexOf("\n", start);
      }
      pending = pending.slice(start);
    }
    pending += decoder.end();
    if (pending) {
      lineNumber += 1;
      if (pending.endsWith("\r")) pending = pending.slice(0, -1);
      if (pending) yield { line: pending, lineNumber };
    }
  } finally {
    closeSync(fd);
  }
}

function normalizeInput(value) {
  return String(value ?? "").trim().toLowerCase().normalize("NFC").replace(/\s+/g, " ");
}

function normalizeOutput(value) {
  return String(value ?? "").trim().normalize("NFC").replace(/\s+/g, " ");
}

function validatedAcceptableTargets(primaryTarget, aliases) {
  const partition = partitionDevanagariWordTargets(
    primaryTarget,
    aliases.map(normalizeOutput)
  );
  for (const rejectedAlias of partition.rejected) {
    reject(`invalid-acceptable-word:${rejectedAlias.primaryIssueCode}`, 1);
  }
  return [...partition.accepted];
}

function reject(reason, count) {
  rejected[reason] = (rejected[reason] ?? 0) + count;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function datasetProvenance() {
  const rowSchemaPath = join(root, "data", "neural", "schema", "lekh-neural-open-vocab-row.schema.json");
  const builderPath = join(root, "scripts", "build-neural-open-vocab-dataset.mjs");
  return {
    builder: lockedFile(builderPath),
    sourceRegistry: lockedFile(registryPath),
    rowSchema: lockedFile(rowSchemaPath),
    targetValidator: lockedFile(join(root, "scripts", "lib", "devanagari-word-sequence.mjs")),
    goldRelease: {
      ...lockedFile(goldManifestPath),
      releaseId: goldManifest?.releaseId ?? null,
      corpusSha256: goldManifest?.corpusSha256 ?? null,
      suites: (goldManifest?.suites ?? []).map((suite) => ({
        id: suite.id,
        path: suite.path,
        sha256: suite.sha256,
        rows: suite.rows
      }))
    },
    inputs: [
      blockedSourceProvenance(
        "syubraj-roman2nepali-transliteration",
        privateSyubrajPath,
        privateSyubrajManifestPath
      ),
      sourceFileProvenance(
        "ai4bharat-aksharantar-nepali",
        privateAksharantarPath,
        privateAksharantarManifestPath,
        sourceConsumption.get("ai4bharat-aksharantar-nepali") ?? 0,
        sourceSelection.get("ai4bharat-aksharantar-nepali") ?? null
      ),
      ...["train", "dev", "test"].map((split) => {
        const path = join(legacyDatasetDir, `${split}.tsv`);
        return {
          id: `legacy-neural-transliteration-${split}`,
          status: existsSync(path) ? "present" : "missing",
          path: relative(root, path),
          sha256: existsSync(path) ? fileSha256(path) : null,
          bytes: existsSync(path) ? statSync(path).size : null
        };
      })
    ]
  };
}

function lockedFile(path) {
  return {
    path: relative(root, path),
    sha256: existsSync(path) ? fileSha256(path) : null,
    bytes: existsSync(path) ? statSync(path).size : null
  };
}

function sourceFileProvenance(id, dataPath, importManifestPath, consumedRows, selection) {
  if (!existsSync(dataPath)) {
    return {
      id,
      status: "missing",
      path: relative(root, dataPath),
      sha256: null,
      bytes: null,
      consumedRows: 0,
      selection,
      importManifest: null
    };
  }
  const actualSha256 = fileSha256(dataPath);
  let importManifest = null;
  if (!existsSync(importManifestPath)) {
    failures.push(`Imported neural source is missing its provenance manifest: ${relative(root, importManifestPath)}.`);
  } else {
    try {
      const parsed = JSON.parse(readFileSync(importManifestPath, "utf8"));
      const declaredOutputSha256 = parsed?.output?.sha256 ?? null;
      if (declaredOutputSha256 !== actualSha256) {
        failures.push(`Imported neural source digest does not match its provenance manifest: ${id}.`);
      }
      importManifest = {
        path: relative(root, importManifestPath),
        sha256: fileSha256(importManifestPath),
        declaredOutputSha256
      };
    } catch (error) {
      failures.push(`Imported neural source provenance manifest is invalid for ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    id,
    status: "present",
    path: relative(root, dataPath),
    sha256: actualSha256,
    bytes: statSync(dataPath).size,
    consumedRows,
    selection,
    importManifest
  };
}

function blockedSourceProvenance(id, dataPath, importManifestPath) {
  return {
    id,
    status: existsSync(dataPath) ? "blocked-local-research-present-not-consumed" : "blocked-local-research-absent",
    path: relative(root, dataPath),
    sha256: existsSync(dataPath) ? fileSha256(dataPath) : null,
    bytes: existsSync(dataPath) ? statSync(dataPath).size : null,
    consumedRows: 0,
    selection: {
      policy: "blocked-local-research-source-not-consumed",
      canonicalTrainingSource: "ai4bharat-aksharantar-nepali"
    },
    importManifest: existsSync(importManifestPath)
      ? { path: relative(root, importManifestPath), sha256: fileSha256(importManifestPath) }
      : null
  };
}

function actualSourceCounts(rows) {
  const counts = {};
  for (const row of rows) {
    for (const sourceId of row.sourceIds) {
      counts[sourceId] = (counts[sourceId] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function cleaningPolicy() {
  return {
    normalizeInput: "trim lowercase NFC collapse-whitespace",
    normalizeOutput: "trim NFC collapse-whitespace",
    activeTokenOnly: true,
    rejectWhitespaceOutputs: true,
    rejectLatinOutputs: true,
    rejectMalformedDevanagariWordSequences: true,
    devanagariWordSequenceValidator: DEVANAGARI_WORD_SEQUENCE_VALIDATOR_ID,
    rejectPhraseSources: true,
    splitPolicy: "connected normalized-input-and-target components; test overrides dev and train; dev overrides train",
    committedGoldPolicy: "reserved-held-out-identities-never-inserted-as-training-rows",
    publicSourcePolicy: "official Aksharantar only; same-lineage mirrors blocked",
    privateAksharantarTrainRowCap,
    noNetworkFetch: true,
    rawUpstreamDataCommitted: false
  };
}

function finish(status, exitCode) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: production
      ? "node scripts/build-neural-open-vocab-dataset.mjs --production"
      : "node scripts/build-neural-open-vocab-dataset.mjs",
    suite: "neural-open-vocab-dataset",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    production,
    datasetDir: "data/generated/neural-open-vocab",
    manifest: generatedManifest ? "data/generated/neural-open-vocab/manifest.json" : null,
    manifestSchemaVersion: generatedManifest?.schemaVersion ?? null,
    datasetContentSha256: generatedManifest?.datasetContentSha256 ?? null,
    sourceRegistry: "data/neural/sources.v1.json",
    privateSources: {
      syubraj: existsSync(privateSyubrajPath) ? relative(root, privateSyubrajPath) : null,
      syubrajPolicy: "blocked-local-research-source-not-consumed",
      aksharantarNepali: existsSync(privateAksharantarPath) ? relative(root, privateAksharantarPath) : null,
      aksharantarTrainRowCap: privateAksharantarTrainRowCap,
      aksharantarSelection: sourceSelection.get("ai4bharat-aksharantar-nepali") ?? null
    },
    goldReservation: {
      policy: "held-out-identities-only-never-added-as-dataset-rows",
      rows: goldReservation.rows,
      uniqueInputs: goldReservation.inputIdentities.size,
      uniqueTargets: goldReservation.targetIdentities.size
    },
    rowSchema: "data/neural/schema/lekh-neural-open-vocab-row.schema.json",
    counts: Object.fromEntries(Object.entries(splitRows).map(([split, value]) => [split, value.length])),
    totalRows: rows.length,
    sourceCounts: actualSourceCounts(rows),
    rejected,
    cleaningPolicy: cleaningPolicy(),
    failures,
    warnings
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const payload = { status, report: relative(root, reportPath), totalRows: rows.length, failures, warnings };
  if (exitCode === 0) console.log(JSON.stringify(payload, null, 2));
  else console.error(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}
