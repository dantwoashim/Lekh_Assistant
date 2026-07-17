const sha256Pattern = /^[a-f0-9]{64}$/u;
const manualEvidenceKeys = Object.freeze([
  "actual", "app", "architecture", "artifacts", "bundleIdentity", "case", "expected",
  "generatedAt", "inputSource", "logPaths", "macOSVersion", "pass", "provenance",
  "schemaVersion", "steps", "suite", "target"
].sort());
const manualBundleIdentityKeys = Object.freeze([
  "buildProvenanceSha256", "buildVersion", "bundleIdentifier", "codeDirectoryHash",
  "connectionName", "executableSha256", "shortVersion", "sourceRevision", "sourceTree"
].sort());
const manualProvenanceKeys = Object.freeze([
  "gitRevision", "installedBuildProvenanceSha256", "installedBuildVersion",
  "installedExecutableSha256", "installedSourceRevision", "installedSourceTree",
  "schemaVersion", "worktreeClean"
].sort());
const manualStepKeys = Object.freeze(["action", "actual", "expected", "pass"].sort());
const manualArtifactKeys = Object.freeze(["kind", "path", "sha256"].sort());
const securePassedSchema = Object.freeze({
  report: [
    "generatedAt", "command", "suite", "durationMs", "hostFramework", "hostControl",
    "appBundle", "bundleIdentity", "automation", "runtime", "artifactProvenance",
    "evidenceProvenance", "recovery", "failures", "cleanup", "privacy", "host",
    "secureInput", "assertions", "runtimeEpoch", "status"
  ],
  bundleIdentity: [
    "bundlePath", "executablePath", "bundleIdentifier", "shortVersion", "buildVersion",
    "connectionName", "executableSha256", "codeDirectoryHash", "architecture", "macOS"
  ],
  automation: [
    "status", "eligible", "accessibilityTrusted", "eventPostAccess", "eventListenAccess",
    "eventListenAccessRequired", "stderr"
  ],
  runtime: [
    "exactInstalledRuntimeVerified", "issues", "processIdentifier", "bundleVersionMatches",
    "executablePathMatches"
  ],
  evidenceProvenance: [
    "schemaVersion", "gitRevision", "sourceFilesClean", "sourceStatusReadable", "sources"
  ],
  recovery: ["startup", "guardian"],
  recoveryStartup: ["status", "cleanupEvidence"],
  recoveryGuardian: ["status", "disposition", "processIdentifier", "exitCode", "signal"],
  cleanup: [
    "hostTerminated", "inputSourceRestored", "preferencesRestored",
    "secureInputReturnedToBaseline", "temporaryHostRemoved"
  ],
  privacy: [
    "rawPayloadIncluded", "candidateTextIncluded", "databaseRowsIncluded",
    "databaseDigestIncluded", "logLinesIncluded", "secureAXValueRead", "eventTapInstalled",
    "syntheticCanaryAbsentFromSerializedReport"
  ],
  host: ["bundleIdentifier", "freshProcessVerified", "calibrationDelivered", "expectedUTF16Length"],
  secureInput: [
    "baselineEnabled", "enabledDuringFocusedEntry", "causalFalseToTrueTransition",
    "sourceIdentifierDuringSecureEntry", "sourceWasASCIICapable", "sourceWasEnabled",
    "sourceCategory", "sourceType", "sourceCategoryValid", "sourceTypeValid",
    "sourceStableThroughEntry", "sourceSampleCount", "liveControllerCallbackAttributed",
    "controllerAttributionNote", "protectionPath", "osInputSourceSubstitutionObserved"
  ],
  assertions: [
    "rawHostResultMatched", "secureInputRouteObserved", "secureInputRouteStable",
    "noMarkedText", "noVisibleLekhCandidateOrGhostSurface", "personalizationPreferenceRequested",
    "database", "writerDrainStable", "runtimeGhostEvidenceUnchanged",
    "runtimeHealthFileUnchanged", "unifiedLog", "metricLog"
  ],
  database: [
    "ready", "rowCountDelta", "frequencyDelta", "lastUsedEqual", "canonicalDigestEqual", "equal"
  ],
  unifiedLog: [
    "reliable", "eventCount", "malformedEventCount", "summaryRecordCount",
    "surfaceEventCount", "syntheticInputMentioned"
  ],
  metricLog: [
    "reliable", "appendedLineCount", "appendedByteCount", "appendedPayloadContainsSyntheticInput"
  ],
  runtimeEpoch: [
    "originalProcessIdentifier", "executablePathPinned", "processStartTokenPinned", "stable", "checkpoints"
  ],
  runtimeCheckpoint: ["step", "verified", "issueCodes"]
});
const artifactKinds = new Set(["screenshot", "video", "log", "json", "text"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isRecord(value) && Object.keys(value).sort().join("\0") === expected.join("\0");
}

function nonemptyString(value, maximumLength = 16_384) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength &&
    !/[\u0000]/u.test(value);
}

