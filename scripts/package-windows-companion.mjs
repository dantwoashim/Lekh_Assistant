#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const startedAt = performance.now();
const signed = process.argv.includes("--signed");
const unsigned = process.argv.includes("--unsigned") || !signed;
const supportedArchitectures = new Map([
  ["x64", { cmake: "x64", buildDirectory: "build", electronBuilder: "x64" }],
  ["arm64", { cmake: "ARM64", buildDirectory: "build-ARM64", electronBuilder: "arm64" }]
]);
const requestedArchitecture = (
  optionValue("--architecture") ?? process.env.LEKH_WINDOWS_ARCHITECTURE ?? "x64"
).toLowerCase();
const architecture = supportedArchitectures.get(requestedArchitecture);
const reportPath = join(root, "reports", signed ? "windows-signed-package-report.json" : "windows-unsigned-package-report.json");

if (!architecture) {
  finish("failed", {
    reason: `Unsupported Windows architecture ${JSON.stringify(requestedArchitecture)}.`,
    supportedArchitectures: [...supportedArchitectures.keys()]
  }, 1);
}

const tsfDll = join(root, "native", "windows-tsf", "skeleton", architecture.buildDirectory, "bin", "Release", "LekhTextService.dll");
const pipeBroker = join(root, "native", "windows-tsf", "skeleton", architecture.buildDirectory, "bin", "Release", "LekhPipeBroker.exe");

function finish(status, details, exitCode) {
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        command: signed ? "npm run package:windows" : "npm run package:windows:unsigned",
        suite: signed ? "windows-signed-installer" : "windows-unsigned-installer",
        durationMs: Math.round(performance.now() - startedAt),
        status,
        architecture: architecture?.electronBuilder ?? requestedArchitecture,
        ...details
      },
      null,
      2
    )}\n`
  );
  console.log(JSON.stringify({ status, report: reportPath.replace(`${root}/`, ""), ...details }, null, 2));
  process.exit(exitCode);
}

if (signed && (!process.env.CSC_LINK || !process.env.CSC_KEY_PASSWORD)) {
  finish(
    "blocked-external",
    {
      reason: "Signed Windows installer requires Authenticode certificate material.",
      requiredEnvironment: ["CSC_LINK", "CSC_KEY_PASSWORD"],
      unsignedDevCommand: "npm run package:windows:unsigned"
    },
    2
  );
}

if (process.platform !== "win32" && !process.env.LEKH_ALLOW_CROSS_WINDOWS_PACKAGE) {
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
  const nativeBuild = runNode(join(root, "scripts", "build-windows-tsf.mjs"), [
    "--architecture",
    architecture.cmake
  ]);
  if (nativeBuild.status !== 0) {
    finish("failed", {
      step: "windows-tsf-build",
      stdout: nativeBuild.stdout,
      stderr: nativeBuild.stderr,
      error: nativeBuild.error?.message
    }, nativeBuild.status ?? 1);
  }
}

if (!existsSync(tsfDll)) {
  finish("failed", {
    step: "windows-tsf-artifact",
    reason: "The required TSF DLL is missing. A companion-only installer is forbidden.",
    expectedArtifact: tsfDll,
    buildCommand: "npm run build:windows"
  }, 1);
}
if (!existsSync(pipeBroker)) {
  finish("failed", {
    step: "windows-pipe-broker-artifact",
    reason: "The required native named-pipe broker is missing. An unprotected daemon endpoint is forbidden.",
    expectedArtifact: pipeBroker,
    buildCommand: "npm run build:windows"
  }, 1);
}

const daemonBuild = runNode(join(root, "scripts", "bundle-daemon.mjs"));
if (daemonBuild.status !== 0) {
  finish("failed", {
    step: "daemon-build",
    stdout: daemonBuild.stdout,
    stderr: daemonBuild.stderr,
    error: daemonBuild.error?.message
  }, daemonBuild.status ?? 1);
}

const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
const build = runNode(viteBin, ["build", "--mode", "companion"]);
if (build.status !== 0) {
  finish("failed", {
    step: "vite-build",
    stdout: build.stdout,
    stderr: build.stderr,
    error: build.error?.message
  }, build.status ?? 1);
}

const tsxBin = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const serviceWorker = runNode(tsxBin, [join(root, "scripts", "write-service-worker.ts")]);
if (serviceWorker.status !== 0) {
  finish("failed", {
    step: "service-worker-build",
    stdout: serviceWorker.stdout,
    stderr: serviceWorker.stderr,
    error: serviceWorker.error?.message
  }, serviceWorker.status ?? 1);
}

const env = {
  ...process.env,
  LEKH_WINDOWS_ARCHITECTURE: architecture.electronBuilder,
  ...(unsigned ? { CSC_IDENTITY_AUTO_DISCOVERY: "false" } : {})
};
const electronBuilderBin = join(root, "node_modules", "electron-builder", "cli.js");
const builder = runNode(
  electronBuilderBin,
  ["--win", "nsis", `--${architecture.electronBuilder}`, "--publish=never", "--config", "electron-builder.config.cjs"],
  { env, timeout: 300_000 }
);
if (builder.status !== 0) {
  finish(
    builder.signal ? "timeout" : "failed",
    {
      step: "electron-builder",
      signal: builder.signal ?? null,
      stdout: builder.stdout,
      stderr: builder.stderr,
      error: builder.error?.message
    },
    builder.status ?? 1
  );
}

const releaseDir = join(root, "release");
const unpackedDirectory = join(
  releaseDir,
  architecture.electronBuilder === "arm64" ? "win-arm64-unpacked" : "win-unpacked"
);
const unpackedArtifacts = [
  join(unpackedDirectory, "Lekh Keyboard Companion.exe"),
  join(unpackedDirectory, "resources", "native", "windows-tsf", "build", "bin", "Release", "LekhTextService.dll"),
  join(unpackedDirectory, "resources", "native", "windows-tsf", "build", "bin", "Release", "LekhPipeBroker.exe"),
  join(unpackedDirectory, "resources", "native", "daemon", "lekh-keyboard-daemon.mjs")
];
const missingUnpackedArtifacts = unpackedArtifacts.filter((path) => !existsSync(path));
if (missingUnpackedArtifacts.length > 0) {
  finish("failed", {
    step: "unpacked-artifacts",
    reason: "electron-builder omitted required architecture-specific runtime files.",
    missingArtifacts: missingUnpackedArtifacts
  }, 1);
}

const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const exe = join(
  releaseDir,
  `Lekh-Keyboard-Companion-${packageVersion}-Setup-${architecture.electronBuilder}.exe`
);
if (!existsSync(exe)) {
  finish("failed", {
    step: "artifact",
    reason: "The architecture-specific Windows installer was not found.",
    expectedArtifact: exe
  }, 1);
}

finish(signed ? "passed-signed" : "passed-unsigned-dev", {
  artifact: exe,
  unpackedArtifacts,
  signed: !unsigned
}, 0);

function runNode(script, args = [], options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    ...options
  });
}

function optionValue(name) {
  const equalsArgument = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (equalsArgument) return equalsArgument.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
