import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DIRECTORY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 4_096;
const DEFAULT_MAX_DIRECTORY_DEPTH = 64;
const READ_BUFFER_BYTES = 64 * 1024;

export class NeuralArtifactFilesystemError extends Error {
  constructor(message) {
    super(message);
    this.name = "NeuralArtifactFilesystemError";
  }
}

export function inspectContainedRegularFile(repoRoot, artifactPath, options = {}) {
  const label = options.label ?? "Artifact";
  const maxBytes = boundedInteger(options.maxBytes, DEFAULT_MAX_FILE_BYTES, "maxBytes");
  const location = containedLocation(repoRoot, artifactPath, label);
  assertNoSymlinkComponents(location, label, false);
  const before = lstat(location.lexicalPath, label);
  if (before.isSymbolicLink()) fail(`${label} must not be a symbolic link: ${location.displayPath}.`);
  if (!before.isFile()) fail(`${label} must be a regular file: ${location.displayPath}.`);
  if (before.nlink !== 1n) {
    fail(`${label} must not be hard-linked: ${location.displayPath}.`);
  }
  if (before.size > BigInt(maxBytes)) {
    fail(`${label} exceeds the ${maxBytes}-byte verification limit: ${location.displayPath}.`);
  }
  const realPath = realpath(location.lexicalPath, label);
  assertContained(location.realRoot, realPath, `${label} resolves outside the repository root`);

  const opened = readRegularFile(
    {
      ...location,
      expectedRealPath: realPath
    },
    before,
    maxBytes,
    Boolean(options.includeContents),
    label
  );
  return Object.freeze({
    path: location.lexicalPath,
    realPath,
    relativePath: portableRelative(location.realRoot, realPath),
    bytes: opened.bytes,
    sha256: opened.sha256,
    contents: opened.contents
  });
}

export function inspectContainedDirectoryTree(repoRoot, artifactPath, options = {}) {
  const label = options.label ?? "Artifact directory";
  const maxBytes = boundedInteger(options.maxBytes, DEFAULT_MAX_DIRECTORY_BYTES, "maxBytes");
  const maxEntries = boundedInteger(options.maxEntries, DEFAULT_MAX_DIRECTORY_ENTRIES, "maxEntries");
  const maxDepth = boundedInteger(options.maxDepth, DEFAULT_MAX_DIRECTORY_DEPTH, "maxDepth");
  const location = containedLocation(repoRoot, artifactPath, label);
  assertNoSymlinkComponents(location, label, false);
  const rootStat = lstat(location.lexicalPath, label);
  if (rootStat.isSymbolicLink()) fail(`${label} must not be a symbolic link: ${location.displayPath}.`);
  if (!rootStat.isDirectory()) fail(`${label} must be a real directory: ${location.displayPath}.`);
  const realDirectory = realpath(location.lexicalPath, label);
  assertContained(location.realRoot, realDirectory, `${label} resolves outside the repository root`);

  const files = [];
  let entries = 0;
  let totalBytes = 0;
  walk(location.lexicalPath, 0, rootStat, realDirectory);
  if (files.length === 0) fail(`${label} contains no regular files.`);
  files.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(file.sha256Bytes);
    hash.update("\0");
  }
  return Object.freeze({
    path: location.lexicalPath,
    realPath: realDirectory,
    relativePath: portableRelative(location.realRoot, realDirectory),
    bytes: totalBytes,
    entries,
    files: Object.freeze(files.map(({ sha256Bytes: _sha256Bytes, ...file }) => Object.freeze(file))),
    sha256: hash.digest("hex")
  });

  function walk(
    directory,
    depth,
    directoryBefore = lstat(directory, label),
    expectedRealDirectory = realpath(directory, label)
  ) {
    if (depth > maxDepth) fail(`${label} exceeds the maximum directory depth of ${maxDepth}.`);
    const directoryLocation = {
      ...location,
      lexicalPath: directory,
      displayPath: display(repoRoot, directory)
    };
    assertNoSymlinkComponents(directoryLocation, label, true);
    if (!directoryBefore.isDirectory()) {
      fail(`${label} changed to a non-directory: ${directoryLocation.displayPath}.`);
    }
    let names;
    try {
      names = readdirSync(directory).sort();
    } catch (error) {
      fail(`${label} cannot be enumerated at ${display(repoRoot, directory)}: ${errorMessage(error)}`);
    }
    for (const name of names) {
      entries += 1;
      if (entries > maxEntries) fail(`${label} exceeds the maximum entry count of ${maxEntries}.`);
      const child = resolve(directory, name);
      const childDisplay = display(repoRoot, child);
      const childStat = lstat(child, label);
      if (childStat.isSymbolicLink()) fail(`${label} contains a symbolic link: ${childDisplay}.`);
      const childRealPath = realpath(child, label);
      assertContained(location.realRoot, childRealPath, `${label} descendant resolves outside the repository root`);
      assertContained(realDirectory, childRealPath, `${label} descendant resolves outside the compiled-model directory`);
      if (childStat.isDirectory()) {
        walk(child, depth + 1, childStat, childRealPath);
        continue;
      }
      if (!childStat.isFile()) fail(`${label} contains a non-regular filesystem entry: ${childDisplay}.`);
      if (childStat.nlink !== 1n) {
        fail(`${label} contains a hard-linked regular file: ${childDisplay}.`);
      }
      if (childStat.size > BigInt(maxBytes - totalBytes)) {
        fail(`${label} exceeds the ${maxBytes}-byte verification limit.`);
      }
      const childLocation = {
        lexicalRoot: location.lexicalRoot,
        lexicalPath: child,
        realRoot: location.realRoot,
        displayPath: childDisplay,
        expectedRealPath: childRealPath
      };
      const opened = readRegularFile(childLocation, childStat, maxBytes - totalBytes, true, label);
      totalBytes += opened.bytes;
      const relativePath = portableRelative(location.lexicalPath, child);
      files.push({
        path: child,
        realPath: childRealPath,
        relativePath,
        bytes: opened.bytes,
        sha256: opened.sha256,
        sha256Bytes: opened.contents
      });
    }
    assertPathVersion(
      directoryLocation,
      directoryBefore,
      expectedRealDirectory,
      label,
      "directory"
    );
  }
}

