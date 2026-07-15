#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const startedAt = performance.now();
const signed = process.argv.includes("--signed");
const unsigned = process.argv.includes("--unsigned") || !signed;
const reportPath = join(root, "reports", signed ? "macos-signed-package-report.json" : "macos-unsigned-package-report.json");
const stableAppBundle = join(root, "release", "Lekh Keyboard Companion.app");

function finish(status, details, exitCode) {
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        command: signed ? "npm run package:macos" : "npm run package:macos:unsigned",
        suite: signed ? "macos-signed-companion" : "macos-unsigned-companion",
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

if (process.platform !== "darwin") {
  finish(
    "blocked-native-environment",
    {
      reason: "macOS companion packaging must run on macOS.",
      currentPlatform: `${process.platform}-${process.arch}`
    },
    2
  );
}

const requiredSigningEnvironment = [
  "LEKH_MAC_DEVELOPER_ID",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID"
];
const missingSigningEnvironment = requiredSigningEnvironment.filter((key) => !process.env[key]);

if (signed && missingSigningEnvironment.length > 0) {
  finish(
    "blocked-external",
    {
      reason: "Signed macOS release requires a Developer ID Application identity and notarization credentials.",
      requiredEnvironment: requiredSigningEnvironment,
      missingEnvironment: missingSigningEnvironment,
      unsignedDevCommand: "npm run package:macos:unsigned"
    },
    2
  );
}

rmSync(stableAppBundle, { recursive: true, force: true });

const daemonBuild = spawnSync("npm", ["run", "build:daemon"], { cwd: root, encoding: "utf8", stdio: "pipe" });
if (daemonBuild.status !== 0) {
  finish("failed", { step: "daemon-build", stdout: daemonBuild.stdout, stderr: daemonBuild.stderr }, daemonBuild.status ?? 1);
}

const build = spawnSync("npm", ["run", "build:companion-ui"], { cwd: root, encoding: "utf8", stdio: "pipe" });
if (build.status !== 0) {
  finish("failed", { step: "vite-build", stdout: build.stdout, stderr: build.stderr }, build.status ?? 1);
}

const env = {
  ...process.env,
  ...(unsigned ? { CSC_IDENTITY_AUTO_DISCOVERY: "false" } : {})
};
const electronBuilderBin = join(root, "node_modules", ".bin", "electron-builder");
const targetArgs = unsigned
  ? ["--mac", "dir", "--publish=never", "--config", "electron-builder.config.cjs", "-c.mac.identity=null"]
  : ["--mac", "dmg", "--publish=never", "--config", "electron-builder.config.cjs"];
const builder = spawnSync(electronBuilderBin, targetArgs, { cwd: root, encoding: "utf8", stdio: "pipe", env, timeout: 300_000 });
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

const appBundle = findAppBundle(join(root, "release"));
if (!appBundle) {
  finish("failed", { step: "artifact", reason: "No macOS .app bundle found in release/." }, 1);
}

if (appBundle !== stableAppBundle) {
  rmSync(stableAppBundle, { recursive: true, force: true });
  const copy = spawnSync("ditto", [appBundle, stableAppBundle], { cwd: root, encoding: "utf8", stdio: "pipe" });
  if (copy.status !== 0) {
    finish("failed", { step: "stable-artifact-copy", sourceArtifact: appBundle, stdout: copy.stdout, stderr: copy.stderr }, copy.status ?? 1);
  }
}

let notarizedArtifact = null;
if (signed) {
  runRequired("codesign-verify", "codesign", ["--verify", "--deep", "--strict", "--verbose=2", stableAppBundle]);
  const dmg = findArtifact(join(root, "release"), ".dmg");
  if (!dmg) {
    finish("failed", { step: "notarization", reason: "Signed release did not produce a DMG for notarization." }, 1);
  }
  runRequired("notarytool", "xcrun", [
    "notarytool",
    "submit",
    dmg,
    "--apple-id",
    process.env.APPLE_ID,
    "--password",
    process.env.APPLE_APP_SPECIFIC_PASSWORD,
    "--team-id",
    process.env.APPLE_TEAM_ID,
    "--wait"
  ]);
  runRequired("staple-app", "xcrun", ["stapler", "staple", stableAppBundle]);
  runRequired("staple-dmg", "xcrun", ["stapler", "staple", dmg]);
  runRequired("gatekeeper-assess", "spctl", ["--assess", "--type", "execute", "--verbose=2", stableAppBundle]);
  runRequired("validate-app-staple", "xcrun", ["stapler", "validate", stableAppBundle]);
  runRequired("validate-staple", "xcrun", ["stapler", "validate", dmg]);
  notarizedArtifact = dmg;
}

finish(unsigned ? "passed-unsigned-dev" : "passed-signed-notarized", {
  artifact: stableAppBundle,
  sourceArtifact: appBundle,
  signed: !unsigned,
  notarizedArtifact
}, 0);

function findAppBundle(dir) {
  if (!existsSync(dir)) return undefined;
  const preferred = [
    join(dir, `mac-${process.arch}`, "Lekh Keyboard Companion.app"),
    join(dir, "mac-universal", "Lekh Keyboard Companion.app")
  ];
  for (const candidate of preferred) {
    if (existsSync(candidate)) return candidate;
  }
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (/\.app$/i.test(entry)) return full;
      const nested = findAppBundle(full);
      if (nested) return nested;
    }
  }
  return undefined;
}

function findArtifact(dir, extension) {
  if (!existsSync(dir)) return undefined;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const nested = findArtifact(full, extension);
      if (nested) return nested;
    } else if (entry.toLowerCase().endsWith(extension)) {
      return full;
    }
  }
  return undefined;
}

function runRequired(step, command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe", timeout: 900_000 });
  if (result.status !== 0) {
    finish(result.signal ? "timeout" : "failed", {
      step,
      signal: result.signal ?? null,
      stdout: result.stdout,
      stderr: result.stderr
    }, result.status ?? 1);
  }
}
