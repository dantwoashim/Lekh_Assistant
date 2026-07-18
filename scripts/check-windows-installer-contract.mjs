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
const packagedX64RelativePath = "native\\windows-tsf\\build\\bin\\Release\\LekhTextService.dll";
const packagedX86RelativePath = "native\\windows-tsf\\build-Win32\\bin\\Release\\LekhTextService.dll";
const packagedBrokerRelativePath = "native\\windows-tsf\\build\\bin\\Release\\LekhPipeBroker.exe";
const installedX64Dll = `$INSTDIR\\resources\\${packagedX64RelativePath}`;
const installedX86Dll = `$INSTDIR\\resources\\${packagedX86RelativePath}`;
const installedBroker = `$INSTDIR\\resources\\${packagedBrokerRelativePath}`;
const failures = [];

requireText(source.build, canonicalBuildSegments, "TSF build output changed without updating the installer contract.");
requireText(source.build, canonicalBrokerBuildSegments, "Pipe-broker build output changed without updating the installer contract.");
requireText(source.builder, 'from: "native/windows-tsf/skeleton"', "electron-builder no longer packages the TSF build tree.");
requireText(source.builder, 'to: "native/windows-tsf"', "electron-builder TSF destination changed.");
requireText(source.builder, '"build/bin/Release/LekhTextService.dll"', "electron-builder no longer includes the TSF DLL.");
requireText(source.builder, '"build-Win32/bin/Release/LekhTextService.dll"', "electron-builder no longer includes the x86 TSF DLL.");
requireText(source.builder, '"build/bin/Release/LekhPipeBroker.exe"', "electron-builder no longer includes the pipe broker.");
requireText(source.builder, 'signExts: [".dll", ".node"]', "electron-builder must explicitly sign packaged DLL and native Node payloads.");
requireText(source.package, 'const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"', "Windows packaging must invoke npm through its native command shim.");
requireText(source.package, 'spawnSync(npmCommand, ["run", "build:windows"]', "Windows packaging must build the TSF DLL first.");
requireText(source.package, '"native", "windows-tsf", "skeleton", "build", "bin", "Release", "LekhTextService.dll"', "Package preflight does not point to the canonical TSF DLL.");
requireText(source.package, '"native", "windows-tsf", "skeleton", "build-Win32", "bin", "Release", "LekhTextService.dll"', "Package preflight does not point to the canonical x86 TSF DLL.");
requireText(source.package, '"native", "windows-tsf", "skeleton", "build", "bin", "Release", "LekhPipeBroker.exe"', "Package preflight does not point to the canonical pipe broker.");
requireText(source.package, "A partial keyboard installer is forbidden.", "Package preflight must fail closed when a native architecture is absent.");
requireText(source.package, "expectedInstaller", "Packaging must bind the exact versioned x64 installer path.");
requireText(source.package, "artifact-freshness", "Packaging must reject a stale installer artifact.");
requireText(source.package, '"signtool.exe"', "Signed packaging must execute Windows SDK Authenticode verification.");
requireText(source.package, '"/tw"', "Authenticode verification must require timestamp diagnostics.");
requireText(source.package, "LEKH_WINDOWS_SIGNER_SHA256", "Signed packaging must pin the expected publisher certificate.");
requireText(source.package, 'if (signed && process.platform !== "win32")', "Signed packaging must never accept cross-host release evidence.");
requireText(source.package, "sourceRemainedClean", "Signed packaging must recheck source cleanliness and revision after artifact verification.");
requireText(source.package, "releaseArtifactsRemainedStable", "Packaging must recheck the complete executable inventory after signature verification.");
requireText(source.package, "packagingPlatform: process.platform", "Package evidence must identify the native host platform.");
requireText(source.package, "binaryInventory", "Packaging must bind every executable artifact by cryptographic identity.");
requireText(source.package, "discoverPortableExecutables", "Packaging must discover the closed-world PE inventory by file magic.");
requireText(source.package, "readPortableExecutableIdentity", "Packaging must verify PE structure and machine identity.");
requireText(source.package, "hasReleaseAliasInPath", "Packaging must reject symbolic-link, junction, and reparse-point release aliases.");

const artifactGuard = source.package.indexOf("for (const expected of [");
const builderInvocation = source.package.indexOf("const electronBuilderBin");
if (artifactGuard < 0 || builderInvocation < 0 || artifactGuard > builderInvocation) {
  failures.push("Architecture-aware native artifact preflight must run before electron-builder.");
}

