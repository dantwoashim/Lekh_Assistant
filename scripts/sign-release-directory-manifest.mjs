#!/usr/bin/env node
import { createHash } from "node:crypto";
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

const releaseDir = args.get("dir") ?? join(ROOT, "release", "native", "macos");
const manifestPath = args.get("manifest") ?? join(releaseDir, "RELEASE-MANIFEST.json");
const signaturePath = args.get("signature") ?? `${manifestPath}.minisig`;
const checksumPath = args.get("checksums") ?? join(releaseDir, "SHA256SUMS.txt");
const reportPath = args.get("report") ?? join(ROOT, "reports", "release-directory-manifest-report.json");
const manifestVersion = args.get("version") ?? "1.0.0";
const manifestBuild = Number(args.get("build") ?? 5);
const releaseChannel = args.get("channel") ?? (process.env.LEKH_MAC_DEVELOPER_ID ? "developer-id" : "test-adhoc");
const minisignSecretKey = process.env.LEKH_RELEASE_MANIFEST_MINISIGN_SECRET_KEY ||
  join(ROOT, "data", "private", "lekh-release-manifest-minisign.sec");
const minisignPublicKey = process.env.LEKH_RELEASE_MANIFEST_MINISIGN_PUBLIC_KEY ||
  join(ROOT, "public", "security", "lekh-release-manifest-minisign.pub");

try {
  if (!existsSync(releaseDir)) {
    finish("failed", { reason: "release directory missing", releaseDir: relative(ROOT, releaseDir) }, 1);
  }
  if (!existsSync(minisignSecretKey)) {
    finish("failed", { reason: "missing minisign secret key", expected: relative(ROOT, minisignSecretKey) }, 1);
  }
  if (!Number.isFinite(manifestBuild) || manifestBuild < 1) {
    finish("failed", { reason: "invalid manifest build", build: args.get("build") }, 1);
  }

  const files = collectFiles(releaseDir)
    .filter((file) => !isGeneratedManifestFile(file))
    .sort((a, b) => relative(releaseDir, a).localeCompare(relative(releaseDir, b), "en"));
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    product: "Lekh Keyboard",
    channel: releaseChannel,
    version: manifestVersion,
    build: manifestBuild,
    hashAlgorithm: "SHA-256",
    signature: {
      algorithm: "minisign",
      publicKey: existsSync(minisignPublicKey) ? relative(ROOT, minisignPublicKey) : null,
      detachedSignature: relative(releaseDir, signaturePath)
    },
    files: files.map((file) => ({
      path: relative(releaseDir, file),
      bytes: statSync(file).size,
      sha256: sha256File(file)
    }))
  };

  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const sign = spawnSync("minisign", ["-Sm", manifestPath, "-s", minisignSecretKey, "-x", signaturePath], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe"
  });
  if (sign.status !== 0) {
    finish("failed", { reason: "minisign failed", stdout: sign.stdout, stderr: sign.stderr }, sign.status ?? 1);
  }
  verifyMinisignSignature(manifestPath, signaturePath);

  const checksumFiles = collectFiles(releaseDir)
    .filter((file) => file !== checksumPath)
    .sort((a, b) => relative(releaseDir, a).localeCompare(relative(releaseDir, b), "en"));
  writeFileSync(
    checksumPath,
    checksumFiles.map((file) => `${sha256File(file)}  ${relative(releaseDir, file)}`).join("\n") + "\n"
  );

  finish("passed", {
    releaseDir: relative(ROOT, releaseDir),
    manifest: relative(ROOT, manifestPath),
    signature: relative(ROOT, signaturePath),
    checksums: relative(ROOT, checksumPath),
    files: manifest.files.length
  }, 0);
} catch (error) {
  finish("failed", { reason: error instanceof Error ? error.message : String(error) }, 1);
}

function collectFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    if (entry === ".DS_Store") return [];
    const path = join(directory, entry);
    const stat = statSync(path);
    return stat.isDirectory() ? collectFiles(path) : [path];
  });
}

function isGeneratedManifestFile(file) {
  return file === manifestPath || file === signaturePath || file === checksumPath;
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function verifyMinisignSignature(manifest, signature) {
  if (!existsSync(minisignPublicKey)) {
    finish("failed", { reason: "missing minisign public key", expected: relative(ROOT, minisignPublicKey) }, 1);
  }
  const signatureLines = readFileSync(signature, "utf8").trim().split(/\r?\n/);
  if (!signatureLines.some((line) => /^[A-Za-z0-9+/]+={0,2}$/.test(line))) {
    finish("failed", { reason: "minisign signature has no base64 payload", signature: relative(ROOT, signature) }, 1);
  }
  const publicKey = readFileSync(minisignPublicKey, "utf8").trim().split(/\r?\n/).at(-1);
  const verify = spawnSync("minisign", ["-Vm", manifest, "-x", signature, "-P", publicKey], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe"
  });
  if (verify.status !== 0) {
    finish("failed", {
      reason: "minisign verification failed after signing",
      stdout: verify.stdout,
      stderr: verify.stderr
    }, verify.status ?? 1);
  }
}

function finish(status, details, exitCode) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/sign-release-directory-manifest.mjs",
    suite: "release-directory-manifest",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(ROOT, reportPath), ...details }, null, 2));
  process.exit(exitCode);
}
