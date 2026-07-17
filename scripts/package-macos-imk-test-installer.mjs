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
import { homedir, tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { verifyMacOSIMKDevArtifact } from "./lib/macos-imk-dev-release-integrity.mjs";
import { readProductionReleasePolicy } from "./lib/macos-production-release-attestation.mjs";

const root = process.cwd();
const startedAt = performance.now();
const reportPath = join(root, "reports", "macos-imk-test-installer-report.json");
const releaseDir = join(root, "release", "native", "macos");
const buildReleaseDir = process.env.LEKH_MACOS_INSTALLER_BUILD_DIR ||
  join(homedir(), "Library", "Caches", "LekhKeyboardBuild", "native", "macos-installer");
const stagedImkBundle = process.env.LEKH_MACOS_IMK_BUILD_DIR
  ? join(process.env.LEKH_MACOS_IMK_BUILD_DIR, "Lekh Keyboard.imkdevbundle")
  : join(homedir(), "Library", "Caches", "LekhKeyboardBuild", "native", "macos", "Lekh Keyboard.imkdevbundle");
const releaseImkBundle = join(releaseDir, "Lekh Keyboard.imkdevbundle");
const imkBundle = existsSync(stagedImkBundle) ? stagedImkBundle : releaseImkBundle;
const installerApp = join(buildReleaseDir, "Lekh Keyboard Test Installer.app");
const uninstallerApp = join(buildReleaseDir, "Lekh Keyboard Uninstaller.app");
const distFolder = join(buildReleaseDir, "Lekh Keyboard Test Installer");
const zipPath = join(releaseDir, "Lekh-Keyboard-Test-Installer.zip");
const publicUpdatesDir = join(root, "public", "updates", "macos");
const skeletonDir = join(root, "native", "macos-imk", "skeleton");
const iconSource = join(root, "build", "icon.icns");
const signingIdentity = process.env.LEKH_MAC_DEVELOPER_ID || "-";
const committedProductionTeamIdentifier = readProductionReleasePolicy(root)
  .policy?.appleDeveloperTeamIdentifier ?? null;
const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const appShortVersion = process.env.LEKH_APP_SHORT_VERSION || packageVersion.match(/^\d+\.\d+\.\d+/)?.[0];
const gitBuild = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const appBuild = Number(process.env.LEKH_APP_BUILD || gitBuild);
const releaseChannel = signingIdentity === "-" ? "test-adhoc" : "developer-id";
const expectedConnectionName = "com.lekh.inputmethod.LekhKeyboard_Connection";
const minisignSecretKey = process.env.LEKH_RELEASE_MANIFEST_MINISIGN_SECRET_KEY ||
  join(root, "data", "private", "lekh-release-manifest-minisign.sec");
const minisignPublicKey = join(root, "public", "security", "lekh-release-manifest-minisign.pub");
const sparklePrivateKey = process.env.LEKH_SPARKLE_EDDSA_PRIVATE_KEY_PATH ||
  join(root, "data", "private", "lekh-sparkle-ed25519-private.pem");
const appcastPath = join(releaseDir, "appcast.xml");
const installerPublicURL = process.env.LEKH_MACOS_INSTALLER_URL ||
  (process.env.LEKH_SPARKLE_APPCAST_URL || "https://lekh-assistant.pages.dev/updates/macos/appcast.xml")
    .replace(/appcast\.xml(?:\?.*)?$/, "Lekh-Keyboard-Test-Installer.zip");
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
    maxBuffer: options.maxBuffer ?? 80 * 1024 * 1024,
    timeout: options.timeout
  });
  if (result.status !== 0) {
    finish("failed", { step, command, args, stdout: result.stdout, stderr: result.stderr }, result.status ?? 1);
  }
  return result;
}

function minisignPublicKeyValue() {
  if (!existsSync(minisignPublicKey)) {
    finish("failed", {
      step: "verify-minisign-signature",
      reason: "Missing minisign public key.",
      expected: minisignPublicKey
    }, 1);
  }
  return readFileSync(minisignPublicKey, "utf8").trim().split(/\r?\n/).at(-1);
}

function verifyMinisignSignature(manifestPath, signaturePath, step) {
  if (!existsSync(signaturePath)) {
    finish("failed", { step, reason: "Missing minisign signature.", signaturePath }, 1);
  }
  const lines = readFileSync(signaturePath, "utf8").trim().split(/\r?\n/);
  const base64Payloads = lines.filter((line) => /^[A-Za-z0-9+/]+={0,2}$/.test(line));
  if (base64Payloads.length < 1) {
    finish("failed", {
      step,
      reason: "Minisign signature has no base64 signature payload.",
      signaturePath
    }, 1);
  }
  run(step, "minisign", ["-Vm", manifestPath, "-x", signaturePath, "-P", minisignPublicKeyValue()]);
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
    const tempRoot = mkdtempSync(join(tmpdir(), "lekh-codesign-clean-"));
    const tempPath = join(tempRoot, basename(path));
    run(`${step}-copy-clean`, "ditto", ["--norsrc", "--noextattr", "--noacl", path, tempPath]);
    stripCodeSignBlockedXattrs(tempPath);
    run(`${step}-temp`, "codesign", [...args.slice(0, -1), tempPath]);
    verifySignedPathRaw(tempPath, `${step}-temp-raw-verify`);
    rmSync(path, { recursive: true, force: true });
    run(`${step}-copy-back`, "ditto", ["--norsrc", "--noextattr", "--noacl", tempPath, path]);
    rmSync(tempRoot, { recursive: true, force: true });
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

function verifySignedPathRaw(path, step) {
  const result = spawnSync("codesign", ["--verify", "--deep", "--strict", path], {
    cwd: root,
    env: toolchainEnv,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 80 * 1024 * 1024
  });
  if (result.status !== 0) {
    finish(
      "failed",
      {
        step,
        command: "codesign",
        args: ["--verify", "--deep", "--strict", path],
        stdout: result.stdout,
        stderr: result.stderr
      },
      result.status ?? 1
    );
  }
}

function stripCodeSignBlockedXattrs(path) {
  spawnSync("dot_clean", ["-m", path], {
    cwd: root,
    env: toolchainEnv,
    encoding: "utf8",
    stdio: "ignore"
  });
  for (const attribute of ["com.apple.FinderInfo", "com.apple.ResourceFork", "com.apple.fileprovider.fpfs#P", "com.apple.provenance"]) {
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
    for (const attribute of ["com.apple.FinderInfo", "com.apple.ResourceFork", "com.apple.fileprovider.fpfs#P", "com.apple.provenance"]) {
      spawnSync("xattr", ["-d", attribute, currentPath], {
        cwd: root,
        env: toolchainEnv,
        encoding: "utf8",
        stdio: "ignore"
      });
    }
  }
  for (const attribute of ["com.apple.FinderInfo", "com.apple.ResourceFork", "com.apple.fileprovider.fpfs#P", "com.apple.provenance"]) {
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
    stagedImkBundle,
    releaseImkBundle,
    installerApp,
    uninstallerApp,
    join(distFolder, "Lekh Keyboard Test Installer.app"),
    join(distFolder, "Lekh Keyboard Uninstaller.app")
  ]) {
    spawnSync(lsregister, ["-u", "-v", path], { cwd: root, encoding: "utf8", stdio: "ignore" });
  }
}

