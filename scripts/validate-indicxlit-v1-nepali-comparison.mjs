#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = process.cwd();
const failures = [];
const checkedExternalArtifacts = [];
const manifestPath = resolve(root, "data/neural/benchmarks/indicxlit-v1/manifest.json");
const auditPath = resolve(root, "data/neural/audits/indicxlit-v1-nepali-comparison.json");
const manifest = readJson(manifestPath, "IndicXlit comparison manifest");
const audit = readJson(auditPath, "IndicXlit comparison audit");

if (manifest && audit) validateComparison();

const status = failures.length === 0
  ? "passed-indicxlit-v1-nepali-comparison-validation"
  : "failed-indicxlit-v1-nepali-comparison-validation";
const result = {
  status,
  benchmarkRows: manifest?.benchmark?.rows ?? null,
  predictionRows: manifest?.predictionArtifact?.rows ?? null,
  checkedExternalArtifacts,
  failures
};
(failures.length === 0 ? console.log : console.error)(JSON.stringify(result, null, 2));
process.exitCode = failures.length === 0 ? 0 : 1;

function validateComparison() {
  assert(manifest.schemaVersion === 1, "Comparison manifest schemaVersion must be 1.");
  assert(manifest.releaseId === "indicxlit-v1-nepali-aksharantar-comparison-v1", "Comparison releaseId changed.");
  assert(manifest.status === "measured-external-comparison", "Comparison status must remain measured-external-comparison.");
  assert(manifest.trainingUse === "forbidden-comparison-only", "Comparison outputs must remain forbidden for training.");
  assert(manifest.teacher?.version === "v1.0", "Teacher version must remain IndicXlit v1.0.");
  assert(manifest.teacher?.targetLanguage === "ne", "Teacher target language must remain Nepali.");
  assert(manifest.protocol?.beam === 4, "Comparison beam must remain 4.");
  assert(manifest.protocol?.nbest === 4, "Comparison n-best count must remain 4.");
  assert(manifest.protocol?.unigramReranking === false, "The measured comparison must remain unreranked.");
  assert(manifest.teacher?.unigramDictionary?.usedDuringBenchmark === false, "The dictionary must remain unused by this measured protocol.");
  assert(audit.schemaVersion === 1, "Comparison audit schemaVersion must be 1.");
  assert(audit.status === "measured-external-comparison", "Comparison audit has the wrong status.");
  assert(audit.protocol?.unigramReranking === false, "Audit must identify the measured run as unreranked.");
  assert(audit.protocol?.dictionaryUsed === false, "Audit must identify the dictionary as unused.");

  verifyHash(manifestPath, audit.evidence?.comparisonManifestSha256, "comparison manifest");
  const benchmarkManifestPath = resolveRepositoryPath(manifest.benchmark?.manifest, "benchmark manifest path");
  const predictionsPath = resolveRepositoryPath(manifest.predictionArtifact?.path, "prediction artifact path");
  const historicalPath = resolveRepositoryPath(audit.evidence?.historicalLekhReport, "historical Lekh report path");
  if (!benchmarkManifestPath || !predictionsPath || !historicalPath) return;

  verifyHash(benchmarkManifestPath, manifest.benchmark?.manifestSha256, "locked benchmark manifest");
  verifyHash(benchmarkManifestPath, audit.evidence?.benchmarkManifestSha256, "audit benchmark manifest");
  verifyHash(predictionsPath, manifest.predictionArtifact?.sha256, "prediction artifact");
  verifyHash(predictionsPath, audit.evidence?.predictionsSha256, "audit prediction artifact");
  verifyHash(historicalPath, audit.evidence?.historicalLekhReportSha256, "historical Lekh report");
  assert(statOrNull(predictionsPath)?.size === manifest.predictionArtifact?.bytes, "Prediction artifact byte count changed.");

  const benchmarkManifest = readJson(benchmarkManifestPath, "locked benchmark manifest");
  const historical = readJson(historicalPath, "historical Lekh report");
  if (!benchmarkManifest || !historical) return;
  assert(benchmarkManifest.releaseId === manifest.benchmark?.releaseId, "Locked benchmark releaseId does not match the comparison manifest.");
  assert(benchmarkManifest.corpusSha256 === manifest.benchmark?.corpusSha256, "Locked benchmark corpus digest changed.");
  assert(benchmarkManifest.trainingUse === "forbidden-evaluation-only", "Locked benchmark must remain forbidden for training.");
  assert(historical.status === "measured-quarantined-historical-baseline", "Historical Lekh report is no longer explicitly quarantined.");
  assert(historical.promotionEligible === false, "Historical Lekh artifact must remain ineligible for promotion.");

  const expectedRows = loadBenchmarkRows(benchmarkManifest, manifest.benchmark?.suites ?? []);
  const predictionRows = loadPredictionRows(predictionsPath);
  validatePredictions(expectedRows, predictionRows);
  const accuracy = scorePredictions(predictionRows);
  validateAccuracy(accuracy, audit.accuracy);
  validateHistoricalComparison(historical, audit.comparisonToQuarantinedHistoricalLekh, accuracy);
  validatePublishedProtocolCheck(audit.publishedProtocolCheck, accuracy);
  validateEvidenceIdentity();
  validateOptionalExternalArtifacts();
}

