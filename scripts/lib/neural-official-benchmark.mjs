import {
  validateDevanagariWordSequence
} from "./devanagari-word-sequence.mjs";

const BUCKETS = Object.freeze([
  "native-frequent",
  "indian-name",
  "foreign-name"
]);
const TARGET_LENGTH_BUCKETS = Object.freeze([
  Object.freeze({ id: "short-1-7", minimum: 1, maximum: 7 }),
  Object.freeze({ id: "medium-8-13", minimum: 8, maximum: 13 }),
  Object.freeze({ id: "long-14-plus", minimum: 14, maximum: Infinity })
]);

export const OFFICIAL_BENCHMARK_LENGTH_DIAGNOSTIC_POLICY = Object.freeze({
  id: "ctc-primary-target-scalar-length-v1",
  unit: "Unicode scalar count of the first locked acceptable target",
  buckets: Object.freeze(
    TARGET_LENGTH_BUCKETS.map(({ id, minimum, maximum }) =>
      Object.freeze({
        id,
        minimum,
        maximum: Number.isFinite(maximum) ? maximum : null
      })
    )
  ),
  promotionBlocking: false,
  purpose:
    "Expose short/medium/long quality separately so sequence-level CTC " +
    "loss weighting cannot hide a target-length regression in aggregate accuracy."
});

export const OFFICIAL_BENCHMARK_QUALITY_POLICY = Object.freeze({
  id: "lekh-indicxlit-parity-v1",
  reference: "AI4Bharat IndicXlit v1.0 unreranked beam-4",
  maximumRegression: Object.freeze({
    overallTop1Accuracy: 0.02,
    overallTop3Accuracy: 0.02,
    nativeFrequentTop1Accuracy: 0.02,
    indianNameTop1Accuracy: 0.03,
    foreignNameTop1Accuracy: 0.03
  }),
  rationale:
    "The shipping student may be dramatically smaller, but production " +
    "promotion requires near-parity with the existing public reference on " +
    "the exact locked official benchmark."
});

