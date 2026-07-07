#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const startedAt = performance.now();
const reportPath = join(root, "reports", "macos-imk-build-report.json");
const skeletonDir = join(root, "native", "macos-imk", "skeleton");
const placeholder = join(skeletonDir, "LekhInputController.placeholder.swift");

function finish(status, details, exitCode) {
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        command: "npm run build:macos",
        suite: "macos-imk-build",
        durationMs: Math.round(performance.now() - startedAt),
        status,
        ...details
      },
      null,
      2
    )}\n`
  );
  console.log(JSON.stringify({ status, report: "reports/macos-imk-build-report.json", ...details }, null, 2));
  process.exit(exitCode);
}

if (process.platform !== "darwin") {
  finish(
    "blocked-native-environment",
    {
      reason: "macOS IMK must be built and enabled on macOS.",
      currentPlatform: `${process.platform}-${process.arch}`
    },
    2
  );
}

if (existsSync(placeholder) && readFileSync(placeholder, "utf8").includes("placeholder")) {
  finish(
    "blocked-native-implementation",
    {
      reason: "macOS IMK source is still a placeholder. Implement IMKInputController, marked text, candidate UI, an in-process fail-open engine, and install/enable/uninstall before claiming macOS native readiness.",
      requiredFiles: [
        "native/macos-imk/skeleton/LekhInputController.swift",
        "native/macos-imk/skeleton/LekhCandidateController.swift",
        "native/macos-imk/skeleton/LekhEngineCore.swift"
      ]
    },
    2
  );
}

const swift = spawnSync("swift", ["build"], { cwd: skeletonDir, encoding: "utf8", stdio: "pipe" });
if (swift.status !== 0) {
  finish("failed", { step: "swift-build", stdout: swift.stdout, stderr: swift.stderr }, swift.status ?? 1);
}

finish("passed", { stdout: swift.stdout }, 0);
