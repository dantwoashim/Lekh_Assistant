import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  inspectContainedRegularFile
} from "./neural-artifact-filesystem.mjs";

const COMPARED_SPLITS = Object.freeze(["train", "dev"]);
const MAX_DATASET_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_SPLIT_BYTES = 1024 * 1024 * 1024;
const READ_BUFFER_BYTES = 256 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export const OFFICIAL_BENCHMARK_ISOLATION_POLICY =
  "official-benchmark-inputs-absent-from-train-and-dev-v1";
export const OFFICIAL_BENCHMARK_INPUT_NORMALIZATION =
  "trim lowercase NFC collapse-whitespace";

export function normalizeOfficialBenchmarkInput(value) {
  return typeof value === "string"
    ? value.normalize("NFC").trim().toLocaleLowerCase("en-US")
      .replace(/\s+/gu, " ")
    : "";
}

export function officialBenchmarkInputSha256(rows) {
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(String(row.id));
    hash.update("\0");
    hash.update(normalizeOfficialBenchmarkInput(row.input));
    hash.update("\n");
  }
  return hash.digest("hex");
}

/**
 * Recompute official-benchmark isolation from the exact dataset split bytes.
 *
 * The expected dataset-manifest digest must come from independently verified
 * candidate evidence (for example manifest.sha256.trainingDatasetManifest),
 * never from the export report's own benchmarkIsolation claim.
 */
export function verifyOfficialBenchmarkTrainingIsolation({
  repoRoot,
  datasetManifestPath,
  expectedDatasetManifestSha256,
  officialRows
}) {
  const issues = [];
  const addIssue = (code) => {
    if (!issues.includes(code)) issues.push(code);
  };
  const root = resolve(String(repoRoot ?? ""));
  let datasetManifestEvidence = null;
  let datasetManifest = null;
  let benchmarkInputSha256 = null;
  const officialInputs = new Set();
  const overlaps = new Set();
  const overlapCounts = { train: 0, dev: 0 };
  const comparedSplits = {};

  if (!Array.isArray(officialRows) || officialRows.length === 0) {
    addIssue("official-benchmark-isolation.official-rows-invalid");
  } else {
    const rowIds = new Set();
    for (const row of officialRows) {
      const normalized = normalizeOfficialBenchmarkInput(row?.input);
      if (!isRecord(row) ||
          typeof row.id !== "string" ||
          row.id.length === 0 ||
          rowIds.has(row.id) ||
          normalized.length === 0 ||
          officialInputs.has(normalized)) {
        addIssue("official-benchmark-isolation.official-rows-invalid");
        break;
      }
      rowIds.add(row.id);
      officialInputs.add(normalized);
    }
    if (issues.length === 0) {
      benchmarkInputSha256 =
        officialBenchmarkInputSha256(officialRows);
    }
  }

  try {
    datasetManifestEvidence = inspectContainedRegularFile(
      root,
      datasetManifestPath,
      {
        label: "Official-isolation dataset manifest",
        includeContents: true,
        maxBytes: MAX_DATASET_MANIFEST_BYTES
      }
    );
    datasetManifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        datasetManifestEvidence.contents
      )
    );
  } catch {
    addIssue("official-benchmark-isolation.dataset-manifest-invalid");
  }
  if (
    !SHA256_PATTERN.test(
      String(expectedDatasetManifestSha256 ?? "")
    ) ||
    datasetManifestEvidence?.sha256 !==
      expectedDatasetManifestSha256
  ) {
    addIssue(
      "official-benchmark-isolation.dataset-manifest-identity-invalid"
    );
  }
  if (
    !isRecord(datasetManifest) ||
    datasetManifest.schemaVersion !== 2 ||
    datasetManifest.cleaningPolicy?.normalizeInput !==
      OFFICIAL_BENCHMARK_INPUT_NORMALIZATION ||
    !SHA256_PATTERN.test(
      String(datasetManifest.datasetContentSha256 ?? "")
    ) ||
    !isRecord(datasetManifest.splitFiles) ||
    !isRecord(datasetManifest.sha256) ||
    !isRecord(datasetManifest.bytes) ||
    !isRecord(datasetManifest.counts)
  ) {
    addIssue("official-benchmark-isolation.dataset-contract-invalid");
  }

  if (
    issues.includes(
      "official-benchmark-isolation.dataset-manifest-invalid"
    ) ||
    issues.includes(
      "official-benchmark-isolation.dataset-contract-invalid"
    )
  ) {
    return result();
  }

  for (const split of COMPARED_SPLITS) {
    const recordedPath = datasetManifest.splitFiles[split];
    const expectedSha256 = datasetManifest.sha256[split];
    const expectedBytes = datasetManifest.bytes[split];
    const expectedRows = datasetManifest.counts[split];
    if (
      !canonicalRecordedPath(root, recordedPath) ||
      !SHA256_PATTERN.test(String(expectedSha256 ?? "")) ||
      !Number.isSafeInteger(expectedBytes) ||
      expectedBytes < 1 ||
      expectedBytes > MAX_SPLIT_BYTES ||
      !Number.isSafeInteger(expectedRows) ||
      expectedRows < 1
    ) {
      addIssue(
        `official-benchmark-isolation.split-contract-invalid:${split}`
      );
      continue;
    }

    let fileEvidence;
    try {
      fileEvidence = inspectContainedRegularFile(
        root,
        recordedPath,
        {
          label: `Official-isolation dataset ${split} split`,
          maxBytes: MAX_SPLIT_BYTES
        }
      );
    } catch {
      addIssue(
        `official-benchmark-isolation.split-file-invalid:${split}`
      );
      continue;
    }
    if (
      fileEvidence.sha256 !== expectedSha256 ||
      fileEvidence.bytes !== expectedBytes
    ) {
      addIssue(
        `official-benchmark-isolation.split-identity-invalid:${split}`
      );
      continue;
    }

    let parsed;
    try {
      parsed = inspectSplitRows({
        path: fileEvidence.path,
        split,
        officialInputs
      });
    } catch {
      addIssue(
        `official-benchmark-isolation.split-rows-invalid:${split}`
      );
      continue;
    }
    if (
      parsed.sha256 !== fileEvidence.sha256 ||
      parsed.bytes !== fileEvidence.bytes ||
      parsed.rows !== expectedRows
    ) {
      addIssue(
        `official-benchmark-isolation.split-reinspection-invalid:${split}`
      );
      continue;
    }
    for (const input of parsed.overlaps) overlaps.add(input);
    overlapCounts[split] = parsed.overlaps.size;
    comparedSplits[split] = Object.freeze({
      path: recordedPath,
      sha256: parsed.sha256,
      bytes: parsed.bytes,
      rows: parsed.rows
    });
  }

  if (overlaps.size > 0) {
    addIssue("official-benchmark-isolation.overlap-detected");
  }
  if (Object.keys(comparedSplits).length !== COMPARED_SPLITS.length) {
    addIssue("official-benchmark-isolation.split-evidence-incomplete");
  }
  return result();

  function result() {
    const comparedSplitSha256 =
      Object.keys(comparedSplits).length === COMPARED_SPLITS.length
        ? Object.freeze({
            train: comparedSplits.train.sha256,
            dev: comparedSplits.dev.sha256
          })
        : null;
    const evidence =
      issues.length === 0
        ? deepFreeze({
            policy: OFFICIAL_BENCHMARK_ISOLATION_POLICY,
            benchmarkInputSha256,
            comparedSplitSha256,
            overlappingInputCount: overlaps.size
          })
        : null;
    return deepFreeze({
      valid: issues.length === 0,
      issueCodes: [...issues].sort(compareText),
      normalizationPolicy:
        OFFICIAL_BENCHMARK_INPUT_NORMALIZATION,
      benchmarkInputSha256,
      datasetManifest: datasetManifestEvidence && datasetManifest
        ? {
            path: portable(root, datasetManifestEvidence.path),
            sha256: datasetManifestEvidence.sha256,
            bytes: datasetManifestEvidence.bytes,
            contentSha256: datasetManifest.datasetContentSha256
          }
        : null,
      comparedSplits,
      overlapCounts,
      overlappingInputCount: overlaps.size,
      overlappingInputExamples: [...overlaps]
        .sort(compareText)
        .slice(0, 5),
      evidence
    });
  }
}

