import { createHash } from "node:crypto";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeNeuralDatasetContentSha256(manifest) {
  const { generatedAt: _generatedAt, datasetContentSha256: _contentSha256, ...content } = manifest;
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

export function validateNeuralDatasetManifest(manifest) {
  const issues = [];
  if (!isRecord(manifest) || manifest.schemaVersion !== 2 ||
      manifest.contentIdentity !== "sha256-canonical-json-v1" ||
      manifest.datasetId !== "lekh-open-vocab-cleaned-v1") {
    issues.push("neural-dataset-manifest.identity-invalid");
    return result();
  }
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(String(manifest.generatedAt ?? "")) ||
      !/^[a-f0-9]{64}$/u.test(String(manifest.datasetContentSha256 ?? ""))) {
    issues.push("neural-dataset-manifest.metadata-invalid");
  }
  for (const split of ["train", "dev", "test"]) {
    if (!Number.isInteger(manifest.counts?.[split]) || manifest.counts[split] < 1 ||
        !Number.isInteger(manifest.bytes?.[split]) || manifest.bytes[split] < 1 ||
        !/^[a-f0-9]{64}$/u.test(String(manifest.sha256?.[split] ?? ""))) {
      issues.push(`neural-dataset-manifest.split-invalid:${split}`);
    }
  }
  if (manifest.totalRows !== Object.values(manifest.counts ?? {}).reduce((sum, value) => sum + value, 0)) {
    issues.push("neural-dataset-manifest.total-rows-invalid");
  }
  if (!isRecord(manifest.provenance) || !Array.isArray(manifest.provenance.inputs) ||
      !isRecord(manifest.provenance.goldRelease)) {
    issues.push("neural-dataset-manifest.provenance-invalid");
  }
  if (manifest.datasetContentSha256 !== computeNeuralDatasetContentSha256(manifest)) {
    issues.push("neural-dataset-manifest.content-digest-invalid");
  }
  return result();

  function result() {
    return Object.freeze({ valid: issues.length === 0, issueCodes: Object.freeze([...new Set(issues)].sort()) });
  }
}
