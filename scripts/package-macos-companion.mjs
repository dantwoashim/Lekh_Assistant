#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const startedAt = performance.now();
const signed = process.argv.includes("--signed");
const unsigned = process.argv.includes("--unsigned") || !signed;
const reportPath = join(root, "reports", signed ? "macos-signed-package-report.json" : "macos-unsigned-package-report.json");

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

if (signed && !process.env.LEKH_MAC_DEVELOPER_ID) {
  finish(
    "blocked-external",
    {
      reason: "Signed macOS release requires a Developer ID Application identity and notarization credentials.",
      requiredEnvironment: ["LEKH_MAC_DEVELOPER_ID", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
      unsignedDevCommand: "npm run package:macos:unsigned"
    },
    2
  );
}

const daemonBuild = spawnSync("npm", ["run", "build:daemon"], { cwd: root, encoding: "utf8", stdio: "pipe" });
if (daemonBuild.status !== 0) {
  finish("failed", { step: "daemon-build", stdout: daemonBuild.stdout, stderr: daemonBuild.stderr }, daemonBuild.status ?? 1);
}

const build = spawnSync("npm", ["run", "build"], { cwd: root, encoding: "utf8", stdio: "pipe" });
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

finish(unsigned ? "passed-unsigned-dev" : "passed-signed", { artifact: appBundle, signed: !unsigned }, 0);

function findAppBundle(dir) {
  if (!existsSync(dir)) return undefined;
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
