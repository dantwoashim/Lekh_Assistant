#!/usr/bin/env node
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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

const production = args.has("production");
const reportPath = args.get("report") ?? join(ROOT, "reports", "macos-update-security-report.json");
const releaseDir = args.get("release-dir") ?? join(ROOT, "release", "native", "macos");
const zipPath = args.get("zip") ?? join(releaseDir, "Lekh-Keyboard-Test-Installer.zip");
const appcastPath = args.get("appcast") ?? join(releaseDir, "appcast.xml");
const dictionaryManifestPath = args.get("dictionary-manifest") ?? join(releaseDir, "dictionary-packs");
const publicUpdatesDir = args.get("public-updates-dir") ?? join(ROOT, "public", "updates", "macos");
const imkInfoPlistPath = args.get("imk-info-plist") ?? join(ROOT, "native", "macos-imk", "skeleton", "Info.plist");
const releaseManifestPath = args.get("release-manifest") ?? join(releaseDir, "RELEASE-MANIFEST.json");
const releaseManifestSignaturePath = `${releaseManifestPath}.minisig`;
const checksumPath = join(releaseDir, "SHA256SUMS.txt");
const minisignPublicKeyPath = join(ROOT, "public", "security", "lekh-release-manifest-minisign.pub");
const sparklePublicKeyPath = join(ROOT, "public", "security", "lekh-sparkle-ed25519-public.txt");
const packPublicKeyPath = join(ROOT, "public", "security", "lekh-pack-ed25519-public.txt");
const failures = [];
const warnings = [];
const HEADER_SIZE = 64;
const ENTRY_STRIDE = 24;
const PREFIX_STRIDE = 16;
const MAX_PREFIX_LENGTH = 12;

requireEnv("LEKH_MAC_DEVELOPER_ID", "Developer ID signing identity is required for production app updates.");
requireEnv("LEKH_NOTARIZATION_PROFILE", "Notarization profile is required before production distribution.");
requireEnv("LEKH_SPARKLE_EDDSA_PUBLIC_KEY", "Sparkle EdDSA public key must be embedded for signed appcast updates.");
requireEnv("LEKH_SPARKLE_APPCAST_URL", "Sparkle appcast URL must be configured for production updates.");
requireEnv("LEKH_PACK_ED25519_PUBLIC_KEY_BASE64", "Dictionary pack Ed25519 public key must be embedded in Info.plist.");
requireEnv("LEKH_PACK_ED25519_PRIVATE_KEY_PEM", "Dictionary pack private signing key must be present only in release CI.");
requireEnv("LEKH_RELEASE_MANIFEST_MINISIGN_SECRET_KEY", "Release manifest minisign secret key must be present only in release CI.");

const imkInfoPlist = readTextIfExists(imkInfoPlistPath);
const pinnedSparkleKey = readRawPublicKey("LEKH_SPARKLE_EDDSA_PUBLIC_KEY", sparklePublicKeyPath);
const pinnedPackKey = readRawPublicKey("LEKH_PACK_ED25519_PUBLIC_KEY_BASE64", packPublicKeyPath);

checkImkPlist(imkInfoPlist);
checkZipArtifact();
const appcastDetails = checkAppcast();
checkDictionaryPacks();
checkReleaseManifest(appcastDetails);
checkChecksums();
checkPublicUpdateFeed();

const report = {
  status: failures.length === 0 ? "passed" : "failed",
  production,
  zip: relative(ROOT, zipPath),
  appcast: relative(ROOT, appcastPath),
  dictionaryManifestPath: relative(ROOT, dictionaryManifestPath),
  publicUpdatesDir: relative(ROOT, publicUpdatesDir),
  releaseManifest: relative(ROOT, releaseManifestPath),
  failures,
  warnings,
  policy: {
    appUpdates: "Sparkle EdDSA signed appcast; production additionally requires Developer ID signing and notarization",
    dictionaryUpdates: "independent Ed25519 signed LEKHBLX1 full and delta pack manifests",
    releaseManifest: "SHA256 manifest over release directory files signed with minisign",
    noDuplicateRuntimePacks: true,
    noKeystrokeNetwork: true,
    updateKeysRequiredInProduction: true
  }
};

finish(report.status, report, failures.length === 0 ? 0 : 1);

