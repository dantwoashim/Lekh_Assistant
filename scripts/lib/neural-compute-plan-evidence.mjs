const evidenceKeys = Object.freeze([
  "architecture",
  "availableComputeDevices",
  "configurationComputeUnits",
  "evidenceKind",
  "generatedAt",
  "macOS",
  "modelBytes",
  "modelKinds",
  "modelPath",
  "modelSha256",
  "neuralEngineAvailable",
  "neuralEnginePlanEvidence",
  "neuralEnginePreferredOperationCount",
  "neuralEngineSupportedOperationCount",
  "operationCount",
  "preferredComputeDeviceCounts",
  "recordType",
  "schemaVersion",
  "status",
  "supportedComputeDeviceCounts",
  "usageUnavailableCount"
].sort());
const countKeys = Object.freeze(["cpu", "gpu", "neural-engine", "unknown"].sort());
const allowedModelKinds = Object.freeze(["neural-network", "pipeline", "program"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isRecord(value) && Object.keys(value).sort().join("\0") === expected.join("\0");
}

function sortedUniqueStrings(values, allowed) {
  return Array.isArray(values) && values.length > 0 &&
    values.every((value) => typeof value === "string" && allowed.includes(value)) &&
    new Set(values).size === values.length &&
    JSON.stringify(values) === JSON.stringify([...values].sort());
}

function validCounts(value) {
  return exactKeys(value, countKeys) && Object.values(value).every((count) =>
    Number.isSafeInteger(count) && count >= 0
  );
}

function sumCounts(value) {
  return Object.values(value).reduce((sum, count) => sum + count, 0);
}

function validMacOSVersion(value) {
  if (typeof value !== "string" || !/^\d{2}\.\d+(?:\.\d+)?$/u.test(value)) return false;
  const [major, minor] = value.split(".").map(Number);
  return major > 14 || (major === 14 && minor >= 4);
}

function validDate(value, now) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) && timestamp <= now.getTime() + 5 * 60 * 1000;
}

