#!/usr/bin/env node
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const startedAt = performance.now();
const reportPath = join(root, "reports", "macos-imk-test-installer-report.json");
const releaseDir = join(root, "release", "native", "macos");
const imkBundle = join(releaseDir, "Lekh Keyboard.imkdevbundle");
const installerApp = join(releaseDir, "Lekh Keyboard Test Installer.app");
const uninstallerApp = join(releaseDir, "Lekh Keyboard Uninstaller.app");
const distFolder = join(releaseDir, "Lekh Keyboard Test Installer");
const zipPath = join(releaseDir, "Lekh-Keyboard-Test-Installer.zip");
const skeletonDir = join(root, "native", "macos-imk", "skeleton");
const iconSource = join(root, "build", "icon.icns");
const signingIdentity = process.env.LEKH_MAC_DEVELOPER_ID || "-";
const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const toolchainCacheDir = join(root, ".build-cache", "macos-toolchain");
const toolchainEnv = {
  ...process.env,
  CLANG_MODULE_CACHE_PATH: join(toolchainCacheDir, "clang-module-cache"),
  SWIFT_MODULE_CACHE_PATH: join(toolchainCacheDir, "swift-module-cache")
};

function finish(status, details, exitCode) {
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        command: "npm run package:macos:imk:test-installer",
        suite: "macos-imk-test-installer",
        durationMs: Math.round(performance.now() - startedAt),
        status,
        ...details
      },
      null,
      2
    )}\n`
  );
  console.log(JSON.stringify({ status, report: "reports/macos-imk-test-installer-report.json", ...details }, null, 2));
  process.exit(exitCode);
}

function run(step, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: toolchainEnv,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: options.maxBuffer ?? 80 * 1024 * 1024
  });
  if (result.status !== 0) {
    finish("failed", { step, command, args, stdout: result.stdout, stderr: result.stderr }, result.status ?? 1);
  }
  return result;
}

function signPath(path, step) {
  stripCodeSignBlockedXattrs(path);
  const args = ["--force", "--options", "runtime", "--sign", signingIdentity];
  if (signingIdentity === "-") args.push("--timestamp=none");
  else args.push("--timestamp");
  args.push(path);
  const firstAttempt = spawnSync("codesign", args, {
    cwd: root,
    env: toolchainEnv,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 80 * 1024 * 1024
  });
  if (firstAttempt.status === 0) return;
  if (`${firstAttempt.stdout}\n${firstAttempt.stderr}`.includes("resource fork, Finder information, or similar detritus not allowed")) {
    stripCodeSignBlockedXattrs(path);
    run(step, "codesign", args);
    return;
  }
  finish("failed", { step, command: "codesign", args, stdout: firstAttempt.stdout, stderr: firstAttempt.stderr }, firstAttempt.status ?? 1);
}

function verifySignedPath(path, step) {
  let lastAttempt = { status: 1, stdout: "", stderr: "" };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    stripCodeSignBlockedXattrs(path);
    const result = spawnSync("codesign", ["--verify", "--deep", "--strict", path], {
      cwd: root,
      env: toolchainEnv,
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 80 * 1024 * 1024
    });
    if (result.status === 0) return;
    lastAttempt = result;
    if (!`${result.stdout}\n${result.stderr}`.includes("resource fork, Finder information, or similar detritus not allowed")) {
      break;
    }
    sleep(250);
  }
  finish(
    "failed",
    {
      step,
      command: "codesign",
      args: ["--verify", "--deep", "--strict", path],
      stdout: lastAttempt.stdout,
      stderr: lastAttempt.stderr
    },
    lastAttempt.status ?? 1
  );
}

function stripCodeSignBlockedXattrs(path) {
  spawnSync("dot_clean", ["-m", path], {
    cwd: root,
    env: toolchainEnv,
    encoding: "utf8",
    stdio: "ignore"
  });
  for (const attribute of ["com.apple.FinderInfo", "com.apple.ResourceFork", "com.apple.fileprovider.fpfs#P"]) {
    spawnSync("xattr", ["-r", "-d", attribute, path], {
      cwd: root,
      env: toolchainEnv,
      encoding: "utf8",
      stdio: "ignore"
    });
  }
  for (const currentPath of walkPaths(path).reverse()) {
    spawnSync("xattr", ["-c", currentPath], {
      cwd: root,
      env: toolchainEnv,
      encoding: "utf8",
      stdio: "ignore"
    });
    for (const attribute of ["com.apple.FinderInfo", "com.apple.ResourceFork", "com.apple.fileprovider.fpfs#P"]) {
      spawnSync("xattr", ["-d", attribute, currentPath], {
        cwd: root,
        env: toolchainEnv,
        encoding: "utf8",
        stdio: "ignore"
      });
    }
  }
  for (const attribute of ["com.apple.FinderInfo", "com.apple.ResourceFork", "com.apple.fileprovider.fpfs#P"]) {
    spawnSync("xattr", ["-r", "-d", attribute, path], {
      cwd: root,
      env: toolchainEnv,
      encoding: "utf8",
      stdio: "ignore"
    });
  }
}

function walkPaths(path) {
  const paths = [path];
  if (!existsSync(path)) return paths;
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return paths;
  for (const entry of readdirSync(path)) {
    paths.push(...walkPaths(join(path, entry)));
  }
  return paths;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function unregisterReleaseArtifacts() {
  for (const path of [
    imkBundle,
    installerApp,
    uninstallerApp,
    join(distFolder, "Lekh Keyboard Test Installer.app"),
    join(distFolder, "Lekh Keyboard Uninstaller.app")
  ]) {
    spawnSync(lsregister, ["-u", "-v", path], { cwd: root, encoding: "utf8", stdio: "ignore" });
  }
}

function writeAppShellBundle({ appPath, displayName, identifier, executableName, script }) {
  rmSync(appPath, { recursive: true, force: true });
  mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(appPath, "Contents", "Resources"), { recursive: true });
  writeFileSync(
    join(appPath, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${displayName}</string>
  <key>CFBundleExecutable</key>
  <string>${executableName}</string>
  <key>CFBundleIconFile</key>
  <string>Lekh.icns</string>
  <key>CFBundleIdentifier</key>
  <string>${identifier}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${displayName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>4</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`
  );
  writeFileSync(join(appPath, "Contents", "PkgInfo"), "APPL????");
  if (existsSync(iconSource)) copyFileSync(iconSource, join(appPath, "Contents", "Resources", "Lekh.icns"));
  writeFileSync(join(appPath, "Contents", "MacOS", executableName), script);
  chmodSync(join(appPath, "Contents", "MacOS", executableName), 0o755);
}