const installedX64PathCount = source.installer.split(installedX64Dll).length - 1;
if (installedX64PathCount !== 4) {
  failures.push(`NSIS must use the canonical installed x64 TSF path exactly four times; found ${installedX64PathCount}.`);
}
const installedX86PathCount = source.installer.split(installedX86Dll).length - 1;
if (installedX86PathCount !== 4) {
  failures.push(`NSIS must use the canonical installed x86 TSF path exactly four times; found ${installedX86PathCount}.`);
}
const installedBrokerPathCount = source.installer.split(installedBroker).length - 1;
if (installedBrokerPathCount !== 1) {
  failures.push(`NSIS must guard the canonical installed pipe-broker path exactly once; found ${installedBrokerPathCount}.`);
}
requireText(source.installer, "Required x64 Lekh TSF DLL is missing", "NSIS must explain a missing x64 DLL.");
requireText(source.installer, "Required x86 Lekh TSF DLL is missing", "NSIS must explain a missing x86 DLL.");
requireText(source.installer, "Required Lekh named-pipe broker is missing", "NSIS must explain a missing secure IPC broker.");
requireText(source.installer, "lekh_pipe_broker_found:", "NSIS pipe-broker guard is absent.");
requireText(source.installer, "lekh_tsf_x64_dll_found:", "NSIS x64 missing-DLL guard is absent.");
requireText(source.installer, "lekh_tsf_x86_dll_found:", "NSIS x86 missing-DLL guard is absent.");
const registerX64 = `ExecWait '\"$WINDIR\\Sysnative\\regsvr32.exe\" /s \"${installedX64Dll}\"' $0`;
const registerX86 = `ExecWait '\"$WINDIR\\SysWOW64\\regsvr32.exe\" /s \"${installedX86Dll}\"' $0`;
const unregisterX64 = `ExecWait '\"$WINDIR\\Sysnative\\regsvr32.exe\" /u /s \"${installedX64Dll}\"' $0`;
const unregisterX86 = `ExecWait '\"$WINDIR\\SysWOW64\\regsvr32.exe\" /u /s \"${installedX86Dll}\"' $0`;
requireText(source.installer, registerX64, "NSIS must register the x64 DLL with native regsvr32 and capture its exit code.");
requireText(source.installer, registerX86, "NSIS must register the x86 DLL with 32-bit regsvr32 and capture its exit code.");
requireText(source.installer, "IfErrors lekh_tsf_x64_registration_failed", "NSIS must handle an x64 regsvr32 launch error.");
requireText(source.installer, "IfErrors lekh_tsf_x86_registration_failed", "NSIS must handle an x86 regsvr32 launch error.");
requireText(source.installer, "lekh_tsf_x64_registration_failed:", "NSIS x64 registration failure handler is absent.");
requireText(source.installer, "lekh_tsf_x86_registration_failed:", "NSIS x86 registration failure handler is absent.");
requireText(source.installer, "preserving the native files required to repair", "NSIS must preserve a safe repair path after registration failure.");
requireText(source.installer, "Abort", "NSIS must abort failed native registration.");
requireText(source.installer, unregisterX64, "Uninstall must unregister the x64 DLL with native regsvr32.");
requireText(source.installer, unregisterX86, "Uninstall must unregister the x86 DLL with 32-bit regsvr32.");
if (/ExecWait\s+'regsvr32\.exe/iu.test(source.installer)) {
  failures.push("NSIS must never resolve regsvr32 through PATH or WOW64 redirection.");
}
requireText(source.installer, "--background", "The login companion must start without opening the settings window.");
requireText(source.installer, "lekh_startup_slot_conflict", "Install must preserve a startup value owned by another installation.");
requireText(source.installer, "lekh_startup_registration_failed", "Install must fail before TSF registration when startup registration fails.");
requireText(source.installer, "lekh_startup_cleanup_failed", "Install must report failure to remove a newly created startup entry.");
requireText(source.installer, "registered x64 Lekh TSF DLL is missing", "Uninstall must fail closed when its x64 DLL is missing.");
requireText(source.installer, "registered x86 Lekh TSF DLL is missing", "Uninstall must fail closed when its x86 DLL is missing.");
requireText(source.installer, "lekh_startup_unregistration_failed", "Uninstall must report and preserve a retry path when startup removal fails.");
requireText(source.installer, "lekh_startup_value_not_owned", "Uninstall must preserve a startup value owned by another installation.");
const uninstallMacro = source.installer.indexOf("!macro customUnInstall");
const installMacro = source.installer.indexOf("!macro customInstall");
const startupWrite = source.installer.indexOf(
  'WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "LekhKeyboardCompanion"',
  installMacro,
);
const registerCommand = source.installer.indexOf(
  registerX64,
  installMacro,
);
if (startupWrite < 0 || registerCommand < 0 || startupWrite > registerCommand) {
  failures.push("Install must establish its owned startup entry before changing TSF registration.");
}
const unregisterCommand = source.installer.indexOf(
  unregisterX86,
  uninstallMacro,
);
const removeStartupEntry = source.installer.indexOf(
  'DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "LekhKeyboardCompanion"',
  unregisterCommand,
);
if (unregisterCommand < 0 || removeStartupEntry < unregisterCommand) {
  failures.push("Uninstall must preserve companion startup until TSF unregistration succeeds.");
}

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
    "native/windows-tsf/skeleton/build-Win32/bin/Release/LekhTextService.dll",
    "native/windows-tsf/skeleton/build/bin/Release/LekhPipeBroker.exe"
  ],
  installedArtifacts: [installedX64Dll, installedX86Dll, installedBroker],
  installerPathReferences: {
    x64: installedX64PathCount,
    x86: installedX86PathCount,
  },
  pipeBrokerInstallerPathReferences: installedBrokerPathCount,
  packageFailsClosed: artifactGuard >= 0 && artifactGuard < builderInvocation,
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