function checkImkPlist(plist) {
  if (!plist) {
    critical(`IMK Info.plist is missing: ${relative(ROOT, imkInfoPlistPath)}`);
    return;
  }
  for (const marker of [
    "LekhDictionaryPackEd25519PublicKeyBase64",
    "<true/>",
    "SUFeedURL",
    "SUPublicEDKey",
    "https://"
  ]) {
    if (!plist.includes(marker)) critical(`IMK Info.plist missing update marker ${marker}.`);
  }
  const packKey = plistValue(plist, "LekhDictionaryPackEd25519PublicKeyBase64");
  const sparkleKey = plistValue(plist, "SUPublicEDKey");
  const feedURL = plistValue(plist, "SUFeedURL");
  const bundleBuild = Number(plistValue(plist, "CFBundleVersion") ?? 0);
  if (!packKey) critical("IMK Info.plist has an empty dictionary-pack public key.");
  if (!sparkleKey) critical("IMK Info.plist has an empty Sparkle public key.");
  if (packKey && pinnedPackKey && packKey !== pinnedPackKey) {
    critical("IMK Info.plist dictionary-pack public key does not match the published key.");
  }
  if (sparkleKey && pinnedSparkleKey && sparkleKey !== pinnedSparkleKey) {
    critical("IMK Info.plist Sparkle public key does not match the published key.");
  }
  if (feedURL && !feedURL.startsWith("https://")) critical("Sparkle feed URL must use HTTPS.");
  if (Number.isFinite(bundleBuild) && bundleBuild > 0 && bundleBuild < 5) {
    critical(`IMK bundle build is stale: ${bundleBuild}. Expected build 5 or newer.`);
  }
}

function checkZipArtifact() {
  if (!existsSync(zipPath)) {
    critical(`Installer ZIP is missing: ${relative(ROOT, zipPath)}`);
    return;
  }
  const result = spawnSync("unzip", ["-t", zipPath], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 120 * 1024 * 1024
  });
  if (result.status !== 0) {
    critical(`Installer ZIP failed central-directory/extractability check: ${result.stderr || result.stdout}`.trim());
  }
}

function checkAppcast() {
  if (!existsSync(appcastPath)) {
    critical(`Sparkle appcast is missing: ${relative(ROOT, appcastPath)}`);
    return null;
  }
  const appcast = readFileSync(appcastPath, "utf8");
  const enclosure = appcast.match(/<enclosure\b[^>]*>/s)?.[0] ?? "";
  const attrs = parseXmlAttributes(enclosure);
  const details = {
    version: firstXmlValue(appcast, "sparkle:version"),
    shortVersion: firstXmlValue(appcast, "sparkle:shortVersionString"),
    minimumAutoupdateVersion: firstXmlValue(appcast, "sparkle:minimumAutoupdateVersion"),
    url: attrs.url,
    length: Number(attrs.length),
    sha256: attrs["sparkle:sha256"],
    signature: attrs["sparkle:edSignature"],
    type: attrs.type
  };
  for (const marker of ["sparkle:edSignature", "enclosure", "url="]) {
    if (!appcast.includes(marker)) critical(`Sparkle appcast missing ${marker}.`);
  }
  if (!details.url?.startsWith("https://")) critical("Sparkle appcast enclosure URL must use HTTPS.");
  if (details.type !== "application/zip") critical(`Sparkle appcast enclosure type must be application/zip, got ${details.type ?? "missing"}.`);
  if (!details.minimumAutoupdateVersion) critical("Sparkle appcast missing rollback floor sparkle:minimumAutoupdateVersion.");
  if (!Number.isFinite(details.length)) critical("Sparkle appcast missing numeric enclosure length.");
  if (!/^[a-f0-9]{64}$/i.test(details.sha256 ?? "")) critical("Sparkle appcast missing valid sparkle:sha256.");
  if (!details.signature) critical("Sparkle appcast missing Ed25519 signature.");

  if (existsSync(zipPath)) {
    const archive = readFileSync(zipPath);
    const bytes = statSync(zipPath).size;
    const sha256 = createHash("sha256").update(archive).digest("hex");
    if (Number.isFinite(details.length) && details.length !== bytes) {
      critical(`Sparkle appcast length is stale: ${details.length}, actual ZIP is ${bytes}.`);
    }
    if (details.sha256 && details.sha256.toLowerCase() !== sha256) {
      critical(`Sparkle appcast sha256 is stale: ${details.sha256}, actual ZIP is ${sha256}.`);
    }
    if (details.signature && pinnedSparkleKey) {
      const ok = verifyEd25519RawPublicKey(pinnedSparkleKey, archive, details.signature);
      if (!ok) critical("Sparkle appcast Ed25519 signature does not verify against the installer ZIP.");
    }
  }
  return details;
}

