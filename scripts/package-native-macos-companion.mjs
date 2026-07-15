#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const startedAt = performance.now();
const signed = process.argv.includes("--signed");
const deliveredAppBundle = join(root, "release", "Lekh Keyboard Companion.app");
const stagingRoot = mkdtempSync(join(tmpdir(), "lekh-native-companion-"));
const appBundle = join(stagingRoot, "Lekh Keyboard Companion.app");
const executableName = "LekhKeyboardCompanion";
const executable = join(appBundle, "Contents", "MacOS", executableName);
const buildRoot = join(root, ".tmp", "native-macos-companion");
const sources = [
  "native/macos-companion/LekhCompanionApp.swift",
  "native/macos-companion/LekhCompanionCopy.swift",
  "native/macos-companion/LekhCompanionModel.swift"
].map((path) => join(root, path));
const reportPath = join(root, "reports", signed
  ? "macos-native-signed-package-report.json"
  : "macos-native-unsigned-package-report.json");

process.on("exit", () => rmSync(stagingRoot, { recursive: true, force: true }));

function finish(status, details, exitCode) {
  mkdirSync(join(root, "reports"), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: signed ? "npm run package:macos" : "npm run package:macos:unsigned",
    suite: "native-macos-companion-package",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    appBundle: deliveredAppBundle,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, report: reportPath.replace(`${root}/`, "") }, null, 2));
  process.exit(exitCode);
}

function run(step, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    timeout: options.timeout ?? 300_000,
    env: options.env ?? process.env
  });
  if (result.status !== 0) {
    finish(result.signal ? "timeout" : "failed", {
      step,
      command: [command, ...args],
      signal: result.signal ?? null,
      stdout: result.stdout,
      stderr: result.stderr
    }, result.status ?? 1);
  }
  return result;
}

if (process.platform !== "darwin") {
  finish("blocked-native-environment", { reason: "The native SwiftUI companion must be packaged on macOS." }, 2);
}

const missingSources = sources.filter((source) => !existsSync(source));
if (missingSources.length > 0) {
  finish("failed", { step: "sources", missingSources }, 1);
}

if (signed && !process.env.LEKH_MAC_DEVELOPER_ID) {
  finish("blocked-external", {
    reason: "Developer ID Application identity is required for a production companion.",
    missingEnvironment: ["LEKH_MAC_DEVELOPER_ID"],
    unsignedDevCommand: "npm run package:macos:unsigned"
  }, 2);
}

const sdk = run("sdk", "xcrun", ["--sdk", "macosx", "--show-sdk-path"]).stdout.trim();
rmSync(buildRoot, { recursive: true, force: true });
rmSync(appBundle, { recursive: true, force: true });
rmSync(deliveredAppBundle, { recursive: true, force: true });
mkdirSync(buildRoot, { recursive: true });
mkdirSync(join(appBundle, "Contents", "MacOS"), { recursive: true });
mkdirSync(join(appBundle, "Contents", "Resources"), { recursive: true });

for (const arch of ["arm64", "x86_64"]) {
  run(`compile-${arch}`, "swiftc", [
    "-parse-as-library",
    "-O",
    "-whole-module-optimization",
    "-module-name", "LekhKeyboardCompanion",
    "-target", `${arch}-apple-macos13`,
    "-sdk", sdk,
    "-framework", "SwiftUI",
    "-framework", "AppKit",
    "-framework", "Carbon",
    "-framework", "Security",
    "-framework", "UniformTypeIdentifiers",
    "-lsqlite3",
    ...sources,
    "-o", join(buildRoot, `${executableName}-${arch}`)
  ]);
}

run("lipo", "lipo", [
  "-create",
  join(buildRoot, `${executableName}-arm64`),
  join(buildRoot, `${executableName}-x86_64`),
  "-output", executable
]);

const iconSource = join(root, "build", "icon.icns");
if (existsSync(iconSource)) copyFileSync(iconSource, join(appBundle, "Contents", "Resources", "Lekh.icns"));

