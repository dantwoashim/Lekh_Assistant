#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
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
const failures = [];
const warnings = [];

requireEnv("LEKH_MAC_DEVELOPER_ID", "Developer ID signing identity is required for production app updates.");
requireEnv("LEKH_NOTARIZATION_PROFILE", "Notarization profile is required before production distribution.");
requireEnv("LEKH_SPARKLE_EDDSA_PUBLIC_KEY", "Sparkle EdDSA public key must be embedded for signed appcast updates.");
requireEnv("LEKH_SPARKLE_APPCAST_URL", "Sparkle appcast URL must be configured for production updates.");
requireEnv("LEKH_PACK_ED25519_PUBLIC_KEY_BASE64", "Dictionary pack Ed25519 public key must be embedded in Info.plist.");
requireEnv("LEKH_PACK_ED25519_PRIVATE_KEY_PEM", "Dictionary pack private signing key must be present only in release CI.");

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
    dictionaryUpdates: "independent Ed25519 signed LEKHBLX1 pack manifests",
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
