const SPLITS = Object.freeze(["train", "dev", "test"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function validateNeuralAuditEvidence({
  datasetManifest,
  datasetManifestPath,
  datasetManifestSha256,
  qualityAudit,
  ctcAudit,
  ctcConfig,
  ctcConfigPath,
  ctcConfigSha256,
  evaluationManifests
}) {
  const failures = [];
  requireRecord(datasetManifest, "Dataset manifest", failures);
  requireRecord(qualityAudit, "Dataset quality audit", failures);
  requireRecord(ctcAudit, "CTC alignment audit", failures);
  requireRecord(ctcConfig, "CTC training config", failures);
  if (failures.length > 0) return Object.freeze({ ok: false, failures });

  requireSha256(datasetManifestSha256, "Dataset manifest SHA-256", failures);
  requireSha256(ctcConfigSha256, "CTC config SHA-256", failures);
  requireEqual(
    qualityAudit.schemaVersion,
    1,
    "Dataset quality audit schemaVersion must be 1.",
    failures
  );
  requireEqual(
    qualityAudit.contentIdentity,
    "lekh-neural-open-vocab-data-quality-audit-v1",
    "Dataset quality audit content identity is unsupported.",
    failures
  );
  requireEqual(
    qualityAudit.status,
    "passed-data-quality-audit-with-observations",
    "Dataset quality audit is not passing.",
    failures
  );
  requireDatasetBinding(
    qualityAudit.dataset,
    {
      datasetManifest,
      datasetManifestPath,
      datasetManifestSha256
    },
    "Dataset quality audit",
    failures
  );
  requireEqual(
    qualityAudit.rowsAudited,
    datasetManifest.totalRows,
    "Dataset quality audit row total is stale.",
    failures
  );
  requireEqual(
    qualityAudit.scope?.activeCTCRepresentationEvidence,
    "data/neural/audits/ctc-transformer-v2-alignment-v1.json",
    "Dataset quality audit does not point to the authoritative CTC representation evidence.",
    failures
  );
  if (
    typeof qualityAudit.scope?.representationWarning !== "string" ||
    !qualityAudit.scope.representationWarning.includes(
      "not Transformer-CTC OOV findings"
    )
  ) {
    failures.push(
      "Dataset quality audit must distinguish historical base-plus-mark warnings from active CTC OOV evidence."
    );
  }
  requireNoErrorFindings(
    qualityAudit.findings,
    "Dataset quality audit",
    failures
  );
  requireSplitArtifacts(
    qualityAudit.artifacts?.splits,
    datasetManifest,
    "Dataset quality audit",
    failures
  );

  requireEqual(
    ctcAudit.schemaVersion,
    1,
    "CTC alignment audit schemaVersion must be 1.",
    failures
  );
  requireEqual(
    ctcAudit.contentIdentity,
    "lekh-neural-ctc-alignment-audit-v1",
    "CTC alignment audit content identity is unsupported.",
    failures
  );
  requireEqual(
    ctcAudit.status,
    "passed-ctc-alignment-audit",
    "CTC alignment audit is not passing.",
    failures
  );
  requireNoErrorFindings(
    ctcAudit.findings,
    "CTC alignment audit",
    failures
  );
  requireDatasetBinding(
    ctcAudit.dataset,
    {
      datasetManifest,
      datasetManifestPath,
      datasetManifestSha256
    },
    "CTC alignment audit",
    failures
  );
  requireEqual(
    ctcAudit.model?.id,
    ctcConfig.modelId,
    "CTC alignment audit model id differs from the active config.",
    failures
  );
  requireEqual(
    ctcAudit.model?.configPath,
    ctcConfigPath,
    "CTC alignment audit config path differs from the active config.",
    failures
  );
  requireEqual(
    ctcAudit.model?.configSha256,
    ctcConfigSha256,
    "CTC alignment audit config SHA-256 is stale.",
    failures
  );
  requireEqual(
    ctcAudit.model?.implementationContractVersion,
    ctcConfig.implementationContractVersion,
    "CTC alignment audit implementation contract is stale.",
    failures
  );
  requireEqual(
    ctcAudit.model?.runtimeModelContract,
    ctcConfig.architecture?.runtimeModelContract,
    "CTC alignment audit runtime contract is stale.",
    failures
  );
  requireEqual(
    ctcAudit.model?.inputTensorLength,
    ctcConfig.decoder?.maxInputGraphemes,
    "CTC alignment audit input tensor length is stale.",
    failures
  );
  requireEqual(
    ctcAudit.model?.inputContentCapacity,
    Number(ctcConfig.decoder?.maxInputGraphemes) - 1,
    "CTC alignment audit input content capacity must reserve EOS.",
    failures
  );
  requireEqual(
    ctcAudit.model?.outputTimeSteps,
    ctcConfig.decoder?.outputTimeSteps,
    "CTC alignment audit output time dimension is stale.",
    failures
  );
  requireEqual(
    ctcAudit.model?.outputTokenization,
    ctcConfig.architecture?.tokenization,
    "CTC alignment audit output tokenization is stale.",
    failures
  );
  requireEqual(
    ctcAudit.model?.outputSequenceValidation,
    ctcConfig.decoder?.outputSequenceValidation,
    "CTC alignment audit sequence validator is stale.",
    failures
  );
  requireSplitArtifacts(
    ctcAudit.artifacts?.splits,
    datasetManifest,
    "CTC alignment audit",
    failures
  );

  for (const split of SPLITS) {
    const state = ctcAudit.splits?.[split];
    if (!isRecord(state)) {
      failures.push(`CTC alignment audit is missing ${split} metrics.`);
      continue;
    }
    requireEqual(
      state.rows,
      datasetManifest.counts?.[split],
      `CTC alignment audit ${split} row count is stale.`,
      failures
    );
    for (const field of [
      "invalidJsonRows",
      "splitMismatchRows",
      "missingPrimaryTargetRows",
      "inputInvalidRows",
      "inputOverCapacityRows",
      "inputUnseenScalarRows",
      "primaryInvalidRows",
      "primaryScalarOverflowRows",
      "primaryAlignmentOverflowRows",
      "primaryUnseenScalarRows",
      "invalidTargetVariants",
      "rowsWithNoRepresentableTarget"
    ]) {
      requireEqual(
        state[field],
        0,
        `CTC alignment audit ${split}.${field} must be zero.`,
        failures
      );
    }
  }

  const references = isRecord(evaluationManifests)
    ? evaluationManifests
    : {};
  for (const [name, reference] of Object.entries(references)) {
    requireSha256(
      reference?.manifestSha256,
      `${name} evaluation manifest SHA-256`,
      failures
    );
    for (const [audit, label] of [
      [qualityAudit, "Dataset quality audit"],
      [ctcAudit, "CTC alignment audit"]
    ]) {
      const observed = audit.artifacts?.evaluationReferences?.[name];
      if (!isRecord(observed)) {
        failures.push(`${label} is missing ${name} evaluation evidence.`);
        continue;
      }
      requireEqual(
        observed.manifestPath,
        reference.manifestPath,
        `${label} ${name} manifest path is stale.`,
        failures
      );
      requireEqual(
        observed.manifestSha256,
        reference.manifestSha256,
        `${label} ${name} manifest SHA-256 is stale.`,
        failures
      );
      requireEqual(
        observed.releaseId,
        reference.manifest?.releaseId ?? null,
        `${label} ${name} release id is stale.`,
        failures
      );
      requireEqual(
        observed.rows,
        reference.rows,
        `${label} ${name} row count is stale.`,
        failures
      );
      if (
        !Array.isArray(observed.suites) ||
        observed.suites.some((suite) => suite.integrityMatches !== true)
      ) {
        failures.push(
          `${label} ${name} does not prove every evaluation suite artifact.`
        );
      }
      requireEvaluationSuites(
        observed.suites,
        reference.manifest?.suites,
        `${label} ${name}`,
        failures
      );
    }
    const metrics = ctcAudit.evaluation?.[name];
    if (!isRecord(metrics)) {
      failures.push(`CTC alignment audit is missing ${name} metrics.`);
      continue;
    }
    requireEqual(
      metrics.rows,
      reference.rows,
      `CTC alignment audit ${name} metric rows are stale.`,
      failures
    );
    requireEqual(
      Number(metrics.positiveRows) + Number(metrics.negativeRows),
      reference.rows,
      `CTC alignment audit ${name} positive/negative rows do not reconcile.`,
      failures
    );
    requireEqual(
      metrics.positiveRowsWithoutTargets,
      0,
      `CTC alignment audit ${name} has positive rows without targets.`,
      failures
    );
    requireEqual(
      metrics.positiveRowsWithNoRepresentableTarget,
      0,
      `CTC alignment audit ${name} has unrepresentable positive rows.`,
      failures
    );
  }

  requireEqual(
    ctcAudit.summary?.datasetRows,
    datasetManifest.totalRows,
    "CTC alignment audit summary row total is stale.",
    failures
  );
  for (const field of [
    "datasetInputIncompatibleRows",
    "datasetInvalidTargetVariants",
    "datasetPrimaryAlignmentOverflowRows",
    "heldOutPrimaryUnseenOutputRows",
    "datasetRowsWithNoRepresentableTarget",
    "evaluationPositiveRowsWithNoRepresentableTarget"
  ]) {
    requireEqual(
      ctcAudit.summary?.[field],
      0,
      `CTC alignment audit summary.${field} must be zero.`,
      failures
    );
  }

  return Object.freeze({
    ok: failures.length === 0,
    failures: Object.freeze(failures)
  });
}

function requireEvaluationSuites(
  observedSuites,
  manifestSuites,
  label,
  failures
) {
  if (!Array.isArray(observedSuites) || !Array.isArray(manifestSuites)) {
    failures.push(`${label} evaluation suite inventory is missing.`);
    return;
  }
  requireEqual(
    observedSuites.length,
    manifestSuites.length,
    `${label} evaluation suite count is stale.`,
    failures
  );
  const observedById = new Map(
    observedSuites.map((suite) => [suite?.id, suite])
  );
  for (const expected of manifestSuites) {
    const observed = observedById.get(expected?.id);
    if (!isRecord(observed)) {
      failures.push(
        `${label} is missing evaluation suite ${expected?.id ?? "<unknown>"}.`
      );
      continue;
    }
    requireEqual(
      observed.path,
      expected.path,
      `${label} suite ${expected.id} path is stale.`,
      failures
    );
    for (const [field, value] of [
      ["rows", expected.rows],
      ["sha256", expected.sha256]
    ]) {
      requireEqual(
        observed.expected?.[field],
        value,
        `${label} suite ${expected.id} expected ${field} is stale.`,
        failures
      );
      requireEqual(
        observed.observed?.[field],
        value,
        `${label} suite ${expected.id} observed ${field} is stale.`,
        failures
      );
    }
    requireEqual(
      observed.observed?.invalidJsonRows,
      0,
      `${label} suite ${expected.id} contains invalid JSON rows.`,
      failures
    );
    requireEqual(
      observed.integrityMatches,
      true,
      `${label} suite ${expected.id} integrity does not match.`,
      failures
    );
  }
}

function requireDatasetBinding(
  observed,
  {
    datasetManifest,
    datasetManifestPath,
    datasetManifestSha256
  },
  label,
  failures
) {
  if (!isRecord(observed)) {
    failures.push(`${label} is missing its dataset binding.`);
    return;
  }
  requireEqual(
    observed.id,
    datasetManifest.datasetId,
    `${label} dataset id is stale.`,
    failures
  );
  requireEqual(
    observed.manifestPath,
    datasetManifestPath,
    `${label} dataset manifest path is stale.`,
    failures
  );
  requireEqual(
    observed.manifestSha256,
    datasetManifestSha256,
    `${label} dataset manifest SHA-256 is stale.`,
    failures
  );
  requireEqual(
    observed.declaredContentSha256,
    datasetManifest.datasetContentSha256,
    `${label} dataset content SHA-256 is stale.`,
    failures
  );
  requireEqual(
    observed.declaredRows,
    datasetManifest.totalRows,
    `${label} declared row total is stale.`,
    failures
  );
  requireDeepEqual(
    observed.declaredCounts,
    datasetManifest.counts,
    `${label} declared split counts are stale.`,
    failures
  );
}

function requireSplitArtifacts(observed, manifest, label, failures) {
  if (!isRecord(observed)) {
    failures.push(`${label} is missing split artifact evidence.`);
    return;
  }
  for (const split of SPLITS) {
    const artifact = observed[split];
    if (!isRecord(artifact)) {
      failures.push(`${label} is missing ${split} artifact evidence.`);
      continue;
    }
    requireEqual(
      artifact.path,
      manifest.splitFiles?.[split],
      `${label} ${split} artifact path is stale.`,
      failures
    );
    for (const [field, expected] of [
      ["bytes", manifest.bytes?.[split]],
      ["rows", manifest.counts?.[split]],
      ["sha256", manifest.sha256?.[split]]
    ]) {
      requireEqual(
        artifact.expected?.[field],
        expected,
        `${label} ${split} expected ${field} is stale.`,
        failures
      );
      requireEqual(
        artifact.observed?.[field],
        expected,
        `${label} ${split} observed ${field} is stale.`,
        failures
      );
    }
    requireEqual(
      artifact.observed?.invalidJsonRows,
      0,
      `${label} ${split} contains invalid JSON rows.`,
      failures
    );
    requireEqual(
      artifact.integrityMatches,
      true,
      `${label} ${split} integrity does not match.`,
      failures
    );
  }
}

function requireNoErrorFindings(findings, label, failures) {
  if (!Array.isArray(findings)) {
    failures.push(`${label} findings must be an array.`);
    return;
  }
  const errors = findings.filter((finding) => finding?.severity === "error");
  if (errors.length > 0) {
    failures.push(
      `${label} contains error findings: ${errors
        .map((finding) => finding.code ?? "<unknown>")
        .join(", ")}`
    );
  }
}

function requireRecord(value, label, failures) {
  if (!isRecord(value)) failures.push(`${label} must be an object.`);
}

function requireSha256(value, label, failures) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    failures.push(`${label} is not a lowercase SHA-256 digest.`);
  }
}

function requireEqual(observed, expected, message, failures) {
  if (observed !== expected) failures.push(message);
}

function requireDeepEqual(observed, expected, message, failures) {
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    failures.push(message);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
