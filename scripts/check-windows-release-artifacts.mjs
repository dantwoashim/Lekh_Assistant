#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { verifyHardenedElectronFusePolicy } from "./lib/electron-fuse-policy.mjs";

const root = process.cwd();
const startedAt = performance.now();
const releaseDirectory = join(root, "release");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const architecture = (process.env.LEKH_WINDOWS_ARCHITECTURE ?? "x64").toLowerCase();
const architecturePolicy = new Map([
  ["x64", { unpacked: "win-unpacked", machine: 0x8664, nativeBuild: "build" }],
  ["arm64", { unpacked: "win-arm64-unpacked", machine: 0xaa64, nativeBuild: "build-ARM64" }]
]).get(architecture);
const failures = [];

if (!architecturePolicy) {
  failures.push(`Unsupported Windows release architecture: ${architecture}.`);
}

const unpackedDirectory = architecturePolicy
  ? join(releaseDirectory, architecturePolicy.unpacked)
  : join(releaseDirectory, "invalid-architecture");
const artifacts = [
  {
    label: "installer",
    path: join(releaseDirectory, `Lekh-Keyboard-Companion-${manifest.version}-Setup-${architecture}.exe`),
    authenticode: true
  },
  {
    label: "companion",
    path: join(unpackedDirectory, "Lekh Keyboard Companion.exe"),
    authenticode: true,
    expectedMachine: architecturePolicy?.machine
  },
  {
    label: "app-asar",
    path: join(unpackedDirectory, "resources", "app.asar"),
    authenticode: false,
    maximumBytes: 16 * 1024 * 1024
  },
  {
    label: "primary-tsf",
    path: join(unpackedDirectory, "resources", "native", "windows-tsf", "build", "bin", "Release", "LekhTextService.dll"),
    sourcePath: architecturePolicy
      ? join(root, "native", "windows-tsf", "skeleton", architecturePolicy.nativeBuild, "bin", "Release", "LekhTextService.dll")
      : null,
    authenticode: true,
    expectedMachine: architecturePolicy?.machine
  },
  {
    label: "pipe-broker",
    path: join(unpackedDirectory, "resources", "native", "windows-tsf", "build", "bin", "Release", "LekhPipeBroker.exe"),
    sourcePath: architecturePolicy
      ? join(root, "native", "windows-tsf", "skeleton", architecturePolicy.nativeBuild, "bin", "Release", "LekhPipeBroker.exe")
      : null,
    authenticode: true,
    expectedMachine: architecturePolicy?.machine
  },
  {
    label: "daemon",
    path: join(unpackedDirectory, "resources", "native", "daemon", "lekh-keyboard-daemon.mjs"),
    sourcePath: join(root, "native", "daemon", "dist", "lekh-keyboard-daemon.mjs"),
    authenticode: false
  },
  {
    label: "compatibility-tsf",
    path: join(unpackedDirectory, "resources", "native", "windows-tsf", "build-x86", "bin", "Release", "LekhTextService.dll"),
    sourcePath: join(root, "native", "windows-tsf", "skeleton", "build-Win32", "bin", "Release", "LekhTextService.dll"),
    authenticode: true,
    expectedMachine: 0x014c
  }
];

for (const artifact of artifacts) {
  if (!existsSync(artifact.path)) failures.push(`Missing ${artifact.label}: ${artifact.path}`);
  if (artifact.sourcePath && !existsSync(artifact.sourcePath)) {
    failures.push(`Missing source artifact for ${artifact.label}: ${artifact.sourcePath}`);
  }
}

