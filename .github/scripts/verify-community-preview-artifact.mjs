#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertInventoriesEqual,
  inventoryTree,
  verifyCommunityPreviewSbom
} from "./community-preview-integrity.mjs";

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (![
      "--artifact",
      "--expected-build-number",
      "--inventory-root",
      "--sbom",
      "--source-root"
    ].includes(option) || !value) {
      throw new Error(
        "Usage: verify-community-preview-artifact.mjs --artifact PATH --inventory-root PATH --sbom PATH --expected-build-number NUMBER [--source-root PATH]"
      );
    }
    values[option.slice(2)] = value;
  }
  if (
    !values.artifact ||
    !values["inventory-root"] ||
    !values.sbom ||
    !/^[1-9]\d*$/u.test(values["expected-build-number"] ?? "")
  ) {
    throw new Error(
      "Usage: verify-community-preview-artifact.mjs --artifact PATH --inventory-root PATH --sbom PATH --expected-build-number NUMBER [--source-root PATH]"
    );
  }
  return values;
}

export async function verifyCommunityPreviewArtifact({
  artifactPath,
  expectedBuildNumber,
  inventoryRootPath,
  sbomPath,
  sourceRootPath = null
}) {
  if (sourceRootPath) {
    const [sourceInventory, extractedInventory] = await Promise.all([
      inventoryTree(sourceRootPath),
      inventoryTree(inventoryRootPath)
    ]);
    assertInventoriesEqual(sourceInventory, extractedInventory);
  }
  return verifyCommunityPreviewSbom({
    artifactPath,
    expectedBuildNumber,
    inventoryRootPath,
    sbomPath
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await verifyCommunityPreviewArtifact({
      artifactPath: options.artifact,
      expectedBuildNumber: options["expected-build-number"],
      inventoryRootPath: options["inventory-root"],
      sbomPath: options.sbom,
      sourceRootPath: options["source-root"] ?? null
    });
    process.stdout.write(`${JSON.stringify({ status: "passed", ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