function writeAppShellBundle({ appPath, displayName, identifier, executableName, script, uiElement = false }) {
  rmSync(appPath, { recursive: true, force: true });
  mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(appPath, "Contents", "Resources"), { recursive: true });
  writeFileSync(
    join(appPath, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
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
  <string>${appShortVersion}</string>
  <key>CFBundleVersion</key>
  <string>${appBuild}</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <${uiElement ? "true" : "false"}/>
</dict>
</plist>
`
  );
  writeFileSync(join(appPath, "Contents", "PkgInfo"), "APPL????");
  if (existsSync(iconSource)) copyFileSync(iconSource, join(appPath, "Contents", "Resources", "Lekh.icns"));
  const executablePath = join(appPath, "Contents", "MacOS", executableName);
  writeFileSync(executablePath, script);
  chmodSync(executablePath, 0o755);
  run(`verify-shell-syntax-${executableName}`, "/bin/bash", ["-n", executablePath]);
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

function notarizeAndStaple(appPaths) {
  const required = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    finish("blocked-external", {
      step: "notarization-credentials",
      reason: "Developer ID output requires notarization credentials.",
      missing
    }, 2);
  }
  const staging = mkdtempSync(join(tmpdir(), "lekh-notary-"));
  const folder = join(staging, "Lekh Keyboard");
  const archive = join(staging, "Lekh-Keyboard-Notary.zip");
  mkdirSync(folder, { recursive: true });
  for (const appPath of appPaths) {
    run("notary-copy", "ditto", ["--norsrc", "--noextattr", "--noacl", appPath, join(folder, basename(appPath))]);
  }
  run("notary-zip", "ditto", ["-c", "-k", "--keepParent", "--norsrc", "--noextattr", "--noacl", folder, archive]);
  run("notary-submit", "xcrun", [
    "notarytool",
    "submit",
    archive,
    "--apple-id",
    process.env.APPLE_ID,
    "--password",
    process.env.APPLE_APP_SPECIFIC_PASSWORD,
    "--team-id",
    process.env.APPLE_TEAM_ID,
    "--wait"
  ], { timeout: 900_000 });
  for (const appPath of appPaths) {
    run(`staple-${basename(appPath)}`, "xcrun", ["stapler", "staple", appPath]);
    run(`validate-staple-${basename(appPath)}`, "xcrun", ["stapler", "validate", appPath]);
    run(`gatekeeper-${basename(appPath)}`, "spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);
  }
  rmSync(staging, { recursive: true, force: true });
}

if (process.platform !== "darwin") {
  finish("blocked-native-environment", { reason: "macOS installer app must be packaged on macOS." }, 2);
}

if (!appShortVersion || !/^\d+\.\d+\.\d+$/.test(appShortVersion) || !Number.isInteger(appBuild) || appBuild < 1) {
  finish("failed", {
    step: "version",
    reason: "LEKH_APP_SHORT_VERSION must be x.y.z and LEKH_APP_BUILD must be a positive integer.",
    appShortVersion,
    appBuild
  }, 1);
}

if (signingIdentity !== "-") {
  const required = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    finish("blocked-external", {
      step: "notarization-credentials",
      reason: "Developer ID packaging cannot proceed without notarization credentials.",
      missing
    }, 2);
  }
  if (
    !/^[A-Z0-9]{10}$/u.test(committedProductionTeamIdentifier ?? "") ||
    process.env.APPLE_TEAM_ID !== committedProductionTeamIdentifier
  ) {
    finish("blocked-external", {
      step: "production-team-identity",
      reason: "APPLE_TEAM_ID must exactly match config/macos-production-release-policy.v1.json."
    }, 2);
  }
}

if (!existsSync(imkBundle)) {
  finish("failed", {
    step: "missing-imk-bundle",
    reason: "Run npm run package:macos:imk:dev first.",
    expected: stagedImkBundle,
    fallback: releaseImkBundle
  }, 1);
}

mkdirSync(toolchainEnv.CLANG_MODULE_CACHE_PATH, { recursive: true });
mkdirSync(toolchainEnv.SWIFT_MODULE_CACHE_PATH, { recursive: true });
run("verify-imk-payload", "codesign", ["--verify", "--deep", "--strict", imkBundle]);
const imkIntegrity = verifyMacOSIMKDevArtifact({
  root,
  appBundle: imkBundle,
  packageReportPath: join(root, "reports", "macos-imk-dev-package-report.json"),
  expectedReportArtifact: imkBundle
});
if (imkIntegrity.status !== "passed") {
  finish("failed", {
    step: "verify-imk-payload-provenance",
    reason: "The selected IMK payload is stale, unbound to the current clean source tree, or does not match its package report.",
    issues: imkIntegrity.issues
  }, 1);
}
const payloadConnectionName = run(
  "verify-imk-connection-name",
  "/usr/bin/plutil",
  ["-extract", "InputMethodConnectionName", "raw", "-o", "-", join(imkBundle, "Contents", "Info.plist")]
).stdout.trim();
if (payloadConnectionName !== expectedConnectionName) {
  finish("failed", {
    step: "verify-imk-connection-name",
    reason: `InputMethodConnectionName must be exactly ${expectedConnectionName}.`,
    observed: payloadConnectionName
  }, 1);
}

rmSync(zipPath, { force: true });
rmSync(distFolder, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });
mkdirSync(buildReleaseDir, { recursive: true });
rmSync(join(releaseDir, "Lekh Keyboard Test Installer.app"), { recursive: true, force: true });
rmSync(join(releaseDir, "Lekh Keyboard Uninstaller.app"), { recursive: true, force: true });
rmSync(join(releaseDir, "Lekh Keyboard Test Installer"), { recursive: true, force: true });
rmSync(join(releaseDir, "LekhInputMethodApp.universal"), { force: true });
rmSync(join(releaseDir, "runtime-suggestions.lkb"), { force: true });
rmSync(join(releaseDir, "runtime-suggestions.sanitized.json"), { force: true });

const installerScript = `#!/usr/bin/env bash
set -euo pipefail

RESOURCE_DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"
DEST="$HOME/Library/Input Methods/Lekh Keyboard.app"
PAYLOAD="$RESOURCE_DIR/Lekh Keyboard.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
LOG_DIR="$HOME/Library/Logs/LekhKeyboard"
LOG_FILE="$LOG_DIR/install.log"
TMP_DEST="$HOME/Library/Input Methods/.Lekh Keyboard.app.installing.$$"
SUPPORT_DIR="$HOME/Library/Application Support/Lekh Keyboard"
LEGACY_BACKUP_ROOT="$SUPPORT_DIR/InstallBackups"
BACKUP_ROOT="$SUPPORT_DIR/InstallBackups.noindex"
BACKUP_EXTRACT_ROOT="$SUPPORT_DIR/.Lekh Keyboard.rollback.$$"
RUNTIME_HEALTH="$SUPPORT_DIR/runtime-health.v1.json"
EXPECTED_CONNECTION_NAME="${expectedConnectionName}"
BACKUP_DEST=""
OLD_DEST=""
DEST_REPLACED=0
SWAPPED_DEST=0

mkdir -p "$LOG_DIR" "$BACKUP_ROOT" || exit 1
/usr/bin/touch "$BACKUP_ROOT/.metadata_never_index"
log() { printf '%s %s\n' "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG_FILE"; }
stop_lekh_input_method_for_replacement() {
  "$RESOURCE_DIR/terminate-exact-processes" --terminate-all-exact-path \
    "$DEST/Contents/MacOS/LekhInputMethodApp" >> "$LOG_FILE" 2>&1
}
dialog() {
  if [[ "\${LEKH_INSTALLER_NO_DIALOG:-0}" == "1" ]]; then
    return 0
  fi
  LEKH_DIALOG_MESSAGE="$1" /usr/bin/osascript <<'APPLESCRIPT' >/dev/null 2>&1
display dialog (system attribute "LEKH_DIALOG_MESSAGE") buttons {"OK"} default button "OK" with title "Lekh Keyboard" with icon note
APPLESCRIPT
}
rollback() {
  if [[ "$SWAPPED_DEST" == "1" && -n "$OLD_DEST" && -d "$OLD_DEST" && -d "$DEST" ]]; then
    log "rollback atomically swapping previous bundle back into place"
    "$RESOURCE_DIR/atomic-install-swap" "$OLD_DEST" "$DEST" >/dev/null 2>&1 || true
    "$RESOURCE_DIR/register-lekh-input-source" "$DEST" >/dev/null 2>&1 || true
    return
  fi
  if [[ -n "$OLD_DEST" && -d "$OLD_DEST" ]]; then
    log "rollback moving previous bundle back into place"
    /bin/rm -rf "$DEST"
    /bin/mv "$OLD_DEST" "$DEST" >/dev/null 2>&1 || true
    "$RESOURCE_DIR/register-lekh-input-source" "$DEST" >/dev/null 2>&1 || true
    return
  fi
	  if [[ "$DEST_REPLACED" == "1" && -n "$BACKUP_DEST" && -f "$BACKUP_DEST" ]]; then
	    log "rollback restoring previous bundle"
	    /bin/rm -rf "$DEST"
	    /bin/rm -rf "$BACKUP_EXTRACT_ROOT"
	    /bin/mkdir -p "$BACKUP_EXTRACT_ROOT"
	    /usr/bin/ditto -x -k "$BACKUP_DEST" "$BACKUP_EXTRACT_ROOT" >/dev/null 2>&1 || true
	    RESTORED_APP="$(/usr/bin/find "$BACKUP_EXTRACT_ROOT" -maxdepth 2 -type d -name 'Lekh Keyboard.app' -print -quit 2>/dev/null)"
	    if [[ -n "$RESTORED_APP" && -d "$RESTORED_APP" ]]; then
	      /usr/bin/ditto --norsrc --noextattr --noacl "$RESTORED_APP" "$DEST" >/dev/null 2>&1 || true
	    fi
	    /bin/rm -rf "$BACKUP_EXTRACT_ROOT"
	    "$RESOURCE_DIR/register-lekh-input-source" "$DEST" >/dev/null 2>&1 || true
	  fi
}
fail() {
  local message="$1"
  log "FAILED: $message"
  rollback
  dialog "Lekh Keyboard installation failed. Nothing was left half-installed. Details were written to ~/Library/Logs/LekhKeyboard/install.log.\n\nलेख किबोर्ड स्थापना असफल भयो। आधा-स्थापित अवस्थामा केही छोडिएको छैन। विवरण ~/Library/Logs/LekhKeyboard/install.log मा लेखिएको छ।"
  exit 1
}
	cleanup() {
	  /bin/rm -rf "$TMP_DEST" "$BACKUP_EXTRACT_ROOT"
	}
	migrate_legacy_backup_bundles() {
	  for backup_root in "$LEGACY_BACKUP_ROOT" "$BACKUP_ROOT"; do
	    [[ -d "$backup_root" ]] || continue
	    while IFS= read -r -d '' backup; do
	        "$LSREGISTER" -u "$backup" >> "$LOG_FILE" 2>&1 || true
	        backup_name="$(/usr/bin/basename "$backup")"
	        archive="$BACKUP_ROOT/$backup_name.zip"
	        [[ -e "$archive" ]] && archive="$BACKUP_ROOT/$backup_name.$$.zip"
	        archive_tmp="$archive.installing"
	        /bin/rm -f "$archive_tmp"
	        if /usr/bin/ditto -c -k --norsrc --noextattr --keepParent "$backup" "$archive_tmp" >> "$LOG_FILE" 2>&1; then
	          /bin/mv "$archive_tmp" "$archive"
	          /bin/rm -rf "$backup"
	        else
	          /bin/rm -f "$archive_tmp"
	          fail "could not archive an indexed rollback backup"
	        fi
	    done < <(/usr/bin/find "$backup_root" -maxdepth 1 -type d -name 'Lekh Keyboard.app.backup.*' -print0 2>/dev/null)
	  done
	  return 0
	}
rotate_backups() {
  local keep_count=3
  local existing_count
	  existing_count="$(/usr/bin/find "$BACKUP_ROOT" -maxdepth 1 -type f -name 'Lekh Keyboard.app.backup.*.zip' 2>/dev/null | /usr/bin/wc -l | /usr/bin/tr -d ' ')"
  if [[ "\${existing_count:-0}" -le "$keep_count" ]]; then
    return
  fi
	  /usr/bin/find "$BACKUP_ROOT" -maxdepth 1 -type f -name 'Lekh Keyboard.app.backup.*.zip' -print 2>/dev/null |
    /usr/bin/sort -r |
    /usr/bin/tail -n +"$((keep_count + 1))" |
    while IFS= read -r old_backup; do
	      [[ -n "$old_backup" ]] && /bin/rm -f "$old_backup"
    done
}
trap 'rollback; cleanup' EXIT
trap 'fail "installation interrupted"' INT TERM HUP

APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PAYLOAD/Contents/Info.plist" 2>/dev/null || printf 'unknown')"
APP_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$PAYLOAD/Contents/Info.plist" 2>/dev/null || printf 'unknown')"
PAYLOAD_CONNECTION_NAME="$(/usr/bin/plutil -extract InputMethodConnectionName raw -o - "$PAYLOAD/Contents/Info.plist" 2>/dev/null || true)"
log "install started payload=$PAYLOAD dest=$DEST version=$APP_VERSION build=$APP_BUILD"
[[ -d "$PAYLOAD" ]] || fail "missing embedded payload"
[[ "$PAYLOAD_CONNECTION_NAME" == "$EXPECTED_CONNECTION_NAME" ]] || fail "embedded payload has an unsupported InputMethodConnectionName"
/usr/bin/codesign --verify --deep --strict "$PAYLOAD" >> "$LOG_FILE" 2>&1 || fail "embedded payload signature failed"
/bin/mkdir -p "$HOME/Library/Input Methods" || fail "could not create Input Methods directory"

"$RESOURCE_DIR/restore-system-keyboard" --snapshot >> "$LOG_FILE" 2>&1 || log "could not snapshot the current non-Lekh input source"
"$RESOURCE_DIR/restore-system-keyboard" >> "$LOG_FILE" 2>&1 || fail "could not select a safe input source before replacement"
if [[ -f "$DEST/Contents/Info.plist" ]]; then
  "$RESOURCE_DIR/register-lekh-input-source" "$DEST" --disable >> "$LOG_FILE" 2>&1 || true
fi
	stop_lekh_input_method_for_replacement || fail "could not stop the running input method before replacement"
	migrate_legacy_backup_bundles

if [[ -d "$DEST" ]]; then
  "$LSREGISTER" -u "$DEST" >> "$LOG_FILE" 2>&1 || true
	  BACKUP_DEST="$BACKUP_ROOT/Lekh Keyboard.app.backup.$(/bin/date -u '+%Y%m%dT%H%M%SZ').zip"
	  /usr/bin/ditto -c -k --norsrc --noextattr --keepParent "$DEST" "$BACKUP_DEST" >> "$LOG_FILE" 2>&1 || fail "could not archive existing install"
  rotate_backups
fi

/bin/rm -rf "$TMP_DEST"
/usr/bin/ditto --norsrc --noextattr --noacl "$PAYLOAD" "$TMP_DEST" >> "$LOG_FILE" 2>&1 || fail "could not copy payload"
/usr/bin/codesign --verify --deep --strict "$TMP_DEST" >> "$LOG_FILE" 2>&1 || fail "copied payload signature failed"
TMP_CONNECTION_NAME="$(/usr/bin/plutil -extract InputMethodConnectionName raw -o - "$TMP_DEST/Contents/Info.plist" 2>/dev/null || true)"
[[ "$TMP_CONNECTION_NAME" == "$EXPECTED_CONNECTION_NAME" ]] || fail "copied payload changed the IMK connection contract"

if [[ -d "$DEST" ]]; then
  "$LSREGISTER" -u "$DEST" >> "$LOG_FILE" 2>&1 || true
  "$RESOURCE_DIR/atomic-install-swap" "$TMP_DEST" "$DEST" >> "$LOG_FILE" 2>&1 || fail "could not atomically swap install into place"
  OLD_DEST="$TMP_DEST"
  TMP_DEST=""
  DEST_REPLACED=1
  SWAPPED_DEST=1
fi
"$RESOURCE_DIR/purge-lekh-input-sources" >> "$LOG_FILE" 2>&1 || true
	migrate_legacy_backup_bundles
if [[ "$SWAPPED_DEST" == "0" ]]; then
  /bin/mv "$TMP_DEST" "$DEST" || fail "could not move install into place"
  TMP_DEST=""
fi

"$LSREGISTER" -f "$DEST" >> "$LOG_FILE" 2>&1 || log "LaunchServices registration returned non-zero"
"$RESOURCE_DIR/register-lekh-input-source" "$DEST" >> "$LOG_FILE" 2>&1 || fail "input source registration failed"
INSTALLED_CONNECTION_NAME="$(/usr/bin/plutil -extract InputMethodConnectionName raw -o - "$DEST/Contents/Info.plist" 2>/dev/null || true)"
[[ "$INSTALLED_CONNECTION_NAME" == "$EXPECTED_CONNECTION_NAME" ]] || fail "installed bundle changed the IMK connection contract"
DEST_REPLACED=0
SWAPPED_DEST=0
/bin/rm -rf "$OLD_DEST"
OLD_DEST=""
		migrate_legacy_backup_bundles
/bin/rm -f "$RUNTIME_HEALTH"

log "install completed"
dialog "Lekh Keyboard installed and enabled. Open the input menu in the menu bar to switch between ABC and Lekh Keyboard. If it does not appear immediately, log out and back in.\n\nलेख किबोर्ड स्थापना र सक्षम भयो। ABC र लेख किबोर्डबीच स्विच गर्न menu bar को input menu खोल्नुहोस्। तुरुन्त नदेखिए log out गरेर फेरि log in गर्नुहोस्।"
exit 0
`
writeAppShellBundle({
  appPath: installerApp,
  displayName: "Lekh Keyboard Test Installer",
  identifier: "com.lekh.inputmethod.TestInstaller",
  executableName: "install-lekh-keyboard",
  script: installerScript
});

const uninstallerScript = `#!/usr/bin/env bash
set -euo pipefail

RESOURCE_DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"
DEST="$HOME/Library/Input Methods/Lekh Keyboard.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
LOG_DIR="$HOME/Library/Logs/LekhKeyboard"
LOG_FILE="$LOG_DIR/uninstall.log"
SUPPORT_DIR="$HOME/Library/Application Support/Lekh Keyboard"
LEGACY_BACKUP_ROOT="$SUPPORT_DIR/InstallBackups"
ARCHIVE_BACKUP_ROOT="$SUPPORT_DIR/InstallBackups.noindex"
CACHE_DIR="$HOME/Library/Caches/LekhKeyboardInstall"
RUNTIME_HEALTH="$SUPPORT_DIR/runtime-health.v1.json"
mkdir -p "$LOG_DIR" || exit 1
log() { printf '%s %s\\n' "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG_FILE"; }
stop_lekh_input_method_for_removal() {
  "$RESOURCE_DIR/terminate-exact-processes" --terminate-all-exact-path \
    "$DEST/Contents/MacOS/LekhInputMethodApp" >> "$LOG_FILE" 2>&1
}
unregister_backup_bundles() {
  for backup_root in "$LEGACY_BACKUP_ROOT" "$ARCHIVE_BACKUP_ROOT"; do
    [[ -d "$backup_root" ]] || continue
    while IFS= read -r -d '' backup; do
        "$LSREGISTER" -u "$backup" >> "$LOG_FILE" 2>&1 || true
    done < <(/usr/bin/find "$backup_root" -maxdepth 1 -type d -name 'Lekh Keyboard.app.backup.*' -print0 2>/dev/null)
  done
  return 0
}
dialog() {
  if [[ "\${LEKH_UNINSTALLER_NO_DIALOG:-0}" == "1" ]]; then
    return 0
  fi
  LEKH_DIALOG_MESSAGE="$1" /usr/bin/osascript <<'APPLESCRIPT' >/dev/null 2>&1
display dialog (system attribute "LEKH_DIALOG_MESSAGE") buttons {"OK"} default button "OK" with title "Lekh Keyboard" with icon note
APPLESCRIPT
}
confirm_uninstall() {
  if [[ "\${LEKH_UNINSTALLER_NO_DIALOG:-0}" == "1" ]]; then
    case "\${LEKH_REMOVE_PERSONAL_DICTIONARY:-1}" in
      0|1) printf '%s\n' "\${LEKH_REMOVE_PERSONAL_DICTIONARY:-1}" ;;
      *) return 64 ;;
    esac
    return 0
  fi
  /usr/bin/osascript <<'APPLESCRIPT'
use framework "AppKit"
use scripting additions

set alert to current application's NSAlert's alloc()'s init()
alert's setMessageText:"Remove Lekh Keyboard from this Mac?"
alert's setInformativeText:"This removes the keyboard, dictionary packs, model files, backups, caches, and Lekh logs. Your personal dictionary is kept unless you check the box below.\n\nयो Mac बाट लेख किबोर्ड हटाउने? यसले keyboard, dictionary packs, model files, backups, caches, र Lekh logs हटाउँछ। तलको checkbox नछानेसम्म personal dictionary राखिन्छ।"
alert's addButtonWithTitle:"Uninstall"
alert's addButtonWithTitle:"Cancel"
alert's setAlertStyle:(current application's NSAlertStyleWarning)
set checkbox to current application's NSButton's checkboxWithTitle:"Also remove my personal dictionary" target:(missing value) action:(missing value)
checkbox's setState:0
alert's setAccessoryView:checkbox
set response to alert's runModal()
if response is not 1000 then error number -128
if (checkbox's state() as integer) is 1 then
  return "1"
end if
return "0"
APPLESCRIPT
}

