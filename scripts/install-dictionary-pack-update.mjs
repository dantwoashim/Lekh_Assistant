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
const production = args.has("production");
const allowUnsignedDev = args.has("allow-unsigned-dev");
const packDirectory = join(homedir(), "Library", "Application Support", "Lekh Keyboard", "Packs");
const activePackPath = join(packDirectory, "runtime-suggestions.current.lkb");
const activeManifestPath = join(packDirectory, "runtime-suggestions.current.json");
const reportPath = args.get("report") ?? join(ROOT, "reports", "dictionary-pack-install-report.json");

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
  if (pack.subarray(0, 8).toString("ascii") !== "LEKHBLX1") fail("invalid-pack-magic", {}, 1);
  if (manifest.bytes !== pack.length) fail("byte-mismatch", { expected: manifest.bytes, actual: pack.length }, 1);
  if (manifest.sha256 !== sha256) fail("sha-mismatch", { expected: manifest.sha256, actual: sha256 }, 1);

  const publicKeyPem = process.env.LEKH_PACK_ED25519_PUBLIC_KEY_PEM;
  if (manifest.signature?.valueBase64 && publicKeyPem) {
    const ok = verify(
      null,
      signatureMessage(manifest),
      createPublicKey(publicKeyPem),
      Buffer.from(manifest.signature.valueBase64, "base64")
    );
    if (!ok) fail("signature-invalid", {}, 1);
  } else if (production || !allowUnsignedDev) {
    fail("signature-required", {
      requiredEnv: "LEKH_PACK_ED25519_PUBLIC_KEY_PEM",
      allowUnsignedDevFlag: "--allow-unsigned-dev"
    }, 1);
  }

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
  return Buffer.from(`LEKH_PACK_V1\n${manifest.version}\n${manifest.sha256}\n${manifest.bytes}\n${manifest.binaryFormat}`, "utf8");
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
