import { extname } from "node:path";
import { TextDecoder } from "node:util";
import {
  inspectContainedDirectoryTree,
  inspectContainedRegularFile
} from "./neural-artifact-filesystem.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DEFAULT_MAX_TRACE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_TRACE_ENTRIES = 32_768;
const DEFAULT_MAX_TRACE_DEPTH = 64;
const DEFAULT_MAX_EXPORT_BYTES = 128 * 1024 * 1024;
const XML_DECLARATION_PATTERN =
  /^<\?xml\s+version=(["'])(?:1\.0|1\.1)\1(?:\s+encoding=(["'])UTF-8\2)?(?:\s+standalone=(["'])(?:yes|no)\3)?\s*\?>/u;
const FORBIDDEN_XML_DECLARATION_PATTERN =
  /<!\s*(?:DOCTYPE|ENTITY)\b/iu;
const INVALID_XML_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u;
const provenanceBrand = new WeakSet();

export class NeuralRuntimeTraceProvenanceError extends Error {
  constructor(message) {
    super(message);
    this.name = "NeuralRuntimeTraceProvenanceError";
  }
}

/**
 * Reopen and identify the exact repository-contained artifacts behind a
 * runtime-placement summary.
 *
 * This intentionally does not interpret xctrace table rows. Without a real,
 * versioned Core ML + Neural Engine export fixture, pretending to derive
 * process/interval/role correlations would merely move the self-attestation
 * into this module. The branded result therefore proves artifact custody and
 * exact byte identity only; production claim validation remains fail-closed.
 */
export function inspectNeuralRuntimeTraceProvenance({
  repoRoot,
  traceDirectory,
  traceExport,
  expectedTraceSha256,
  expectedTraceExportSha256,
  limits = {}
}) {
  assertNonemptyText(repoRoot, "Repository root");
  assertNonemptyText(traceDirectory, "Raw xctrace directory");
  assertNonemptyText(traceExport, "xctrace XML export");
  assertSha256(expectedTraceSha256, "Expected raw trace SHA-256");
  assertSha256(
    expectedTraceExportSha256,
    "Expected trace-export SHA-256"
  );
  if (extname(traceDirectory) !== ".trace") {
    fail("Raw xctrace artifact must be a .trace directory.");
  }
  if (extname(traceExport).toLowerCase() !== ".xml") {
    fail("xctrace export must be an .xml regular file.");
  }

  const trace = inspectContainedDirectoryTree(repoRoot, traceDirectory, {
    label: "Raw xctrace directory",
    maxBytes: boundedLimit(
      limits.maxTraceBytes,
      DEFAULT_MAX_TRACE_BYTES,
      "maxTraceBytes"
    ),
    maxEntries: boundedLimit(
      limits.maxTraceEntries,
      DEFAULT_MAX_TRACE_ENTRIES,
      "maxTraceEntries"
    ),
    maxDepth: boundedLimit(
      limits.maxTraceDepth,
      DEFAULT_MAX_TRACE_DEPTH,
      "maxTraceDepth"
    )
  });
  const traceExportFile = inspectContainedRegularFile(
    repoRoot,
    traceExport,
    {
      label: "xctrace XML export",
      includeContents: true,
      maxBytes: boundedLimit(
        limits.maxExportBytes,
        DEFAULT_MAX_EXPORT_BYTES,
        "maxExportBytes"
      )
    }
  );

  if (trace.sha256 !== expectedTraceSha256) {
    fail(
      "Raw xctrace directory SHA-256 does not match the placement record."
    );
  }
  if (traceExportFile.sha256 !== expectedTraceExportSha256) {
    fail(
      "xctrace XML export SHA-256 does not match the placement record."
    );
  }
  inspectStrictUtf8Xml(traceExportFile.contents);

  const provenance = deepFreeze({
    schemaVersion: 1,
    provenanceKind: "repo-contained-xctrace-artifacts-v1",
    trace: {
      relativePath: trace.relativePath,
      bytes: trace.bytes,
      entries: trace.entries,
      sha256: trace.sha256
    },
    traceExport: {
      relativePath: traceExportFile.relativePath,
      bytes: traceExportFile.bytes,
      sha256: traceExportFile.sha256,
      encoding: "UTF-8",
      unsafeDeclarationsRejected: true
    },
    semanticDerivation: {
      status: "unavailable",
      requirement:
        "versioned-real-xctrace-coreml-neural-engine-export-fixture"
    }
  });
  provenanceBrand.add(provenance);
  return provenance;
}

/**
 * A serialized or hand-constructed object cannot pass this check. The WeakSet
 * brand exists only for objects returned by the safe artifact inspector in
 * this module instance.
 */
export function isNeuralRuntimeTraceProvenance(value) {
  return Boolean(value) &&
    typeof value === "object" &&
    provenanceBrand.has(value);
}

export function matchNeuralRuntimeTraceProvenance(
  value,
  { traceSha256, traceExportSha256 }
) {
  if (!isNeuralRuntimeTraceProvenance(value)) {
    return Object.freeze({
      valid: false,
      issueCode: "neural-runtime-placement.provenance-unverified"
    });
  }
  if (
    value.trace.sha256 !== traceSha256 ||
    value.traceExport.sha256 !== traceExportSha256
  ) {
    return Object.freeze({
      valid: false,
      issueCode: "neural-runtime-placement.provenance-hash-mismatch"
    });
  }
  if (value.semanticDerivation.status !== "verified") {
    return Object.freeze({
      valid: false,
      issueCode:
        "neural-runtime-placement.semantic-correlation-unverified"
    });
  }
  return Object.freeze({ valid: true, issueCode: null });
}

function inspectStrictUtf8Xml(bytes) {
  let xml;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("xctrace XML export is not strict UTF-8.");
  }
  if (
    xml.length === 0 ||
    INVALID_XML_CHARACTER_PATTERN.test(xml) ||
    !XML_DECLARATION_PATTERN.test(xml)
  ) {
    fail(
      "xctrace XML export must be nonempty XML with a UTF-8-compatible " +
      "XML declaration and no invalid XML characters."
    );
  }
  if (FORBIDDEN_XML_DECLARATION_PATTERN.test(xml)) {
    fail("xctrace XML export must not contain DOCTYPE or ENTITY.");
  }
  const afterDeclaration = xml.replace(XML_DECLARATION_PATTERN, "");
  if (!/^\s*<[A-Za-z_][A-Za-z0-9_.:-]*(?:\s|>|\/>)/u.test(
    afterDeclaration
  )) {
    fail("xctrace XML export has no recognizable document element.");
  }
}

function boundedLimit(value, fallback, label) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    fail(`${label} must be a positive safe integer.`);
  }
  return candidate;
}

function assertNonemptyText(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a nonempty string.`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function fail(message) {
  throw new NeuralRuntimeTraceProvenanceError(message);
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}