REMOVE_PERSONAL_DICTIONARY="$(confirm_uninstall 2>/dev/null || true)"
if [[ "$REMOVE_PERSONAL_DICTIONARY" != "0" && "$REMOVE_PERSONAL_DICTIONARY" != "1" ]]; then
  log "uninstall cancelled by user"
  exit 0
fi

log "uninstall started"
"$RESOURCE_DIR/restore-system-keyboard" >> "$LOG_FILE" 2>&1 || true
"$RESOURCE_DIR/register-lekh-input-source" "$DEST" --disable >> "$LOG_FILE" 2>&1 || true
if [[ -d "$DEST" ]]; then
  "$LSREGISTER" -u "$DEST" >> "$LOG_FILE" 2>&1 || true
fi
unregister_backup_bundles
	stop_lekh_input_method_for_removal || { log "could not stop the running input method before removal"; exit 1; }
/bin/rm -rf "$DEST"
"$RESOURCE_DIR/purge-lekh-input-sources" >> "$LOG_FILE" 2>&1 || true
		/bin/rm -rf "$SUPPORT_DIR/Packs" "$SUPPORT_DIR/Models" "$LEGACY_BACKUP_ROOT" "$ARCHIVE_BACKUP_ROOT" "$SUPPORT_DIR/Diagnostics" "$CACHE_DIR"