function compileUniversalHelper(sourceFile, outputPath) {
  const archs = ["arm64", "x86_64"];
  const archOutputs = [];
  for (const arch of archs) {
    const archOutput = `${outputPath}.${arch}`;
    run(
      `compile-${basename(sourceFile)}-${arch}`,
      "swiftc",
      ["-O", "-target", `${arch}-apple-macos13.0`, join(skeletonDir, sourceFile), "-o", archOutput]
    );
    archOutputs.push(archOutput);
  }
  run(`lipo-${basename(outputPath)}`, "lipo", ["-create", ...archOutputs, "-output", outputPath]);
  run(`strip-${basename(outputPath)}`, "strip", ["-S", outputPath]);
  chmodSync(outputPath, 0o755);
  signPath(outputPath, `codesign-${basename(outputPath)}`);
  for (const archOutput of archOutputs) rmSync(archOutput, { force: true });
}

if (process.platform !== "darwin") {
  finish("blocked-native-environment", { reason: "macOS installer app must be packaged on macOS." }, 2);
}

if (!existsSync(imkBundle)) {
  finish("failed", {
    step: "missing-imk-bundle",
    reason: "Run npm run package:macos:imk:dev first.",
    expected: imkBundle
  }, 1);
}

mkdirSync(toolchainEnv.CLANG_MODULE_CACHE_PATH, { recursive: true });
mkdirSync(toolchainEnv.SWIFT_MODULE_CACHE_PATH, { recursive: true });
run("verify-imk-payload", "codesign", ["--verify", "--deep", "--strict", imkBundle]);