function validTimestamp(value) {
  if (!nonemptyString(value, 128)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && milliseconds <= Date.now() + 5 * 60_000;
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function secureFieldHostEvidenceHasClosedSchema(report) {
  if (
    !exactKeys(report, [...securePassedSchema.report].sort()) ||
    !exactKeys(report.bundleIdentity, [...securePassedSchema.bundleIdentity].sort()) ||
    !exactKeys(report.automation, [...securePassedSchema.automation].sort()) ||
    !exactKeys(report.runtime, [...securePassedSchema.runtime].sort()) ||
    !exactKeys(report.evidenceProvenance, [...securePassedSchema.evidenceProvenance].sort()) ||
    !exactKeys(report.recovery, [...securePassedSchema.recovery].sort()) ||
    !exactKeys(report.recovery.startup, [...securePassedSchema.recoveryStartup].sort()) ||
    !exactKeys(report.recovery.guardian, [...securePassedSchema.recoveryGuardian].sort()) ||
    !exactKeys(report.cleanup, [...securePassedSchema.cleanup].sort()) ||
    !exactKeys(report.privacy, [...securePassedSchema.privacy].sort()) ||
    !exactKeys(report.host, [...securePassedSchema.host].sort()) ||
    !exactKeys(report.secureInput, [...securePassedSchema.secureInput].sort()) ||
    !exactKeys(report.assertions, [...securePassedSchema.assertions].sort()) ||
    !exactKeys(report.assertions.database, [...securePassedSchema.database].sort()) ||
    !exactKeys(report.assertions.unifiedLog, [...securePassedSchema.unifiedLog].sort()) ||
    !exactKeys(report.assertions.metricLog, [...securePassedSchema.metricLog].sort()) ||
    !exactKeys(report.runtimeEpoch, [...securePassedSchema.runtimeEpoch].sort()) ||
    !Array.isArray(report.runtimeEpoch.checkpoints) ||
    !report.runtimeEpoch.checkpoints.every((checkpoint) =>
      exactKeys(checkpoint, [...securePassedSchema.runtimeCheckpoint].sort())
    )
  ) return false;
  return report.recovery.startup.cleanupEvidence === null ||
    exactKeys(report.recovery.startup.cleanupEvidence, [...securePassedSchema.cleanup].sort());
}

function validateManualEvidence(evidence, {
  target,
  app,
  testCase,
  path,
  sourceRevision,
  sourceTree,
  indexedArtifacts
}) {
  const issues = [];
  if (!exactKeys(evidence, manualEvidenceKeys)) {
    return { valid: false, issueCodes: ["indexed-evidence.manual-schema-invalid"], artifactClaims: [] };
  }
  const expectedPrefix = `reports/qa/macos-imk/${slug(app)}/${slug(testCase)}`;
  if (path !== `${expectedPrefix}.json` && !path.startsWith(`${expectedPrefix}.`)) {
    issues.push("indexed-evidence.manual-path-identity-invalid");
  }
  if (evidence.schemaVersion !== 1 || evidence.suite !== "macos-imk-manual-host-evidence") {
    issues.push("indexed-evidence.manual-identity-invalid");
  }
  if (evidence.target !== target || evidence.app !== app || evidence.case !== testCase) {
    issues.push("indexed-evidence.manual-tuple-mismatch");
  }
  if (!validTimestamp(evidence.generatedAt) || evidence.pass !== true ||
      !nonemptyString(evidence.expected) || !nonemptyString(evidence.actual)) {
    issues.push("indexed-evidence.manual-result-invalid");
  }
  const expectedMajor = /^macOS (\d+) (?:Apple Silicon|Intel)$/u.exec(target)?.[1] ?? "";
  const expectedArchitecture = target.endsWith("Intel") ? "x86_64" : "arm64";
  if (!/^\d+\.\d+(?:\.\d+)?$/u.test(evidence.macOSVersion ?? "") ||
      String(evidence.macOSVersion).split(".")[0] !== expectedMajor ||
      evidence.architecture !== expectedArchitecture ||
      evidence.inputSource !== "com.lekh.inputmethod.LekhKeyboard.Main") {
    issues.push("indexed-evidence.manual-host-identity-invalid");
  }

  const bundle = evidence.bundleIdentity;
  if (!exactKeys(bundle, manualBundleIdentityKeys) ||
      bundle.bundleIdentifier !== "com.lekh.inputmethod.LekhKeyboard" ||
      bundle.connectionName !== "com.lekh.inputmethod.LekhKeyboard_Connection" ||
      !nonemptyString(bundle.shortVersion, 128) || !nonemptyString(bundle.buildVersion, 128) ||
      bundle.sourceRevision !== sourceRevision || bundle.sourceTree !== sourceTree ||
      !sha256Pattern.test(bundle.executableSha256 ?? "") ||
      !/^[a-f0-9]{40,64}$/u.test(bundle.codeDirectoryHash ?? "") ||
      !sha256Pattern.test(bundle.buildProvenanceSha256 ?? "")) {
    issues.push("indexed-evidence.manual-bundle-identity-invalid");
  }

  const provenance = evidence.provenance;
  if (!exactKeys(provenance, manualProvenanceKeys) || provenance.schemaVersion !== 1 ||
      provenance.gitRevision !== sourceRevision || provenance.worktreeClean !== true ||
      provenance.installedSourceRevision !== sourceRevision ||
      provenance.installedSourceTree !== sourceTree ||
      provenance.installedBuildProvenanceSha256 !== bundle?.buildProvenanceSha256 ||
      provenance.installedExecutableSha256 !== bundle?.executableSha256 ||
      provenance.installedBuildVersion !== bundle?.buildVersion) {
    issues.push("indexed-evidence.manual-provenance-invalid");
  }

  if (!Array.isArray(evidence.steps) || evidence.steps.length === 0 || evidence.steps.length > 256 ||
      !evidence.steps.every((step) =>
        exactKeys(step, manualStepKeys) && nonemptyString(step.action) &&
        nonemptyString(step.expected) && nonemptyString(step.actual) && step.pass === true
      )) {
    issues.push("indexed-evidence.manual-steps-invalid");
  }

  const artifactClaims = [];
  const artifactPaths = new Set();
  if (!Array.isArray(evidence.artifacts) || evidence.artifacts.length === 0 || evidence.artifacts.length > 128) {
    issues.push("indexed-evidence.manual-artifacts-invalid");
  } else {
    for (const artifact of evidence.artifacts) {
      if (!exactKeys(artifact, manualArtifactKeys) || !artifactKinds.has(artifact.kind) ||
          typeof artifact.path !== "string" || !artifact.path.startsWith("reports/qa/macos-imk/") ||
          artifact.path === path || !sha256Pattern.test(artifact.sha256 ?? "") ||
          artifactPaths.has(artifact.path)) {
        issues.push("indexed-evidence.manual-artifact-claim-invalid");
        continue;
      }
      artifactPaths.add(artifact.path);
      artifactClaims.push({ path: artifact.path, sha256: artifact.sha256 });
    }
  }
  if (!Array.isArray(evidence.logPaths) || evidence.logPaths.length > 64 ||
      new Set(evidence.logPaths).size !== evidence.logPaths.length ||
      !evidence.logPaths.every((logPath) =>
        evidence.artifacts.some((artifact) => artifact.kind === "log" && artifact.path === logPath)
      )) {
    issues.push("indexed-evidence.manual-log-paths-invalid");
  }
  const indexedClaims = Array.isArray(indexedArtifacts)
    ? indexedArtifacts.map(({ path: artifactPath, sha256 }) => ({ path: artifactPath, sha256 }))
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    : [];
  const reportClaims = artifactClaims
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (JSON.stringify(indexedClaims) !== JSON.stringify(reportClaims)) {
    issues.push("indexed-evidence.manual-artifact-index-mismatch");
  }
  return { valid: issues.length === 0, issueCodes: [...new Set(issues)], artifactClaims };
}

function validateSecureEvidence(evidence, { target, app, testCase, path, sourceRevision, indexedArtifacts }) {
  const issues = [];
  const archivedPrefix = "reports/qa/macos-imk/password-fields/secure-field-no-memory";
  if (!/^macOS (?:13|14|15|26) (?:Apple Silicon|Intel)$/u.test(target ?? "") ||
      app !== "Password Fields" || testCase !== "secure-field-no-memory" ||
      (path !== "reports/macos-imk-host-secure-field.json" &&
        path !== `${archivedPrefix}.json` &&
        !(path.startsWith(`${archivedPrefix}.`) && path.endsWith(".json")))) {
    issues.push("indexed-evidence.secure-tuple-or-path-invalid");
  }
  if (!secureFieldHostEvidenceHasClosedSchema(evidence)) {
    issues.push("indexed-evidence.secure-schema-invalid");
  }
  if (evidence?.status !== "passed" || evidence?.suite !== "macos-imk-host-secure-field" ||
      evidence?.command !== "node scripts/check-macos-imk-host-secure-field.mjs" ||
      evidence?.hostFramework !== "AppKit" || evidence?.hostControl !== "NSSecureTextField" ||
      !validTimestamp(evidence?.generatedAt) || !Array.isArray(evidence?.failures) || evidence.failures.length !== 0) {
    issues.push("indexed-evidence.secure-identity-invalid");
  }
  if (evidence?.evidenceProvenance?.schemaVersion !== 1 ||
      evidence?.evidenceProvenance?.gitRevision !== sourceRevision ||
      evidence?.evidenceProvenance?.sourceFilesClean !== true ||
      evidence?.evidenceProvenance?.sourceStatusReadable !== true) {
    issues.push("indexed-evidence.secure-provenance-invalid");
  }
  if (evidence?.bundleIdentity?.bundleIdentifier !== "com.lekh.inputmethod.LekhKeyboard" ||
      evidence?.bundleIdentity?.connectionName !== "com.lekh.inputmethod.LekhKeyboard_Connection" ||
      String(evidence?.bundleIdentity?.macOS ?? "").split(".")[0] !== /^macOS (\d+)/u.exec(target ?? "")?.[1] ||
      evidence?.bundleIdentity?.architecture !== (target.endsWith("Intel") ? "x86_64" : "arm64") ||
      !sha256Pattern.test(evidence?.bundleIdentity?.executableSha256 ?? "") ||
      !/^[a-f0-9]{40,64}$/u.test(evidence?.bundleIdentity?.codeDirectoryHash ?? "") ||
      evidence?.artifactProvenance?.embeddedSourceRevision !== sourceRevision ||
      evidence?.runtime?.exactInstalledRuntimeVerified !== true ||
      !Array.isArray(evidence?.runtime?.issues) || evidence.runtime.issues.length !== 0) {
    issues.push("indexed-evidence.secure-runtime-identity-invalid");
  }
  const privacy = evidence?.privacy ?? {};
  if ([
    "rawPayloadIncluded", "candidateTextIncluded", "databaseRowsIncluded", "databaseDigestIncluded",
    "logLinesIncluded", "secureAXValueRead", "eventTapInstalled"
  ].some((key) => privacy[key] !== false) || privacy.syntheticCanaryAbsentFromSerializedReport !== true) {
    issues.push("indexed-evidence.secure-privacy-invalid");
  }
  const cleanup = evidence?.cleanup ?? {};
  if ([
    "hostTerminated", "inputSourceRestored", "preferencesRestored",
    "secureInputReturnedToBaseline", "temporaryHostRemoved"
  ].some((key) => cleanup[key] !== true)) {
    issues.push("indexed-evidence.secure-cleanup-invalid");
  }
  if (!Array.isArray(indexedArtifacts) || indexedArtifacts.length !== 0) {
    issues.push("indexed-evidence.secure-artifact-index-invalid");
  }
  return { valid: issues.length === 0, issueCodes: [...new Set(issues)], artifactClaims: [] };
}

export function validateIndexedMacOSHostEvidence(evidence, options) {
  if (!isRecord(evidence)) {
    return { valid: false, issueCodes: ["indexed-evidence.report-invalid"], artifactClaims: [] };
  }
  if (evidence.suite === "macos-imk-manual-host-evidence") {
    if (options.app === "Password Fields" && options.testCase === "secure-field-no-memory") {
      return {
        valid: false,
        issueCodes: ["indexed-evidence.specialized-secure-proof-required"],
        artifactClaims: []
      };
    }
    return validateManualEvidence(evidence, options);
  }
  if (evidence.suite === "macos-imk-host-secure-field") return validateSecureEvidence(evidence, options);
  return { valid: false, issueCodes: ["indexed-evidence.unsupported-suite"], artifactClaims: [] };
}
