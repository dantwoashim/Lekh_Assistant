import * as path from "node:path";
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const WINDOWS_REPARSE_POINT_ATTRIBUTE = 0x400;
const PE_MACHINE_NAMES = new Map([
  [0x014c, "x86"],
  [0x8664, "x64"],
  [0xaa64, "arm64"],
]);
const PE_MACHINE_NAME_SET = new Set(PE_MACHINE_NAMES.values());

export function normalizeSha256Fingerprint(value) {
  if (typeof value !== "string") return null;
  if (/^[a-fA-F0-9]{64}$/.test(value)) return value.toUpperCase();
  const colonSeparated = /^(?:[a-fA-F0-9]{2}:){31}[a-fA-F0-9]{2}$/.test(value);
  const spaceSeparated = /^(?:[a-fA-F0-9]{2} ){31}[a-fA-F0-9]{2}$/.test(value);
  return colonSeparated || spaceSeparated ? value.replace(/[: ]/g, "").toUpperCase() : null;
}

export function isStrictDescendant(baseDirectory, candidate, pathApi = path) {
  const relativePath = pathApi.relative(pathApi.resolve(baseDirectory), pathApi.resolve(candidate));
  return relativePath !== "" && relativePath !== ".." &&
    !pathApi.isAbsolute(relativePath) && !relativePath.startsWith(`..${pathApi.sep}`);
}

export function windowsFileAttributesContainReparsePoint(attributes) {
  return Number.isSafeInteger(attributes) && attributes >= 0 &&
    (attributes & WINDOWS_REPARSE_POINT_ATTRIBUTE) !== 0;
}

export function hasPortableExecutableMagic(file) {
  const descriptor = openSync(file, "r");
  try {
    const magic = Buffer.allocUnsafe(2);
    return readSync(descriptor, magic, 0, magic.length, 0) === magic.length &&
      magic[0] === 0x4d && magic[1] === 0x5a;
  } finally {
    closeSync(descriptor);
  }
}

export function readPortableExecutableIdentity(file) {
  const descriptor = openSync(file, "r");
  try {
    const details = fstatSync(descriptor);
    if (!details.isFile() || details.size < 88) {
      throw new Error(`Portable executable is truncated: ${file}`);
    }
    const dosHeader = Buffer.alloc(64);
    readExactly(descriptor, dosHeader, 0);
    if (dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) {
      throw new Error(`Portable executable has no DOS MZ header: ${file}`);
    }
    const peOffset = dosHeader.readUInt32LE(0x3c);
    if (peOffset < dosHeader.length || peOffset > details.size - 26) {
      throw new Error(`Portable executable has an invalid PE header offset: ${file}`);
    }
    const coffHeader = Buffer.alloc(26);
    readExactly(descriptor, coffHeader, peOffset);
    if (!coffHeader.subarray(0, 4).equals(Buffer.from([0x50, 0x45, 0x00, 0x00]))) {
      throw new Error(`Portable executable has no PE signature: ${file}`);
    }
    const machine = coffHeader.readUInt16LE(4);
    const machineName = PE_MACHINE_NAMES.get(machine);
    if (!machineName) {
      throw new Error(`Portable executable uses unsupported machine 0x${machine.toString(16)}: ${file}`);
    }
    const sectionCount = coffHeader.readUInt16LE(6);
    const optionalHeaderBytes = coffHeader.readUInt16LE(20);
    const optionalHeaderMagic = coffHeader.readUInt16LE(24);
    const expectedOptionalHeaderMagic = machine === 0x014c ? 0x010b : 0x020b;
    if (
      sectionCount === 0 ||
      optionalHeaderBytes < 2 ||
      peOffset + 24 + optionalHeaderBytes > details.size ||
      optionalHeaderMagic !== expectedOptionalHeaderMagic
    ) {
      throw new Error(`Portable executable has an invalid COFF or optional header: ${file}`);
    }
    return {
      machine,
      machineName,
      optionalHeaderMagic,
      bytes: details.size,
    };
  } finally {
    closeSync(descriptor);
  }
}

export function discoverPortableExecutables(directory) {
  const root = path.resolve(directory);
  const pending = [root];
  const binaries = [];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      const details = lstatSync(candidate);
      if (details.isSymbolicLink()) {
        throw new Error(`Release tree contains a symbolic-link alias: ${candidate}`);
      }
      if (details.isDirectory()) {
        pending.push(candidate);
      } else if (details.isFile()) {
        const extension = path.extname(candidate).toLowerCase();
        const hasMagic = hasPortableExecutableMagic(candidate);
        if (hasMagic) {
          readPortableExecutableIdentity(candidate);
          binaries.push(candidate);
        } else if (extension === ".exe" || extension === ".dll" || extension === ".node") {
          throw new Error(`Executable payload has no valid PE image: ${candidate}`);
        }
      }
    }
  }
  return binaries.sort((left, right) => left.localeCompare(right));
}

