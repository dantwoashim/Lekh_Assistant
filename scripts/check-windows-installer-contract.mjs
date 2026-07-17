#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const startedAt = performance.now();
const paths = {
  build: "scripts/build-windows-tsf.mjs",
  package: "scripts/package-windows-companion.mjs",
  builder: "electron-builder.config.cjs",
  installer: "build/installer/windows/installer.nsh"
};
const source = Object.fromEntries(
  Object.entries(paths).map(([key, file]) => [key, readFileSync(join(root, file), "utf8")])
);
const canonicalBuildSegments = 'join(buildDir, "bin", "Release", "LekhTextService.dll")';
const canonicalBrokerBuildSegments = 'join(buildDir, "bin", "Release", "LekhPipeBroker.exe")';
const packagedRelativePath = "native\\windows-tsf\\build\\bin\\Release\\LekhTextService.dll";
const packagedBrokerRelativePath = "native\\windows-tsf\\build\\bin\\Release\\LekhPipeBroker.exe";
const installedDll = `$INSTDIR\\resources\\${packagedRelativePath}`;
const installedBroker = `$INSTDIR\\resources\\${packagedBrokerRelativePath}`;
const failures = [];

requireText(source.build, canonicalBuildSegments, "TSF build output changed without updating the installer contract.");
requireText(source.build, canonicalBrokerBuildSegments, "Pipe-broker build output changed without updating the installer contract.");
requireText(source.builder, 'from: "native/windows-tsf/skeleton"', "electron-builder no longer packages the TSF build tree.");
requireText(source.builder, 'to: "native/windows-tsf"', "electron-builder TSF destination changed.");
requireText(source.builder, '"build/bin/Release/LekhTextService.dll"', "electron-builder no longer includes the TSF DLL.");
requireText(source.builder, '"build/bin/Release/LekhPipeBroker.exe"', "electron-builder no longer includes the pipe broker.");
requireText(source.package, 'npm", ["run", "build:windows"]', "Windows packaging must build the TSF DLL first.");
requireText(source.package, '"native", "windows-tsf", "skeleton", "build", "bin", "Release", "LekhTextService.dll"', "Package preflight does not point to the canonical TSF DLL.");
requireText(source.package, '"native", "windows-tsf", "skeleton", "build", "bin", "Release", "LekhPipeBroker.exe"', "Package preflight does not point to the canonical pipe broker.");
requireText(source.package, "A companion-only installer is forbidden.", "Package preflight must fail closed when the TSF DLL is absent.");
requireText(source.package, "An unprotected daemon endpoint is forbidden.", "Package preflight must fail closed when the pipe broker is absent.");

const artifactGuard = source.package.indexOf("if (!existsSync(tsfDll))");
const brokerArtifactGuard = source.package.indexOf("if (!existsSync(pipeBroker))");
const builderInvocation = source.package.indexOf("const electronBuilderBin");
if (artifactGuard < 0 || builderInvocation < 0 || artifactGuard > builderInvocation) {
  failures.push("TSF artifact preflight must run before electron-builder.");
}
if (brokerArtifactGuard < 0 || builderInvocation < 0 || brokerArtifactGuard > builderInvocation) {
  failures.push("Pipe-broker artifact preflight must run before electron-builder.");
}

const installedPathCount = source.installer.split(installedDll).length - 1;
if (installedPathCount !== 4) {
  failures.push(`NSIS must use the canonical installed TSF path exactly four times; found ${installedPathCount}.`);
}
const installedBrokerPathCount = source.installer.split(installedBroker).length - 1;
if (installedBrokerPathCount !== 1) {
  failures.push(`NSIS must guard the canonical installed pipe-broker path exactly once; found ${installedBrokerPathCount}.`);
}
requireText(source.installer, "Required Lekh TSF DLL is missing", "NSIS must explain a missing native DLL.");
requireText(source.installer, "Required Lekh named-pipe broker is missing", "NSIS must explain a missing secure IPC broker.");
requireText(source.installer, "lekh_pipe_broker_found:", "NSIS pipe-broker guard is absent.");
requireText(source.installer, "lekh_tsf_dll_found:", "NSIS missing-DLL guard is absent.");
requireText(source.installer, `ExecWait 'regsvr32.exe /s "${installedDll}"' $0`, "NSIS must capture regsvr32's exit code.");
requireText(source.installer, "IfErrors lekh_tsf_registration_failed", "NSIS must handle a regsvr32 launch error.");
requireText(source.installer, "IntCmp $0 0 lekh_tsf_registration_complete", "NSIS must reject a nonzero regsvr32 exit code.");
requireText(source.installer, "lekh_tsf_registration_failed:", "NSIS registration failure handler is absent.");
requireText(source.installer, "No working keyboard was installed.", "NSIS must not disguise registration failure as a usable keyboard.");
requireText(source.installer, "Abort", "NSIS must abort failed native registration.");
requireText(source.installer, `ExecWait 'regsvr32.exe /u /s "${installedDll}"'`, "Uninstall must unregister the same DLL that install registered.");

if (source.installer.includes("companion-only dev install")) {
  failures.push("NSIS still contains the silent companion-only installation path.");
}

const report = {
  generatedAt: new Date().toISOString(),
  command: "npm run check:windows-installer-contract",
  suite: "windows-installer-tsf-contract",
  durationMs: Math.round(performance.now() - startedAt),
  status: failures.length === 0 ? "passed" : "failed",
  buildArtifacts: [
    "native/windows-tsf/skeleton/build/bin/Release/LekhTextService.dll",
    "native/windows-tsf/skeleton/build/bin/Release/LekhPipeBroker.exe"
  ],
  installedArtifacts: [installedDll, installedBroker],
  installerPathReferences: installedPathCount,
  pipeBrokerInstallerPathReferences: installedBrokerPathCount,
  packageFailsClosed: artifactGuard >= 0 && artifactGuard < builderInvocation &&
    brokerArtifactGuard >= 0 && brokerArtifactGuard < builderInvocation,
  failures
};

mkdirSync(join(root, "reports"), { recursive: true });
writeFileSync(
  join(root, "reports", "windows-installer-contract-report.json"),
  `${JSON.stringify(report, null, 2)}\n`
);
console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) process.exit(1);

function requireText(text, needle, message) {
  if (!text.includes(needle)) failures.push(message);
}
