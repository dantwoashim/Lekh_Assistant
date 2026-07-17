import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NEURAL_RUNTIME_MANIFEST_SCHEMA_VERSION,
  validateNeuralRuntimeManifestVersion
} from "./neural-runtime-manifest-version.mjs";

const runIdentity = "0123456789abcdef0123456789abcdef";

describe("neural runtime manifest version policy", () => {
  it("accepts the legacy checked-in candidate only as an explicitly warned development artifact", () => {
    const manifest = JSON.parse(readFileSync("models/macos/LekhNeuralTransliterator.manifest.json", "utf8"));
    const result = validateNeuralRuntimeManifestVersion(manifest);

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.productionEligible).toBe(false);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("development candidate");
  });

  it("never accepts a legacy manifest for production", () => {
    const result = validateNeuralRuntimeManifestVersion(
      { schemaVersion: 1, productionEligible: false },
      { production: true }
    );

    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "Production requires neural runtime manifest schemaVersion=2 with bound run identities."
    );
  });

  it("requires two lowercase 32-hex run identities in schema v2", () => {
    const valid = validateNeuralRuntimeManifestVersion({
      schemaVersion: NEURAL_RUNTIME_MANIFEST_SCHEMA_VERSION,
      productionEligible: true,
      trainingRunId: runIdentity,
      exportRunId: "fedcba9876543210fedcba9876543210"
    }, { production: true });
    const uppercase = validateNeuralRuntimeManifestVersion({
      schemaVersion: NEURAL_RUNTIME_MANIFEST_SCHEMA_VERSION,
      productionEligible: false,
      trainingRunId: runIdentity.toUpperCase(),
      exportRunId: runIdentity
    });
    const missing = validateNeuralRuntimeManifestVersion({
      schemaVersion: NEURAL_RUNTIME_MANIFEST_SCHEMA_VERSION,
      productionEligible: false,
      trainingRunId: runIdentity
    });
    const reused = validateNeuralRuntimeManifestVersion({
      schemaVersion: NEURAL_RUNTIME_MANIFEST_SCHEMA_VERSION,
      productionEligible: false,
      trainingRunId: runIdentity,
      exportRunId: runIdentity
    });

    expect(valid).toEqual({ valid: true, failures: [], warnings: [] });
    expect(uppercase.failures).toContain(
      "Neural runtime manifest trainingRunId must be exactly 32 lowercase hexadecimal characters."
    );
    expect(missing.failures).toContain(
      "Neural runtime manifest exportRunId must be exactly 32 lowercase hexadecimal characters."
    );
    expect(reused.failures).toContain(
      "Neural runtime manifest trainingRunId and exportRunId must identify distinct runs."
    );
  });

  it("rejects legacy manifests that claim production or smuggle v2 fields", () => {
    const productionClaim = validateNeuralRuntimeManifestVersion({
      schemaVersion: 1,
      productionEligible: true
    });
    const mixedShape = validateNeuralRuntimeManifestVersion({
      schemaVersion: 1,
      productionEligible: false,
      trainingRunId: runIdentity
    });

    expect(productionClaim.valid).toBe(false);
    expect(productionClaim.failures[0]).toContain("can never be productionEligible");
    expect(mixedShape.valid).toBe(false);
    expect(mixedShape.failures[0]).toContain("exact legacy shape");
  });
});