function loadBenchmarkRows(benchmarkManifest, comparisonSuites) {
  const rows = [];
  const suiteById = new Map(comparisonSuites.map((suite) => [suite.id, suite]));
  for (const suite of benchmarkManifest.suites ?? []) {
    const comparisonSuite = suiteById.get(suite.id);
    assert(Boolean(comparisonSuite), `Comparison manifest is missing benchmark suite ${suite.id}.`);
    assert(comparisonSuite?.benchmarkBucket === suite.benchmarkBucket, `${suite.id} benchmark bucket changed.`);
    assert(comparisonSuite?.rows === suite.rows, `${suite.id} row count changed in the comparison manifest.`);
    assert(comparisonSuite?.sha256 === suite.sha256, `${suite.id} digest changed in the comparison manifest.`);
    const suitePath = resolveRepositoryPath(suite.path, `${suite.id} path`);
    if (!suitePath) continue;
    verifyHash(suitePath, suite.sha256, suite.id);
    const lines = readLines(suitePath, suite.id);
    assert(lines.length === suite.rows, `${suite.id} row count does not match its manifest.`);
    for (const [index, line] of lines.entries()) {
      const row = parseJsonLine(line, suite.path, index + 1);
      if (!row) continue;
      rows.push({
        id: row.id,
        input: row.input,
        acceptable: row.acceptable,
        benchmarkBucket: suite.benchmarkBucket
      });
    }
  }
  assert(rows.length === benchmarkManifest.suites?.reduce((sum, suite) => sum + suite.rows, 0), "Loaded benchmark row total changed.");
  assert(rows.length === manifest.benchmark?.rows, "Benchmark row total does not match the comparison manifest.");
  return rows;
}

function loadPredictionRows(path) {
  const lines = readLines(path, "prediction artifact");
  const rows = [];
  for (const [index, line] of lines.entries()) {
    const row = parseJsonLine(line, relative(root, path), index + 1);
    if (row) rows.push(row);
  }
  assert(lines.length === manifest.predictionArtifact?.rows, "Prediction row count changed.");
  assert(lines.length === audit.evidence?.predictionRows, "Prediction row count does not match the audit.");
  return rows;
}

function validatePredictions(expectedRows, predictions) {
  const ids = new Set();
  const inputs = new Set();
  assert(predictions.length === expectedRows.length, "Predictions do not cover the complete locked benchmark.");
  for (let index = 0; index < Math.min(expectedRows.length, predictions.length); index += 1) {
    const expected = expectedRows[index];
    const prediction = predictions[index];
    const location = `${manifest.predictionArtifact.path}:${index + 1}`;
    assert(prediction.id === expected.id, `${location} does not match the locked benchmark row id/order.`);
    assert(prediction.input === expected.input, `${location} input does not match the locked benchmark.`);
    assert(prediction.benchmarkBucket === expected.benchmarkBucket, `${location} benchmark bucket does not match.`);
    assert(equalStringArrays(prediction.acceptable, expected.acceptable), `${location} acceptable targets do not match the locked benchmark.`);
    assert(!ids.has(prediction.id), `${location} repeats id ${prediction.id}.`);
    assert(!inputs.has(normalizeInput(prediction.input)), `${location} repeats normalized input ${prediction.input}.`);
    ids.add(prediction.id);
    inputs.add(normalizeInput(prediction.input));
    assert(Array.isArray(prediction.candidates), `${location} candidates must be an array.`);
    assert(prediction.candidates?.length === manifest.predictionArtifact?.candidatesPerRow, `${location} must contain exactly four candidates.`);
    for (const candidate of prediction.candidates ?? []) {
      assert(typeof candidate === "string" && candidate.length > 0, `${location} contains an empty or non-string candidate.`);
      assert(candidate === candidate.normalize("NFC"), `${location} contains a non-NFC candidate.`);
      assert(!/\s/u.test(candidate), `${location} contains whitespace in a token candidate.`);
      assert(!/[A-Za-z]/u.test(candidate), `${location} contains Latin text in a native candidate.`);
      assert(/[\u0900-\u097F]/u.test(candidate), `${location} candidate does not contain Devanagari.`);
    }
  }
  assert(ids.size === manifest.predictionArtifact?.rows, "Prediction IDs are not a complete unique set.");
  assert(inputs.size === manifest.predictionArtifact?.rows, "Prediction inputs are not a complete unique set.");
}

