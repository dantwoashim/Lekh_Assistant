import {
  validateDevanagariWordSequence
} from "./devanagari-word-sequence.mjs";

const REQUIRED_LOCKED_EVALUATIONS = Object.freeze([
  "gold",
  "official-benchmark"
]);

export function evaluateNeuralRareScalarEvidence({
  contract,
  probePredictions,
  lockedEvaluations
}) {
  const failures = [];
  const warnings = [];
  const scalarRecords = Array.isArray(contract?.scalars)
    ? contract.scalars
    : [];
  const probes = scalarRecords.flatMap((record) =>
    (record.probes ?? []).map((probe) => ({
      ...probe,
      scalar: record.scalar,
      cldrNepaliMainExemplar: record.cldrNepaliMainExemplar,
      treatment: record.treatment
    }))
  );
  const probeIndex = validatePredictionCoverage({
    expectedRows: probes,
    predictionRows: probePredictions,
    label: "rare-probe",
    maximumCandidates: 4,
    failures
  });
  const evaluations = Array.isArray(lockedEvaluations)
    ? lockedEvaluations
    : [];
  const labels = evaluations.map((value) => value?.label).sort(compareText);
  if (
    JSON.stringify(labels) !==
    JSON.stringify([...REQUIRED_LOCKED_EVALUATIONS].sort(compareText))
  ) {
    failures.push(
      "neural-rare-scalar.locked-evaluation-inventory-invalid"
    );
  }
  const evaluationIndexes = new Map();
  for (const evaluation of evaluations) {
    if (
      typeof evaluation?.label !== "string" ||
      !REQUIRED_LOCKED_EVALUATIONS.includes(evaluation.label)
    ) {
      continue;
    }
    const rows = Array.isArray(evaluation.rows) ? evaluation.rows : [];
    const predictions = Array.isArray(evaluation.predictions)
      ? evaluation.predictions
      : [];
    evaluationIndexes.set(
      evaluation.label,
      validatePredictionCoverage({
        expectedRows: rows,
        predictionRows: predictions,
        label: evaluation.label,
        maximumCandidates: 4,
        failures
      })
    );
  }

  const byScalar = Object.fromEntries(
    scalarRecords.map((record) => [
      record.scalar,
      evaluateScalarProbes(record, probeIndex)
    ])
  );
  for (const record of scalarRecords) {
    const metrics = byScalar[record.scalar];
    if (
      record.cldrNepaliMainExemplar === true &&
      metrics?.top4ScalarEmissionRows === 0
    ) {
      warnings.push(
        `neural-rare-scalar.supported-scalar-not-emitted:${codePointLabel(
          record.scalar
        )}`
      );
    }
    if (
      record.cldrNepaliMainExemplar === true &&
      metrics?.heldOutProbeRows > 0 &&
      metrics?.heldOutTop4ExactRows === 0
    ) {
      warnings.push(
        `neural-rare-scalar.no-heldout-exact-match:${codePointLabel(
          record.scalar
        )}`
      );
    }
  }

  const spuriousTop1 = [];
  for (const record of scalarRecords.filter(
    (value) => value.cldrNepaliMainExemplar === false
  )) {
    for (const evaluation of evaluations) {
      const predictions = evaluationIndexes.get(evaluation.label);
      if (!(predictions instanceof Map)) continue;
      for (const row of evaluation.rows ?? []) {
        const top1 = predictions.get(row?.id)?.candidates?.[0];
        if (typeof top1 !== "string" || !top1.includes(record.scalar)) {
          continue;
        }
        const accepted = acceptedTargets(row);
        if (accepted.some((target) => target.includes(record.scalar))) {
          continue;
        }
        spuriousTop1.push({
          scalar: record.scalar,
          codePoint: codePointLabel(record.scalar),
          evaluation: evaluation.label,
          id: row?.id ?? null,
          input: row?.input ?? null,
          top1
        });
      }
    }
  }
  if (spuriousTop1.length > 0) {
    failures.push(
      "neural-rare-scalar.unaccepted-non-exemplar-top1-emission"
    );
  }

  const uniqueFailures = [...new Set(failures)].sort(compareText);
  const uniqueWarnings = [...new Set(warnings)].sort(compareText);
  return Object.freeze({
    status: uniqueFailures.length === 0
      ? "passed-neural-rare-scalar-evaluation"
      : "failed-neural-rare-scalar-evaluation",
    policy:
      "silver probes are diagnostic; unaccepted non-CLDR-exemplar sparse scalars are forbidden at top-1 on locked evaluations",
    probeRows: probes.length,
    lockedEvaluationRows: evaluations.reduce(
      (sum, evaluation) => sum + Number(evaluation?.rows?.length ?? 0),
      0
    ),
    byScalar: deepFreeze(byScalar),
    spuriousNonExemplarTop1: Object.freeze(spuriousTop1),
    failures: Object.freeze(uniqueFailures),
    warnings: Object.freeze(uniqueWarnings),
    productionGatePassed: uniqueFailures.length === 0
  });
}

