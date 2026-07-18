#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { readPortableExecutableIdentity } from "./windows-release-evidence.mjs";

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
const targets = [
  { architecture: "x64", buildDirectory: "build", expectedMachine: "x64" },
  { architecture: "Win32", buildDirectory: "build-Win32", expectedMachine: "x86" },
];
const artifacts = [];
for (const target of targets) {
  const buildDir = join(sourceDir, target.buildDirectory);
  const configure = spawnSync(
    "cmake",
    ["-S", sourceDir, "-B", buildDir, "-A", target.architecture, "-DBUILD_TESTING=ON"],
    { encoding: "utf8", stdio: "pipe" },
  );
  if (configure.status !== 0) {
    finish(
      "failed",
      {
        step: "configure",
        architecture: target.architecture,
        stdout: configure.stdout,
        stderr: configure.stderr,
      },
      configure.status ?? 1,
    );
  }

  const build = spawnSync("cmake", ["--build", buildDir, "--config", "Release"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (build.status !== 0) {
    finish(
      "failed",
      {
        step: "build",
        architecture: target.architecture,
        stdout: build.stdout,
        stderr: build.stderr,
      },
      build.status ?? 1,
    );
  }

  const nativeTests = spawnSync(
    "ctest",
    ["--test-dir", buildDir, "-C", "Release", "--output-on-failure"],
    { encoding: "utf8", stdio: "pipe" },
  );
  if (nativeTests.status !== 0) {
    finish(
      "failed",
      {
        step: "native-tests",
        architecture: target.architecture,
        stdout: nativeTests.stdout,
        stderr: nativeTests.stderr,
      },
      nativeTests.status ?? 1,
    );
  }

  const dll = join(buildDir, "bin", "Release", "LekhTextService.dll");
  if (!existsSync(dll)) {
    finish(
      "failed",
      { step: "artifact", architecture: target.architecture, reason: `Expected DLL was not found at ${dll}` },
      1,
    );
  }
  const dllIdentity = readPortableExecutableIdentity(dll);
  if (dllIdentity.machineName !== target.expectedMachine) {
    finish(
      "failed",
      {
        step: "artifact-architecture",
        architecture: target.architecture,
        expectedMachine: target.expectedMachine,
        actualMachine: dllIdentity.machineName,
        artifact: dll,
      },
      1,
    );
  }
  artifacts.push({ architecture: target.architecture, kind: "tsf-dll", path: dll, ...dllIdentity });

  if (target.architecture === "x64") {
    const broker = join(buildDir, "bin", "Release", "LekhPipeBroker.exe");
    if (!existsSync(broker)) {
      finish("failed", { step: "artifact", reason: `Expected named-pipe broker was not found at ${broker}` }, 1);
    }
    const brokerIdentity = readPortableExecutableIdentity(broker);
    if (brokerIdentity.machineName !== "x64") {
      finish(
        "failed",
        {
          step: "artifact-architecture",
          expectedMachine: "x64",
          actualMachine: brokerIdentity.machineName,
          artifact: broker,
        },
        1,
      );
    }
    artifacts.push({ architecture: "x64", kind: "pipe-broker", path: broker, ...brokerIdentity });
  }
}

finish("passed", {
  artifacts,
  architectures: targets.map((target) => target.architecture),
  cmake: cmakeVersion.stdout.split("\n")[0],
  nativeTests: "passed"
}, 0);
