#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const startedAt = performance.now();
const signed = process.argv.includes("--signed");
const unsigned = process.argv.includes("--unsigned") || !signed;
const reportPath = join(root, "reports", signed ? "windows-signed-package-report.json" : "windows-unsigned-package-report.json");
const tsfDll = join(root, "native", "windows-tsf", "skeleton", "build", "bin", "Release", "LekhTextService.dll");
const pipeBroker = join(root, "native", "windows-tsf", "skeleton", "build", "bin", "Release", "LekhPipeBroker.exe");

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
  const nativeBuild = runNode(join(root, "scripts", "build-windows-tsf.mjs"));
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
  ...(unsigned ? { CSC_IDENTITY_AUTO_DISCOVERY: "false" } : {})
};
const electronBuilderBin = join(root, "node_modules", "electron-builder", "cli.js");
const builder = runNode(
  electronBuilderBin,
  ["--win", "nsis", "--x64", "--publish=never", "--config", "electron-builder.config.cjs"],
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
const exe = existsSync(releaseDir)
  ? findInstallerExe(releaseDir)
  : undefined;
if (!exe) {
  finish("failed", { step: "artifact", reason: "No Windows installer .exe found in release/." }, 1);
}

finish(signed ? "passed-signed" : "passed-unsigned-dev", { artifact: exe, signed: !unsigned }, 0);

function runNode(script, args = [], options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    ...options
  });
}

function findInstallerExe(dir) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const nested = findInstallerExe(full);
      if (nested) return nested;
    }
    if (/Setup.*\.exe$|\.exe$/i.test(entry)) return full;
  }
  return undefined;
}
