#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
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
const appcastPath = args.get("appcast") ?? join(ROOT, "release", "native", "macos", "appcast.xml");
const dictionaryManifestPath = args.get("dictionary-manifest") ?? join(ROOT, "release", "native", "macos", "dictionary-packs");
const imkInfoPlistPath = args.get("imk-info-plist") ?? join(ROOT, "native", "macos-imk", "skeleton", "Info.plist");
const releaseManifestPath = args.get("release-manifest") ?? join(ROOT, "release", "native", "macos", "RELEASE-MANIFEST.json");
const releaseManifestSignaturePath = `${releaseManifestPath}.minisig`;
const minisignPublicKeyPath = join(ROOT, "public", "security", "lekh-release-manifest-minisign.pub");
const failures = [];
const warnings = [];

requireEnv("LEKH_MAC_DEVELOPER_ID", "Developer ID signing identity is required for production app updates.");
requireEnv("LEKH_NOTARIZATION_PROFILE", "Notarization profile is required before production distribution.");
requireEnv("LEKH_SPARKLE_EDDSA_PUBLIC_KEY", "Sparkle EdDSA public key must be embedded for signed appcast updates.");
requireEnv("LEKH_SPARKLE_APPCAST_URL", "Sparkle appcast URL must be configured for production updates.");
requireEnv("LEKH_PACK_ED25519_PUBLIC_KEY_BASE64", "Dictionary pack Ed25519 public key must be embedded in Info.plist.");
requireEnv("LEKH_PACK_ED25519_PRIVATE_KEY_PEM", "Dictionary pack private signing key must be present only in release CI.");
requireEnv("LEKH_RELEASE_MANIFEST_MINISIGN_SECRET_KEY", "Release manifest minisign secret key must be present only in release CI.");

if (!existsSync(imkInfoPlistPath)) {
  noteMissing(`IMK Info.plist is missing: ${relative(ROOT, imkInfoPlistPath)}`);
} else {
  const plist = readFileSync(imkInfoPlistPath, "utf8");
  for (const marker of [
    "LekhDictionaryPackEd25519PublicKeyBase64",
    "<true/>",
    "SUFeedURL",
    "SUPublicEDKey",
    "https://"
  ]) {
    if (!plist.includes(marker)) noteMissing(`IMK Info.plist missing update marker ${marker}.`);
  }
  if (/<key>LekhDictionaryPackEd25519PublicKeyBase64<\/key>\s*<string>\s*<\/string>/m.test(plist)) {
    noteMissing("IMK Info.plist has an empty dictionary-pack public key.");
  }
  if (/<key>SUPublicEDKey<\/key>\s*<string>\s*<\/string>/m.test(plist)) {
    noteMissing("IMK Info.plist has an empty Sparkle public key.");
  }
}

if (!existsSync(appcastPath)) {
  noteMissing(`Sparkle appcast is missing: ${relative(ROOT, appcastPath)}`);
} else {
  const appcast = readFileSync(appcastPath, "utf8");
  for (const marker of ["sparkle:edSignature", "enclosure", "url="]) {
    if (!appcast.includes(marker)) {
      noteMissing(`Sparkle appcast missing ${marker}.`);
    }
  }
}

if (!existsSync(dictionaryManifestPath)) {
  noteMissing(`Dictionary pack update output is missing: ${relative(ROOT, dictionaryManifestPath)}`);
} else {
  const manifests = collectFiles(dictionaryManifestPath).filter((file) => file.endsWith("manifest.json"));
  if (manifests.length === 0) noteMissing("Dictionary pack update output has no manifest.json files.");
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!manifest.minAppVersion) noteMissing(`${relative(ROOT, manifestPath)} missing minAppVersion.`);
    if (!manifest.signature?.valueBase64) noteMissing(`${relative(ROOT, manifestPath)} missing Ed25519 signature.`);
    if (manifest.signature?.message && !String(manifest.signature.message).includes("LEKH_PACK_V2")) {
      noteMissing(`${relative(ROOT, manifestPath)} uses an obsolete pack signature message.`);
    }
    if (manifest.delta && !manifest.delta.sha256) {
      noteMissing(`${relative(ROOT, manifestPath)} has an unsigned delta entry missing delta.sha256.`);
    }
  }
}

if (!existsSync(minisignPublicKeyPath)) {
  noteMissing(`Release manifest minisign public key is missing: ${relative(ROOT, minisignPublicKeyPath)}`);
}
if (!existsSync(releaseManifestPath)) {
  noteMissing(`Release manifest is missing: ${relative(ROOT, releaseManifestPath)}`);
}
if (!existsSync(releaseManifestSignaturePath)) {
  noteMissing(`Release manifest minisign signature is missing: ${relative(ROOT, releaseManifestSignaturePath)}`);
}
if (existsSync(releaseManifestPath) && existsSync(releaseManifestSignaturePath) && existsSync(minisignPublicKeyPath)) {
  const manifest = JSON.parse(readFileSync(releaseManifestPath, "utf8"));
  const manifestFiles = new Set((manifest.files ?? []).map((file) => file.path));
  for (const requiredFile of [
    "Lekh-Keyboard-Test-Installer.zip",
    "appcast.xml"
  ]) {
    if (!manifestFiles.has(requiredFile)) {
      noteMissing(`Release manifest does not cover ${requiredFile}.`);
    }
  }
  if (![...manifestFiles].some((file) => file.startsWith("dictionary-packs/") && file.endsWith("/manifest.json"))) {
    noteMissing("Release manifest does not cover dictionary pack manifests.");
  }
  if (![...manifestFiles].some((file) => file.startsWith("dictionary-packs/") && file.endsWith(".lkb"))) {
    noteMissing("Release manifest does not cover dictionary pack binaries.");
  }
  const publicKey = readFileSync(minisignPublicKeyPath, "utf8").trim().split(/\r?\n/).at(-1);
  const verify = spawnSync("minisign", ["-Vm", releaseManifestPath, "-P", publicKey], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe"
  });
  if (verify.status !== 0) {
    noteMissing(`Release manifest minisign verification failed: ${verify.stderr || verify.stdout}`.trim());
  }
}

const report = {
  status: failures.length === 0 ? "passed" : "failed",
  production,
  appcast: relative(ROOT, appcastPath),
  dictionaryManifestPath: relative(ROOT, dictionaryManifestPath),
  failures,
  warnings,
  policy: {
    appUpdates: "Sparkle EdDSA signed appcast plus Developer ID notarized payload",
    dictionaryUpdates: "independent Ed25519 signed LEKHBLX1 full and delta pack manifests",
    releaseManifest: "SHA256 manifest over release directory files signed with minisign",
    noKeystrokeNetwork: true,
    updateKeysRequiredInProduction: true
  }
};

finish(report.status, report, failures.length === 0 ? 0 : 1);

function requireEnv(name, message) {
  if (process.env[name]) return;
  noteMissing(`${message} Missing env ${name}.`);
}

function noteMissing(message) {
  if (production) failures.push(message);
  else warnings.push(message);
}

function collectFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    const stat = statSync(path);
    return stat.isDirectory() ? collectFiles(path) : [path];
  });
}

function finish(status, details, exitCode) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-macos-update-security.mjs",
    suite: "macos-update-security",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(ROOT, reportPath), failures, warnings }, null, 2));
  process.exit(exitCode);
}
