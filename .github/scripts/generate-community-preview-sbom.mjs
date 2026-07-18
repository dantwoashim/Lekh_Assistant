#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  hashFile,
  inventoryTree,
  packageVerificationCode
} from "./community-preview-integrity.mjs";

const SPDX_VERSION = "SPDX-2.3";
const DATA_LICENSE = "CC0-1.0";
const DOCUMENT_ID = "SPDXRef-DOCUMENT";
const PACKAGE_ID = "SPDXRef-Package-Lekh-Keyboard-Community-Preview";
const VERSION_INFO_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\+build\.[1-9]\d*$/u;

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function createNamespace(repository, revision, artifactSha256) {
  const validRepository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
    ? repository
    : "lekh-keyboard/local-build";
  const validRevision = /^[a-f0-9]{40,64}$/iu.test(revision) ? revision.toLowerCase() : "local";
  return `https://github.com/${validRepository}/attestations/spdx/${validRevision}/${artifactSha256}`;
}

function asSpdxFile(rootName, record) {
  const fileName = `./${rootName}/${record.path}`;
  const file = {
    SPDXID: `SPDXRef-File-${sha256Text(fileName).slice(0, 32)}`,
    fileName,
    checksums: [
      { algorithm: "SHA1", checksumValue: record.sha1 },
      { algorithm: "SHA256", checksumValue: record.sha256 }
    ],
    licenseConcluded: "NOASSERTION",
    copyrightText: "NOASSERTION"
  };
  if (record.kind === "symlink") {
    file.fileTypes = ["OTHER"];
    file.comment = `Symbolic link target: ${record.target}`;
  }
  return file;
}

export async function generateCommunityPreviewSbom({
  artifactPath,
  inventoryRootPath,
  outputPath,
  versionInfo,
  packageJsonPath = resolve("package.json"),
  repository = process.env.GITHUB_REPOSITORY ?? "lekh-keyboard/local-build",
  revision = process.env.GITHUB_SHA ?? "local",
  createdAt = new Date().toISOString()
}) {
  const absoluteArtifactPath = resolve(artifactPath);
  const absoluteInventoryRootPath = resolve(inventoryRootPath);
  const absoluteOutputPath = resolve(outputPath);
  const [artifactMetadata, inventoryMetadata, packageJson] = await Promise.all([
    stat(absoluteArtifactPath),
    stat(absoluteInventoryRootPath),
    readFile(resolve(packageJsonPath), "utf8").then(JSON.parse)
  ]);

  if (!artifactMetadata.isFile() || artifactMetadata.size === 0) {
    throw new Error("The attestation subject must be a non-empty file.");
  }
  if (!inventoryMetadata.isDirectory()) {
    throw new Error("The SBOM inventory root must be a directory.");
  }
  if (typeof packageJson.name !== "string" || packageJson.name.trim() === "") {
    throw new Error("package.json must define a non-empty package name.");
  }
  if (!VERSION_INFO_PATTERN.test(versionInfo ?? "")) {
    throw new Error("versionInfo must bind semantic app version to a positive macOS build number.");
  }

  const [artifactSha256, inventory] = await Promise.all([
    hashFile(absoluteArtifactPath, "sha256"),
    inventoryTree(absoluteInventoryRootPath)
  ]);
  const contentRecords = inventory.records.filter(({ kind }) => kind !== "directory");
  const spdxFiles = contentRecords.map((record) => asSpdxFile(inventory.rootName, record));
  if (new Set(spdxFiles.map(({ SPDXID }) => SPDXID)).size !== spdxFiles.length) {
    throw new Error("Generated SPDX file identifiers collided; refusing to emit an ambiguous inventory.");
  }
  const document = {
    spdxVersion: SPDX_VERSION,
    dataLicense: DATA_LICENSE,
    SPDXID: DOCUMENT_ID,
    name: `${packageJson.name}-${versionInfo}-macos-community-preview`,
    documentNamespace: createNamespace(repository, revision, artifactSha256),
    creationInfo: {
      created: createdAt,
      creators: [
        "Tool: Lekh repository community-preview SBOM generator",
        "Organization: Lekh Keyboard contributors"
      ]
    },
    documentDescribes: [PACKAGE_ID],
    packages: [
      {
        SPDXID: PACKAGE_ID,
        name: "Lekh Keyboard macOS Community Preview",
        versionInfo,
        packageFileName: basename(absoluteArtifactPath),
        supplier: "Organization: Lekh Keyboard contributors",
        downloadLocation: "NOASSERTION",
        filesAnalyzed: true,
        packageVerificationCode: {
          packageVerificationCodeValue: packageVerificationCode(contentRecords)
        },
        checksums: [{ algorithm: "SHA256", checksumValue: artifactSha256 }],
        primaryPackagePurpose: "APPLICATION",
        licenseConcluded: "NOASSERTION",
        licenseDeclared: "NOASSERTION",
        copyrightText: "NOASSERTION",
        comment:
          "Closed-world file inventory for the extracted ad-hoc-signed macOS community-preview distribution. " +
          "License conclusions remain NOASSERTION; consult the bundled LICENSE and THIRD_PARTY_NOTICES files. " +
          "GitHub attestations do not provide Apple Developer ID signing, notarization, or Gatekeeper approval."
      }
    ],
    files: spdxFiles,
    relationships: [
      { spdxElementId: DOCUMENT_ID, relationshipType: "DESCRIBES", relatedSpdxElement: PACKAGE_ID },
      ...spdxFiles.map(({ SPDXID }) => ({
        spdxElementId: PACKAGE_ID,
        relationshipType: "CONTAINS",
        relatedSpdxElement: SPDXID
      }))
    ]
  };

  await mkdir(dirname(absoluteOutputPath), { recursive: true });
  const temporaryOutputPath = `${absoluteOutputPath}.tmp-${process.pid}`;
  await writeFile(temporaryOutputPath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644
  });
  await rename(temporaryOutputPath, absoluteOutputPath);

  return {
    artifactSha256,
    fileCount: contentRecords.length,
    outputPath: absoluteOutputPath,
    packageVerificationCode: document.packages[0].packageVerificationCode.packageVerificationCodeValue,
    versionInfo
  };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (![
      "--artifact",
      "--inventory-root",
      "--output",
      "--version-info"
    ].includes(option) || !value) {
      throw new Error(
        "Usage: generate-community-preview-sbom.mjs --inventory-root PATH --artifact PATH --output PATH --version-info VERSION+build.NUMBER"
      );
    }
    values[option.slice(2)] = value;
  }
  if (!values.artifact || !values["inventory-root"] || !values.output || !values["version-info"]) {
    throw new Error(
      "Usage: generate-community-preview-sbom.mjs --inventory-root PATH --artifact PATH --output PATH --version-info VERSION+build.NUMBER"
    );
  }
  return values;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await generateCommunityPreviewSbom({
      artifactPath: options.artifact,
      inventoryRootPath: options["inventory-root"],
      outputPath: options.output,
      versionInfo: options["version-info"]
    });
    process.stdout.write(`${JSON.stringify({ status: "passed", ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
