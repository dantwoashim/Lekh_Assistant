const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const EXPECTED_SCALAR_CLASSIFICATION = Object.freeze({
  "ऑ": true,
  "ऱ": false,
  "ळ": true,
  "ॠ": false
});
const PROBE_KEYS = Object.freeze([
  "acceptable",
  "id",
  "input",
  "reviewTier",
  "rowHash",
  "sourceIds",
  "split",
  "target"
]);

export function validateNeuralRareScalarContract({
  contract,
  ctcAudit,
  ctcAuditPath,
  ctcAuditSha256,
  datasetManifest,
  datasetManifestPath,
  datasetManifestSha256
}) {
  const failures = [];
  if (!isRecord(contract)) {
    return Object.freeze({
      ok: false,
      failures: Object.freeze([
        "Rare-scalar probe contract must be an object."
      ])
    });
  }
  if (!isRecord(ctcAudit) || !isRecord(datasetManifest)) {
    return Object.freeze({
      ok: false,
      failures: Object.freeze([
        "Rare-scalar validation requires CTC audit and dataset manifest objects."
      ])
    });
  }

  requireEqual(
    contract.schemaVersion,
    1,
    "Rare-scalar probe contract schemaVersion must be 1.",
    failures
  );
  requireEqual(
    contract.contentIdentity,
    "lekh-neural-ctc-rare-output-scalar-probes-v1",
    "Rare-scalar probe contract content identity is unsupported.",
    failures
  );
  requireEqual(
    contract.status,
    "frozen-dataset-derived-diagnostic",
    "Rare-scalar probe contract status is not frozen.",
    failures
  );
  requireEqual(
    contract.dataset?.id,
    datasetManifest.datasetId,
    "Rare-scalar probe contract dataset id is stale.",
    failures
  );
  requireEqual(
    contract.dataset?.manifest,
    datasetManifestPath,
    "Rare-scalar probe contract dataset manifest path is stale.",
    failures
  );
  requireEqual(
    contract.dataset?.manifestSha256,
    datasetManifestSha256,
    "Rare-scalar probe contract dataset manifest SHA-256 is stale.",
    failures
  );
  requireEqual(
    contract.dataset?.contentSha256,
    datasetManifest.datasetContentSha256,
    "Rare-scalar probe contract dataset content SHA-256 is stale.",
    failures
  );
  requireDeepEqual(
    contract.dataset?.splitSha256,
    datasetManifest.sha256,
    "Rare-scalar probe contract split SHA-256 inventory is stale.",
    failures
  );
  requireEqual(
    contract.ctcAudit?.path,
    ctcAuditPath,
    "Rare-scalar probe contract CTC audit path is stale.",
    failures
  );
  requireEqual(
    contract.ctcAudit?.sha256,
    ctcAuditSha256,
    "Rare-scalar probe contract CTC audit SHA-256 is stale.",
    failures
  );
  for (const [value, label] of [
    [datasetManifestSha256, "Dataset manifest SHA-256"],
    [ctcAuditSha256, "CTC audit SHA-256"]
  ]) {
    if (!SHA256_PATTERN.test(String(value ?? ""))) {
      failures.push(`${label} is not a lowercase SHA-256 digest.`);
    }
  }
  requireEqual(
    contract.policy?.maximumTrainOccurrences,
    5,
    "Rare-scalar probe threshold must remain five train occurrences.",
    failures
  );
  requireEqual(
    contract.policy?.exactProbeMatches,
    "diagnostic-only-silver-derived-no-accuracy-claim",
    "Rare-scalar exact probe matches must remain diagnostic only.",
    failures
  );
  requireEqual(
    contract.policy?.nonExemplarSilverScalars,
    "require-zero-unaccepted-top1-emissions-on-locked-gold-and-official-benchmark",
    "Rare non-exemplar scalar emission policy is stale.",
    failures
  );

  const rareVocabulary = (ctcAudit.trainingVocabulary?.output?.tokens ?? [])
    .filter((token) => Number(token?.count) <= 5)
    .map((token) => ({
      scalar: token?.token,
      codePoint: token?.codePoint,
      trainOccurrences: token?.count
    }))
    .sort(compareScalarRecords);
  const auditProbes = Array.isArray(ctcAudit.sparseOutputScalarProbes)
    ? ctcAudit.sparseOutputScalarProbes
    : [];
  const contractScalars = Array.isArray(contract.scalars)
    ? contract.scalars
    : [];
  if (rareVocabulary.length === 0) {
    failures.push("CTC audit does not expose a sparse output vocabulary tail.");
  }
  if (auditProbes.length === 0) {
    failures.push("CTC audit does not retain sparse output scalar probes.");
  }
  if (contractScalars.length === 0) {
    failures.push("Rare-scalar probe contract contains no scalar records.");
  }

  const contractInventory = contractScalars
    .map(({ scalar, codePoint, trainOccurrences }) => ({
      scalar,
      codePoint,
      trainOccurrences
    }))
    .sort(compareScalarRecords);
  requireDeepEqual(
    contractInventory,
    rareVocabulary,
    "Rare-scalar probe contract vocabulary inventory differs from the CTC audit.",
    failures
  );
  const contractProbeProjection = contractScalars
    .map(({ scalar, codePoint, trainOccurrences, probes }) => ({
      scalar,
      codePoint,
      trainOccurrences,
      probes
    }))
    .sort(compareScalarRecords);
  requireDeepEqual(
    contractProbeProjection,
    [...auditProbes].sort(compareScalarRecords),
    "Rare-scalar probes differ from the exact rows retained by the CTC audit.",
    failures
  );

  const seenScalars = new Set();
  const seenProbeIds = new Set();
  for (const record of contractScalars) {
    const scalar = record?.scalar;
    if (
      typeof scalar !== "string" ||
      [...scalar].length !== 1 ||
      seenScalars.has(scalar)
    ) {
      failures.push("Rare-scalar contract contains an invalid or duplicate scalar.");
      continue;
    }
    seenScalars.add(scalar);
    const expectedClassification = EXPECTED_SCALAR_CLASSIFICATION[scalar];
    if (expectedClassification === undefined) {
      failures.push(`Rare-scalar contract contains an unreviewed scalar: ${scalar}`);
      continue;
    }
    requireEqual(
      record.cldrNepaliMainExemplar,
      expectedClassification,
      `Rare scalar ${scalar} CLDR Nepali classification is stale.`,
      failures
    );
    requireEqual(
      record.treatment,
      expectedClassification
        ? "supported-sparse-diagnostic"
        : "non-exemplar-silver-data-risk",
      `Rare scalar ${scalar} production treatment is stale.`,
      failures
    );
    const expectedCodePoint = codePointLabel(scalar);
    requireEqual(
      record.codePoint,
      expectedCodePoint,
      `Rare scalar ${scalar} code point is stale.`,
      failures
    );
    if (
      !Number.isSafeInteger(record.trainOccurrences) ||
      record.trainOccurrences < 1 ||
      record.trainOccurrences > 5
    ) {
      failures.push(`Rare scalar ${scalar} train occurrence count is invalid.`);
    }
    if (!Array.isArray(record.probes) || record.probes.length === 0) {
      failures.push(`Rare scalar ${scalar} has no retained probes.`);
      continue;
    }
    let trainProbeRows = 0;
    for (const probe of record.probes) {
      if (!isRecord(probe)) {
        failures.push(`Rare scalar ${scalar} contains a non-object probe.`);
        continue;
      }
      requireExactKeys(
        probe,
        PROBE_KEYS,
        `Rare scalar ${scalar} probe ${probe.id ?? "<unknown>"}`,
        failures
      );
      if (
        typeof probe.id !== "string" ||
        !probe.id ||
        seenProbeIds.has(probe.id)
      ) {
        failures.push(`Rare scalar ${scalar} contains an invalid or duplicate probe id.`);
      } else {
        seenProbeIds.add(probe.id);
      }
      if (!["train", "dev", "test"].includes(probe.split)) {
        failures.push(`Rare scalar ${scalar} probe ${probe.id} has an invalid split.`);
      }
      if (probe.split === "train") trainProbeRows += 1;
      if (
        typeof probe.input !== "string" ||
        !/^[a-z]+$/u.test(probe.input)
      ) {
        failures.push(`Rare scalar ${scalar} probe ${probe.id} has an invalid input.`);
      }
      if (
        typeof probe.target !== "string" ||
        !probe.target.includes(scalar) ||
        probe.target !== probe.target.normalize("NFC")
      ) {
        failures.push(`Rare scalar ${scalar} probe ${probe.id} has an invalid target.`);
      }
      if (
        !Array.isArray(probe.acceptable) ||
        probe.acceptable.length === 0 ||
        !probe.acceptable.includes(probe.target)
      ) {
        failures.push(`Rare scalar ${scalar} probe ${probe.id} lacks its target in acceptable outputs.`);
      }
      if (!SHA256_PATTERN.test(String(probe.rowHash ?? ""))) {
        failures.push(`Rare scalar ${scalar} probe ${probe.id} has an invalid row hash.`);
      }
      if (
        !Array.isArray(probe.sourceIds) ||
        probe.sourceIds.length === 0 ||
        probe.sourceIds.some((value) => typeof value !== "string" || !value)
      ) {
        failures.push(`Rare scalar ${scalar} probe ${probe.id} has invalid source evidence.`);
      }
      if (
        typeof probe.reviewTier !== "string" ||
        !probe.reviewTier.startsWith("silver-")
      ) {
        failures.push(`Rare scalar ${scalar} probe ${probe.id} must remain visibly silver-derived.`);
      }
    }
    if (trainProbeRows === 0 || trainProbeRows > record.trainOccurrences) {
      failures.push(`Rare scalar ${scalar} train probe coverage is invalid.`);
    }
  }
  requireDeepEqual(
    [...seenScalars].sort(compareText),
    Object.keys(EXPECTED_SCALAR_CLASSIFICATION).sort(compareText),
    "Rare-scalar contract does not cover the reviewed sparse scalar inventory.",
    failures
  );

  return Object.freeze({
    ok: failures.length === 0,
    failures: Object.freeze(failures)
  });
}

function requireExactKeys(value, expected, label, failures) {
  const observed = Object.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  requireDeepEqual(
    observed,
    wanted,
    `${label} fields are not closed and canonical.`,
    failures
  );
}

function requireEqual(observed, expected, message, failures) {
  if (observed !== expected) failures.push(message);
}

function requireDeepEqual(observed, expected, message, failures) {
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    failures.push(message);
  }
}

function codePointLabel(value) {
  return `U+${value
    .codePointAt(0)
    .toString(16)
    .toUpperCase()
    .padStart(4, "0")}`;
}

function compareScalarRecords(left, right) {
  return compareText(String(left?.scalar ?? ""), String(right?.scalar ?? ""));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