export function scoreOfficialBenchmark(
  benchmarkRows,
  predictionRows,
  options = {}
) {
  const issues = [];
  const benchmarkById = new Map();
  const benchmarkInputs = new Set();
  const predictionsById = new Map();
  let filteredInvalidCandidateCount = 0;
  if (!Array.isArray(benchmarkRows) || benchmarkRows.length === 0) {
    issues.push("official-benchmark.rows-missing");
    return result(null);
  }
  if (!Array.isArray(predictionRows) || predictionRows.length === 0) {
    issues.push("official-benchmark.predictions-missing");
    return result(null);
  }

  for (const [index, row] of benchmarkRows.entries()) {
    const label = row?.id ?? `benchmark-row-${index + 1}`;
    if (!isRecord(row) ||
        typeof row.id !== "string" ||
        row.id.length === 0 ||
        typeof row.input !== "string" ||
        normalizedInput(row.input).length === 0 ||
        !Array.isArray(row.acceptable) ||
        row.acceptable.length === 0 ||
        !BUCKETS.includes(row.benchmarkBucket)) {
      issues.push(`official-benchmark.row-invalid:${label}`);
      continue;
    }
    if (benchmarkById.has(row.id)) {
      issues.push(`official-benchmark.id-duplicate:${row.id}`);
      continue;
    }
    const inputIdentity = normalizedInput(row.input);
    if (benchmarkInputs.has(inputIdentity)) {
      issues.push(`official-benchmark.input-duplicate:${row.id}`);
    }
    benchmarkInputs.add(inputIdentity);
    const acceptable = [];
    const acceptableSet = new Set();
    for (const candidate of row.acceptable) {
      const normalized = normalizedText(candidate);
      if (typeof candidate !== "string" ||
          candidate !== normalized ||
          !validateDevanagariWordSequence(candidate).valid) {
        issues.push(`official-benchmark.acceptable-invalid:${row.id}`);
        continue;
      }
      if (acceptableSet.has(candidate)) {
        issues.push(`official-benchmark.acceptable-duplicate:${row.id}`);
        continue;
      }
      acceptable.push(candidate);
      acceptableSet.add(candidate);
    }
    benchmarkById.set(row.id, {
      id: row.id,
      input: row.input,
      acceptable,
      benchmarkBucket: row.benchmarkBucket
    });
  }

  for (const [index, row] of predictionRows.entries()) {
    const label = row?.id ?? `prediction-row-${index + 1}`;
    if (!isRecord(row) ||
        typeof row.id !== "string" ||
        row.id.length === 0 ||
        typeof row.input !== "string" ||
        !Array.isArray(row.candidates) ||
        row.candidates.length > 8) {
      issues.push(`official-benchmark.prediction-invalid:${label}`);
      continue;
    }
    const keys = Object.keys(row).sort();
    const allowedKeys = options.allowReferenceAnnotations === true
      ? ["acceptable", "benchmarkBucket", "candidates", "id", "input"]
      : ["candidates", "id", "input"];
    if (JSON.stringify(keys) !== JSON.stringify(allowedKeys)) {
      issues.push(`official-benchmark.prediction-schema-invalid:${label}`);
      continue;
    }
    if (predictionsById.has(row.id)) {
      issues.push(`official-benchmark.prediction-id-duplicate:${row.id}`);
      continue;
    }
    const benchmark = benchmarkById.get(row.id);
    if (!benchmark) {
      issues.push(`official-benchmark.prediction-id-unknown:${row.id}`);
      continue;
    }
    if (normalizedInput(row.input) !== normalizedInput(benchmark.input)) {
      issues.push(`official-benchmark.prediction-input-mismatch:${row.id}`);
    }
    if (options.allowReferenceAnnotations === true &&
        (row.benchmarkBucket !== benchmark.benchmarkBucket ||
          !sameSet(row.acceptable, benchmark.acceptable))) {
      issues.push(`official-benchmark.reference-annotation-mismatch:${row.id}`);
    }
    const candidates = [];
    const candidateSet = new Set();
    for (const candidate of row.candidates) {
      if (typeof candidate !== "string" ||
          candidate !== normalizedText(candidate) ||
          !validateDevanagariWordSequence(candidate).valid) {
        if (options.allowReferenceAnnotations === true) {
          filteredInvalidCandidateCount += 1;
        } else {
          issues.push(`official-benchmark.candidate-invalid:${row.id}`);
        }
        continue;
      }
      if (candidateSet.has(candidate)) {
        issues.push(`official-benchmark.candidate-duplicate:${row.id}`);
        continue;
      }
      candidateSet.add(candidate);
      candidates.push(candidate);
    }
    predictionsById.set(row.id, {
      id: row.id,
      input: row.input,
      candidates
    });
  }

  for (const id of benchmarkById.keys()) {
    if (!predictionsById.has(id)) {
      issues.push(`official-benchmark.prediction-id-missing:${id}`);
    }
  }
  if (issues.length > 0) return result(null);

  const scored = [...benchmarkById.values()].map((row) => {
    const candidates = predictionsById.get(row.id).candidates;
    const acceptable = new Set(row.acceptable);
    return {
      bucket: row.benchmarkBucket,
      targetScalarLength: [...row.acceptable[0]].length,
      top1: candidates.slice(0, 1).some((value) => acceptable.has(value)),
      top3: candidates.slice(0, 3).some((value) => acceptable.has(value))
    };
  });
  const metrics = {
    overall: metricBucket(scored),
    byBucket: Object.fromEntries(
      BUCKETS.map((bucket) => [
        bucket,
        metricBucket(scored.filter((row) => row.bucket === bucket))
      ])
    )
  };
  const metricsByTargetLength = Object.fromEntries(
    TARGET_LENGTH_BUCKETS.map(({ id, minimum, maximum }) => [
      id,
      metricBucket(
        scored.filter((row) =>
          row.targetScalarLength >= minimum &&
          row.targetScalarLength <= maximum
        )
      )
    ])
  );
  return result(metrics, metricsByTargetLength);

  function result(metrics, metricsByTargetLength = null) {
    const issueCodes = [...new Set(issues)].sort();
    return Object.freeze({
      valid: issueCodes.length === 0,
      exactCoverage: issueCodes.length === 0 &&
        benchmarkById.size === predictionsById.size,
      issueCodes: Object.freeze(issueCodes),
      benchmarkRows: benchmarkById.size,
      predictionRows: predictionsById.size,
      distinctInputCount: benchmarkInputs.size,
      filteredInvalidCandidateCount,
      metrics: metrics ? deepFreeze(metrics) : null,
      targetLengthDiagnosticPolicy:
        deepFreeze(
          structuredClone(OFFICIAL_BENCHMARK_LENGTH_DIAGNOSTIC_POLICY)
        ),
      metricsByTargetLength: metricsByTargetLength
        ? deepFreeze(metricsByTargetLength)
        : null
    });
  }
}