function inspectSplitRows({ path, split, officialInputs }) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  const overlaps = new Set();
  let before;
  let bytes = 0;
  let rows = 0;
  let carry = "";
  try {
    before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new TypeError("Dataset split is not a regular file.");
    }
    while (true) {
      const count = readSync(
        descriptor,
        buffer,
        0,
        buffer.length,
        null
      );
      if (count === 0) break;
      const chunk = buffer.subarray(0, count);
      bytes += count;
      if (bytes > MAX_SPLIT_BYTES) {
        throw new RangeError("Dataset split exceeds the byte limit.");
      }
      hash.update(chunk);
      const decoded = carry + decoder.decode(chunk, { stream: true });
      const lines = decoded.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) consume(line);
    }
    carry += decoder.decode();
    if (carry.length > 0) consume(carry);
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameFileVersion(before, after) ||
        BigInt(bytes) !== after.size) {
      throw new Error("Dataset split changed while being read.");
    }
  } finally {
    closeSync(descriptor);
  }
  return {
    bytes,
    rows,
    sha256: hash.digest("hex"),
    overlaps
  };

  function consume(line) {
    if (line.trim().length === 0) return;
    const row = JSON.parse(line);
    const normalized = normalizeOfficialBenchmarkInput(row?.input);
    if (!isRecord(row) ||
        row.split !== split ||
        normalized.length === 0) {
      throw new TypeError("Dataset split contains an invalid row.");
    }
    rows += 1;
    if (officialInputs.has(normalized)) overlaps.add(normalized);
  }
}

function canonicalRecordedPath(root, value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((part) =>
      part.length === 0 || part === "." || part === ".."
    )
  ) {
    return false;
  }
  return portable(root, resolve(root, value)) === value;
}

function sameFileVersion(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function portable(root, path) {
  const child = relative(resolve(root), resolve(path));
  if (
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    return null;
  }
  return child.split(sep).join("/");
}

function isRecord(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
