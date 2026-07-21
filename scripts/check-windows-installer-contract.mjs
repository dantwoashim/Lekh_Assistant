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
  installer: "build/installer/windows/installer.nsh",
  lifecycle: "scripts/test-windows-installer.ps1",
  workflow: ".github/workflows/ci.yml"
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
requireText(source.builder, "runAfterFinish: false", "electron-builder must not launch a second companion after custom installation.");
requireText(source.builder, "perMachine: true", "The TSF installer must request the machine-wide registration context required by Windows.");
requireText(source.package, '"scripts", "build-windows-tsf.mjs"', "Windows packaging must build the TSF DLL first.");
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
if (installedPathCount !== 5) {
  failures.push(`NSIS must use the canonical installed TSF path exactly five times; found ${installedPathCount}.`);
}
const installedBrokerPathCount = source.installer.split(installedBroker).length - 1;
if (installedBrokerPathCount !== 1) {
  failures.push(`NSIS must guard the canonical installed pipe-broker path exactly once; found ${installedBrokerPathCount}.`);
}
requireText(source.installer, "Required Lekh TSF DLL is missing", "NSIS must explain a missing native DLL.");
requireText(source.installer, "Required Lekh named-pipe broker is missing", "NSIS must explain a missing secure IPC broker.");
requireText(source.installer, "!macro customCheckAppRunning", "NSIS must use a bounded native process check instead of WMI.");
requireText(source.installer, 'nsProcess::_FindProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"', "NSIS must check the companion without PowerShell/WMI.");
requireText(source.installer, "lekh_pipe_broker_found:", "NSIS pipe-broker guard is absent.");
requireText(source.installer, "lekh_tsf_dll_found:", "NSIS missing-DLL guard is absent.");
requireText(source.installer, `ExecWait '"$WINDIR\\Sysnative\\regsvr32.exe" /s "${installedDll}"' $0`, "NSIS must use native 64-bit regsvr32 and capture its exit code.");
requireText(source.installer, "IfErrors lekh_tsf_registration_failed", "NSIS must handle a regsvr32 launch error.");
requireText(source.installer, "IntCmp $0 0 lekh_tsf_registration_complete", "NSIS must reject a nonzero regsvr32 exit code.");
requireText(source.installer, "lekh_tsf_registration_failed:", "NSIS registration failure handler is absent.");
requireText(source.installer, "No working keyboard was installed.", "NSIS must not disguise registration failure as a usable keyboard.");
requireText(source.installer, "/SD IDOK", "NSIS failure dialogs must not block silent installation.");
requireText(source.installer, "SetErrorLevel 1", "NSIS must report failed native registration to automation.");
requireText(source.installer, `ExecWait '"$WINDIR\\Sysnative\\regsvr32.exe" /u /s "${installedDll}"'`, "Uninstall must unregister the same DLL with native 64-bit regsvr32.");
requireText(source.installer, 'start "" /B "$INSTDIR\\Lekh Keyboard Companion.exe" --background', "Install must detach the companion through a bounded launcher.");
requireText(source.installer, '"$INSTDIR\\Lekh Keyboard Companion.exe" --background', "Install must persist the companion in background mode.");
requireText(source.installer, '!insertmacro lekhInstallPhase "registering-tsf"', "Install failures must identify whether native registration started.");
requireText(source.installer, 'taskkill.exe /F /T /IM "Lekh Keyboard Companion.exe"', "Uninstall must stop the companion process tree before deleting files.");
requireText(source.installer, 'taskkill.exe /F /IM "LekhPipeBroker.exe"', "Uninstall must stop the native broker before deleting files.");
requireText(source.lifecycle, "Invoke-DaemonHealthCheck", "The installer lifecycle test must negotiate with the installed daemon.");
requireText(source.lifecycle, 'client = "windows-tsf"', "The installer health request must identify as a supported native Windows client.");
requireText(source.lifecycle, '$requestBytes = $encoding.GetBytes($request + "`n")', "The installer health frame must be prepared before the fail-closed pipe connection opens.");
requireText(source.lifecycle, '$pipe.Write($requestBytes, 0, $requestBytes.Length)', "The installer health check must write the prepared frame directly within the broker deadline.");
requireText(source.lifecycle, "The installer did not register the TSF input profile.", "The lifecycle test must verify TSF registration.");
requireText(source.lifecycle, "COM registration remained after uninstall.", "The lifecycle test must reject leftover COM registration.");
requireText(source.lifecycle, "TSF profile registration remained after uninstall.", "The lifecycle test must reject leftover TSF registration.");
requireText(source.workflow, "Build unsigned Windows installer", "Windows CI must build the actual unsigned NSIS artifact.");
requireText(source.workflow, "Verify silent Windows install lifecycle", "Windows CI must run the silent installer lifecycle test.");

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
