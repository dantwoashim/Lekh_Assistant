#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import {
  artifactInventoriesMatch,
  discoverPortableExecutables,
  hasReleaseAliasInPath,
  normalizeSha256Fingerprint,
  readPortableExecutableIdentity,
  releaseTreeContainsAlias
} from "./windows-release-evidence.mjs";

const root = process.cwd();
const startedAt = performance.now();
const packagingStartedAt = Date.now();
const signed = process.argv.includes("--signed");
const explicitlyUnsigned = process.argv.includes("--unsigned");
if (signed === explicitlyUnsigned) {
  console.error("Choose exactly one packaging mode: --signed or --unsigned.");
  process.exit(2);
}
const unsigned = explicitlyUnsigned;
const reportPath = join(root, "reports", signed ? "windows-signed-package-report.json" : "windows-unsigned-package-report.json");
const tsfDll = join(root, "native", "windows-tsf", "skeleton", "build", "bin", "Release", "LekhTextService.dll");
const tsfDllX86 = join(root, "native", "windows-tsf", "skeleton", "build-Win32", "bin", "Release", "LekhTextService.dll");
const pipeBroker = join(root, "native", "windows-tsf", "skeleton", "build", "bin", "Release", "LekhPipeBroker.exe");
const packageMetadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const releaseDir = join(root, "release");
const expectedInstaller = join(
  releaseDir,
  `Lekh-Keyboard-Companion-${packageMetadata.version}-Setup-x64.exe`
);
const sourceRevision = gitOutput(["rev-parse", "HEAD"]);
const sourceWasClean = gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]) === "";
const expectedSignerSha256 = normalizeSha256Fingerprint(process.env.LEKH_WINDOWS_SIGNER_SHA256);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function finish(status, details, exitCode) {
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        command: signed ? "npm run package:windows" : "npm run package:windows:unsigned",
        suite: signed ? "windows-signed-installer" : "windows-unsigned-installer",
        packagingPlatform: process.platform,
        packagingArch: process.arch,
        durationMs: Math.round(performance.now() - startedAt),
        status,
        ...details
      },
      null,
      2
    )}\n`
  );
  console.log(JSON.stringify({ status, report: reportPath.replace(`${root}/`, ""), ...details }, null, 2));
  process.exit(exitCode);
}

if (signed && (!process.env.CSC_LINK || !process.env.CSC_KEY_PASSWORD || !expectedSignerSha256)) {
  finish(
    "blocked-external",
    {
      reason: "Signed Windows installer requires certificate material and an independently pinned SHA-256 signer certificate fingerprint.",
      requiredEnvironment: ["CSC_LINK", "CSC_KEY_PASSWORD", "LEKH_WINDOWS_SIGNER_SHA256"],
      unsignedDevCommand: "npm run package:windows:unsigned"
    },
    2
  );
}

if (signed && !sourceWasClean) {
  finish(
    "failed",
    {
      step: "source-provenance",
      reason: "Signed release packaging requires a clean, committed source tree.",
      sourceRevision
    },
    1
  );
}

if (signed && process.platform !== "win32") {
  finish(
    "blocked-native-environment",
    {
      reason: "Signed Windows release evidence must be produced and verified on Windows; the cross-package override is development-only.",
      currentPlatform: `${process.platform}-${process.arch}`
    },
    2
  );
}

if (unsigned && process.platform !== "win32" && !process.env.LEKH_ALLOW_CROSS_WINDOWS_PACKAGE) {
  finish(
    "blocked-native-environment",
    {
      reason: "Windows NSIS installer and TSF registration must be produced on a Windows release machine. Cross-packaging can be attempted with LEKH_ALLOW_CROSS_WINDOWS_PACKAGE=1, but it is not release evidence.",
      currentPlatform: `${process.platform}-${process.arch}`,
      manualCommands: [
        "npm ci",
        "npm run build:daemon",
        "npm run build:companion-ui",
        "npm run build:windows",
        signed ? "npm run package:windows" : "npm run package:windows:unsigned",
        "npm run check:windows-release"
      ]
    },
    2
  );
}

if (process.platform === "win32") {
  const nativeBuild = spawnSync(npmCommand, ["run", "build:windows"], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe"
  });
  if (nativeBuild.status !== 0) {
    finish("failed", {
      step: "windows-tsf-build",
      stdout: nativeBuild.stdout,
      stderr: nativeBuild.stderr
    }, nativeBuild.status ?? 1);
  }
}

for (const expected of [
  { path: tsfDll, kind: "x64 TSF DLL", machine: "x64" },
  { path: tsfDllX86, kind: "x86 TSF DLL", machine: "x86" },
  { path: pipeBroker, kind: "x64 named-pipe broker", machine: "x64" },
]) {
  if (!existsSync(expected.path) || !statSync(expected.path).isFile()) {
    finish("failed", {
      step: "windows-native-artifact",
      reason: `The required ${expected.kind} is missing. A partial keyboard installer is forbidden.`,
      expectedArtifact: expected.path,
      buildCommand: "npm run build:windows"
    }, 1);
  }
  let identity;
  try {
    identity = readPortableExecutableIdentity(expected.path);
  } catch (error) {
    finish("failed", {
      step: "windows-native-artifact",
      reason: error instanceof Error ? error.message : String(error),
      expectedArtifact: expected.path,
    }, 1);
  }
  if (identity.machineName !== expected.machine) {
    finish("failed", {
      step: "windows-native-architecture",
      reason: `${expected.kind} has machine ${identity.machineName}; expected ${expected.machine}.`,
      expectedArtifact: expected.path,
    }, 1);
  }
}

const daemonBuild = spawnSync(npmCommand, ["run", "build:daemon"], { cwd: root, encoding: "utf8", stdio: "pipe" });
if (daemonBuild.status !== 0) {
  finish("failed", { step: "daemon-build", stdout: daemonBuild.stdout, stderr: daemonBuild.stderr }, daemonBuild.status ?? 1);
}

const build = spawnSync(npmCommand, ["run", "build:companion-ui"], { cwd: root, encoding: "utf8", stdio: "pipe" });
if (build.status !== 0) {
  finish("failed", { step: "vite-build", stdout: build.stdout, stderr: build.stderr }, build.status ?? 1);
}

const env = {
  ...process.env,
  ...(unsigned ? { CSC_IDENTITY_AUTO_DISCOVERY: "false" } : {})
};
const electronBuilderBin = join(root, "node_modules", ".bin", process.platform === "win32" ? "electron-builder.cmd" : "electron-builder");
const builder = spawnSync(
  electronBuilderBin,
  ["--win", "nsis", "--x64", "--publish=never", "--config", "electron-builder.config.cjs"],
  { cwd: root, encoding: "utf8", stdio: "pipe", env, timeout: 300_000 }
);
if (builder.status !== 0) {
  finish(
    builder.signal ? "timeout" : "failed",
    {
      step: "electron-builder",
      signal: builder.signal ?? null,
      stdout: builder.stdout,
      stderr: builder.stderr
    },
    builder.status ?? 1
  );
}

if (!existsSync(expectedInstaller)) {
  finish("failed", {
    step: "artifact",
    reason: "The exact versioned x64 NSIS installer was not produced.",
    expectedArtifact: reportPathFor(expectedInstaller)
  }, 1);
}
const installerStat = statSync(expectedInstaller);
if (!installerStat.isFile() || installerStat.mtimeMs + 2_000 < packagingStartedAt) {
  finish("failed", {
    step: "artifact-freshness",
    reason: "The expected installer predates this packaging invocation; stale release artifacts are forbidden.",
    expectedArtifact: reportPathFor(expectedInstaller),
    packagingStartedAt: new Date(packagingStartedAt).toISOString(),
    artifactModifiedAt: new Date(installerStat.mtimeMs).toISOString()
  }, 1);
}

const requiredPackagedBinaries = [
  expectedInstaller,
  join(releaseDir, "win-unpacked", "Lekh Keyboard Companion.exe"),
  join(releaseDir, "win-unpacked", "resources", "native", "windows-tsf", "build", "bin", "Release", "LekhTextService.dll"),
  join(releaseDir, "win-unpacked", "resources", "native", "windows-tsf", "build-Win32", "bin", "Release", "LekhTextService.dll"),
  join(releaseDir, "win-unpacked", "resources", "native", "windows-tsf", "build", "bin", "Release", "LekhPipeBroker.exe")
];
const missingPackagedBinaries = requiredPackagedBinaries.filter((artifact) => !existsSync(artifact) || !statSync(artifact).isFile());
if (missingPackagedBinaries.length > 0) {
  finish("failed", {
    step: "packaged-native-inventory",
    reason: "The installer staging tree is incomplete.",
    missingArtifacts: missingPackagedBinaries.map(reportPathFor)
  }, 1);
}
if (releaseTreeContainsAlias(join(releaseDir, "win-unpacked"))) {
  finish("failed", {
    step: "packaged-release-tree",
    reason: "The unpacked release contains a symbolic link, hard link, junction, mount point, or other reparse-point alias."
  }, 1);
}
let packagedBinaries;
try {
  packagedBinaries = [
    expectedInstaller,
    ...discoverPortableExecutables(join(releaseDir, "win-unpacked"))
  ];
} catch (error) {
  finish("failed", {
    step: "packaged-executable-inventory",
    reason: error instanceof Error ? error.message : String(error)
  }, 1);
}
const linkedPackagedBinaries = packagedBinaries.filter((artifact) => hasReleaseAliasInPath(releaseDir, artifact));
if (linkedPackagedBinaries.length > 0) {
  finish("failed", {
    step: "packaged-native-inventory",
    reason: "Symbolic links or reparse-point aliases are forbidden in release evidence.",
    linkedArtifacts: linkedPackagedBinaries.map(reportPathFor)
  }, 1);
}
const binaryInventory = packagedBinaries.map(artifactIdentity);

let signatureVerification = [];
if (signed) {
  const signTool = resolveSignTool();
  if (!signTool) {
    finish("blocked-native-environment", {
      step: "authenticode-verification",
      reason: "signtool.exe was not found. Set LEKH_SIGNTOOL_PATH or install the Windows SDK.",
      sourceRevision
    }, 2);
  }
  signatureVerification = packagedBinaries.map((artifact) => verifyAuthenticode(
    signTool,
    artifact,
    expectedSignerSha256,
    requiredPackagedBinaries.includes(artifact)
  ));
  const failedVerification = signatureVerification.find((result) => !result.verified);
  if (failedVerification) {
    finish("failed", {
      step: "authenticode-verification",
      reason: "Authenticode verification failed or reported a missing timestamp.",
      verification: signatureVerification
    }, 1);
  }
}

let finalPackagedBinaries;
try {
  if (releaseTreeContainsAlias(join(releaseDir, "win-unpacked"))) {
    throw new Error("The unpacked release acquired a filesystem alias during verification.");
  }
  finalPackagedBinaries = [
    expectedInstaller,
    ...discoverPortableExecutables(join(releaseDir, "win-unpacked"))
  ];
} catch (error) {
  finish("failed", {
    step: "artifact-stability-final",
    reason: error instanceof Error ? error.message : String(error)
  }, 1);
}
const finalLinkedBinaries = finalPackagedBinaries.filter((candidate) =>
  hasReleaseAliasInPath(releaseDir, candidate)
);
const finalBinaryInventory = finalLinkedBinaries.length === 0
  ? finalPackagedBinaries.map(artifactIdentity)
  : [];
const releaseArtifactsRemainedStable = finalLinkedBinaries.length === 0 &&
  artifactInventoriesMatch(binaryInventory, finalBinaryInventory);
if (!releaseArtifactsRemainedStable) {
  finish("failed", {
    step: "artifact-stability-final",
    reason: "The release executable inventory, bytes, timestamps, or filesystem ownership changed during verification.",
    linkedArtifacts: finalLinkedBinaries.map(reportPathFor)
  }, 1);
}

const finalSourceRevision = gitOutput(["rev-parse", "HEAD"]);
const sourceRemainedClean = sourceWasClean && finalSourceRevision === sourceRevision &&
  gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]) === "";
if (signed && !sourceRemainedClean) {
  finish("failed", {
    step: "source-provenance-final",
    reason: "The source revision or worktree changed while signed artifacts were being built and verified.",
    sourceRevision,
    finalSourceRevision,
    sourceWasClean,
    sourceRemainedClean
  }, 1);
}

const artifact = finalBinaryInventory.find((entry) => entry.path === reportPathFor(expectedInstaller));

finish(signed ? "passed-signed" : "passed-unsigned-dev", {
  artifact,
  signed: !unsigned,
  sourceRevision,
  sourceWasClean,
  sourceRemainedClean,
  releaseArtifactsRemainedStable,
  expectedSignerSha256: signed ? expectedSignerSha256 : null,
  signatureVerification,
  binaryInventory: finalBinaryInventory
}, 0);

function gitOutput(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function reportPathFor(path) {
  return relative(root, path).replaceAll("\\", "/");
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function artifactIdentity(file) {
  const details = statSync(file);
  const executable = readPortableExecutableIdentity(file);
  return {
    path: reportPathFor(file),
    bytes: details.size,
    sha256: sha256File(file),
    modifiedAt: new Date(details.mtimeMs).toISOString(),
    machine: executable.machineName,
  };
}

function resolveSignTool() {
  const configured = process.env.LEKH_SIGNTOOL_PATH;
  if (configured && existsSync(configured) && statSync(configured).isFile()) return configured;
  const located = spawnSync("where.exe", ["signtool.exe"], { encoding: "utf8", stdio: "pipe" });
  if (located.status === 0) {
    const candidate = located.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (candidate && existsSync(candidate)) return candidate;
  }

  const kitsRoots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]
    .filter(Boolean)
    .map((directory) => join(directory, "Windows Kits", "10", "bin"))
    .filter((directory) => existsSync(directory));
  const candidates = [];
  for (const kitsRoot of kitsRoots) {
    for (const version of readdirSync(kitsRoot)) {
      const candidate = join(kitsRoot, version, "x64", "signtool.exe");
      if (existsSync(candidate) && statSync(candidate).isFile()) candidates.push(candidate);
    }
  }
  return candidates.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0];
}

function verifyAuthenticode(signTool, artifact, expectedSigner, requiresPinnedSigner) {
  const verification = spawnSync(
    signTool,
    ["verify", "/pa", "/all", "/v", "/tw", artifact],
    {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 60_000,
      env: { ...process.env, VSLANG: "1033" }
    }
  );
  const output = `${verification.stdout ?? ""}\n${verification.stderr ?? ""}`.trim();
  const signerSha256 = readSignerSha256(artifact);
  const timestampVerified = /Number of warnings:\s*0/i.test(output) && !/SignTool Warning/i.test(output);
  const signatureValid = verification.status === 0 && timestampVerified && signerSha256 !== null;
  const signerMatchesExpected = signerSha256 === expectedSigner;
  return {
    artifact: reportPathFor(artifact),
    verified: signatureValid && (!requiresPinnedSigner || signerMatchesExpected),
    signatureValid,
    requiresPinnedSigner,
    exitCode: verification.status,
    signal: verification.signal ?? null,
    signerSha256,
    signerMatchesExpected,
    timestampVerified,
    output
  };
}

function readSignerSha256(artifact) {
  const script = [
    "$signature = Get-AuthenticodeSignature -LiteralPath $args[0]",
    "if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { exit 3 }",
    "$sha = [System.Security.Cryptography.SHA256]::Create()",
    "$bytes = $sha.ComputeHash($signature.SignerCertificate.RawData)",
    "[System.BitConverter]::ToString($bytes).Replace('-', '')"
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script, artifact],
    { cwd: root, encoding: "utf8", stdio: "pipe", timeout: 30_000 }
  );
  return result.status === 0 ? normalizeSha256Fingerprint(result.stdout.trim()) : null;
}