/bin/rm -f "$RUNTIME_HEALTH"
if [[ "$REMOVE_PERSONAL_DICTIONARY" == "1" ]]; then
  /bin/rm -f "$SUPPORT_DIR/lekh-keyboard.sqlite3" "$SUPPORT_DIR/lekh-keyboard.sqlite3-wal" "$SUPPORT_DIR/lekh-keyboard.sqlite3-shm"
elif [[ -f "$SUPPORT_DIR/lekh-keyboard.sqlite3" ]]; then
  /usr/bin/sqlite3 "$SUPPORT_DIR/lekh-keyboard.sqlite3" 'PRAGMA wal_checkpoint(TRUNCATE);' >> "$LOG_FILE" 2>&1 || true
  /bin/rm -f "$SUPPORT_DIR/lekh-keyboard.sqlite3-shm"
  if [[ -f "$SUPPORT_DIR/lekh-keyboard.sqlite3-wal" && ! -s "$SUPPORT_DIR/lekh-keyboard.sqlite3-wal" ]]; then
    /bin/rm -f "$SUPPORT_DIR/lekh-keyboard.sqlite3-wal"
  fi
fi
/usr/bin/find "$SUPPORT_DIR" -depth -type d -empty -delete >/dev/null 2>&1 || true
log "uninstall completed"
dialog "Lekh Keyboard was removed. Dictionary packs, model files, backups, caches, and Lekh logs were deleted. Personal dictionary removed: \${REMOVE_PERSONAL_DICTIONARY}. Your previous keyboard was restored if macOS allowed the change.\n\nलेख किबोर्ड हटाइयो। dictionary packs, model files, backups, caches, र Lekh logs मेटाइयो। personal dictionary removed: \${REMOVE_PERSONAL_DICTIONARY}। macOS ले अनुमति दिएको भए पहिलेको keyboard restore गरिएको छ।"
/bin/rm -rf "$LOG_DIR"
exit 0
`;

writeAppShellBundle({
  appPath: uninstallerApp,
  displayName: "Lekh Keyboard Uninstaller",
  identifier: "com.lekh.inputmethod.Uninstaller",
  executableName: "uninstall-lekh-keyboard",
  script: uninstallerScript
});

const metadataSafeDittoFlags = ["--norsrc", "--noextattr", "--noacl"];
for (const appPath of [installerApp, uninstallerApp]) {
  const resourcesDir = join(appPath, "Contents", "Resources");
  if (appPath === installerApp) {
    run("copy-imk-payload", "ditto", [...metadataSafeDittoFlags, imkBundle, join(resourcesDir, "Lekh Keyboard.app")]);
  }
  for (const [sourceFile, binaryName] of [
    ["register-dev.swift", "register-lekh-input-source"],
    ["restore-system-keyboard.swift", "restore-system-keyboard"],
    ["purge-lekh-input-sources.swift", "purge-lekh-input-sources"],
    ["atomic-install-swap.swift", "atomic-install-swap"],
    ["terminate-exact-processes.swift", "terminate-exact-processes"]
  ]) {
    compileUniversalHelper(sourceFile, join(resourcesDir, binaryName));
  }
  signPath(appPath, `codesign-${basename(appPath)}`);
  sleep(500);
  stripCodeSignBlockedXattrs(appPath);
  verifySignedPath(appPath, `verify-${basename(appPath)}`);
}

if (signingIdentity !== "-") {
  notarizeAndStaple([installerApp, uninstallerApp]);
}

mkdirSync(distFolder, { recursive: true });
run("copy-installer-to-folder", "ditto", [...metadataSafeDittoFlags, installerApp, join(distFolder, "Lekh Keyboard Test Installer.app")]);
run("copy-uninstaller-to-folder", "ditto", [...metadataSafeDittoFlags, uninstallerApp, join(distFolder, "Lekh Keyboard Uninstaller.app")]);

const terminalInstallScript = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")" || exit 1
SOURCE_INSTALLER_APP="$PWD/Lekh Keyboard Test Installer.app"
SOURCE_INSTALLER_BIN="$SOURCE_INSTALLER_APP/Contents/MacOS/install-lekh-keyboard"
LOCAL_TMP_ROOT="\${TMPDIR:-/tmp}"
LOCAL_TMP_ROOT="\${LOCAL_TMP_ROOT%/}"
STAGING_DIR=""

cleanup_staging() {
  if [[ -n "$STAGING_DIR" && "$STAGING_DIR" == "$LOCAL_TMP_ROOT"/lekh-keyboard-installer.* ]]; then
    /bin/rm -rf -- "$STAGING_DIR"
  fi
}
trap cleanup_staging EXIT
trap 'exit 130' INT TERM HUP

echo "Lekh Keyboard terminal installer"
echo "This unsigned QA build cannot pass Finder/Gatekeeper without Developer ID notarization."
echo "This script removes only the known Finder metadata that blocks code-signature verification, verifies the packaged app signature, then runs the same installer."
echo

if [[ ! -x "$SOURCE_INSTALLER_BIN" ]]; then
  echo "Missing installer executable: $SOURCE_INSTALLER_BIN" >&2
  read -r -p "Press Return to close this window..."
  exit 1
fi

umask 077
STAGING_DIR="$(/usr/bin/mktemp -d "$LOCAL_TMP_ROOT/lekh-keyboard-installer.XXXXXX")" || {
  echo "Could not create a private local installer staging directory." >&2
  read -r -p "Press Return to close this window..."
  exit 1
}
INSTALLER_APP="$STAGING_DIR/Lekh Keyboard Test Installer.app"
INSTALLER_BIN="$INSTALLER_APP/Contents/MacOS/install-lekh-keyboard"
/usr/bin/ditto --norsrc --noextattr --noacl "$SOURCE_INSTALLER_APP" "$INSTALLER_APP" || {
  echo "Could not stage the installer outside Finder/File Provider storage." >&2
  read -r -p "Press Return to close this window..."
  exit 1
}
/usr/bin/dot_clean -m "$INSTALLER_APP" >/dev/null 2>&1 || true
for attribute in com.apple.quarantine com.apple.FinderInfo com.apple.ResourceFork 'com.apple.fileprovider.fpfs#P' com.apple.provenance; do
  /usr/bin/xattr -r -d "$attribute" "$INSTALLER_APP" 2>/dev/null || true
done

if ! verify_output="$(/usr/bin/codesign --verify --deep --strict --verbose=4 "$INSTALLER_APP" 2>&1)"; then
  echo "The metadata-free staged installer failed code-signature verification." >&2
  printf '%s\n' "$verify_output" >&2
  echo "The signed app contents differ from the release archive; use a fresh package." >&2
  read -r -p "Press Return to close this window..."
  exit 1
fi

set +e
"$INSTALLER_BIN"
status=$?
set -e
echo
if [[ "$status" -eq 0 ]]; then
  echo "Install finished. Use the macOS input menu to select Lekh Keyboard."
else
  echo "Install failed with status $status. See ~/Library/Logs/LekhKeyboard/install.log."
fi
read -r -p "Press Return to close this window..."
exit "$status"
`;
const terminalUninstallScript = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")" || exit 1
SOURCE_UNINSTALLER_APP="$PWD/Lekh Keyboard Uninstaller.app"
SOURCE_UNINSTALLER_BIN="$SOURCE_UNINSTALLER_APP/Contents/MacOS/uninstall-lekh-keyboard"
LOCAL_TMP_ROOT="\${TMPDIR:-/tmp}"
LOCAL_TMP_ROOT="\${LOCAL_TMP_ROOT%/}"
STAGING_DIR=""