const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8").toString()).version;
const shortVersion = String(packageVersion).match(/^\d+\.\d+\.\d+/)?.[0] ?? "0.1.0";
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Lekh Keyboard Companion</string>
  <key>CFBundleExecutable</key><string>${executableName}</string>
  <key>CFBundleIconFile</key><string>Lekh.icns</string>
  <key>CFBundleIdentifier</key><string>com.lekh.keyboard.companion</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Lekh Keyboard Companion</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${shortVersion}</string>
  <key>CFBundleVersion</key><string>101</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSMultipleInstancesProhibited</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Copyright © 2026 Lekh</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSQuitAlwaysKeepsWindows</key><false/>
  <key>NSSupportsAutomaticTermination</key><true/>
</dict>
</plist>
`;
writeFileSync(join(appBundle, "Contents", "Info.plist"), plist);
writeFileSync(join(appBundle, "Contents", "PkgInfo"), "APPL????");

run("strip-extended-attributes", "xattr", ["-cr", appBundle]);
const signArgs = signed
  ? ["--force", "--options", "runtime", "--timestamp", "--sign", process.env.LEKH_MAC_DEVELOPER_ID, appBundle]
  : ["--force", "--options", "runtime", "--timestamp=none", "--sign", "-", appBundle];
run("codesign", "codesign", signArgs);
// Documents may be backed by File Provider, which can reattach Finder metadata
// after bundle creation. It is not signed content and must be stripped again.
run("strip-post-sign-extended-attributes", "xattr", ["-cr", appBundle]);
run("codesign-verify", "codesign", ["--verify", "--deep", "--strict", "--verbose=2", appBundle]);

const architectureOutput = run("architecture", "lipo", ["-archs", executable]).stdout.trim();
const forbiddenUsageKeys = [
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSLocationUsageDescription"
];
const plistText = readFileSync(join(appBundle, "Contents", "Info.plist"), "utf8");
const presentForbiddenUsageKeys = forbiddenUsageKeys.filter((key) => plistText.includes(`<key>${key}</key>`));
if (presentForbiddenUsageKeys.length > 0 || plistText.includes("NSAllowsArbitraryLoads")) {
  finish("failed", { step: "least-privilege", presentForbiddenUsageKeys }, 1);
}

let notarizedArtifact = null;
if (signed) {
  const required = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    finish("blocked-external", {
      reason: "Notarization credentials are missing after the signed app was built.",
      missingEnvironment: missing
    }, 2);
  }
  const dmg = join(root, "release", `Lekh-Keyboard-Companion-${shortVersion}.dmg`);
  rmSync(dmg, { force: true });
  run("dmg", "hdiutil", ["create", "-volname", "Lekh Keyboard", "-srcfolder", appBundle, "-ov", "-format", "UDZO", dmg]);
  run("notarytool", "xcrun", [
    "notarytool", "submit", dmg,
    "--apple-id", process.env.APPLE_ID,
    "--password", process.env.APPLE_APP_SPECIFIC_PASSWORD,
    "--team-id", process.env.APPLE_TEAM_ID,
    "--wait"
  ], { timeout: 900_000 });
  run("staple-app", "xcrun", ["stapler", "staple", appBundle]);
  run("staple-dmg", "xcrun", ["stapler", "staple", dmg]);
  run("gatekeeper", "spctl", ["--assess", "--type", "execute", "--verbose=2", appBundle]);
  notarizedArtifact = dmg;
}

// Sign and verify outside Documents/File Provider, then deliver only file data.
// Finder metadata can be reattached to the working copy later, but is not part
// of the signed/notarized transport artifact.
run("deliver-app", "ditto", ["--norsrc", "--noextattr", appBundle, deliveredAppBundle]);

finish(signed ? "passed-signed-notarized" : "passed-unsigned-native-dev", {
  signed,
  notarizedArtifact,
  architectures: architectureOutput.split(/\s+/).sort(),
  bundleBytes: directoryBytes(appBundle),
  electronFrameworkPresent: existsSync(join(appBundle, "Contents", "Frameworks", "Electron Framework.framework")),
  arbitraryNetworkLoads: false,
  hardwareUsageDescriptions: []
}, 0);

function directoryBytes(directory) {
  const result = spawnSync("du", ["-sk", directory], { encoding: "utf8" });
  if (result.status === 0) return Number(result.stdout.trim().split(/\s+/)[0]) * 1024;
  return statSync(executable).size;
}