function evaluateScalarProbes(record, predictions) {
  const rows = Array.isArray(record?.probes) ? record.probes : [];
  const observations = rows.map((row) => {
    const candidates = predictions.get(row.id)?.candidates ?? [];
    const acceptable = new Set(acceptedTargets(row));
    return {
      id: row.id,
      split: row.split,
      input: row.input,
      target: row.target,
      candidates,
      top1Exact:
        candidates.length > 0 && acceptable.has(candidates[0]),
      top4Exact: candidates.some((candidate) => acceptable.has(candidate)),
      top1ContainsScalar:
        candidates.length > 0 && candidates[0].includes(record.scalar),
      top4ContainsScalar:
        candidates.some((candidate) => candidate.includes(record.scalar))
    };
  });
  const heldOut = observations.filter((row) => row.split !== "train");
  return {
    scalar: record.scalar,
    codePoint: record.codePoint,
    cldrNepaliMainExemplar: record.cldrNepaliMainExemplar,
    treatment: record.treatment,
    probeRows: observations.length,
    trainProbeRows: observations.length - heldOut.length,
    heldOutProbeRows: heldOut.length,
    top1ExactRows: observations.filter((row) => row.top1Exact).length,
    top4ExactRows: observations.filter((row) => row.top4Exact).length,
    heldOutTop1ExactRows: heldOut.filter((row) => row.top1Exact).length,
    heldOutTop4ExactRows: heldOut.filter((row) => row.top4Exact).length,
    top1ScalarEmissionRows: observations.filter(
      (row) => row.top1ContainsScalar
    ).length,
    top4ScalarEmissionRows: observations.filter(
      (row) => row.top4ContainsScalar
    ).length,
    observations
  };
}

function validatePredictionCoverage({
  expectedRows,
  predictionRows,
  label,
  maximumCandidates,
  failures
}) {
  const expected = new Map();
  const predictions = new Map();
  if (!Array.isArray(expectedRows) || expectedRows.length === 0) {
    failures.push(`neural-rare-scalar.${label}-rows-invalid`);
    return predictions;
  }
  if (!Array.isArray(predictionRows) || predictionRows.length === 0) {
    failures.push(`neural-rare-scalar.${label}-predictions-invalid`);
    return predictions;
  }
  for (const row of expectedRows) {
    if (
      !isRecord(row) ||
      typeof row.id !== "string" ||
      !row.id ||
      typeof row.input !== "string" ||
      !row.input ||
      expected.has(row.id)
    ) {
      failures.push(`neural-rare-scalar.${label}-expected-row-invalid`);
      continue;
    }
    expected.set(row.id, row);
  }
  for (const [index, row] of predictionRows.entries()) {
    const id = typeof row?.id === "string" && row.id
      ? row.id
      : `row-${index + 1}`;
    if (
      !isRecord(row) ||
      JSON.stringify(Object.keys(row).sort(compareText)) !==
        JSON.stringify(["candidates", "id", "input"]) ||
      typeof row.id !== "string" ||
      !row.id ||
      typeof row.input !== "string" ||
      !row.input ||
      !Array.isArray(row.candidates) ||
      row.candidates.length > maximumCandidates
    ) {
      failures.push(
        `neural-rare-scalar.${label}-prediction-schema-invalid:${id}`
      );
      continue;
    }
    if (predictions.has(row.id)) {
      failures.push(
        `neural-rare-scalar.${label}-prediction-duplicate:${row.id}`
      );
      continue;
    }
    const expectedRow = expected.get(row.id);
    if (!expectedRow) {
      failures.push(
        `neural-rare-scalar.${label}-prediction-unknown:${row.id}`
      );
      continue;
    }
    if (normalizeInput(row.input) !== normalizeInput(expectedRow.input)) {
      failures.push(
        `neural-rare-scalar.${label}-prediction-input-mismatch:${row.id}`
      );
    }
    const candidates = new Set();
    for (const candidate of row.candidates) {
      if (
        typeof candidate !== "string" ||
        !candidate ||
        candidate.length > 128 ||
        candidate !== candidate.normalize("NFC") ||
        /[\u0000-\u001f\u007f\sA-Za-z]/u.test(candidate) ||
        !validateDevanagariWordSequence(candidate).valid
      ) {
        failures.push(
          `neural-rare-scalar.${label}-candidate-invalid:${row.id}`
        );
        continue;
      }
      if (candidates.has(candidate)) {
        failures.push(
          `neural-rare-scalar.${label}-candidate-duplicate:${row.id}`
        );
      }
      candidates.add(candidate);
    }
    predictions.set(row.id, row);
  }
  for (const id of expected.keys()) {
    if (!predictions.has(id)) {
      failures.push(
        `neural-rare-scalar.${label}-prediction-missing:${id}`
      );
    }
  }
  return predictions;
}

function acceptedTargets(row) {
  const values = row?.acceptableOutputs ?? row?.acceptable ?? row?.expected;
  if (!Array.isArray(values)) return [];
  return [...new Set(
    values
      .filter((value) => typeof value === "string" && value)
      .map((value) => value.normalize("NFC"))
  )];
}

function normalizeInput(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFC")
    .replace(/\s+/gu, " ");
}

function codePointLabel(value) {
  return `U+${value
    .codePointAt(0)
    .toString(16)
    .toUpperCase()
    .padStart(4, "0")}`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
