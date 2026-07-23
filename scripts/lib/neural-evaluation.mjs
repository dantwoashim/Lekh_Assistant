const splitNames = Object.freeze(["train", "dev", "test"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedText(value) {
  return String(value ?? "").normalize("NFC");
}

function normalizedInput(value) {
  return normalizedText(value).trim().toLowerCase().replace(/\s+/gu, " ");
}

function isModelOutcomeIssue(issue) {
  return issue.startsWith("neural-evaluation.protected-row-produced-candidate:");
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function validateNeuralPredictionRows(predictionRows, goldRows) {
  const issues = [];
  const goldById = new Map();
  const goldByNormalizedInput = new Map();
  const predictionsById = new Map();

  if (!Array.isArray(goldRows) || goldRows.length === 0) {
    issues.push("neural-evaluation.gold-rows-invalid");
    return result();
  }
  if (!Array.isArray(predictionRows) || predictionRows.length === 0) {
    issues.push("neural-evaluation.prediction-rows-invalid");
    return result();
  }

  for (const gold of goldRows) {
    if (!isRecord(gold) || typeof gold.id !== "string" || gold.id.length === 0 ||
        typeof gold.input !== "string" || normalizedInput(gold.input).length === 0) {
      issues.push("neural-evaluation.gold-row-invalid");
      continue;
    }
    if (goldById.has(gold.id)) {
      issues.push(`neural-evaluation.gold-id-duplicate:${gold.id}`);
      continue;
    }
    goldById.set(gold.id, gold);
    const inputIdentity = normalizedInput(gold.input);
    const existingInput = goldByNormalizedInput.get(inputIdentity);
    if (existingInput) {
      issues.push(`neural-evaluation.gold-input-duplicate:${existingInput.id}:${gold.id}`);
    } else {
      goldByNormalizedInput.set(inputIdentity, gold);
    }
  }

  for (const [index, row] of predictionRows.entries()) {
    const label = isRecord(row) && typeof row.id === "string" && row.id.length > 0
      ? row.id
      : `row-${index + 1}`;
    if (!isRecord(row) || Object.keys(row).sort().join("\0") !== "candidates\0id\0input") {
      issues.push(`neural-evaluation.prediction-schema-invalid:${label}`);
      continue;
    }
    if (typeof row.id !== "string" || row.id.length === 0 || row.id.length > 256 ||
        typeof row.input !== "string" || row.input.length === 0 || row.input.length > 512 ||
        !Array.isArray(row.candidates) || row.candidates.length > 8) {
      issues.push(`neural-evaluation.prediction-row-invalid:${label}`);
      continue;
    }
    if (predictionsById.has(row.id)) {
      issues.push(`neural-evaluation.prediction-id-duplicate:${row.id}`);
      continue;
    }
    const gold = goldById.get(row.id);
    if (!gold) {
      issues.push(`neural-evaluation.prediction-id-unknown:${row.id}`);
      continue;
    }
    if (normalizedInput(row.input) !== normalizedInput(gold.input)) {
      issues.push(`neural-evaluation.prediction-input-mismatch:${row.id}`);
    }

    const seenCandidates = new Set();
    for (const candidate of row.candidates) {
      if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 128 ||
          candidate !== normalizedText(candidate) || /[\u0000-\u001f\u007f]/u.test(candidate) ||
          /\s/u.test(candidate) || /[A-Za-z]/u.test(candidate)) {
        issues.push(`neural-evaluation.candidate-invalid:${row.id}`);
        continue;
      }
      if (seenCandidates.has(candidate)) issues.push(`neural-evaluation.candidate-duplicate:${row.id}`);
      seenCandidates.add(candidate);
    }
    if (gold.expectedAction === "no-neural-candidate" && row.candidates.length > 0) {
      issues.push(`neural-evaluation.protected-row-produced-candidate:${row.id}`);
    }
    predictionsById.set(row.id, row);
  }

  for (const id of goldById.keys()) {
    if (!predictionsById.has(id)) issues.push(`neural-evaluation.prediction-id-missing:${id}`);
  }

  return result();

  function result() {
    const issueCodes = [...new Set(issues)].sort();
    const integrityIssues = issueCodes.filter((issue) => !isModelOutcomeIssue(issue));
    return Object.freeze({
      valid: issueCodes.length === 0,
      exactCoverage: integrityIssues.length === 0,
      metricsReportable: integrityIssues.length === 0,
      issueCodes: Object.freeze(issueCodes),
      predictionsById,
      goldById
    });
  }
}

export function evaluateNeuralPredictions(goldRows, predictionValidation, split = "test") {
  if (split !== "all" && !splitNames.includes(split)) {
    throw new TypeError(`Unsupported neural evaluation split: ${split}`);
  }
  if (!isRecord(predictionValidation) || !(predictionValidation.predictionsById instanceof Map) ||
      typeof predictionValidation.metricsReportable !== "boolean") {
    throw new TypeError("Neural metrics require a prediction-validation result.");
  }
  if (!predictionValidation.metricsReportable) return null;
  const { predictionsById } = predictionValidation;
  const rows = split === "all" ? goldRows : goldRows.filter((row) => row.split === split);
  const buckets = {
    tail: rows.filter((row) => row.expectedAction === "produce-candidate"),
    chat: rows.filter((row) => row.suiteId === "chat-convention"),
    names: rows.filter((row) => row.suiteId === "names"),
    protected: rows.filter((row) => row.expectedAction === "no-neural-candidate"),
    adversarial: rows.filter((row) => row.suiteId === "adversarial-safety")
  };

  const top = (bucketRows, count) => {
    if (bucketRows.length === 0) return null;
    let hits = 0;
    for (const row of bucketRows) {
      const acceptable = new Set(row.acceptableOutputs ?? row.acceptable ?? row.expected ?? []);
      const candidates = (predictionsById.get(row.id)?.candidates ?? []).slice(0, count);
      if (candidates.some((candidate) => acceptable.has(candidate))) hits += 1;
    }
    return round(hits / bucketRows.length);
  };
  const rate = (bucketRows, predicate) => bucketRows.length === 0
    ? null
    : round(bucketRows.filter(predicate).length / bucketRows.length);
  const hasForbiddenCandidate = (row) => {
    const forbidden = new Set(row.forbiddenOutputs ?? []);
    return (predictionsById.get(row.id)?.candidates ?? []).some((candidate) => forbidden.has(candidate));
  };
  const hasPhraseCandidate = (row) =>
    (predictionsById.get(row.id)?.candidates ?? []).some((candidate) => /\s/u.test(String(candidate)));
  const producedCandidate = (row) => (predictionsById.get(row.id)?.candidates ?? []).length > 0;

  return Object.freeze({
    split,
    rowCount: rows.length,
    tailTop1Accuracy: top(buckets.tail, 1),
    tailTop3Accuracy: top(buckets.tail, 3),
    chatConventionTop1Accuracy: top(buckets.chat, 1),
    chatConventionTop3Accuracy: top(buckets.chat, 3),
    namesTop3Accuracy: top(buckets.names, 3),
    protectedFalseConversionRate: rate(buckets.protected, producedCandidate),
    singleTokenPhraseExpansionRate: rate(buckets.tail, hasPhraseCandidate),
    forbiddenCandidateRate: rate(rows, hasForbiddenCandidate),
    adversarialForbiddenCandidateRate: rate(buckets.adversarial, hasForbiddenCandidate),
    evaluatedBuckets: Object.freeze(
      Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, value.length]))
    )
  });
}

export function validateNeuralEvaluationSafety(metrics) {
  const issues = [];
  if (metrics.protectedFalseConversionRate !== null && metrics.protectedFalseConversionRate !== 0) {
    issues.push("neural-evaluation.protected-false-conversion");
  }
  if (metrics.singleTokenPhraseExpansionRate !== null && metrics.singleTokenPhraseExpansionRate !== 0) {
    issues.push("neural-evaluation.single-token-phrase-expansion");
  }
  if (metrics.forbiddenCandidateRate !== null && metrics.forbiddenCandidateRate !== 0) {
    issues.push("neural-evaluation.forbidden-candidate");
  }
  if (metrics.adversarialForbiddenCandidateRate !== null && metrics.adversarialForbiddenCandidateRate !== 0) {
    issues.push("neural-evaluation.adversarial-forbidden-candidate");
  }
  return Object.freeze({ valid: issues.length === 0, issueCodes: Object.freeze(issues) });
}