function readRegularFile(location, before, maxBytes, includeContents, label) {
  let descriptor;
  try {
    descriptor = openSync(location.lexicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    fail(`${label} cannot be opened safely at ${location.displayPath}: ${errorMessage(error)}`);
  }
  const hash = createHash("sha256");
  const chunks = includeContents ? [] : null;
  let bytes = 0;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()) fail(`${label} changed to a non-regular file while being verified: ${location.displayPath}.`);
    if (!sameVersion(opened, before)) {
      fail(`${label} changed before it could be verified: ${location.displayPath}.`);
    }
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      bytes += count;
      if (bytes > maxBytes) fail(`${label} exceeds the ${maxBytes}-byte verification limit: ${location.displayPath}.`);
      const chunk = buffer.subarray(0, count);
      hash.update(chunk);
      if (chunks) chunks.push(Buffer.from(chunk));
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameVersion(after, opened) || BigInt(bytes) !== opened.size) {
      fail(`${label} changed while being verified: ${location.displayPath}.`);
    }
    assertPathVersion(
      location,
      opened,
      location.expectedRealPath,
      label,
      "file"
    );
  } finally {
    closeSync(descriptor);
  }
  return {
    bytes,
    sha256: hash.digest("hex"),
    contents: chunks ? Buffer.concat(chunks) : undefined
  };
}

function containedLocation(repoRoot, artifactPath, label) {
  const lexicalRoot = resolve(repoRoot);
  const lexicalPath = isAbsolute(artifactPath) ? resolve(artifactPath) : resolve(lexicalRoot, artifactPath);
  assertContained(lexicalRoot, lexicalPath, `${label} path escapes the repository root`);
  return {
    lexicalRoot,
    lexicalPath,
    realRoot: realpath(lexicalRoot, "Repository root"),
    displayPath: display(lexicalRoot, lexicalPath)
  };
}

function assertPathVersion(
  location,
  expected,
  expectedRealPath,
  label,
  kind
) {
  assertNoSymlinkComponents(location, label, true);
  const current = lstat(location.lexicalPath, label);
  const typeMatches = kind === "directory"
    ? current.isDirectory()
    : current.isFile();
  if (!typeMatches || !sameVersion(current, expected)) {
    fail(
      `${label} pathname changed while being verified: ` +
      `${location.displayPath}.`
    );
  }
  const currentRealPath = realpath(location.lexicalPath, label);
  assertContained(
    location.realRoot,
    currentRealPath,
    `${label} resolves outside the repository root`
  );
  if (currentRealPath !== expectedRealPath) {
    fail(
      `${label} pathname resolved to a different artifact while being ` +
      `verified: ${location.displayPath}.`
    );
  }
}

function assertNoSymlinkComponents(
  location,
  label,
  includeLeaf
) {
  const rootStat = lstat(location.lexicalRoot, "Repository root");
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail("Repository root must be a real directory.");
  }
  const child = relative(location.lexicalRoot, location.lexicalPath);
  const parts = child.split(sep).filter(Boolean);
  const count = includeLeaf ? parts.length : Math.max(0, parts.length - 1);
  let current = location.lexicalRoot;
  for (const component of parts.slice(0, count)) {
    current = resolve(current, component);
    const metadata = lstat(current, label);
    if (metadata.isSymbolicLink()) {
      fail(
        `${label} contains a symbolic-link path component: ` +
        `${display(location.lexicalRoot, current)}.`
      );
    }
    if (!metadata.isDirectory() && current !== location.lexicalPath) {
      fail(
        `${label} contains a non-directory parent component: ` +
        `${display(location.lexicalRoot, current)}.`
      );
    }
  }
}

function sameVersion(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function assertContained(parent, candidate, prefix) {
  const child = relative(parent, candidate);
  if (child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))) return;
  fail(`${prefix}: ${candidate}.`);
}

function lstat(path, label) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    fail(`${label} cannot be inspected at ${path}: ${errorMessage(error)}`);
  }
}

function realpath(path, label) {
  try {
    return realpathSync(path);
  } catch (error) {
    fail(`${label} cannot be resolved at ${path}: ${errorMessage(error)}`);
  }
}

function boundedInteger(value, fallback, name) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1) fail(`${name} must be a positive safe integer.`);
  return candidate;
}

function portableRelative(parent, candidate) {
  return relative(parent, candidate).split(sep).join("/");
}

function display(root, path) {
  const candidate = relative(resolve(root), resolve(path));
  return candidate && !candidate.startsWith("..") && !isAbsolute(candidate)
    ? candidate.split(sep).join("/")
    : resolve(path);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(message) {
  throw new NeuralArtifactFilesystemError(message);
}