function readExactly(descriptor, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const read = readSync(
      descriptor,
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (read === 0) throw new Error("Portable executable ended while reading its headers.");
    offset += read;
  }
}

function windowsPathContainsReparsePoint(nodes) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop'; $paths=@(ConvertFrom-Json $env:LEKH_RELEASE_REPARSE_PATHS); foreach($path in $paths){ $item=Get-Item -LiteralPath $path -Force; if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){ exit 10 } }; exit 0",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      env: {
        ...process.env,
        LEKH_RELEASE_REPARSE_PATHS: JSON.stringify(nodes),
      },
    },
  );
  // Release authentication is fail-closed: inability to query attributes is
  // indistinguishable from an unsafe alias.
  return result.status !== 0;
}

function windowsTreeContainsReparsePoint(root) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop'; $root=$env:LEKH_RELEASE_REPARSE_ROOT; $items=@(Get-Item -LiteralPath $root -Force) + @(Get-ChildItem -LiteralPath $root -Force -Recurse); foreach($item in $items){ if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){ exit 10 } }; exit 0",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      env: {
        ...process.env,
        LEKH_RELEASE_REPARSE_ROOT: root,
      },
    },
  );
  return result.status !== 0;
}

export function releaseTreeContainsAlias(directory) {
  const root = path.resolve(directory);
  try {
    if (process.platform === "win32" && windowsTreeContainsReparsePoint(root)) return true;
    const pending = [root];
    while (pending.length > 0) {
      const current = pending.pop();
      const currentDetails = lstatSync(current);
      if (currentDetails.isSymbolicLink() || (currentDetails.isFile() && currentDetails.nlink !== 1)) {
        return true;
      }
      if (!currentDetails.isDirectory()) continue;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        pending.push(path.join(current, entry.name));
      }
    }
    return false;
  } catch {
    // An unreadable or unstable release tree cannot produce trustworthy evidence.
    return true;
  }
}

export function hasReleaseAliasInPath(baseDirectory, candidate, pathApi = path) {
  if (!isStrictDescendant(baseDirectory, candidate, pathApi)) return true;
  const base = pathApi.resolve(baseDirectory);
  const segments = pathApi.relative(base, pathApi.resolve(candidate)).split(pathApi.sep);
  let cursor = base;
  const nodes = [base];
  try {
    const baseDetails = lstatSync(cursor);
    if (baseDetails.isSymbolicLink() || (baseDetails.isFile() && baseDetails.nlink !== 1)) return true;
    for (const segment of segments) {
      cursor = pathApi.join(cursor, segment);
      nodes.push(cursor);
      const details = lstatSync(cursor);
      if (details.isSymbolicLink() || (details.isFile() && details.nlink !== 1)) return true;
    }
    return process.platform === "win32" ? windowsPathContainsReparsePoint(nodes) : false;
  } catch {
    return true;
  }
}

// Compatibility alias for older release scripts; semantics now reject every
// Windows reparse-point alias, not only symbolic links and junctions.
export const hasSymbolicLinkInPath = hasReleaseAliasInPath;

export function signerInventoryMatches(entries, expectedSigner, expectedArtifacts) {
  const normalizedSigner = normalizeSha256Fingerprint(expectedSigner);
  if (!normalizedSigner || !Array.isArray(entries)) return false;
  return [...expectedArtifacts].every((artifact) => {
    const entry = entries.find((candidate) => candidate?.artifact === artifact);
    return entry?.verified === true && entry?.signerMatchesExpected === true &&
      normalizeSha256Fingerprint(entry?.signerSha256) === normalizedSigner;
  });
}

export function artifactInventoriesMatch(expected, actual) {
  if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) {
    return false;
  }
  const expectedByPath = inventoryByPath(expected);
  const actualByPath = inventoryByPath(actual);
  if (!expectedByPath || !actualByPath || expectedByPath.size !== actualByPath.size) return false;
  for (const [artifactPath, identity] of expectedByPath) {
    const candidate = actualByPath.get(artifactPath);
    if (!candidate || candidate.bytes !== identity.bytes || candidate.sha256 !== identity.sha256 ||
        candidate.modifiedAt !== identity.modifiedAt || candidate.machine !== identity.machine) {
      return false;
    }
  }
  return true;
}

function inventoryByPath(entries) {
  const inventory = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0 ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
        !/^[a-fA-F0-9]{64}$/.test(entry.sha256 ?? "") ||
        typeof entry.modifiedAt !== "string" || !Number.isFinite(Date.parse(entry.modifiedAt)) ||
        !PE_MACHINE_NAME_SET.has(entry.machine) ||
        inventory.has(entry.path)) {
      return null;
    }
    inventory.set(entry.path, entry);
  }
  return inventory;
}