function checkDictionaryPacks() {
  if (!existsSync(dictionaryManifestPath)) {
    critical(`Dictionary pack update output is missing: ${relative(ROOT, dictionaryManifestPath)}`);
    return;
  }
  const manifests = collectFiles(dictionaryManifestPath).filter((file) => file.endsWith("manifest.json"));
  if (manifests.length === 0) critical("Dictionary pack update output has no manifest.json files.");
  for (const manifestPath of manifests) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      critical(`${relative(ROOT, manifestPath)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!manifest.minAppVersion) critical(`${relative(ROOT, manifestPath)} missing minAppVersion.`);
    if (!Number.isFinite(Number(manifest.minAppBuild))) critical(`${relative(ROOT, manifestPath)} missing numeric minAppBuild.`);
    if (manifest.binaryFormat !== "LEKHBLX1") critical(`${relative(ROOT, manifestPath)} invalid binaryFormat ${manifest.binaryFormat}.`);
    if ((manifest.binaryFormatVersion ?? 1) !== 1) critical(`${relative(ROOT, manifestPath)} invalid binaryFormatVersion ${manifest.binaryFormatVersion}.`);
    if (!manifest.signature?.valueBase64) critical(`${relative(ROOT, manifestPath)} missing Ed25519 signature.`);
    if (manifest.signature?.message && !String(manifest.signature.message).includes("LEKH_PACK_V2")) {
      critical(`${relative(ROOT, manifestPath)} uses an obsolete pack signature message.`);
    }
    if (manifest.delta && !manifest.delta.sha256) {
      critical(`${relative(ROOT, manifestPath)} has an unsigned delta entry missing delta.sha256.`);
    }
    const packPath = resolve(dirname(manifestPath), manifest.path ?? "");
    if (!manifest.path || !existsSync(packPath)) {
      critical(`${relative(ROOT, manifestPath)} references a missing pack: ${manifest.path ?? "missing path"}.`);
      continue;
    }
    const pack = readFileSync(packPath);
    const sha256 = createHash("sha256").update(pack).digest("hex");
    const validation = validateBinaryPack(pack);
    if (validation.failures.length > 0) {
      critical(`${relative(ROOT, packPath)} failed LEKHBLX1 structure validation: ${validation.failures.join("; ")}`);
    }
    if (manifest.bytes !== pack.length) critical(`${relative(ROOT, manifestPath)} byte count mismatch.`);
    if (String(manifest.sha256).toLowerCase() !== sha256) critical(`${relative(ROOT, manifestPath)} sha256 mismatch.`);
    if (manifest.signature?.valueBase64 && pinnedPackKey) {
      const ok = verifyEd25519RawPublicKey(pinnedPackKey, packSignatureMessage(manifest), manifest.signature.valueBase64);
      if (!ok) critical(`${relative(ROOT, manifestPath)} Ed25519 signature does not verify.`);
    }
  }
}

function checkReleaseManifest(appcastDetails) {
  if (!existsSync(minisignPublicKeyPath)) {
    critical(`Release manifest minisign public key is missing: ${relative(ROOT, minisignPublicKeyPath)}`);
  }
  if (!existsSync(releaseManifestPath)) {
    critical(`Release manifest is missing: ${relative(ROOT, releaseManifestPath)}`);
    return;
  }
  if (!existsSync(releaseManifestSignaturePath)) {
    critical(`Release manifest minisign signature is missing: ${relative(ROOT, releaseManifestSignaturePath)}`);
    return;
  }

  const signatureLines = readFileSync(releaseManifestSignaturePath, "utf8").trim().split(/\r?\n/);
  if (!signatureLines.some((line) => /^[A-Za-z0-9+/]+={0,2}$/.test(line))) {
    critical("Release manifest minisign signature has no base64 payload.");
  }
  if (existsSync(minisignPublicKeyPath)) {
    const publicKey = readFileSync(minisignPublicKeyPath, "utf8").trim().split(/\r?\n/).at(-1);
    const verify = spawnSync("minisign", ["-Vm", releaseManifestPath, "-x", releaseManifestSignaturePath, "-P", publicKey], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe"
    });
    if (verify.status !== 0) {
      critical(`Release manifest minisign verification failed: ${verify.stderr || verify.stdout}`.trim());
    }
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(releaseManifestPath, "utf8"));
  } catch (error) {
    critical(`Release manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (production && manifest.channel !== "developer-id") critical(`Production release manifest channel must be developer-id, got ${manifest.channel}.`);
  if (!production && manifest.channel !== "developer-id") warnings.push(`Non-production release manifest channel is ${manifest.channel}.`);
  if (appcastDetails?.version && String(manifest.build) !== String(appcastDetails.version)) {
    critical(`Release manifest build ${manifest.build} does not match appcast version ${appcastDetails.version}.`);
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const manifestFiles = new Set(files.map((file) => file.path));
  for (const requiredFile of [
    "Lekh-Keyboard-Test-Installer.zip",
    "appcast.xml"
  ]) {
    if (!manifestFiles.has(requiredFile)) critical(`Release manifest does not cover ${requiredFile}.`);
  }
  if (![...manifestFiles].some((file) => file.startsWith("dictionary-packs/") && file.endsWith("/manifest.json"))) {
    critical("Release manifest does not cover dictionary pack manifests.");
  }
  if (![...manifestFiles].some((file) => file.startsWith("dictionary-packs/") && file.endsWith(".lkb"))) {
    critical("Release manifest does not cover dictionary pack binaries.");
  }
  for (const file of files) {
    if (file.path.includes("dev-local-signed")) critical(`Release manifest contains dev-local-signed artifact: ${file.path}`);
    if (file.path === "runtime-suggestions.lkb" || file.path === "runtime-suggestions.sanitized.json") {
      critical(`Release directory contains stale root runtime artifact: ${file.path}`);
    }
    const diskPath = join(releaseDir, file.path);
    if (!existsSync(diskPath)) {
      critical(`Release manifest references missing file: ${file.path}`);
      continue;
    }
    const bytes = statSync(diskPath).size;
    const sha256 = createHash("sha256").update(readFileSync(diskPath)).digest("hex");
    if (file.bytes !== bytes) critical(`Release manifest byte mismatch for ${file.path}.`);
    if (String(file.sha256).toLowerCase() !== sha256) critical(`Release manifest sha256 mismatch for ${file.path}.`);
  }
  const lkbByHash = new Map();
  for (const file of files.filter((entry) => entry.path.endsWith(".lkb"))) {
    const group = lkbByHash.get(file.sha256) ?? [];
    group.push(file.path);
    lkbByHash.set(file.sha256, group);
  }
  for (const group of lkbByHash.values()) {
    if (group.length > 1) critical(`Duplicate dictionary binary payloads in release manifest: ${group.join(", ")}`);
  }
}

function checkChecksums() {
  if (!existsSync(checksumPath)) {
    critical(`SHA256SUMS.txt is missing: ${relative(ROOT, checksumPath)}`);
    return;
  }
  const checksums = new Map();
  for (const line of readFileSync(checksumPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (!match) {
      critical(`Malformed SHA256SUMS line: ${line}`);
      continue;
    }
    checksums.set(match[2], match[1].toLowerCase());
  }
  const releaseFiles = collectFiles(releaseDir)
    .filter((file) => file !== checksumPath)
    .map((file) => relative(releaseDir, file))
    .sort((a, b) => a.localeCompare(b, "en"));
  for (const file of releaseFiles) {
    const expected = checksums.get(file);
    if (!expected) {
      critical(`SHA256SUMS.txt does not cover ${file}.`);
      continue;
    }
    const actual = createHash("sha256").update(readFileSync(join(releaseDir, file))).digest("hex");
    if (actual !== expected) critical(`SHA256SUMS.txt hash mismatch for ${file}.`);
  }
}

function checkPublicUpdateFeed() {
  const feedURL = imkInfoPlist ? plistValue(imkInfoPlist, "SUFeedURL") : null;
  if (!feedURL?.includes("/updates/macos/")) return;
  if (!existsSync(publicUpdatesDir)) {
    critical(`Public macOS update feed directory is missing: ${relative(ROOT, publicUpdatesDir)}`);
    return;
  }
  for (const fileName of [
    "Lekh-Keyboard-Test-Installer.zip",
    "appcast.xml",
    "RELEASE-MANIFEST.json",
    "RELEASE-MANIFEST.json.minisig",
    "SHA256SUMS.txt"
  ]) {
    compareMirrorFile(join(releaseDir, fileName), join(publicUpdatesDir, fileName), `public updates ${fileName}`);
  }
  const releasePackFiles = existsSync(dictionaryManifestPath)
    ? collectFiles(dictionaryManifestPath).filter((file) => file.endsWith(".lkb") || file.endsWith("manifest.json"))
    : [];
  for (const releasePackFile of releasePackFiles) {
    compareMirrorFile(
      releasePackFile,
      join(publicUpdatesDir, relative(releaseDir, releasePackFile)),
      `public updates ${relative(releaseDir, releasePackFile)}`
    );
  }
}

function compareMirrorFile(source, target, label) {
  if (!existsSync(source)) {
    critical(`${label} source is missing: ${relative(ROOT, source)}`);
    return;
  }
  if (!existsSync(target)) {
    critical(`${label} mirror is missing: ${relative(ROOT, target)}`);
    return;
  }
  const sourceHash = createHash("sha256").update(readFileSync(source)).digest("hex");
  const targetHash = createHash("sha256").update(readFileSync(target)).digest("hex");
  if (sourceHash !== targetHash) {
    critical(`${label} mirror hash mismatch: ${relative(ROOT, target)}`);
  }
}

function requireEnv(name, message) {
  if (process.env[name]) return;
  policy(`${message} Missing env ${name}.`);
}

function critical(message) {
  failures.push(message);
}

function policy(message) {
  if (production) failures.push(message);
  else warnings.push(message);
}

function collectFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    if (entry === ".DS_Store") return [];
    const path = join(directory, entry);
    const stat = statSync(path);
    return stat.isDirectory() ? collectFiles(path) : [path];
  });
}

