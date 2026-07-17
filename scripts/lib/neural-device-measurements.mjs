import { validateNeuralComputePlanEvidence } from "./neural-compute-plan-evidence.mjs";

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
  const architectures = new Set();
  const identities = new Set();
  let neuralEngineClaimAllowed = false;
  let intelFallbackProven = false;

  if (!Array.isArray(devices) || devices.length === 0 || devices.length > 32) {
    issues.push("neural-device-measurements.devices-invalid");
    return result();
  }

  for (const [index, device] of devices.entries()) {
    const label = isRecord(device) && isShortText(device.name) ? device.name : `device-${index}`;
    const hasComputePlan = isRecord(device?.computePlan);
    const expectedKeys = hasComputePlan ? currentKeys : legacyKeys;
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
    if (timings.some((value) => !Number.isFinite(value) || value < 0 || value > 3) ||
        timings[0] > timings[1] || timings[1] > timings[2]) {
      issues.push(`neural-device-measurements.latency-invalid:${label}`);
    }
    if (device.secureFieldInferenceCount !== 0) {
      issues.push(`neural-device-measurements.secure-field-inference:${label}`);
    }
    if (device.packagedApp !== true) {
      if (production) issues.push(`neural-device-measurements.not-packaged:${label}`);
      else warnings.push(`${label} is not a packaged-app measurement.`);
    }

    if (!hasComputePlan) {
      if (production) issues.push(`neural-device-measurements.compute-plan-missing:${label}`);
      else warnings.push(`${label} predates compute-plan evidence and cannot support a compute-device claim.`);
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
    if (device.architecture === "arm64" && computeValidation.neuralEngineClaimAllowed) {
      neuralEngineClaimAllowed = true;
    }
    if (device.architecture === "x86_64" && computeValidation.deterministicFallbackProven) {
      intelFallbackProven = true;
    }
  }

  if (production) {
    for (const architecture of ["arm64", "x86_64"]) {
      if (!architectures.has(architecture)) {
        issues.push(`neural-device-measurements.architecture-missing:${architecture}`);
      }
    }
    if (!neuralEngineClaimAllowed) {
      issues.push("neural-device-measurements.neural-engine-plan-unproven");
    }
    if (!intelFallbackProven) {
      issues.push("neural-device-measurements.intel-fallback-unproven");
    }
  }

  return result();

  function result() {
    return Object.freeze({
      valid: issues.length === 0,
      issueCodes: Object.freeze([...new Set(issues)].sort()),
      warnings: Object.freeze([...warnings]),
      architectures: Object.freeze([...architectures].sort()),
      neuralEngineClaimAllowed,
      intelFallbackProven,
      production
    });
  }
}
