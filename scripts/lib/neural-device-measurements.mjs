import { validateNeuralComputePlanEvidence } from "./neural-compute-plan-evidence.mjs";
import {
  validateNeuralPostExportMemoryEvidence
} from "./neural-post-export-memory-evidence.mjs";
import { basename } from "node:path";

const legacyKeys = Object.freeze([
  "architecture",
  "artifact",
  "macOS",
  "name",
  "p50Ms",
  "p95Ms",
  "p99Ms",
  "packagedApp",
  "secureFieldInferenceCount"
].sort());
const currentKeys = Object.freeze([
  ...legacyKeys,
  "computePlan",
  "configurationComputeUnits"
].sort());
const fullCandidateKeys = Object.freeze([
  ...currentKeys,
  "measurementKind"
].sort());
const artifactSetCandidateKeys = Object.freeze([
  ...legacyKeys,
  "artifactSetSha256",
  "computePlans",
  "configurationComputeUnits",
  "measurementKind"
].sort());

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isRecord(value) && Object.keys(value).sort().join("\0") === expected.join("\0");
}

function isShortText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 500 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

export function validateNeuralDeviceMeasurements(devices, context) {
  const issues = [];
  const warnings = [];
  const production = context.production === true;
  const summaryMemory = context.memoryEvidence;
  const summaryMemoryValidation =
    production || summaryMemory !== undefined
      ? validateNeuralPostExportMemoryEvidence(summaryMemory)
      : null;
  const architectures = new Set();
  const identities = new Set();
  let neuralEngineCompatibilityIndicated = false;
  let intelFallbackProven = false;

  if (!Array.isArray(devices) || devices.length === 0 || devices.length > 32) {
    issues.push("neural-device-measurements.devices-invalid");
    return result();
  }

  if (summaryMemoryValidation && !summaryMemoryValidation.valid) {
    issues.push(...summaryMemoryValidation.issueCodes.map((issue) =>
      `${issue}:summary`
    ));
  }

  for (const [index, device] of devices.entries()) {
    const label = isRecord(device) && isShortText(device.name) ? device.name : `device-${index}`;
    const hasComputePlan = isRecord(device?.computePlan);
    const hasComputePlans = isRecord(device?.computePlans);
    const fullCandidateMeasurement = device?.measurementKind === "full-candidate-generation";
    const baseExpectedKeys = hasComputePlans
      ? artifactSetCandidateKeys
      : fullCandidateMeasurement
      ? fullCandidateKeys
      : hasComputePlan ? currentKeys : legacyKeys;
    const hasMemoryEvidence = Object.hasOwn(device ?? {}, "memory");
    const expectedKeys = hasMemoryEvidence
      ? [...baseExpectedKeys, "memory"].sort()
      : baseExpectedKeys;
    if (!exactKeys(device, expectedKeys)) {
      issues.push(`neural-device-measurements.schema-invalid:${label}`);
      continue;
    }
    if (!isShortText(device.name) || !isShortText(device.macOS) ||
        !["arm64", "x86_64"].includes(device.architecture) || !isShortText(device.artifact)) {
      issues.push(`neural-device-measurements.identity-invalid:${label}`);
      continue;
    }
    const identity = `${device.architecture}\0${device.macOS}\0${device.name}`;
    if (identities.has(identity)) issues.push(`neural-device-measurements.duplicate:${label}`);
    identities.add(identity);
    architectures.add(device.architecture);

    const timings = [device.p50Ms, device.p95Ms, device.p99Ms].map(Number);
    if (timings.some((value) => !Number.isFinite(value) || value < 0 || value >= 50) ||
        timings[0] > timings[1] || timings[1] > timings[2]) {
      issues.push(`neural-device-measurements.latency-invalid:${label}`);
    }
    if (production && !fullCandidateMeasurement) {
      issues.push(`neural-device-measurements.not-full-candidate-generation:${label}`);
    }
    if (device.secureFieldInferenceCount !== 0) {
      issues.push(`neural-device-measurements.secure-field-inference:${label}`);
    }
    if (device.packagedApp !== true) {
      if (production) issues.push(`neural-device-measurements.not-packaged:${label}`);
      else warnings.push(`${label} is not a packaged-app measurement.`);
    }

    if (production && !hasMemoryEvidence) {
      issues.push(`neural-device-measurements.memory-missing:${label}`);
    } else if (hasMemoryEvidence) {
      const memoryValidation =
        validateNeuralPostExportMemoryEvidence(device.memory);
      if (!memoryValidation.valid) {
        issues.push(...memoryValidation.issueCodes.map((issue) =>
          `${issue}:${label}`
        ));
      } else if (
        summaryMemoryValidation?.valid &&
        canonicalJson(device.memory) !== canonicalJson(summaryMemory)
      ) {
        issues.push(`neural-device-measurements.memory-mismatch:${label}`);
      }
    }

    if (!hasComputePlan && !hasComputePlans) {
      if (production) issues.push(`neural-device-measurements.compute-plan-missing:${label}`);
      else warnings.push(`${label} predates compute-plan evidence and cannot support a compute-device claim.`);
      continue;
    }
    if (hasComputePlans) {
      const descriptor = context.artifactDescriptor;
      if (!descriptor ||
          device.artifactSetSha256 !== descriptor.artifactSetSha256 ||
          !/^[a-f0-9]{64}$/u.test(String(device.artifactSetSha256 ?? "")) ||
          device.configurationComputeUnits !== "all") {
        issues.push(`neural-device-measurements.artifact-set-binding-invalid:${label}`);
        continue;
      }
      const artifacts = Array.isArray(descriptor.artifacts)
        ? descriptor.artifacts
        : [];
      const expectedRoles = artifacts.map((artifact) => artifact.role).sort();
      if (expectedRoles.length < 1 ||
          Object.keys(device.computePlans).sort().join("\0") !==
            expectedRoles.join("\0")) {
        issues.push(`neural-device-measurements.compute-plan-inventory-invalid:${label}`);
        continue;
      }
      const roleValidations = [];
      for (const artifact of artifacts) {
        const plan = device.computePlans[artifact.role];
        if (!isRecord(plan) ||
            plan.configurationComputeUnits !== "all" ||
            plan.architecture !== device.architecture ||
            plan.macOS !== device.macOS ||
            basename(String(plan.modelPath ?? "")) !== artifact.bundleName) {
          issues.push(
            `neural-device-measurements.compute-plan-binding-invalid:` +
            `${label}:${artifact.role}`
          );
          continue;
        }
        const computeValidation = validateNeuralComputePlanEvidence(plan, {
          expectedArchitecture: device.architecture,
          expectedModelSha256: artifact.compiledSha256,
          expectedModelBytes: artifact.compiledBytes,
          now: context.now,
          production
        });
        roleValidations.push(computeValidation);
        if (!computeValidation.valid) {
          issues.push(...computeValidation.issueCodes.map((issue) =>
            `${issue}:${label}:${artifact.role}`
          ));
        }
        warnings.push(...computeValidation.warnings.map((warning) =>
          `${label}:${artifact.role}: ${warning}`
        ));
      }
      if (roleValidations.length !== artifacts.length) continue;
      if (device.architecture === "arm64" &&
          roleValidations.every((validation) =>
            validation.neuralEngineCompatibilityIndicated
          )) {
        neuralEngineCompatibilityIndicated = true;
      }
      if (device.architecture === "x86_64" &&
          roleValidations.every((validation) =>
            validation.deterministicFallbackProven
          )) {
        intelFallbackProven = true;
      }
      continue;
    }
    if (device.configurationComputeUnits !== "all" ||
        device.computePlan.configurationComputeUnits !== "all" ||
        device.computePlan.architecture !== device.architecture ||
        device.computePlan.macOS !== device.macOS ||
        device.computePlan.modelPath !== device.artifact) {
      issues.push(`neural-device-measurements.compute-plan-binding-invalid:${label}`);
      continue;
    }
    const computeValidation = validateNeuralComputePlanEvidence(device.computePlan, {
      expectedArchitecture: device.architecture,
      manifest: context.manifest,
      now: context.now,
      production
    });
    if (!computeValidation.valid) {
      issues.push(...computeValidation.issueCodes.map((issue) => `${issue}:${label}`));
    }
    warnings.push(...computeValidation.warnings.map((warning) => `${label}: ${warning}`));
    if (
      device.architecture === "arm64" &&
      computeValidation.neuralEngineCompatibilityIndicated
    ) {
      neuralEngineCompatibilityIndicated = true;
    }
    if (device.architecture === "x86_64" && computeValidation.deterministicFallbackProven) {
      intelFallbackProven = true;
    }
  }

  if (production) {
    if (!architectures.has("arm64")) {
      issues.push("neural-device-measurements.architecture-missing:arm64");
    }
    if (!neuralEngineCompatibilityIndicated) {
      issues.push(
        "neural-device-measurements.neural-engine-compatibility-unproven"
      );
    }
  }

  return result();

  function result() {
    return Object.freeze({
      valid: issues.length === 0,
      issueCodes: Object.freeze([...new Set(issues)].sort()),
      warnings: Object.freeze([...warnings]),
      architectures: Object.freeze([...architectures].sort()),
      neuralEngineCompatibilityIndicated,
      neuralEngineClaimAllowed: false,
      intelFallbackProven,
      production
    });
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}