cleanup_staging() {
  if [[ -n "$STAGING_DIR" && "$STAGING_DIR" == "$LOCAL_TMP_ROOT"/lekh-keyboard-uninstaller.* ]]; then
    /bin/rm -rf -- "$STAGING_DIR"
  fi
}
trap cleanup_staging EXIT
trap 'exit 130' INT TERM HUP

echo "Lekh Keyboard terminal uninstaller"
echo "This script removes only the known Finder metadata that blocks code-signature verification, verifies the uninstaller, then runs it."
echo

if [[ ! -x "$SOURCE_UNINSTALLER_BIN" ]]; then
  echo "Missing uninstaller executable: $SOURCE_UNINSTALLER_BIN" >&2
  read -r -p "Press Return to close this window..."
  exit 1
fi

umask 077
STAGING_DIR="$(/usr/bin/mktemp -d "$LOCAL_TMP_ROOT/lekh-keyboard-uninstaller.XXXXXX")" || {
  echo "Could not create a private local uninstaller staging directory." >&2
  read -r -p "Press Return to close this window..."
  exit 1
}
UNINSTALLER_APP="$STAGING_DIR/Lekh Keyboard Uninstaller.app"
UNINSTALLER_BIN="$UNINSTALLER_APP/Contents/MacOS/uninstall-lekh-keyboard"
/usr/bin/ditto --norsrc --noextattr --noacl "$SOURCE_UNINSTALLER_APP" "$UNINSTALLER_APP" || {
  echo "Could not stage the uninstaller outside Finder/File Provider storage." >&2
  read -r -p "Press Return to close this window..."
  exit 1
}
/usr/bin/dot_clean -m "$UNINSTALLER_APP" >/dev/null 2>&1 || true
for attribute in com.apple.quarantine com.apple.FinderInfo com.apple.ResourceFork 'com.apple.fileprovider.fpfs#P' com.apple.provenance; do
  /usr/bin/xattr -r -d "$attribute" "$UNINSTALLER_APP" 2>/dev/null || true