function readTextIfExists(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function plistValue(plist, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return plist.match(new RegExp(`<key>${escaped}<\\/key>\\s*<string>([\\s\\S]*?)<\\/string>`))?.[1]?.trim() ?? null;
}

function parseXmlAttributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [match[1], decodeXml(match[2])]));
}

function firstXmlValue(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return xml.match(new RegExp(`<${escaped}>([\\s\\S]*?)<\\/${escaped}>`))?.[1]?.trim() ?? null;
}

function decodeXml(value) {
  return String(value)
    .replace(/&quot;/g, "\"")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function readRawPublicKey(envName, path) {
  if (process.env[envName]) return process.env[envName].trim();
  if (!existsSync(path)) {
    policy(`Published public key file missing: ${relative(ROOT, path)}.`);
    return "";
  }
  const text = readFileSync(path, "utf8");
  const matches = [...text.matchAll(/[A-Za-z0-9+/]{43}=/g)].map((match) => match[0]);
  if (matches.length === 0) {
    critical(`Published public key file has no raw Ed25519 base64 key: ${relative(ROOT, path)}.`);
    return "";
  }
  return matches.at(-1);
}

function verifyEd25519RawPublicKey(rawBase64, message, signatureBase64) {
  try {
    const raw = Buffer.from(rawBase64, "base64");
    if (raw.length !== 32) return false;
    const derPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const publicKey = createPublicKey({ key: Buffer.concat([derPrefix, raw]), format: "der", type: "spki" });
    const payload = Buffer.isBuffer(message) ? message : Buffer.from(message);
    return verifySignature(null, payload, publicKey, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

function packSignatureMessage(manifest) {
  return Buffer.from([
    "LEKH_PACK_V2",
    manifest.version,
    String(manifest.sha256).toLowerCase(),
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
      if (!rangeInside(buffer.readUInt32LE(offset), buffer.readUInt16LE(offset + 4), stringBytes)) {
        failures.push(`entry[${index}] romanized string is out of bounds`);
        break;
      }
      if (!rangeInside(buffer.readUInt32LE(offset + 8), buffer.readUInt16LE(offset + 6), stringBytes)) {
        failures.push(`entry[${index}] unicode string is out of bounds`);
        break;
      }
    }
  }
  if (failures.length === 0) {
    for (let index = 0; index < prefixCount; index += 1) {
      const offset = prefixOffset + index * prefixStride;
      if (!rangeInside(buffer.readUInt32LE(offset), buffer.readUInt16LE(offset + 4), stringBytes)) {
        failures.push(`prefix[${index}] string is out of bounds`);
        break;
      }
      if (!rangeInside(buffer.readUInt32LE(offset + 8), buffer.readUInt32LE(offset + 12), refCount)) {
        failures.push(`prefix[${index}] ref range is out of bounds`);
        break;
      }
    }
  }
  if (failures.length === 0) {
    for (let index = 0; index < refCount; index += 1) {
      if (buffer.readUInt32LE(refOffset + index * 4) >= entryCount) {
        failures.push(`ref[${index}] points outside entry table`);
        break;
      }
    }
  }
  return { failures };
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

function finish(status, details, exitCode) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-macos-update-security.mjs",
    suite: "macos-update-security",
    durationMs: Math.round(performance.now() - startedAt),
    ...details,
    status
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(ROOT, reportPath), failures, warnings }, null, 2));
  process.exit(exitCode);
}
