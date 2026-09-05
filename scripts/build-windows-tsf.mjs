#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const startedAt = performance.now();
const reportPath = join(root, "reports", "windows-tsf-build-report.json");
const supportedArchitectures = new Map([
  ["x64", { cmake: "x64", buildDirectory: "build" }],
  ["x86", { cmake: "Win32", buildDirectory: "build-Win32" }],
  ["win32", { cmake: "Win32", buildDirectory: "build-Win32" }],
  ["arm64", { cmake: "ARM64", buildDirectory: "build-ARM64" }]
]);
const requestedArchitecture = (
  optionValue("--architecture") ?? process.env.LEKH_WINDOWS_ARCHITECTURE ?? "x64"
).toLowerCase();
const architecture = supportedArchitectures.get(requestedArchitecture);

if (!architecture) {
  finish("failed", {
    reason: `Unsupported Windows architecture ${JSON.stringify(requestedArchitecture)}.`,
    supportedArchitectures: [...supportedArchitectures.keys()]
  }, 1);
}

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

const cmakeExecutable = resolveCmakeExecutable();
const ctestExecutable = cmakeExecutable === "cmake"
  ? "ctest"
  : join(dirname(cmakeExecutable), "ctest.exe");
const cmakeVersion = spawnSync(cmakeExecutable, ["--version"], { encoding: "utf8" });
if (cmakeVersion.status !== 0) {
  finish("failed", { reason: "cmake is required on Windows to build the TSF DLL.", stderr: cmakeVersion.stderr }, 1);
}

const sourceDir = join(root, "native", "windows-tsf", "skeleton");
const buildDir = join(sourceDir, architecture.buildDirectory);
const configure = spawnSync(cmakeExecutable, ["-S", sourceDir, "-B", buildDir, "-A", architecture.cmake], { encoding: "utf8", stdio: "pipe" });
if (configure.status !== 0) {
  finish("failed", { step: "configure", stdout: configure.stdout, stderr: configure.stderr }, configure.status ?? 1);
}

const build = spawnSync(cmakeExecutable, ["--build", buildDir, "--config", "Release"], { encoding: "utf8", stdio: "pipe" });
if (build.status !== 0) {
  finish("failed", { step: "build", stdout: build.stdout, stderr: build.stderr }, build.status ?? 1);
}

const nativeTests = spawnSync(ctestExecutable, ["--test-dir", buildDir, "-C", "Release", "--output-on-failure"], {
  encoding: "utf8",
  stdio: "pipe"
});
if (nativeTests.status !== 0) {
  finish("failed", { step: "native-tests", stdout: nativeTests.stdout, stderr: nativeTests.stderr }, nativeTests.status ?? 1);
}

const dll = join(buildDir, "bin", "Release", "LekhTextService.dll");
if (!existsSync(dll)) {
  finish("failed", { step: "artifact", reason: `Expected DLL was not found at ${dll}` }, 1);
}
const broker = join(buildDir, "bin", "Release", "LekhPipeBroker.exe");
if (!existsSync(broker)) {
  finish("failed", { step: "artifact", reason: `Expected named-pipe broker was not found at ${broker}` }, 1);
}

finish("passed", {
  architecture: architecture.cmake,
  artifacts: [dll, broker],
  cmake: cmakeVersion.stdout.split("\n")[0],
  nativeTests: "passed"
}, 0);

function optionValue(name) {
  const equalsArgument = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (equalsArgument) return equalsArgument.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function resolveCmakeExecutable() {
  const candidates = [
    process.env.CMAKE_EXE,
    process.env.VSINSTALLDIR && join(process.env.VSINSTALLDIR, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "CMake", "bin", "cmake.exe"),
    "D:\\VSBuildTools\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe",
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe",
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe"
  ].filter(Boolean);

  const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
  if (existsSync(vswhere)) {
    const lookup = spawnSync(vswhere, [
      "-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.CMake.Project", "-property", "installationPath"
    ], { encoding: "utf8" });
    const installationPath = lookup.status === 0 ? lookup.stdout.trim() : "";
    if (installationPath) {
      candidates.unshift(join(installationPath, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "CMake", "bin", "cmake.exe"));
    }
  }

  return candidates.find((candidate) => existsSync(candidate)) ?? "cmake";
}