done

if ! verify_output="$(/usr/bin/codesign --verify --deep --strict --verbose=4 "$UNINSTALLER_APP" 2>&1)"; then
  echo "The metadata-free staged uninstaller failed code-signature verification." >&2
  printf '%s\n' "$verify_output" >&2
  echo "The signed app contents differ from the release archive; use a fresh package." >&2
  read -r -p "Press Return to close this window..."
  exit 1
fi

set +e
"$UNINSTALLER_BIN"
status=$?
set -e
echo
if [[ "$status" -eq 0 ]]; then
  echo "Uninstall finished."
else
  echo "Uninstall failed with status $status."
fi
read -r -p "Press Return to close this window..."
exit "$status"
`;
const terminalInstallPath = join(distFolder, "Install Lekh Keyboard from Terminal.command");
const terminalUninstallPath = join(distFolder, "Uninstall Lekh Keyboard from Terminal.command");
writeFileSync(terminalInstallPath, terminalInstallScript);
writeFileSync(terminalUninstallPath, terminalUninstallScript);
chmodSync(terminalInstallPath, 0o755);
chmodSync(terminalUninstallPath, 0o755);
writeFileSync(
  join(distFolder, "README.txt"),
  [
    "Lekh Keyboard Test Installer",
    "",
    `Version: ${appShortVersion} build ${appBuild}`,
    "Signature: ad-hoc unless this package was built with LEKH_MAC_DEVELOPER_ID.",
    "",
    "Install:",
    "1. Open Lekh Keyboard Test Installer.app.",
    "2. If macOS blocks the app because it is an unsigned test build, open System Settings > Privacy & Security and choose Open Anyway for Lekh Keyboard Test Installer.",
    "3. If macOS only shows Move to Trash or Done and no Open Anyway option appears, open Install Lekh Keyboard from Terminal.command instead.",
    "4. If the .command file is also blocked, open Terminal and run:",
    "   cd ~/Downloads/'Lekh Keyboard Test Installer'",
    "   xattr -dr com.apple.quarantine .",
    "   ./Install\\ Lekh\\ Keyboard\\ from\\ Terminal.command",
    "5. After it finishes, use the macOS input menu in the menu bar to choose Lekh Keyboard.",
    "6. If Lekh Keyboard does not appear immediately, log out and back in, then open Keyboard Settings > Text Input > Edit and add it under Nepali.",
    "7. Installer rollback backups are compressed under ~/Library/Application Support/Lekh Keyboard/InstallBackups.noindex and rotated to the newest 3 copies so macOS cannot rediscover them as duplicate input methods.",
    "",
    "Uninstall:",
    "Open Lekh Keyboard Uninstaller.app. If Finder blocks it, use Uninstall Lekh Keyboard from Terminal.command. It asks for confirmation, restores the previous keyboard when possible, deletes packs, models, backups, caches, and logs, and can optionally delete local learned words.",
    "",
    "Logs:",
    "~/Library/Logs/LekhKeyboard/install.log",
    "Uninstall logs are deleted at the end of uninstall for privacy.",
    "",
    "This test build is local-first and does not send typing data to a server.",
    "Production distribution still requires Developer ID signing and notarization if this zip is built without LEKH_MAC_DEVELOPER_ID.",
    "Release manifest:",
    "RELEASE-MANIFEST.json is signed by RELEASE-MANIFEST.json.minisig. Verify with:",
    "minisign -Vm RELEASE-MANIFEST.json -x RELEASE-MANIFEST.json.minisig -P $(tail -n 1 lekh-release-manifest-minisign.pub)",
    "Or run Verify Lekh Release.command after installing minisign.",
    "",
    "नेपाली:",
    "१. Lekh Keyboard Test Installer.app खोल्नुहोस्।",
    "२. macOS ले unsigned test build भनेर block गरेमा System Settings > Privacy & Security मा Open Anyway छान्नुहोस्।",
    "३. Move to Trash वा Done मात्र देखिए Install Lekh Keyboard from Terminal.command चलाउनुहोस्।",
    "४. स्थापना भएपछि menu bar को input menu बाट Lekh Keyboard छान्नुहोस्।",
    "५. तुरुन्त नदेखिए log out गरेर फेरि log in गर्नुहोस्, अनि Keyboard Settings > Text Input > Edit > Nepali बाट थप्नुहोस्।",
    "६. Uninstaller ले confirmation माग्छ र local learned words, packs, models, backups, caches, logs हटाउँछ।",
    ""
  ].join("\n")
);
if (existsSync(join(root, "LICENSE"))) {
  copyFileSync(join(root, "LICENSE"), join(distFolder, "LICENSE.txt"));
}
if (existsSync(minisignPublicKey)) {
  copyFileSync(minisignPublicKey, join(distFolder, "lekh-release-manifest-minisign.pub"));
}
const verifyReleaseScript = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")" || exit 1

if ! command -v minisign >/dev/null 2>&1; then
  echo "minisign is required to verify RELEASE-MANIFEST.json." >&2
  echo "Install it with: brew install minisign" >&2
  read -r -p "Press Return to close this window..."
  exit 127
fi

echo "Verifying SHA256SUMS.txt..."
/usr/bin/shasum -a 256 -c SHA256SUMS.txt

echo
echo "Verifying signed release manifest..."
minisign -Vm RELEASE-MANIFEST.json -x RELEASE-MANIFEST.json.minisig -P "$(tail -n 1 lekh-release-manifest-minisign.pub)"

echo
echo "Lekh release verification passed."
read -r -p "Press Return to close this window..."
`;
const verifyReleasePath = join(distFolder, "Verify Lekh Release.command");
writeFileSync(verifyReleasePath, verifyReleaseScript);
chmodSync(verifyReleasePath, 0o755);