function scorePredictions(predictions) {
  const buckets = ["native-frequent", "indian-name", "foreign-name", "all", "all-names"];
  const result = {};
  for (const bucket of buckets) {
    const selected = predictions.filter((row) => {
      if (bucket === "all") return true;
      if (bucket === "all-names") return row.benchmarkBucket === "indian-name" || row.benchmarkBucket === "foreign-name";
      return row.benchmarkBucket === bucket;
    });
    let top1Hits = 0;
    let top3Hits = 0;
    for (const row of selected) {
      const acceptable = new Set(row.acceptable.map((value) => value.normalize("NFC")));
      top1Hits += Number(acceptable.has(row.candidates[0]));
      top3Hits += Number(row.candidates.slice(0, 3).some((candidate) => acceptable.has(candidate)));
    }
    result[bucket] = {
      rows: selected.length,
      top1Hits,
      top1Accuracy: top1Hits / selected.length,
      top3Hits,
      top3Accuracy: top3Hits / selected.length
    };
  }
  return result;
}

function validateAccuracy(actual, recorded) {
  for (const [bucket, metrics] of Object.entries(actual)) {
    const expected = recorded?.[bucket];
    assert(Boolean(expected), `Audit accuracy is missing ${bucket}.`);
    for (const field of ["rows", "top1Hits", "top3Hits"]) {
      assert(expected?.[field] === metrics[field], `Audit ${bucket}.${field} is stale.`);
    }
    for (const field of ["top1Accuracy", "top3Accuracy"]) {
      assert(close(expected?.[field], metrics[field]), `Audit ${bucket}.${field} is stale.`);
    }
  }
}

function validateHistoricalComparison(historical, comparison, indicXlit) {
  const mappings = {
    overall: [historical.metrics, indicXlit.all],
    "native-frequent": [historical.metricsBySuite?.["aksharantar-native-frequent"], indicXlit["native-frequent"]],
    "indian-name": [historical.metricsBySuite?.["aksharantar-indian-names"], indicXlit["indian-name"]],
    "foreign-name": [historical.metricsBySuite?.["aksharantar-foreign-names"], indicXlit["foreign-name"]]
  };
  assert(comparison?.lekhStatus === historical.status, "Historical comparison status is stale.");
  assert(comparison?.lekhPromotionEligible === false, "Historical comparison must remain ineligible for promotion.");
  for (const [bucket, [lekh, ceiling]] of Object.entries(mappings)) {
    const recorded = comparison?.[bucket];
    assert(close(recorded?.lekhTop1, lekh?.top1Accuracy), `${bucket} historical top-1 value is stale.`);
    assert(close(recorded?.lekhTop3, lekh?.top3Accuracy), `${bucket} historical top-3 value is stale.`);
    assert(close(recorded?.indicXlitTop1, ceiling.top1Accuracy), `${bucket} IndicXlit top-1 value is stale.`);
    assert(close(recorded?.indicXlitTop3, ceiling.top3Accuracy), `${bucket} IndicXlit top-3 value is stale.`);
    assert(close(recorded?.indicXlitMinusLekhTop1, ceiling.top1Accuracy - lekh?.top1Accuracy), `${bucket} top-1 comparison delta is stale.`);
    assert(close(recorded?.indicXlitMinusLekhTop3, ceiling.top3Accuracy - lekh?.top3Accuracy), `${bucket} top-3 comparison delta is stale.`);
  }
}

