#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const startedAt = performance.now();
const paths = {
  build: "scripts/build-windows-tsf.mjs",
  package: "scripts/package-windows-companion.mjs",
  fusePolicy: "scripts/lib/electron-fuse-policy.mjs",
  builder: "electron-builder.config.cjs",
  companion: "electron/main.cjs",
  installer: "build/installer/windows/installer.nsh",
  devRegister: "native/windows-tsf/skeleton/register-dev.ps1",
  devUnregister: "native/windows-tsf/skeleton/unregister-dev.ps1",
  lifecycle: "scripts/test-windows-installer.ps1",
  workflow: ".github/workflows/ci.yml",
  manifest: "package.json"
};
const source = Object.fromEntries(
  Object.entries(paths).map(([key, file]) => [key, readFileSync(join(root, file), "utf8")])
);
const canonicalBuildSegments = 'join(buildDir, "bin", "Release", "LekhTextService.dll")';
const canonicalBrokerBuildSegments = 'join(buildDir, "bin", "Release", "LekhPipeBroker.exe")';
const packagedRelativePath = "native\\windows-tsf\\build\\bin\\Release\\LekhTextService.dll";
const packagedBrokerRelativePath = "native\\windows-tsf\\build\\bin\\Release\\LekhPipeBroker.exe";
const packagedX86RelativePath = "native\\windows-tsf\\build-x86\\bin\\Release\\LekhTextService.dll";
const installedDll = `$INSTDIR\\resources\\${packagedRelativePath}`;
const installedBroker = `$INSTDIR\\resources\\${packagedBrokerRelativePath}`;
const installedX86Dll = `$INSTDIR\\resources\\${packagedX86RelativePath}`;
const failures = [];

