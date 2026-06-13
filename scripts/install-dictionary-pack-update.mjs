#!/usr/bin/env node
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";

const ROOT = process.cwd();
const startedAt = performance.now();
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const value = process.argv[index + 1]?.startsWith("--") ? "1" : process.argv[index + 1] ?? "1";
  args.set(key, value);
  if (value !== "1") index += 1;
}

const manifestPath = args.get("manifest") ? resolve(args.get("manifest")) : null;
const appVersion = args.get("app-version") ?? "0.1.0";
const appBuild = Number(args.get("app-build") ?? 5);
const packDirectory = join(homedir(), "Library", "Application Support", "Lekh Keyboard", "Packs");
const activePackPath = join(packDirectory, "runtime-suggestions.current.lkb");
const activeManifestPath = join(packDirectory, "runtime-suggestions.current.json");
const reportPath = args.get("report") ?? join(ROOT, "reports", "dictionary-pack-install-report.json");
const localPublicKeyPath = join(ROOT, "data", "private", "lekh-pack-ed25519-public.pem");
const HEADER_SIZE = 64;
const ENTRY_STRIDE = 24;
const PREFIX_STRIDE = 16;
const MAX_PREFIX_LENGTH = 12;

try {
  if (!manifestPath || !existsSync(manifestPath)) {
    fail("missing-manifest", { manifest: manifestPath }, 1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const packPath = resolve(dirname(manifestPath), manifest.path);
  if (!existsSync(packPath)) fail("missing-pack", { pack: packPath }, 1);
  const pack = readFileSync(packPath);
  const sha256 = createHash("sha256").update(pack).digest("hex");
  if (manifest.binaryFormat !== "LEKHBLX1") fail("invalid-format", { binaryFormat: manifest.binaryFormat }, 1);
  if ((manifest.binaryFormatVersion ?? 1) !== 1) {
    fail("invalid-format-version", { binaryFormatVersion: manifest.binaryFormatVersion }, 1);
  }
  if (!isCompatibleManifest(manifest, appVersion, appBuild)) {
    fail("incompatible-pack", {
      appVersion,
      appBuild,
      minAppVersion: manifest.minAppVersion,
      minAppBuild: manifest.minAppBuild,
      maxAppBuild: manifest.maxAppBuild
    }, 1);
  }
  const validation = validateBinaryPack(pack);
  if (validation.failures.length > 0) {
    fail("invalid-pack-layout", {
      failures: validation.failures,
      header: validation.header
    }, 1);
  }
  if (manifest.bytes !== pack.length) fail("byte-mismatch", { expected: manifest.bytes, actual: pack.length }, 1);
  if (manifest.sha256 !== sha256) fail("sha-mismatch", { expected: manifest.sha256, actual: sha256 }, 1);

  const publicKeyPem = process.env.LEKH_PACK_ED25519_PUBLIC_KEY_PEM ||
    (existsSync(localPublicKeyPath) ? readFileSync(localPublicKeyPath, "utf8") : "");
  if (!manifest.signature?.valueBase64) {
    fail("signature-required", {
      reason: "Dictionary packs are fail-closed; unsigned packs are never installed."
    }, 1);
  }
  if (!publicKeyPem) {
    fail("signature-required", {
      requiredEnv: "LEKH_PACK_ED25519_PUBLIC_KEY_PEM",
      localDevKey: relative(ROOT, localPublicKeyPath)
    }, 1);
  }
  const ok = verify(
    null,
    signatureMessage(manifest),
    createPublicKey(publicKeyPem),
    Buffer.from(manifest.signature.valueBase64, "base64")
  );
  if (!ok) fail("signature-invalid", {}, 1);

  mkdirSync(packDirectory, { recursive: true });
  const tmpPack = `${activePackPath}.installing.${process.pid}`;
  const tmpManifest = `${activeManifestPath}.installing.${process.pid}`;
  rmSync(tmpPack, { force: true });
  rmSync(tmpManifest, { force: true });
  copyFileSync(packPath, tmpPack);
  writeFileSync(tmpManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmpPack, activePackPath);
  renameSync(tmpManifest, activeManifestPath);

  finish("passed", {
    manifest: relative(ROOT, manifestPath),
    installedPack: activePackPath,
    installedManifest: activeManifestPath,
    version: manifest.version,
    bytes: statSync(activePackPath).size,
    sha256,
    signed: Boolean(manifest.signature?.valueBase64 && publicKeyPem)
  }, 0);
} catch (error) {
  fail("dictionary-pack-install-error", { error: error instanceof Error ? error.message : String(error) }, 1);
}

function signatureMessage(manifest) {
  return Buffer.from([
    "LEKH_PACK_V2",
    manifest.version,
    manifest.sha256,
    String(manifest.bytes),
    manifest.binaryFormat,
    String(manifest.binaryFormatVersion ?? 1),
    manifest.minAppVersion,
    manifest.minAppBuild === null || manifest.minAppBuild === undefined ? "" : String(manifest.minAppBuild),
    manifest.maxAppBuild === null || manifest.maxAppBuild === undefined ? "" : String(manifest.maxAppBuild),
    manifest.path ?? "",
    manifest.delta?.sha256 ?? ""
  ].join("\n"), "utf8");
}

function isCompatibleManifest(manifest, currentVersion, currentBuild) {
  if (!manifest.minAppVersion || compareVersion(currentVersion, manifest.minAppVersion) < 0) return false;
  if (manifest.minAppBuild !== null && manifest.minAppBuild !== undefined) {
    const minBuild = Number(manifest.minAppBuild);
    if (Number.isFinite(minBuild) && currentBuild < minBuild) return false;
  }
  if (manifest.maxAppBuild !== null && manifest.maxAppBuild !== undefined) {
    const maxBuild = Number(manifest.maxAppBuild);
    if (Number.isFinite(maxBuild) && currentBuild > maxBuild) return false;
  }
  return true;
}

function compareVersion(left, right) {
  const leftParts = String(left).split(".").map((part) => Number(part) || 0);
  const rightParts = String(right).split(".").map((part) => Number(part) || 0);
  const count = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
}

function validateBinaryPack(buffer) {
  const failures = [];
  if (!Buffer.isBuffer(buffer) || buffer.length < HEADER_SIZE) {
    return { failures: ["binary pack is smaller than the 64-byte LEKHBLX1 header"], header: null };
  }
  if (buffer.subarray(0, 8).toString("ascii") !== "LEKHBLX1") failures.push("invalid LEKHBLX1 magic");

  const version = buffer.readUInt32LE(8);
  const headerSize = buffer.readUInt32LE(12);
  const entryCount = buffer.readUInt32LE(16);
  const entryOffset = buffer.readUInt32LE(20);
  const entryStride = buffer.readUInt32LE(24);
  const prefixCount = buffer.readUInt32LE(28);
  const prefixOffset = buffer.readUInt32LE(32);
  const prefixStride = buffer.readUInt32LE(36);
  const refCount = buffer.readUInt32LE(40);
  const refOffset = buffer.readUInt32LE(44);
  const stringOffset = buffer.readUInt32LE(48);
  const stringBytes = buffer.readUInt32LE(52);
  const maxPrefixLength = buffer.readUInt32LE(56);
  const header = {
    version,
    headerSize,
    entryCount,
    entryOffset,
    entryStride,
    prefixCount,
    prefixOffset,
    prefixStride,
    refCount,
    refOffset,
    stringOffset,
    stringBytes,
    maxPrefixLength,
    fileBytes: buffer.length
  };

  if (version !== 1) failures.push(`unsupported binary version ${version}`);
  if (headerSize !== HEADER_SIZE) failures.push(`invalid header size ${headerSize}`);
  if (entryStride < ENTRY_STRIDE) failures.push(`entry stride ${entryStride} is smaller than ${ENTRY_STRIDE}`);
  if (prefixStride < PREFIX_STRIDE) failures.push(`prefix stride ${prefixStride} is smaller than ${PREFIX_STRIDE}`);
  if (maxPrefixLength < 1 || maxPrefixLength > MAX_PREFIX_LENGTH) {
    failures.push(`max prefix length ${maxPrefixLength} outside supported range`);
  }
  checkSection("entries", entryOffset, entryCount, entryStride, buffer.length, failures);
  checkSection("prefixes", prefixOffset, prefixCount, prefixStride, buffer.length, failures);
  checkSection("refs", refOffset, refCount, 4, buffer.length, failures);
  checkSection("strings", stringOffset, stringBytes, 1, buffer.length, failures);
  if (!(HEADER_SIZE <= entryOffset && entryOffset <= prefixOffset && prefixOffset <= refOffset && refOffset <= stringOffset)) {
    failures.push("binary sections are not monotonically ordered");
  }

  if (failures.length === 0) {
    for (let index = 0; index < entryCount; index += 1) {
      const offset = entryOffset + index * entryStride;
      const romanOffset = buffer.readUInt32LE(offset);
      const romanLength = buffer.readUInt16LE(offset + 4);
      const unicodeLength = buffer.readUInt16LE(offset + 6);
      const unicodeOffset = buffer.readUInt32LE(offset + 8);
      if (!rangeInside(romanOffset, romanLength, stringBytes)) {
        failures.push(`entry[${index}] romanized string is out of bounds`);
        break;
      }
      if (!rangeInside(unicodeOffset, unicodeLength, stringBytes)) {
        failures.push(`entry[${index}] unicode string is out of bounds`);
        break;
      }
    }
  }

  if (failures.length === 0) {
    for (let index = 0; index < prefixCount; index += 1) {
      const offset = prefixOffset + index * prefixStride;
      const prefixStringOffset = buffer.readUInt32LE(offset);
      const prefixStringLength = buffer.readUInt16LE(offset + 4);
      const startRef = buffer.readUInt32LE(offset + 8);
      const count = buffer.readUInt32LE(offset + 12);
      if (!rangeInside(prefixStringOffset, prefixStringLength, stringBytes)) {
        failures.push(`prefix[${index}] string is out of bounds`);
        break;
      }
      if (!rangeInside(startRef, count, refCount)) {
        failures.push(`prefix[${index}] ref range is out of bounds`);
        break;
      }
    }
  }

  if (failures.length === 0) {
    for (let index = 0; index < refCount; index += 1) {
      const entryIndex = buffer.readUInt32LE(refOffset + index * 4);
      if (entryIndex >= entryCount) {
        failures.push(`ref[${index}] points outside entry table`);
        break;
      }
    }
  }
  return { failures, header };
}

function checkSection(name, offset, count, stride, fileBytes, failures) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(count) || !Number.isSafeInteger(stride)) {
    failures.push(`${name} section has unsafe integer metadata`);
    return;
  }
  if (offset < HEADER_SIZE) failures.push(`${name} section starts before header end`);
  if (count < 0 || stride <= 0) failures.push(`${name} section has invalid count or stride`);
  const bytes = count * stride;
  if (!Number.isSafeInteger(bytes) || bytes < 0) failures.push(`${name} section byte size overflows`);
  if (offset + bytes > fileBytes) failures.push(`${name} section exceeds file length`);
}

function rangeInside(offset, length, limit) {
  return Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    offset >= 0 &&
    length >= 0 &&
    offset + length <= limit;
}

function fail(status, details, exitCode) {
  finish(status, details, exitCode);
}

function finish(status, details, exitCode) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/install-dictionary-pack-update.mjs",
    suite: "dictionary-pack-install",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(ROOT, reportPath), ...details }, null, 2));
  process.exit(exitCode);
}
