#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const startedAt = performance.now();
const reportPath = join(root, "reports", "windows-tsf-build-report.json");

function finish(status, details, exitCode) {
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        command: "npm run build:windows",
        suite: "windows-tsf-build",
        durationMs: Math.round(performance.now() - startedAt),
        status,
        ...details
      },
      null,
      2
    )}\n`
  );
  console.log(JSON.stringify({ status, report: "reports/windows-tsf-build-report.json", ...details }, null, 2));
  process.exit(exitCode);
}

if (process.platform !== "win32") {
  finish(
    "blocked-native-environment",
    {
      reason: "Windows TSF DLL requires a Windows host with MSVC and the Windows SDK.",
      currentPlatform: `${process.platform}-${process.arch}`,
      manualCommands: [
        "cd native\\windows-tsf\\skeleton",
        ".\\build.ps1",
        ".\\register-dev.ps1"
      ]
    },
    2
  );
}

const cmakeVersion = spawnSync("cmake", ["--version"], { encoding: "utf8" });
if (cmakeVersion.status !== 0) {
  finish("failed", { reason: "cmake is required on Windows to build the TSF DLL.", stderr: cmakeVersion.stderr }, 1);
}

const sourceDir = join(root, "native", "windows-tsf", "skeleton");
const buildDir = join(sourceDir, "build");
const configure = spawnSync("cmake", ["-S", sourceDir, "-B", buildDir, "-A", "x64"], { encoding: "utf8", stdio: "pipe" });
if (configure.status !== 0) {
  finish("failed", { step: "configure", stdout: configure.stdout, stderr: configure.stderr }, configure.status ?? 1);
}

const build = spawnSync("cmake", ["--build", buildDir, "--config", "Release"], { encoding: "utf8", stdio: "pipe" });
if (build.status !== 0) {
  finish("failed", { step: "build", stdout: build.stdout, stderr: build.stderr }, build.status ?? 1);
}

const dll = join(buildDir, "bin", "Release", "LekhTextService.dll");
if (!existsSync(dll)) {
  finish("failed", { step: "artifact", reason: `Expected DLL was not found at ${dll}` }, 1);
}

finish("passed", { artifact: dll, cmake: cmakeVersion.stdout.split("\n")[0] }, 0);