rmSync(zipPath, { force: true });
rmSync(distFolder, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });

const installerScript = `#!/usr/bin/env bash
set -uo pipefail

RESOURCE_DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"
DEST="$HOME/Library/Input Methods/Lekh Keyboard.app"
PAYLOAD="$RESOURCE_DIR/Lekh Keyboard.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
LOG_DIR="$HOME/Library/Logs/LekhKeyboard"
LOG_FILE="$LOG_DIR/install.log"
TMP_DEST="$HOME/Library/Input Methods/.Lekh Keyboard.app.installing.$$"
BACKUP_ROOT="$HOME/Library/Caches/LekhKeyboardInstall"
BACKUP_DEST=""
DEST_REPLACED=0

mkdir -p "$LOG_DIR" "$BACKUP_ROOT"
log() { printf '%s %s\\n' "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG_FILE"; }
dialog() {
  /usr/bin/osascript <<APPLESCRIPT >/dev/null 2>&1
display dialog "$1" buttons {"OK"} default button "OK" with title "Lekh Keyboard" with icon note
APPLESCRIPT
}
rollback() {
  if [[ "$DEST_REPLACED" == "1" && -n "$BACKUP_DEST" && -d "$BACKUP_DEST" ]]; then
    log "rollback restoring previous bundle"
    /bin/rm -rf "$DEST"
    /usr/bin/ditto --norsrc --noextattr --noqtn --noacl "$BACKUP_DEST" "$DEST" >/dev/null 2>&1 || true
    "$RESOURCE_DIR/register-lekh-input-source" "$DEST" >/dev/null 2>&1 || true
  fi
}
fail() {
  local message="$1"
  log "FAILED: $message"
  rollback
  dialog "Lekh Keyboard installation failed. Nothing was left half-installed. Details were written to ~/Library/Logs/LekhKeyboard/install.log."
  exit 1
}
cleanup() {
  /bin/rm -rf "$TMP_DEST"
}
trap cleanup EXIT

log "install started payload=$PAYLOAD dest=$DEST"
[[ -d "$PAYLOAD" ]] || fail "missing embedded payload"
/usr/bin/codesign --verify --deep --strict "$PAYLOAD" >> "$LOG_FILE" 2>&1 || fail "embedded payload signature failed"
/bin/mkdir -p "$HOME/Library/Input Methods" || fail "could not create Input Methods directory"

"$RESOURCE_DIR/register-lekh-input-source" "$DEST" --disable >> "$LOG_FILE" 2>&1 || true
/usr/bin/pkill -x LekhInputMethodApp >> "$LOG_FILE" 2>&1 || true

if [[ -d "$DEST" ]]; then
  BACKUP_DEST="$BACKUP_ROOT/Lekh Keyboard.app.backup.$(/bin/date -u '+%Y%m%dT%H%M%SZ')"
  /usr/bin/ditto --norsrc --noextattr --noqtn --noacl "$DEST" "$BACKUP_DEST" >> "$LOG_FILE" 2>&1 || fail "could not back up existing install"
fi

/bin/rm -rf "$TMP_DEST"
/usr/bin/ditto --norsrc --noextattr --noqtn --noacl "$PAYLOAD" "$TMP_DEST" >> "$LOG_FILE" 2>&1 || fail "could not copy payload"
/usr/bin/codesign --verify --deep --strict "$TMP_DEST" >> "$LOG_FILE" 2>&1 || fail "copied payload signature failed"

if [[ -d "$DEST" ]]; then
  /bin/rm -rf "$DEST" || fail "could not remove old install"
  DEST_REPLACED=1
fi
/bin/mv "$TMP_DEST" "$DEST" || fail "could not move install into place"
DEST_REPLACED=0

"$LSREGISTER" -f "$DEST" >> "$LOG_FILE" 2>&1 || log "LaunchServices registration returned non-zero"
"$RESOURCE_DIR/register-lekh-input-source" "$DEST" >> "$LOG_FILE" 2>&1 || fail "input source registration failed"
/usr/bin/killall TextInputMenuAgent TextInputSwitcher >> "$LOG_FILE" 2>&1 || true

log "install completed"
dialog "Lekh Keyboard installed and enabled. Open the input menu in the menu bar to switch between ABC and Lekh Keyboard."
exit 0
`;

