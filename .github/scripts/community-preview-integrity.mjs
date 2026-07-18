import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  realpath,
  stat
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";

const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export function normalizePath(path) {
  return path.split(sep).join("/");
}

export async function hashFile(path, algorithm = "sha256") {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function hashBytes(value, algorithm) {
  return createHash(algorithm).update(value).digest("hex");
}

function isPathInside(root, candidate) {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function assertPortableRelativePath(path, description = "archive path") {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    CONTROL_CHARACTER_PATTERN.test(path)
  ) {
    throw new Error(`Unsafe ${description}: ${JSON.stringify(path)}.`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Unsafe ${description}: ${JSON.stringify(path)}.`);
  }
}

function sortRecords(records) {
  records.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return records;
}

export async function inventoryTree(rootPath) {
  const absoluteRoot = resolve(rootPath);
  const rootMetadata = await lstat(absoluteRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("The inventory root must be a real directory, not a symbolic link.");
  }
  const canonicalRoot = await realpath(absoluteRoot);
  const rootName = basename(absoluteRoot);
  assertPortableRelativePath(rootName, "inventory-root name");
  const records = [];
  const normalizedPaths = new Map();

  function registerPath(path) {
    assertPortableRelativePath(path);
    const normalized = path.normalize("NFC");
    const previous = normalizedPaths.get(normalized);
    if (previous) {
      throw new Error(
        `Inventory contains Unicode-normalization-colliding paths: ${JSON.stringify(previous)} and ${JSON.stringify(path)}.`
      );
    }
    normalizedPaths.set(normalized, path);
  }

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));

    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      if (!isPathInside(absoluteRoot, absolutePath)) {
        throw new Error(`Inventory traversal escaped its root at ${JSON.stringify(absolutePath)}.`);
      }
      const path = normalizePath(relative(absoluteRoot, absolutePath));
      registerPath(path);
      const metadata = await lstat(absolutePath);

      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        records.push({ kind: "directory", mode: metadata.mode & 0o777, path });
        await visit(absolutePath);
        continue;
      }

      if (metadata.isFile() && !metadata.isSymbolicLink()) {
        const [sha1, sha256] = await Promise.all([
          hashFile(absolutePath, "sha1"),
          hashFile(absolutePath, "sha256")
        ]);
        records.push({ kind: "file", mode: metadata.mode & 0o777, path, sha1, sha256 });
        continue;
      }

      if (metadata.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        if (
          isAbsolute(target) ||
          target.includes("\\") ||
          CONTROL_CHARACTER_PATTERN.test(target)
        ) {
          throw new Error(`Unsafe symbolic link ${JSON.stringify(path)} -> ${JSON.stringify(target)}.`);
        }
        const lexicalTarget = resolve(dirname(absolutePath), target);
        if (!isPathInside(absoluteRoot, lexicalTarget)) {
          throw new Error(`Symbolic link escapes inventory root: ${JSON.stringify(path)} -> ${JSON.stringify(target)}.`);
        }
        let canonicalTarget;
        try {
          canonicalTarget = await realpath(absolutePath);
        } catch {
          throw new Error(`Symbolic link is dangling or cyclic: ${JSON.stringify(path)} -> ${JSON.stringify(target)}.`);
        }
        if (!isPathInside(canonicalRoot, canonicalTarget)) {
          throw new Error(`Symbolic link resolves outside inventory root: ${JSON.stringify(path)} -> ${JSON.stringify(target)}.`);
        }
        const bytes = Buffer.from(target, "utf8");
        records.push({
          kind: "symlink",
          mode: metadata.mode & 0o777,
          path,
          sha1: hashBytes(bytes, "sha1"),
          sha256: hashBytes(bytes, "sha256"),
          target
        });
        continue;
      }

      throw new Error(`Unsupported inventory entry ${JSON.stringify(path)} (mode ${metadata.mode.toString(8)}).`);
    }
  }

  await visit(absoluteRoot);
  const contentRecords = records.filter(({ kind }) => kind !== "directory");
  if (contentRecords.length === 0) {
    throw new Error("The preview inventory is empty; refusing to continue.");
  }
  return { records: sortRecords(records), rootName };
}

function comparableRecord(record) {
  if (record.kind === "directory") return { kind: record.kind, path: record.path };
  if (record.kind === "symlink") {
    return {
      kind: record.kind,
      path: record.path,
      sha1: record.sha1,
      sha256: record.sha256,
      target: record.target
    };
  }
  return { kind: record.kind, path: record.path, sha1: record.sha1, sha256: record.sha256 };
}

export function assertInventoriesEqual(expected, actual) {
  if (expected.rootName !== actual.rootName) {
    throw new Error(
      `Distribution root name changed during archiving: ${JSON.stringify(expected.rootName)} != ${JSON.stringify(actual.rootName)}.`
    );
  }
  const expectedRecords = expected.records.map(comparableRecord);
  const actualRecords = actual.records.map(comparableRecord);
  if (JSON.stringify(expectedRecords) !== JSON.stringify(actualRecords)) {
    const expectedMap = new Map(expectedRecords.map((record) => [record.path, record]));
    const actualMap = new Map(actualRecords.map((record) => [record.path, record]));
    const issues = [];
    for (const [path, record] of expectedMap) {
      const observed = actualMap.get(path);
      if (!observed) issues.push(`missing ${path}`);
      else if (JSON.stringify(record) !== JSON.stringify(observed)) issues.push(`changed ${path}`);
    }
    for (const path of actualMap.keys()) {
      if (!expectedMap.has(path)) issues.push(`unlisted ${path}`);
    }
    throw new Error(`Closed-world archive inventory mismatch: ${issues.join(", ") || "record ordering changed"}.`);
  }
}

export function packageVerificationCode(records) {
  const hashes = records
    .filter(({ kind }) => kind !== "directory")
    .map(({ sha1 }) => sha1)
    .sort()
    .join("");
  return createHash("sha1").update(hashes, "utf8").digest("hex");
}

function checksumsByAlgorithm(checksums) {
  if (!Array.isArray(checksums)) return new Map();
  return new Map(checksums.map(({ algorithm, checksumValue }) => [algorithm, checksumValue]));
}

function requireExactSet(actual, expected, description) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (
    actualSet.size !== actual.length ||
    expectedSet.size !== expected.length ||
    actualSet.size !== expectedSet.size ||
    [...expectedSet].some((value) => !actualSet.has(value))
  ) {
    throw new Error(`${description} is not a closed-world match.`);
  }
}

export async function verifyCommunityPreviewSbom({
  artifactPath,
  inventoryRootPath,
  sbomPath,
  expectedBuildNumber = null
}) {
  const absoluteArtifactPath = resolve(artifactPath);
  const artifactMetadata = await stat(absoluteArtifactPath);
  if (!artifactMetadata.isFile() || artifactMetadata.size === 0) {
    throw new Error("The attestation subject must be a non-empty regular file.");
  }
  const [artifactSha256, inventory, document] = await Promise.all([
    hashFile(absoluteArtifactPath, "sha256"),
    inventoryTree(inventoryRootPath),
    readFile(resolve(sbomPath), "utf8").then(JSON.parse)
  ]);

  if (document?.spdxVersion !== "SPDX-2.3" || document?.SPDXID !== "SPDXRef-DOCUMENT") {
    throw new Error("SBOM is not the expected SPDX 2.3 document.");
  }
  if (!Array.isArray(document.packages) || document.packages.length !== 1) {
    throw new Error("SBOM must describe exactly one distribution package.");
  }
  const describedPackage = document.packages[0];
  if (
    !Array.isArray(document.documentDescribes) ||
    document.documentDescribes.length !== 1 ||
    document.documentDescribes[0] !== describedPackage.SPDXID
  ) {
    throw new Error("SBOM documentDescribes must bind exactly the distribution package.");
  }
  if (describedPackage.packageFileName !== basename(absoluteArtifactPath)) {
    throw new Error("SBOM packageFileName does not name the attestation subject.");
  }
  const packageChecksums = checksumsByAlgorithm(describedPackage.checksums);
  if (packageChecksums.size !== 1 || packageChecksums.get("SHA256") !== artifactSha256) {
    throw new Error("SBOM package SHA-256 does not match the attestation subject.");
  }
  if (
    typeof document.documentNamespace !== "string" ||
    !document.documentNamespace.endsWith(`/${artifactSha256}`)
  ) {
    throw new Error("SBOM namespace is not bound to the attestation subject digest.");
  }
  if (
    expectedBuildNumber !== null &&
    describedPackage.versionInfo !== `${describedPackage.versionInfo?.split("+build.")[0]}+build.${expectedBuildNumber}`
  ) {
    throw new Error("SBOM versionInfo is not bound to the expected macOS build number.");
  }
  if (describedPackage.filesAnalyzed !== true || describedPackage.licenseDeclared !== "NOASSERTION") {
    throw new Error("SBOM package analysis/license policy is invalid.");
  }

  const contentRecords = inventory.records.filter(({ kind }) => kind !== "directory");
  if (!Array.isArray(document.files) || document.files.length !== contentRecords.length) {
    throw new Error("SBOM file count does not match the extracted distribution.");
  }
  const expectedFiles = new Map(
    contentRecords.map((record) => [`./${inventory.rootName}/${record.path}`, record])
  );
  const observedFileNames = [];
  const observedSpdxIds = [];
  for (const file of document.files) {
    const expected = expectedFiles.get(file.fileName);
    if (!expected) throw new Error(`SBOM contains an unlisted file: ${JSON.stringify(file.fileName)}.`);
    const checksums = checksumsByAlgorithm(file.checksums);
    if (
      checksums.size !== 2 ||
      !SHA1_PATTERN.test(checksums.get("SHA1") ?? "") ||
      !SHA256_PATTERN.test(checksums.get("SHA256") ?? "") ||
      checksums.get("SHA1") !== expected.sha1 ||
      checksums.get("SHA256") !== expected.sha256
    ) {
      throw new Error(`SBOM checksum mismatch for ${JSON.stringify(file.fileName)}.`);
    }
    if (expected.kind === "symlink") {
      if (!Array.isArray(file.fileTypes) || file.fileTypes.length !== 1 || file.fileTypes[0] !== "OTHER") {
        throw new Error(`SBOM symbolic-link type is missing for ${JSON.stringify(file.fileName)}.`);
      }
      if (file.comment !== `Symbolic link target: ${expected.target}`) {
        throw new Error(`SBOM symbolic-link target mismatch for ${JSON.stringify(file.fileName)}.`);
      }
    }
    observedFileNames.push(file.fileName);
    observedSpdxIds.push(file.SPDXID);
  }
  requireExactSet(observedFileNames, [...expectedFiles.keys()], "SBOM file inventory");
  if (new Set(observedSpdxIds).size !== observedSpdxIds.length) {
    throw new Error("SBOM file SPDX identifiers are not unique.");
  }

  const expectedVerificationCode = packageVerificationCode(contentRecords);
  if (describedPackage.packageVerificationCode?.packageVerificationCodeValue !== expectedVerificationCode) {
    throw new Error("SBOM package verification code does not match the extracted distribution.");
  }
  const expectedRelationships = [
    `SPDXRef-DOCUMENT\u0000DESCRIBES\u0000${describedPackage.SPDXID}`,
    ...observedSpdxIds.map(
      (id) => `${describedPackage.SPDXID}\u0000CONTAINS\u0000${id}`
    )
  ];
  const observedRelationships = Array.isArray(document.relationships)
    ? document.relationships.map(
      ({ spdxElementId, relationshipType, relatedSpdxElement }) =>
        `${spdxElementId}\u0000${relationshipType}\u0000${relatedSpdxElement}`
    )
    : [];
  requireExactSet(observedRelationships, expectedRelationships, "SBOM relationships");

  return {
    artifactSha256,
    fileCount: contentRecords.length,
    packageVerificationCode: expectedVerificationCode,
    versionInfo: describedPackage.versionInfo
  };
}

export function validateArchiveEntryNames(entries, expectedRoot) {
  assertPortableRelativePath(expectedRoot, "expected archive-root name");
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Archive entry list is empty.");
  }
  const seen = new Map();
  let fileEntryCount = 0;
  for (const rawEntry of entries) {
    if (typeof rawEntry !== "string" || rawEntry.length === 0) {
      throw new Error("Archive contains an empty entry name.");
    }
    const directory = rawEntry.endsWith("/");
    const entry = directory ? rawEntry.slice(0, -1) : rawEntry;
    assertPortableRelativePath(entry, "archive entry");
    if (entry !== expectedRoot && !entry.startsWith(`${expectedRoot}/`)) {
      throw new Error(`Archive entry is outside the expected distribution root: ${JSON.stringify(rawEntry)}.`);
    }
    const normalized = entry.normalize("NFC");
    const previous = seen.get(normalized);
    if (previous) {
      throw new Error(`Archive contains duplicate or normalization-colliding entries: ${JSON.stringify(previous)} and ${JSON.stringify(rawEntry)}.`);
    }
    seen.set(normalized, rawEntry);
    if (!directory) fileEntryCount += 1;
  }
  if (fileEntryCount === 0) throw new Error("Archive contains no regular content entries.");
  return { entryCount: entries.length, fileEntryCount };
}
