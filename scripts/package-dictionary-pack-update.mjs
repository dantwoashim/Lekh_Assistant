#!/usr/bin/env node
import { createHash, createPrivateKey, sign } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";

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

const version = args.get("version") ?? new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
const channel = args.get("channel") ?? "dev";
const minAppBuild = Number(args.get("min-app-build") ?? 5);
const maxAppBuild = args.has("max-app-build") ? Number(args.get("max-app-build")) : null;
const binaryPath = args.get("binary") ?? join(ROOT, "release", "native", "macos", "runtime-suggestions.lkb");
const previousPath = args.get("previous");
const outDir = args.get("out-dir") ?? join(ROOT, "release", "native", "macos", "dictionary-packs", version);
const production = args.has("production");
const reportPath = args.get("report") ?? join(ROOT, "reports", "dictionary-pack-update-report.json");
const localPrivateKeyPath = join(ROOT, "data", "private", "lekh-pack-ed25519-private.pem");
const HEADER_SIZE = 64;
const ENTRY_STRIDE = 24;
const PREFIX_STRIDE = 16;
const MAX_PREFIX_LENGTH = 12;

try {
  if (production && channel !== "developer-id") {
    fail("production-channel-required", {
      channel,
      reason: "Production dictionary packs must be generated for the developer-id channel."
    }, 1);
  }
  if (!existsSync(binaryPath)) {
    fail("missing-binary-pack", { binary: relative(ROOT, binaryPath) }, 1);
  }

  const pack = readFileSync(binaryPath);
  const validation = validateBinaryPack(pack);
  if (validation.failures.length > 0) {
    fail("invalid-binary-pack", {
      reason: "Dictionary pack failed LEKHBLX1 structure validation.",
      failures: validation.failures,
      header: validation.header
    }, 1);
  }

  mkdirSync(outDir, { recursive: true });
  const packFileName = `runtime-suggestions-${version}.lkb`;
  const packOutPath = join(outDir, packFileName);
  copyFileSync(binaryPath, packOutPath);

  const sha256 = createHash("sha256").update(pack).digest("hex");
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    channel,
    version,
    binaryFormat: "LEKHBLX1",
    binaryFormatVersion: 1,
    bytes: pack.length,
    sha256,
    path: packFileName,
    minAppVersion: args.get("min-app-version") ?? "0.1.0",
    minAppBuild: Number.isFinite(minAppBuild) ? minAppBuild : 5,
    maxAppBuild: Number.isFinite(maxAppBuild) ? maxAppBuild : null,
    installName: "runtime-suggestions.current.lkb",
    signature: null
  };

  let delta = null;
  if (previousPath && existsSync(previousPath)) {
    const previous = readFileSync(previousPath);
    delta = buildDelta(previous, pack, version, sha256);
    const deltaPath = join(outDir, `runtime-suggestions-${version}.delta.json.gz`);
    const compressedDelta = gzipSync(JSON.stringify(delta));
    writeFileSync(deltaPath, compressedDelta);
    manifest.delta = {
      path: basename(deltaPath),
      sourceSha256: delta.sourceSha256,
      targetSha256: delta.targetSha256,
      rangeCount: delta.ranges.length,
      compressedBytes: statSync(deltaPath).size,
      sha256: createHash("sha256").update(compressedDelta).digest("hex")
    };
  }

  const privateKeyPem = process.env.LEKH_PACK_ED25519_PRIVATE_KEY_PEM ||
    (existsSync(localPrivateKeyPath) ? readFileSync(localPrivateKeyPath, "utf8") : "");
  if (privateKeyPem) {
    const signature = sign(null, signatureMessage(manifest), createPrivateKey(privateKeyPem));
    manifest.signature = {
      algorithm: "Ed25519",
      valueBase64: signature.toString("base64"),
      message: "LEKH_PACK_V2\\nversion\\nsha256\\nbytes\\nformat\\nformatVersion\\nminAppVersion\\nminAppBuild\\nmaxAppBuild\\npath",
      signedAt: new Date().toISOString()
    };
  } else {
    fail("missing-pack-signing-key", {
      requiredEnv: "LEKH_PACK_ED25519_PRIVATE_KEY_PEM",
      localDevKey: relative(ROOT, localPrivateKeyPath),
      reason: "Production dictionary packs must be Ed25519 signed."
    }, 1);
  }

  const manifestPath = join(outDir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const report = {
    status: manifest.signature ? "passed-signed" : "passed-unsigned-dev",
    outDir: relative(ROOT, outDir),
    manifest: relative(ROOT, manifestPath),
    pack: relative(ROOT, packOutPath),
    packBytes: pack.length,
    sha256,
    delta: delta
      ? {
          sourceSha256: delta.sourceSha256,
          targetSha256: delta.targetSha256,
          ranges: delta.ranges.length
        }
      : null,
    productionSigned: Boolean(manifest.signature)
  };
  finish(report.status, report, 0);
} catch (error) {
  fail("dictionary-pack-update-error", { error: error instanceof Error ? error.message : String(error) }, 1);
}

function buildDelta(previous, target, version, targetSha256) {
  const ranges = [];
  let offset = 0;
  while (offset < target.length) {
    if (offset < previous.length && previous[offset] === target[offset]) {
      offset += 1;
      continue;
    }
    const start = offset;
    const bytes = [];
    while (offset < target.length && (offset >= previous.length || previous[offset] !== target[offset])) {
      bytes.push(target[offset]);
      offset += 1;
    }
    ranges.push({ offset: start, dataBase64: Buffer.from(bytes).toString("base64") });
  }
  return {
    schemaVersion: 1,
    version,
    sourceSha256: createHash("sha256").update(previous).digest("hex"),
    targetSha256,
    targetBytes: target.length,
    ranges
  };
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
    command: "node scripts/package-dictionary-pack-update.mjs",
    suite: "dictionary-pack-update",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(ROOT, reportPath), ...details }, null, 2));
  process.exit(exitCode);
}