writeAppShellBundle({
  appPath: installerApp,
  displayName: "Lekh Keyboard Test Installer",
  identifier: "com.lekh.inputmethod.TestInstaller",
  executableName: "install-lekh-keyboard",
  script: installerScript
});

const uninstallerScript = `#!/usr/bin/env bash
set -uo pipefail

RESOURCE_DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"
DEST="$HOME/Library/Input Methods/Lekh Keyboard.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
LOG_DIR="$HOME/Library/Logs/LekhKeyboard"
LOG_FILE="$LOG_DIR/uninstall.log"
mkdir -p "$LOG_DIR"
log() { printf '%s %s\\n' "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG_FILE"; }
dialog() {
  /usr/bin/osascript <<APPLESCRIPT >/dev/null 2>&1
display dialog "$1" buttons {"OK"} default button "OK" with title "Lekh Keyboard" with icon note
APPLESCRIPT
}

log "uninstall started"
"$RESOURCE_DIR/restore-system-keyboard" >> "$LOG_FILE" 2>&1 || true
"$RESOURCE_DIR/register-lekh-input-source" "$DEST" --disable >> "$LOG_FILE" 2>&1 || true
if [[ -d "$DEST" ]]; then
  "$LSREGISTER" -u "$DEST" >> "$LOG_FILE" 2>&1 || true
fi
/usr/bin/pkill -x LekhInputMethodApp >> "$LOG_FILE" 2>&1 || true
/bin/rm -rf "$DEST"
"$RESOURCE_DIR/purge-lekh-input-sources" >> "$LOG_FILE" 2>&1 || true
/usr/bin/killall TextInputMenuAgent TextInputSwitcher >> "$LOG_FILE" 2>&1 || true
log "uninstall completed"
dialog "Lekh Keyboard was removed. Your keyboard was restored to ABC if macOS allowed the change."
exit 0
`;

writeAppShellBundle({
  appPath: uninstallerApp,
  displayName: "Lekh Keyboard Uninstaller",
  identifier: "com.lekh.inputmethod.Uninstaller",
  executableName: "uninstall-lekh-keyboard",
  script: uninstallerScript
});

const metadataSafeDittoFlags = ["--norsrc", "--noextattr", "--noqtn", "--noacl"];
for (const appPath of [installerApp, uninstallerApp]) {
  const resourcesDir = join(appPath, "Contents", "Resources");
  run("copy-imk-payload", "ditto", [...metadataSafeDittoFlags, imkBundle, join(resourcesDir, "Lekh Keyboard.app")]);
  for (const [sourceFile, binaryName] of [
    ["register-dev.swift", "register-lekh-input-source"],
    ["restore-system-keyboard.swift", "restore-system-keyboard"],
    ["purge-lekh-input-sources.swift", "purge-lekh-input-sources"]
  ]) {
    compileUniversalHelper(sourceFile, join(resourcesDir, binaryName));
  }
  signPath(appPath, `codesign-${basename(appPath)}`);
  sleep(500);
  stripCodeSignBlockedXattrs(appPath);
  verifySignedPath(appPath, `verify-${basename(appPath)}`);
}

mkdirSync(distFolder, { recursive: true });
run("copy-installer-to-folder", "ditto", [...metadataSafeDittoFlags, installerApp, join(distFolder, "Lekh Keyboard Test Installer.app")]);
run("copy-uninstaller-to-folder", "ditto", [...metadataSafeDittoFlags, uninstallerApp, join(distFolder, "Lekh Keyboard Uninstaller.app")]);
writeFileSync(
  join(distFolder, "README.txt"),
  [
    "Lekh Keyboard Test Installer",
    "",
    "Install:",
    "1. Open Lekh Keyboard Test Installer.app.",
    "2. After it finishes, use the macOS input menu in the menu bar to choose Lekh Keyboard.",
    "",
    "Uninstall:",
    "Open Lekh Keyboard Uninstaller.app.",
    "",
    "Logs:",
    "~/Library/Logs/LekhKeyboard/install.log",
    "~/Library/Logs/LekhKeyboard/uninstall.log",
    "",
    "This test build is local-first and does not send typing data to a server.",
    "Production distribution still requires Developer ID signing and notarization if this zip is built without LEKH_MAC_DEVELOPER_ID.",
    ""
  ].join("\n")
);
if (existsSync(join(root, "LICENSE"))) {
  copyFileSync(join(root, "LICENSE"), join(distFolder, "LICENSE.txt"));
}