const releaseManifestPath = join(distFolder, "RELEASE-MANIFEST.json");
const manifestSignaturePath = `${releaseManifestPath}.minisig`;
const releaseManifestFiles = walkPaths(distFolder)
  .filter((target) => lstatSync(target).isFile())
  .filter((target) => basename(target) !== "SHA256SUMS.txt")
  .filter((target) => basename(target) !== "RELEASE-MANIFEST.json")
  .filter((target) => basename(target) !== "RELEASE-MANIFEST.json.minisig")
  .sort((a, b) => relative(distFolder, a).localeCompare(relative(distFolder, b), "en"));
const releaseManifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  product: "Lekh Keyboard",
  channel: releaseChannel,
  version: appShortVersion,
  build: appBuild,
  hashAlgorithm: "SHA-256",
  signature: {
    algorithm: "minisign",
    publicKey: existsSync(join(distFolder, "lekh-release-manifest-minisign.pub")) ? "lekh-release-manifest-minisign.pub" : null,
    detachedSignature: "RELEASE-MANIFEST.json.minisig"
  },
  files: releaseManifestFiles.map((target) => ({
    path: relative(distFolder, target),
    bytes: statSync(target).size,
    sha256: createHash("sha256").update(readFileSync(target)).digest("hex")
  }))
};
writeFileSync(releaseManifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`);
if (!existsSync(minisignSecretKey)) {
  finish("failed", {
    step: "sign-release-manifest",
    reason: "Missing minisign secret key for RELEASE-MANIFEST.json.",
    expected: minisignSecretKey
  }, 1);
}
run("sign-release-manifest", "minisign", ["-Sm", releaseManifestPath, "-s", minisignSecretKey, "-x", manifestSignaturePath]);
if (!existsSync(manifestSignaturePath)) {
  finish("failed", {
    step: "sign-release-manifest",
    reason: "minisign did not create RELEASE-MANIFEST.json.minisig"
  }, 1);
}
verifyMinisignSignature(releaseManifestPath, manifestSignaturePath, "verify-dist-manifest-minisign");

const checksumTargets = walkPaths(distFolder)
  .filter((target) => lstatSync(target).isFile())
  .filter((target) => basename(target) !== "SHA256SUMS.txt")
  .sort((a, b) => relative(distFolder, a).localeCompare(relative(distFolder, b), "en"));
const checksumLines = checksumTargets.map((target) => {
  const output = run(`checksum-${basename(target)}`, "shasum", ["-a", "256", target]).stdout.trim();
  return output.replace(target, relative(distFolder, target));
});
writeFileSync(join(distFolder, "SHA256SUMS.txt"), `${checksumLines.join("\n")}\n`);
const releaseManifestSidecarPath = join(releaseDir, "RELEASE-MANIFEST.json");
const manifestSignatureSidecarPath = join(releaseDir, "RELEASE-MANIFEST.json.minisig");
const checksumSidecarPath = join(releaseDir, "SHA256SUMS.txt");
stripCodeSignBlockedXattrs(installerApp);
stripCodeSignBlockedXattrs(uninstallerApp);
stripCodeSignBlockedXattrs(distFolder);
verifySignedPath(installerApp, "verify-final-installer-app");
verifySignedPath(uninstallerApp, "verify-final-uninstaller-app");

rmSync(zipPath, { force: true });
run("zip-installer-folder", "ditto", ["-c", "-k", "--keepParent", "--norsrc", "--noextattr", "--noacl", distFolder, zipPath], {
  cwd: releaseDir
});
run("verify-zip-central-directory", "unzip", ["-t", zipPath], { maxBuffer: 120 * 1024 * 1024 });

const zipCheckDir = mkdtempSync(join(tmpdir(), "lekh-installer-verify-"));
run("verify-zip-extract", "ditto", ["-x", "-k", zipPath, zipCheckDir]);
const extractedRoot = join(zipCheckDir, "Lekh Keyboard Test Installer");
const extractedInstaller = join(extractedRoot, "Lekh Keyboard Test Installer.app");
const extractedUninstaller = join(extractedRoot, "Lekh Keyboard Uninstaller.app");
verifySignedPath(extractedInstaller, "verify-extracted-installer");
verifySignedPath(extractedUninstaller, "verify-extracted-uninstaller");
const extractedPayloadPlist = join(
  extractedInstaller,
  "Contents",
  "Resources",
  "Lekh Keyboard.app",
  "Contents",
  "Info.plist"
);
const extractedConnectionName = run(
  "verify-extracted-payload-connection-name",
  "/usr/bin/plutil",
  ["-extract", "InputMethodConnectionName", "raw", "-o", "-", extractedPayloadPlist]
).stdout.trim();
if (extractedConnectionName !== expectedConnectionName) {
  finish("failed", {
    step: "verify-extracted-payload-connection-name",
    reason: "Extracted installer payload changed the IMK connection contract.",
    expected: expectedConnectionName,
    observed: extractedConnectionName
  }, 1);
}
stripCodeSignBlockedXattrs(extractedInstaller);
stripCodeSignBlockedXattrs(extractedUninstaller);
verifySignedPathRaw(extractedInstaller, "verify-extracted-installer-raw");
verifySignedPathRaw(extractedUninstaller, "verify-extracted-uninstaller-raw");
if (existsSync(join(extractedUninstaller, "Contents", "Resources", "Lekh Keyboard.app"))) {
  finish("failed", {
    step: "verify-extracted-uninstaller",
    reason: "Uninstaller must not embed the full keyboard payload."
  }, 1);
}
const extractedPayloadArchs = run(
  "verify-extracted-payload-archs",
  "lipo",
  ["-archs", join(extractedInstaller, "Contents", "Resources", "Lekh Keyboard.app", "Contents", "MacOS", "LekhInputMethodApp")]
).stdout.trim();
rmSync(zipCheckDir, { recursive: true, force: true });

const dictionaryPackVersion = `${releaseChannel}-build${appBuild}`;
const dictionaryPackDir = join(releaseDir, "dictionary-packs", dictionaryPackVersion);
const bundledRuntimeBinary = join(imkBundle, "Contents", "Resources", "runtime-suggestions.lkb");
rmSync(join(releaseDir, "dictionary-packs"), { recursive: true, force: true });
run("package-signed-dictionary-pack", process.execPath, [
  join(root, "scripts", "package-dictionary-pack-update.mjs"),
  "--binary",
  bundledRuntimeBinary,
  "--version",
  dictionaryPackVersion,
  "--channel",
  releaseChannel,
  "--min-app-version",
  appShortVersion,
  "--min-app-build",
  String(appBuild),
  "--out-dir",
  dictionaryPackDir,
  "--report",
  join(root, "reports", "dictionary-pack-update-report.json")
]);
rmSync(join(releaseDir, "runtime-suggestions.lkb"), { force: true });
rmSync(join(releaseDir, "runtime-suggestions.sanitized.json"), { force: true });

if (!existsSync(sparklePrivateKey)) {
  finish("failed", {
    step: "package-appcast",
    reason: "Missing Sparkle EdDSA private key for appcast signing.",
    expected: sparklePrivateKey
  }, 1);
}
run("package-appcast", process.execPath, [
  join(root, "scripts", "package-macos-appcast.mjs"),
  "--zip",
  zipPath,
  "--out",
  appcastPath,
  "--version",
  String(appBuild),
  "--short-version",
  appShortVersion,
  "--channel",
  releaseChannel,
  "--private-key",
  sparklePrivateKey,
  "--report",
  join(root, "reports", "macos-appcast-report.json")
]);

const zipSha256ForCask = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
const caskPath = join(releaseDir, "lekh-keyboard-test.rb");
writeFileSync(
  caskPath,
  [
    "cask \"lekh-keyboard-test\" do",
    `  version "${appShortVersion},${appBuild}"`,
    `  sha256 "${zipSha256ForCask}"`,
    "",
    `  url "${installerPublicURL}"`,
    "  name \"Lekh Keyboard\"",
    "  desc \"Native macOS Nepali input method\"",
    "  homepage \"https://lekh-assistant.pages.dev/\"",
    "",
    "  installer script: {",
    "    executable: \"Lekh Keyboard Test Installer/Install Lekh Keyboard from Terminal.command\",",
    "    sudo: false",
    "  }",
    "",
    "  uninstall script: {",
    "    executable: \"Lekh Keyboard Test Installer/Uninstall Lekh Keyboard from Terminal.command\",",
    "    sudo: false",
    "  }",
    "end",
    ""
  ].join("\n")
);

run("sign-release-directory-manifest", process.execPath, [
  join(root, "scripts", "sign-release-directory-manifest.mjs"),
  "--dir",
  releaseDir,
  "--version",
  appShortVersion,
  "--build",
  String(appBuild),
  "--channel",
  releaseChannel,
  "--report",
  join(root, "reports", "release-directory-manifest-report.json")
]);
verifyMinisignSignature(releaseManifestSidecarPath, manifestSignatureSidecarPath, "verify-release-directory-minisign");

rmSync(publicUpdatesDir, { recursive: true, force: true });
mkdirSync(join(publicUpdatesDir, "dictionary-packs", dictionaryPackVersion), { recursive: true });
for (const fileName of [
  "Lekh-Keyboard-Test-Installer.zip",
  "appcast.xml",
  "RELEASE-MANIFEST.json",
  "RELEASE-MANIFEST.json.minisig",
  "SHA256SUMS.txt",
  "lekh-keyboard-test.rb"
]) {
  copyFileSync(join(releaseDir, fileName), join(publicUpdatesDir, fileName));
}
if (existsSync(minisignPublicKey)) {
  copyFileSync(minisignPublicKey, join(publicUpdatesDir, "lekh-release-manifest-minisign.pub"));
}
copyFileSync(
  join(dictionaryPackDir, "manifest.json"),
  join(publicUpdatesDir, "dictionary-packs", dictionaryPackVersion, "manifest.json")
);
copyFileSync(
  join(dictionaryPackDir, `runtime-suggestions-${dictionaryPackVersion}.lkb`),
  join(publicUpdatesDir, "dictionary-packs", dictionaryPackVersion, `runtime-suggestions-${dictionaryPackVersion}.lkb`)
);

unregisterReleaseArtifacts();
sleep(500);
unregisterReleaseArtifacts();

const helperArchs = run(
  "helper-archs",
  "lipo",
  ["-archs", join(installerApp, "Contents", "Resources", "register-lekh-input-source")]
).stdout.trim();
const zipBytes = statSync(zipPath).size;

finish(signingIdentity === "-" ? "passed-adhoc-release" : "passed-developer-id-notarized", {
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
  checksumEntries: checksumLines.length,
  releaseManifest: releaseManifestSidecarPath,
  releaseManifestSignature: manifestSignatureSidecarPath,
  checksumFile: checksumSidecarPath,
  note: signingIdentity === "-"
    ? "Ad-hoc signed test artifact. Developer ID signing and notarization are still required for production distribution."
    : "Developer ID signed, notarized, stapled, and Gatekeeper-assessed artifact."
}, 0);