requireText(source.build, canonicalBuildSegments, "TSF build output changed without updating the installer contract.");
requireText(source.build, canonicalBrokerBuildSegments, "Pipe-broker build output changed without updating the installer contract.");
requireText(source.build, '["arm64", { cmake: "ARM64", buildDirectory: "build-ARM64" }]', "TSF build no longer supports the CI ARM64 architecture.");
requireText(source.build, '["x86", { cmake: "Win32", buildDirectory: "build-Win32" }]', "TSF build must support 32-bit Windows applications.");
requireText(source.builder, "native/windows-tsf/skeleton/${windowsNativeBuildDirectory}/bin/Release", "electron-builder no longer selects the architecture-specific TSF release directory.");
requireText(source.builder, 'to: "native/windows-tsf/build/bin/Release"', "electron-builder TSF destination changed.");
requireText(source.builder, '"LekhTextService.dll"', "electron-builder no longer includes the TSF DLL.");
requireText(source.builder, '"LekhPipeBroker.exe"', "electron-builder no longer includes the pipe broker.");
requireText(source.builder, "arch: [windowsArchitecture]", "electron-builder no longer packages the requested Windows architecture.");
requireText(source.builder, "runAfterFinish: false", "electron-builder must not launch a second companion after custom installation.");
requireText(source.builder, "perMachine: true", "The TSF installer must request the machine-wide registration context required by Windows.");
requireText(source.fusePolicy, "runAsNode: true", "The contained daemon requires the packaged Electron runtime's explicit Node-mode fuse.");
requireText(source.fusePolicy, "enableNodeOptionsEnvironmentVariable: false", "Packaged Electron must ignore hostile Node option environment variables.");
requireText(source.fusePolicy, "enableNodeCliInspectArguments: false", "Packaged Electron must reject remote inspector command-line flags.");
requireText(source.fusePolicy, "enableEmbeddedAsarIntegrityValidation: true", "Packaged Electron must validate its embedded ASAR integrity.");
requireText(source.fusePolicy, "onlyLoadAppFromAsar: true", "Packaged Electron must not fall back to unpacked application code.");
requireText(source.fusePolicy, "loadBrowserProcessSpecificV8Snapshot: false", "Packaging must not require an absent custom browser V8 snapshot.");
requireText(source.fusePolicy, "grantFileProtocolExtraPrivileges: false", "The companion must not grant legacy file-protocol privileges.");
requireText(source.fusePolicy, "wasmTrapHandlers: true", "The current Electron WebAssembly guard fuse must be explicit.");
requireText(source.fusePolicy, "strictlyRequireAllFuses: true", "Electron upgrades must fail closed when a new fuse is introduced.");
requireText(source.builder, "afterPack: applyHardenedElectronFuses", "The current fuse library must harden the binary before signing.");
requireText(source.manifest, '"@electron/fuses": "^2.1.3"', "Packaging must use the current fuse schema instead of electron-builder's stale transitive reader.");
requireText(source.companion, "setPermissionRequestHandler", "The companion must deny unneeded renderer permission requests.");
requireText(source.companion, "setPermissionCheckHandler", "The companion must deny unneeded renderer permission checks.");
requireText(source.companion, "const health = await waitForWindowsBrokerHealth();", "Windows repair must wait for the local typing service to become ready.");
requireText(source.package, '"scripts", "build-windows-tsf.mjs"', "Windows packaging must build the TSF DLL first.");
requireText(source.package, '["arm64", { cmake: "ARM64", buildDirectory: "build-ARM64", electronBuilder: "arm64", compatibilityArchitecture: "x86" }]', "Windows packaging no longer supports the CI ARM64 architecture.");
requireText(source.package, 'compatibilityArchitecture: "x86"', "64-bit Windows packages must carry the 32-bit compatibility TSF DLL.");
requireText(source.package, '"native", "windows-tsf", "skeleton", architecture.buildDirectory, "bin", "Release", "LekhTextService.dll"', "Package preflight does not point to the architecture-specific TSF DLL.");
requireText(source.package, '"native", "windows-tsf", "skeleton", architecture.buildDirectory, "bin", "Release", "LekhPipeBroker.exe"', "Package preflight does not point to the architecture-specific pipe broker.");
requireText(source.package, "LEKH_WINDOWS_ARCHITECTURE: architecture.electronBuilder", "Windows packaging does not bind electron-builder to the native architecture.");
requireText(source.package, "missingUnpackedArtifacts", "Windows packaging does not verify the unpacked runtime before accepting an installer.");
requireText(source.package, 'step: "unpacked-artifacts"', "Windows packaging lacks a fail-closed unpacked-artifact check.");
requireText(source.package, 'step: "package-footprint"', "Windows packaging must reject an accidentally dependency-heavy companion ASAR.");
requireText(source.package, "maximumCompanionAsarBytes", "Windows packaging must keep a bounded companion runtime payload.");
requireText(source.package, "verifyHardenedElectronFusePolicy", "Windows packaging must inspect the actual packaged Electron fuse wire.");
requireText(source.fusePolicy, "FuseV1Options.WasmTrapHandlers", "Windows packaging must verify the current ninth Electron fuse.");
requireText(source.package, 'step: "electron-fuses"', "Windows packaging must fail closed on a fuse-policy mismatch.");
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
if (installedPathCount !== 6) {
  failures.push(`NSIS must use the canonical installed TSF path exactly six times; found ${installedPathCount}.`);
}
const installedX86PathCount = source.installer.split(installedX86Dll).length - 1;
if (installedX86PathCount !== 5) {
  failures.push(`NSIS must use the canonical installed x86 TSF path exactly five times; found ${installedX86PathCount}.`);
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
requireText(source.installer, `ExecWait '"$WINDIR\\SysWOW64\\regsvr32.exe" /s "${installedX86Dll}"' $1`, "NSIS must register the x86 TSF DLL for 32-bit applications.");
requireText(source.installer, "IfErrors lekh_tsf_registration_failed", "NSIS must handle a regsvr32 launch error.");
requireText(source.installer, "IntCmp $0 0 lekh_tsf_registration_complete", "NSIS must reject a nonzero regsvr32 exit code.");
requireText(source.installer, "lekh_tsf_registration_failed:", "NSIS registration failure handler is absent.");
requireText(source.installer, "No working keyboard was installed.", "NSIS must not disguise registration failure as a usable keyboard.");
requireText(source.installer, "/SD IDOK", "NSIS failure dialogs must not block silent installation.");
requireText(source.installer, "SetErrorLevel 1", "NSIS must report failed native registration to automation.");
requireText(source.installer, `ExecWait '"$WINDIR\\Sysnative\\regsvr32.exe" /u /s "${installedDll}"'`, "Uninstall must unregister the same DLL with native 64-bit regsvr32.");
requireText(source.installer, '!insertmacro UAC_AsUser_ExecShell "" "$INSTDIR\\Lekh Keyboard Companion.exe" "--background" "$INSTDIR" SW_HIDE', "Install must launch the companion in the original desktop-user context.");
if (source.installer.includes('$SYSDIR\\cmd.exe') || source.installer.includes('start "" /B')) {
  failures.push("Install must not inherit the elevated installer token through cmd.exe.");
}
requireText(source.installer, '"$INSTDIR\\Lekh Keyboard Companion.exe" --background', "Install must persist the companion in background mode.");
requireText(source.installer, 'nsProcess::_FindProcess /NOUNLOAD "LekhPipeBroker.exe"', "Install must verify that the broker process actually starts.");
requireText(source.installer, "IntCmp $2 20 lekh_runtime_start_failed", "Install startup verification must have a finite retry bound.");
requireText(source.installer, '!insertmacro lekhInstallPhase "registering-tsf"', "Install failures must identify whether native registration started.");
requireText(source.installer, 'taskkill.exe /F /T /IM "Lekh Keyboard Companion.exe"', "Uninstall must stop the companion process tree before deleting files.");
requireText(source.installer, 'taskkill.exe /F /IM "LekhPipeBroker.exe"', "Uninstall must stop the native broker before deleting files.");
requireText(source.devRegister, 'build-Win32\\bin\\Release\\LekhTextService.dll', "Development registration must include the 32-bit TSF DLL.");
requireText(source.devRegister, 'SysWOW64\\regsvr32.exe', "Development registration must use the 32-bit registrar for compatibility apps.");
requireText(source.devRegister, 'System32\\regsvr32.exe" /u /s $Dll', "Development registration must roll back 64-bit state when compatibility registration fails.");
requireText(source.devUnregister, 'SysWOW64\\regsvr32.exe" /u /s $CompatibilityDll', "Development cleanup must unregister the 32-bit TSF DLL.");
requireText(source.lifecycle, "Invoke-DaemonHealthCheck", "The installer lifecycle test must negotiate with the installed daemon.");
requireText(source.lifecycle, "must run in an elevated PowerShell session", "The installer lifecycle test must fail clearly before a non-elevated mutation attempt.");
requireText(source.lifecycle, "Refusing to overwrite an existing Lekh installation", "The installer lifecycle test must preserve an existing machine registration.");
requireText(source.lifecycle, "Refusing to overwrite an existing Lekh run-at-sign-in registration", "The installer lifecycle test must preserve an existing user startup entry.");
requireText(source.lifecycle, 'client = "windows-tsf"', "The installer health request must identify as a supported native Windows client.");
requireText(source.lifecycle, '$requestBytes = $encoding.GetBytes($request + "`n")', "The installer health frame must be prepared before the fail-closed pipe connection opens.");
requireText(source.lifecycle, '$pipe.Write($requestBytes, 0, $requestBytes.Length)', "The installer health check must write the prepared frame directly within the broker deadline.");
requireText(source.lifecycle, '$readyDeadline = [DateTime]::UtcNow.AddSeconds(30)', "The lifecycle check must allow bounded cold-start and broker-restart time.");
requireText(source.lifecycle, 'engineReady -ne $true', "The lifecycle test must prove that the public listener is gated on engine readiness.");
requireText(source.lifecycle, '-Type "session.begin"', "The lifecycle test must open a real bound keyboard session.");
requireText(source.lifecycle, '-Type "session.processKeyStroke"', "The lifecycle test must send a valid first hot-path key request.");
requireText(source.lifecycle, '-DeadlineMilliseconds 50', "The lifecycle test must preserve the protocol's 50 ms hot-path envelope.");
requireText(source.lifecycle, String.raw`[\u0900-\u097F]`, "The lifecycle test must require a Devanagari first-key decision.");
requireText(source.lifecycle, '(Get-PeMachine -Path $TsfPath) -ne 0x8664', "The lifecycle test must verify the primary x64 TSF DLL architecture.");
requireText(source.lifecycle, '(Get-PeMachine -Path $TsfX86Path) -ne 0x014C', "The lifecycle test must verify the compatibility x86 TSF DLL architecture.");
requireText(source.lifecycle, 'did not expose a warmed public listener within 30 seconds', "The lifecycle check must report a bounded warmed-listener failure.");
requireText(source.lifecycle, "The installer did not register the TSF input profile.", "The lifecycle test must verify TSF registration.");
requireText(source.lifecycle, "COM registration remained after uninstall.", "The lifecycle test must reject leftover COM registration.");
requireText(source.lifecycle, "TSF profile registration remained after uninstall.", "The lifecycle test must reject leftover TSF registration.");
requireText(source.lifecycle, "@(Get-InstalledProcesses).Count -eq 0", "The lifecycle cleanup check must treat an empty PowerShell pipeline as zero processes.");
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
    "native/windows-tsf/skeleton/build/bin/Release/LekhPipeBroker.exe",
    "native/windows-tsf/skeleton/build-Win32/bin/Release/LekhTextService.dll",
    "native/windows-tsf/skeleton/build-ARM64/bin/Release/LekhTextService.dll",
    "native/windows-tsf/skeleton/build-ARM64/bin/Release/LekhPipeBroker.exe"
  ],
  installedArtifacts: [installedDll, installedX86Dll, installedBroker],
  installerPathReferences: installedPathCount,
  x86InstallerPathReferences: installedX86PathCount,
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