const artifactEvidence = [];
for (const artifact of artifacts) {
  if (!existsSync(artifact.path)) continue;
  const evidence = {
    label: artifact.label,
    path: workspacePath(artifact.path),
    bytes: statSync(artifact.path).size,
    sha256: await sha256(artifact.path)
  };
  if (artifact.maximumBytes !== undefined) {
    evidence.maximumBytes = artifact.maximumBytes;
    if (evidence.bytes > artifact.maximumBytes) {
      failures.push(`${artifact.label} is ${evidence.bytes} bytes; maximum is ${artifact.maximumBytes}.`);
    }
  }
  if (artifact.expectedMachine !== undefined) {
    try {
      evidence.peMachine = readPeMachine(artifact.path);
      evidence.expectedPeMachine = artifact.expectedMachine;
      if (evidence.peMachine !== artifact.expectedMachine) {
        failures.push(
          `${artifact.label} PE machine is 0x${evidence.peMachine.toString(16)}; expected 0x${artifact.expectedMachine.toString(16)}.`
        );
      }
    } catch (error) {
      failures.push(`${artifact.label} PE header could not be verified: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (artifact.sourcePath && existsSync(artifact.sourcePath)) {
    evidence.sourceSha256 = await sha256(artifact.sourcePath);
    evidence.matchesSourceArtifact = evidence.sha256 === evidence.sourceSha256;
    if (!evidence.matchesSourceArtifact) {
      failures.push(`${artifact.label} does not byte-match the build artifact copied into the package.`);
    }
  }
  artifactEvidence.push(evidence);
}

let fuseVerification = null;
const companion = artifacts.find((artifact) => artifact.label === "companion");
if (companion && existsSync(companion.path)) {
  try {
    fuseVerification = await verifyHardenedElectronFusePolicy(companion.path);
    if (!fuseVerification.valid) failures.push("The packaged companion does not match the complete Electron fuse policy.");
  } catch (error) {
    failures.push(`The packaged Electron fuse wire could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let signatures = null;
let signed = false;
if (process.platform === "win32") {
  try {
    signatures = inspectAuthenticode(
      artifacts.filter((artifact) => artifact.authenticode && existsSync(artifact.path)).map((artifact) => artifact.path)
    );
    const statuses = signatures.map((signature) => signature.status);
    const allValid = statuses.length > 0 && statuses.every((status) => status === "Valid");
    const allUnsigned = statuses.length > 0 && statuses.every((status) => status === "NotSigned");
    signed = allValid;
    if (!allValid && !allUnsigned) {
      failures.push(`Authenticode state is mixed or invalid: ${statuses.join(", ")}.`);
    }
  } catch (error) {
    failures.push(`Authenticode inspection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const status = failures.length > 0
  ? "failed"
  : signed
    ? "passed-signed"
    : process.platform === "win32"
      ? "passed-dev-installer"
      : "passed-signature-unverified";
const report = {
  generatedAt: new Date().toISOString(),
  command: "npm run check:windows-release",
  suite: "windows-release-artifacts",
  durationMs: Math.round(performance.now() - startedAt),
  status,
  architecture,
  signed,
  artifacts: artifactEvidence,
  electronFuses: fuseVerification,
  authenticode: signatures,
  failures,
  note: signed
    ? "Every signable release artifact has a valid Authenticode signature. Certificate-chain and timestamp policy still belong in the controlled release-host attestation."
    : "Unsigned artifacts are development evidence only and must not be presented as a trusted public release."
};

mkdirSync(join(root, "reports"), { recursive: true });
writeFileSync(join(root, "reports", "windows-release-artifacts-report.json"), `${JSON.stringify(report, null, 2)}\n`);

const result = {
  status,
  installer: workspacePath(artifacts[0].path),
  signed,
  artifactCount: artifactEvidence.length,
  electronFuseCount: fuseVerification?.wireFuseCount ?? null,
  failures,
  report: "reports/windows-release-artifacts-report.json"
};
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exit(1);

function workspacePath(path) {
  return relative(root, path).replaceAll("\\", "/");
}

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

function readPeMachine(path) {
  const descriptor = openSync(path, "r");
  try {
    const dosHeader = Buffer.alloc(64);
    if (readSync(descriptor, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length || dosHeader.readUInt16LE(0) !== 0x5a4d) {
      throw new Error("missing DOS header");
    }
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(6);
    if (readSync(descriptor, peHeader, 0, peHeader.length, peOffset) !== peHeader.length || peHeader.readUInt32LE(0) !== 0x00004550) {
      throw new Error("missing PE signature");
    }
    return peHeader.readUInt16LE(4);
  } finally {
    closeSync(descriptor);
  }
}

function inspectAuthenticode(paths) {
  const executable = process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$signaturePaths = ConvertFrom-Json -InputObject $env:LEKH_AUTHENTICODE_PATHS",
    "$records = @(foreach ($path in $signaturePaths) {",
    "  $signature = Get-AuthenticodeSignature -LiteralPath ([string]$path)",
    "  [pscustomobject]@{",
    "    path = [string]$path",
    "    status = [string]$signature.Status",
    "    statusMessage = [string]$signature.StatusMessage",
    "    signerSubject = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null })",
    "    signerThumbprint = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null })",
    "    timestampSubject = $(if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { $null })",
    "  }",
    "})",
    "ConvertTo-Json -InputObject $records -Compress -Depth 4"
  ].join("\n");
  const environment = { ...process.env, LEKH_AUTHENTICODE_PATHS: JSON.stringify(paths) };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "psmodulepath") delete environment[key];
  }
  const result = spawnSync(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: environment
    }
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `PowerShell exited ${result.status}`).trim());
  }
  const parsed = JSON.parse(result.stdout.trim());
  return (Array.isArray(parsed) ? parsed : [parsed]).map((signature) => ({
    ...signature,
    path: workspacePath(signature.path)
  }));
}
