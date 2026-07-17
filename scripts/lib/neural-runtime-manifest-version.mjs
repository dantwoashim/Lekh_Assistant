export const NEURAL_RUNTIME_MANIFEST_SCHEMA_VERSION = 2;
export const NEURAL_RUNTIME_RUN_IDENTIFIER_PATTERN = /^[a-f0-9]{32}$/u;

export function validateNeuralRuntimeManifestVersion(manifest, { production = false } = {}) {
  const failures = [];
  const warnings = [];
  const schemaVersion = manifest?.schemaVersion;

  if (schemaVersion === 1) {
    if (production) {
      failures.push("Production requires neural runtime manifest schemaVersion=2 with bound run identities.");
    } else {
      warnings.push(
        "Legacy neural runtime manifest schemaVersion=1 is accepted only for the checked-in development candidate; regenerate it before production."
      );
    }
    if (manifest?.productionEligible === true) {
      failures.push("Legacy neural runtime manifest schemaVersion=1 can never be productionEligible.");
    }
    if (Object.hasOwn(manifest ?? {}, "trainingRunId") || Object.hasOwn(manifest ?? {}, "exportRunId")) {
      failures.push("Legacy neural runtime manifest schemaVersion=1 must use its exact legacy shape without run identities.");
    }
  } else if (schemaVersion === NEURAL_RUNTIME_MANIFEST_SCHEMA_VERSION) {
    const validRunIdentifiers = [];
    for (const field of ["trainingRunId", "exportRunId"]) {
      const valid = NEURAL_RUNTIME_RUN_IDENTIFIER_PATTERN.test(manifest?.[field] ?? "");
      validRunIdentifiers.push(valid);
      if (!valid) {
        failures.push(`Neural runtime manifest ${field} must be exactly 32 lowercase hexadecimal characters.`);
      }
    }
    if (validRunIdentifiers.every(Boolean) && manifest.trainingRunId === manifest.exportRunId) {
      failures.push("Neural runtime manifest trainingRunId and exportRunId must identify distinct runs.");
    }
  } else {
    failures.push(
      `Neural runtime manifest schemaVersion must be 1 (development compatibility only) or ${NEURAL_RUNTIME_MANIFEST_SCHEMA_VERSION}.`
    );
  }

  return { valid: failures.length === 0, failures, warnings };
}