export function evaluateOfficialBenchmarkQuality(candidateMetrics, referenceMetrics) {
  validateMetrics(candidateMetrics, "Candidate metrics");
  validateMetrics(referenceMetrics, "Reference metrics");
  const policy = OFFICIAL_BENCHMARK_QUALITY_POLICY.maximumRegression;
  const checks = [
    check(
      "overallTop1Accuracy",
      candidateMetrics.overall.top1Accuracy,
      referenceMetrics.overall.top1Accuracy,
      policy.overallTop1Accuracy
    ),
    check(
      "overallTop3Accuracy",
      candidateMetrics.overall.top3Accuracy,
      referenceMetrics.overall.top3Accuracy,
      policy.overallTop3Accuracy
    ),
    check(
      "nativeFrequentTop1Accuracy",
      candidateMetrics.byBucket["native-frequent"].top1Accuracy,
      referenceMetrics.byBucket["native-frequent"].top1Accuracy,
      policy.nativeFrequentTop1Accuracy
    ),
    check(
      "indianNameTop1Accuracy",
      candidateMetrics.byBucket["indian-name"].top1Accuracy,
      referenceMetrics.byBucket["indian-name"].top1Accuracy,
      policy.indianNameTop1Accuracy
    ),
    check(
      "foreignNameTop1Accuracy",
      candidateMetrics.byBucket["foreign-name"].top1Accuracy,
      referenceMetrics.byBucket["foreign-name"].top1Accuracy,
      policy.foreignNameTop1Accuracy
    )
  ];
  return deepFreeze({
    policy: structuredClone(OFFICIAL_BENCHMARK_QUALITY_POLICY),
    passed: checks.every((value) => value.passed),
    checks
  });
}

function check(metric, candidate, reference, maximumRegression) {
  const minimum = round(Math.max(0, reference - maximumRegression));
  return {
    metric,
    candidate,
    reference,
    maximumRegression,
    minimum,
    delta: round(candidate - reference),
    passed: candidate >= minimum
  };
}

function metricBucket(rows) {
  const top1Hits = rows.filter((row) => row.top1).length;
  const top3Hits = rows.filter((row) => row.top3).length;
  return {
    rows: rows.length,
    top1Hits,
    top3Hits,
    top1Accuracy: rows.length === 0 ? 0 : round(top1Hits / rows.length),
    top3Accuracy: rows.length === 0 ? 0 : round(top3Hits / rows.length)
  };
}

function validateMetrics(value, label) {
  if (!isRecord(value) || !isRecord(value.overall) ||
      !isRecord(value.byBucket)) {
    throw new TypeError(`${label} must contain overall and byBucket metrics.`);
  }
  for (const bucket of BUCKETS) {
    if (!isRecord(value.byBucket[bucket])) {
      throw new TypeError(`${label} is missing ${bucket}.`);
    }
  }
}

function sameSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  return JSON.stringify([...new Set(left)].sort()) ===
    JSON.stringify([...new Set(right)].sort());
}

function normalizedText(value) {
  return typeof value === "string" ? value.normalize("NFC") : "";
}

function normalizedInput(value) {
  return normalizedText(value).trim().toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ");
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
