const splitNames = Object.freeze(["train", "dev", "test"]);
const metricUnit = "suite-assertion";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedText(value) {
  return String(value ?? "").normalize("NFC");
}

function normalizedInput(value) {
  return normalizedText(value).trim().toLowerCase().replace(/\s+/gu, " ");
}

function normalizedContext(row) {
  const context = row.previousContext ?? [];
  if (!Array.isArray(context) || context.some((token) => typeof token !== "string")) return null;
  return context.map((token) => normalizedInput(token));
}

function normalizedAcceptableSet(row) {
  const acceptable = row.acceptableOutputs ?? row.acceptable ?? row.expected ?? [];
  if (!Array.isArray(acceptable) || acceptable.some((candidate) => typeof candidate !== "string")) {
    return null;
  }
  return [...new Set(acceptable.map((candidate) => normalizedText(candidate)))].sort();
}

function sameOrderedValues(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function inputContextIdentity(row) {
  const context = normalizedContext(row);
  return context === null ? null : JSON.stringify([normalizedInput(row.input), context]);
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
  const compatibleDuplicateGroups = [];
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
    const inputGroup = goldByNormalizedInput.get(inputIdentity) ?? [];
    inputGroup.push(gold);
    goldByNormalizedInput.set(inputIdentity, inputGroup);
  }

  for (const inputGroup of goldByNormalizedInput.values()) {
    if (inputGroup.length < 2) continue;
    const anchor = inputGroup[0];
    const anchorContext = normalizedContext(anchor);
    const anchorAcceptable = normalizedAcceptableSet(anchor);
    const suiteOwners = new Map();
    let compatible = true;

    for (const row of inputGroup) {
      if (typeof row.suiteId !== "string" || row.suiteId.length === 0) {
        issues.push(`neural-evaluation.gold-input-duplicate-suite-invalid:${anchor.id}:${row.id}`);
        compatible = false;
      } else if (suiteOwners.has(row.suiteId)) {
        issues.push(
          `neural-evaluation.gold-input-duplicate-same-suite:${suiteOwners.get(row.suiteId).id}:${row.id}`
        );
        compatible = false;
      } else {
        suiteOwners.set(row.suiteId, row);
      }
    }

    for (const row of inputGroup.slice(1)) {
      if (!sameOrderedValues(anchorContext, normalizedContext(row))) {
        issues.push(`neural-evaluation.gold-input-duplicate-context-conflict:${anchor.id}:${row.id}`);
        compatible = false;
      }
      if (anchor.split !== row.split) {
        issues.push(`neural-evaluation.gold-input-duplicate-split-conflict:${anchor.id}:${row.id}`);
        compatible = false;
      }
      if (anchor.expectedAction !== row.expectedAction) {
        issues.push(`neural-evaluation.gold-input-duplicate-action-conflict:${anchor.id}:${row.id}`);
        compatible = false;
      }
      if (!sameOrderedValues(anchorAcceptable, normalizedAcceptableSet(row))) {
        issues.push(`neural-evaluation.gold-input-duplicate-target-conflict:${anchor.id}:${row.id}`);
        compatible = false;
      }
    }

    if (compatible) compatibleDuplicateGroups.push(inputGroup);
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

  for (const duplicateGroup of compatibleDuplicateGroups) {
    const anchor = duplicateGroup[0];
    const anchorPrediction = predictionsById.get(anchor.id);
    if (!anchorPrediction) continue;
    for (const row of duplicateGroup.slice(1)) {
      const prediction = predictionsById.get(row.id);
      if (prediction && !sameOrderedValues(anchorPrediction.candidates, prediction.candidates)) {
        issues.push(`neural-evaluation.duplicate-assertion-prediction-divergence:${anchor.id}:${row.id}`);
      }
    }
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
    chat: rows.filter((row) => row.category === "chat-convention"),
    names: rows.filter((row) => row.category === "name"),
    protected: rows.filter((row) => row.expectedAction === "no-neural-candidate"),
    adversarial: rows.filter((row) => row.category === "adversarial-safety")
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
  const inputContextIdentities = new Set(
    rows.map((row) => inputContextIdentity(row) ?? `invalid-context:${row.id}`)
  );

  return Object.freeze({
    split,
    metricUnit,
    rowCount: rows.length,
    suiteAssertionCount: rows.length,
    distinctInputContextCount: inputContextIdentities.size,
    repeatedSuiteAssertionCount: rows.length - inputContextIdentities.size,
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