export function validateNeuralComputePlanEvidence(evidence, context) {
  const issues = [];
  const warnings = [];
  const production = context.production === true;
  const now = context.now ?? new Date();
  let environmentCapabilityLimited = false;

  if (!exactKeys(evidence, evidenceKeys)) {
    issues.push("neural-compute-plan.schema-invalid");
    return result(false, false, false);
  }
  if (evidence.schemaVersion !== 1 ||
      evidence.recordType !== "lekh-neural-compute-plan-evidence" ||
      evidence.status !== "passed" ||
      evidence.evidenceKind !== "coreml-compute-plan-anticipated-device-usage" ||
      evidence.configurationComputeUnits !== "all") {
    issues.push("neural-compute-plan.identity-invalid");
  }
  if (!validDate(evidence.generatedAt, now) || !validMacOSVersion(evidence.macOS)) {
    issues.push("neural-compute-plan.environment-invalid");
  }
  if (evidence.architecture !== context.expectedArchitecture ||
      !["arm64", "x86_64"].includes(evidence.architecture)) {
    issues.push("neural-compute-plan.architecture-invalid");
  }
  const expectedModelSha256 = context.expectedModelSha256 ??
    context.manifest?.sha256?.compiledModel;
  const expectedModelBytes = context.expectedModelBytes ??
    context.manifest?.modelBytes;
  if (typeof evidence.modelPath !== "string" || !evidence.modelPath.endsWith(".mlmodelc") ||
      !/^[a-f0-9]{64}$/u.test(evidence.modelSha256) ||
      evidence.modelSha256 !== expectedModelSha256 ||
      !Number.isSafeInteger(evidence.modelBytes) || evidence.modelBytes <= 0 ||
      evidence.modelBytes !== expectedModelBytes ||
      (context.expectedModelPath !== undefined &&
        evidence.modelPath !== context.expectedModelPath)) {
    issues.push("neural-compute-plan.model-identity-invalid");
  }
  if (!sortedUniqueStrings(
    evidence.availableComputeDevices,
    ["cpu", "gpu", "neural-engine", "unknown"]
  ) || !evidence.availableComputeDevices.includes("cpu") ||
      !sortedUniqueStrings(evidence.modelKinds, allowedModelKinds)) {
    issues.push("neural-compute-plan.devices-invalid");
  }
  if (!validCounts(evidence.preferredComputeDeviceCounts) ||
      !validCounts(evidence.supportedComputeDeviceCounts) ||
      !Number.isSafeInteger(evidence.operationCount) || evidence.operationCount <= 0 ||
      !Number.isSafeInteger(evidence.usageUnavailableCount) || evidence.usageUnavailableCount < 0 ||
      sumCounts(evidence.preferredComputeDeviceCounts) + evidence.usageUnavailableCount !==
        evidence.operationCount ||
      Object.values(evidence.supportedComputeDeviceCounts).some((count) =>
        count > evidence.operationCount
      )) {
    issues.push("neural-compute-plan.counts-invalid");
  }

  const preferredNeural = evidence.preferredComputeDeviceCounts?.["neural-engine"];
  const supportedNeural = evidence.supportedComputeDeviceCounts?.["neural-engine"];
  const neuralAvailable = evidence.availableComputeDevices?.includes("neural-engine") === true;
  if (evidence.neuralEngineAvailable !== neuralAvailable ||
      evidence.neuralEnginePreferredOperationCount !== preferredNeural ||
      evidence.neuralEngineSupportedOperationCount !== supportedNeural ||
      evidence.neuralEnginePlanEvidence !== (neuralAvailable && preferredNeural > 0)) {
    issues.push("neural-compute-plan.neural-summary-invalid");
  }

  let neuralEngineClaimAllowed = false;
  let deterministicFallbackProven = false;
  if (evidence.architecture === "arm64") {
    if (!neuralAvailable) {
      const preferredFallback = (evidence.preferredComputeDeviceCounts?.cpu ?? 0) +
        (evidence.preferredComputeDeviceCounts?.gpu ?? 0);
      if (preferredNeural !== 0 || supportedNeural !== 0 || preferredFallback < 1) {
        issues.push("neural-compute-plan.capability-limited-fallback-invalid");
      } else if (production) {
        issues.push("neural-compute-plan.neural-engine-unavailable");
      } else {
        environmentCapabilityLimited = true;
        warnings.push(
          "This Apple Silicon environment exposes no Neural Engine; the Core ML plan is structurally valid, but it cannot support a Neural Engine claim."
        );
      }
    } else if (supportedNeural < 1) {
      issues.push("neural-compute-plan.model-neural-engine-unsupported");
    } else if (preferredNeural < 1) {
      if (production) issues.push("neural-compute-plan.neural-engine-not-preferred");
      else warnings.push("Core ML supports Neural Engine execution for some operations but currently prefers another device.");
    } else {
      neuralEngineClaimAllowed = true;
    }
  } else if (evidence.architecture === "x86_64") {
    const preferredFallback = (evidence.preferredComputeDeviceCounts?.cpu ?? 0) +
      (evidence.preferredComputeDeviceCounts?.gpu ?? 0);
    if (neuralAvailable || preferredNeural !== 0 || supportedNeural !== 0 || preferredFallback < 1) {
      issues.push("neural-compute-plan.intel-fallback-invalid");
    } else {
      deterministicFallbackProven = true;
    }
  }

  return result(neuralEngineClaimAllowed, deterministicFallbackProven, environmentCapabilityLimited);

  function result(neuralClaim, fallbackProven, capabilityLimited) {
    return Object.freeze({
      valid: issues.length === 0,
      issueCodes: Object.freeze([...new Set(issues)].sort()),
      warnings: Object.freeze([...warnings]),
      neuralEngineClaimAllowed: neuralClaim,
      deterministicFallbackProven: fallbackProven,
      environmentCapabilityLimited: capabilityLimited,
      production
    });
  }
}