const checksumTargets = [
  join(distFolder, "Lekh Keyboard Test Installer.app", "Contents", "MacOS", "install-lekh-keyboard"),
  join(distFolder, "Lekh Keyboard Test Installer.app", "Contents", "Resources", "Lekh Keyboard.app", "Contents", "MacOS", "LekhInputMethodApp"),
  join(distFolder, "Lekh Keyboard Test Installer.app", "Contents", "Resources", "register-lekh-input-source"),
  join(distFolder, "Lekh Keyboard Uninstaller.app", "Contents", "MacOS", "uninstall-lekh-keyboard"),
  join(distFolder, "README.txt"),
  existsSync(join(distFolder, "LICENSE.txt")) ? join(distFolder, "LICENSE.txt") : null
].filter(Boolean);
const checksumLines = checksumTargets.map((target) => {
  const output = run(`checksum-${basename(target)}`, "shasum", ["-a", "256", target]).stdout.trim();
  return output.replace(target, relative(distFolder, target));
});
writeFileSync(join(distFolder, "SHA256SUMS.txt"), `${checksumLines.join("\n")}\n`);
stripCodeSignBlockedXattrs(installerApp);
stripCodeSignBlockedXattrs(uninstallerApp);
stripCodeSignBlockedXattrs(distFolder);
verifySignedPath(installerApp, "verify-final-installer-app");
verifySignedPath(uninstallerApp, "verify-final-uninstaller-app");

run("zip-installer-folder", "ditto", ["-c", "-k", "--keepParent", "--norsrc", "--noextattr", "--noqtn", "--noacl", distFolder, zipPath], {
  cwd: releaseDir
});

const zipCheckDir = mkdtempSync(join(tmpdir(), "lekh-installer-verify-"));
run("verify-zip-extract", "ditto", ["-x", "-k", zipPath, zipCheckDir]);
const extractedRoot = join(zipCheckDir, "Lekh Keyboard Test Installer");
const extractedInstaller = join(extractedRoot, "Lekh Keyboard Test Installer.app");
const extractedUninstaller = join(extractedRoot, "Lekh Keyboard Uninstaller.app");
verifySignedPath(extractedInstaller, "verify-extracted-installer");
verifySignedPath(extractedUninstaller, "verify-extracted-uninstaller");
const extractedPayloadArchs = run(
  "verify-extracted-payload-archs",
  "lipo",
  ["-archs", join(extractedInstaller, "Contents", "Resources", "Lekh Keyboard.app", "Contents", "MacOS", "LekhInputMethodApp")]
).stdout.trim();
rmSync(zipCheckDir, { recursive: true, force: true });
unregisterReleaseArtifacts();
sleep(500);
unregisterReleaseArtifacts();

const helperArchs = run(
  "helper-archs",
  "lipo",
  ["-archs", join(installerApp, "Contents", "Resources", "register-lekh-input-source")]
).stdout.trim();
const zipBytes = statSync(zipPath).size;

finish(signingIdentity === "-" ? "passed-adhoc-release" : "passed-developer-id-ready", {
  artifact: installerApp,
  uninstaller: uninstallerApp,
  folder: distFolder,
  zip: zipPath,
  payload: imkBundle,
  signed: signingIdentity === "-" ? "ad-hoc-hardened-runtime" : signingIdentity,
  helperArchs,
  extractedPayloadArchs,
  zipVerification: "passed",
  zipBytes,
  note: signingIdentity === "-"
    ? "Ad-hoc signed test artifact. Developer ID signing and notarization are still required for production distribution."
    : "Developer ID signed artifact. Notarization/stapling gate must run before public distribution."
}, 0);