function validatePublishedProtocolCheck(check, accuracy) {
  assert(check?.rerankedProtocolRunLocally === false, "Audit must not claim a local reranked run.");
  for (const bucket of ["native-frequent", "indian-name", "foreign-name"]) {
    const published = check?.officialUnrerankedTop1?.[bucket];
    assert(close(check?.measuredMinusPublished?.[bucket], accuracy[bucket].top1Accuracy - published), `Published-protocol delta is stale for ${bucket}.`);
  }
}

function validateEvidenceIdentity() {
  const teacher = manifest.teacher;
  const auditTeacher = audit.teacher;
  const pairs = [
    [teacher?.officialSourceCommit, auditTeacher?.officialSourceCommit, "source commit"],
    [teacher?.officialInferenceSourceSha256, auditTeacher?.officialInferenceSourceSha256, "inference source digest"],
    [teacher?.modelArchive?.sha256, auditTeacher?.modelArchiveSha256, "model archive digest"],
    [teacher?.checkpoint?.sha256, auditTeacher?.checkpointSha256, "checkpoint digest"],
    [teacher?.officialPythonWrapper?.sha256, auditTeacher?.officialWrapperWheelSha256, "wrapper wheel digest"],
    [teacher?.unigramDictionary?.archiveSha256, auditTeacher?.dictionaryArchiveSha256, "dictionary archive digest"],
    [teacher?.unigramDictionary?.nepaliSha256, auditTeacher?.nepaliDictionarySha256, "Nepali dictionary digest"]
  ];
  for (const [manifestValue, auditValue, label] of pairs) {
    assert(isShaOrCommit(manifestValue), `Manifest ${label} is malformed.`);
    assert(manifestValue === auditValue, `Manifest and audit ${label} disagree.`);
  }
}

function validateOptionalExternalArtifacts() {
  const base = join(root, ".tmp", "indicxlit-benchmark");
  const artifacts = [
    [join(base, "indicxlit-en-indic-v1.0.zip"), manifest.teacher?.modelArchive?.sha256],
    [join(base, "model", "transformer", "indicxlit.pt"), manifest.teacher?.checkpoint?.sha256],
    [join(base, "IndicXlit", "app", "ai4bharat", "transliteration", "transformer", "custom_interactive.py"), manifest.teacher?.officialInferenceSourceSha256],
    [join(base, "downloads", manifest.teacher?.officialPythonWrapper?.wheel ?? ""), manifest.teacher?.officialPythonWrapper?.sha256],
    [join(base, "word_prob_dicts.zip"), manifest.teacher?.unigramDictionary?.archiveSha256],
    [join(base, "dictionary", "ne_word_prob_dict.json"), manifest.teacher?.unigramDictionary?.nepaliSha256]
  ];
  for (const [path, expectedSha256] of artifacts) {
    if (!existsSync(path)) continue;
    checkedExternalArtifacts.push(relative(root, path));
    verifyHash(path, expectedSha256, relative(root, path));
  }
}

function resolveRepositoryPath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    failures.push(`Missing ${label}.`);
    return null;
  }
  const path = resolve(root, value);
  const repositoryRelative = relative(root, path);
  if (repositoryRelative !== value || repositoryRelative.startsWith("..")) {
    failures.push(`${label} must be canonical and repository-relative: ${value}`);
    return null;
  }
  return path;
}

function verifyHash(path, expected, label) {
  if (!existsSync(path)) {
    failures.push(`Missing ${label}: ${relative(root, path)}`);
    return;
  }
  const actual = sha256File(path);
  assert(actual === expected, `${label} SHA-256 mismatch: expected ${expected}, got ${actual}.`);
}

function readLines(path, label) {
  if (!existsSync(path)) {
    failures.push(`Missing ${label}: ${relative(root, path)}`);
    return [];
  }
  return readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean);
}

function parseJsonLine(line, path, lineNumber) {
  try {
    return JSON.parse(line);
  } catch (error) {
    failures.push(`${path}:${lineNumber} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function readJson(path, label) {
  if (!existsSync(path)) {
    failures.push(`Missing ${label}: ${relative(root, path)}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`Invalid ${label}: ${relative(root, path)}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function statOrNull(path) {
  if (!existsSync(path)) return null;
  return statSync(path);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function normalizeInput(value) {
  return String(value ?? "").trim().toLowerCase().normalize("NFC").replace(/\s+/gu, " ");
}

function equalStringArrays(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function close(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 1e-14;
}

function isShaOrCommit(value) {
  return /^[a-f0-9]{40}$|^[a-f0-9]{64}$/u.test(String(value ?? ""));
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}
