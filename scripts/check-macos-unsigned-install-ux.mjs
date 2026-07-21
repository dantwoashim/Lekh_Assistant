#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const helper = join(root, "native", "macos-imk", "skeleton", "detect-quarantine.sh");
const packagerPath = join(root, "scripts", "package-macos-imk-test-installer.mjs");
const readmePath = join(root, "README.md");
const receiptPath = join(root, "C2_MACOS_UNSIGNED_INSTALL_WALKTHROUGH.md");
const syntheticQuarantine = "0083;00000000;LekhFreshInstallTest;";

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe"
  });
}

if (process.platform !== "darwin") {
  throw new Error("The macOS unsigned-install walkthrough requires macOS xattr behavior.");
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "lekh-c2-fresh-install-"));
const extractedFolder = join(temporaryRoot, "Lekh Keyboard Test Installer");
const installerApp = join(extractedFolder, "Lekh Keyboard Test Installer.app");
mkdirSync(join(installerApp, "Contents", "MacOS"), { recursive: true });

try {
  const clear = run("/bin/bash", [helper, installerApp, extractedFolder]);
  requireCondition(clear.status === 1 && clear.stdout === "", "A clean extraction was misclassified as quarantined.");

  let result = run("/usr/bin/xattr", ["-w", "com.apple.quarantine", syntheticQuarantine, extractedFolder]);
  requireCondition(result.status === 0, `Could not quarantine the simulated extracted folder: ${result.stderr}`);
  result = run("/bin/bash", [helper, installerApp, extractedFolder]);
  requireCondition(
    result.status === 0 && result.stdout.trim() === extractedFolder,
    "The downloaded-folder quarantine marker was not detected exactly."
  );

  result = run("/usr/bin/xattr", ["-d", "com.apple.quarantine", extractedFolder]);
  requireCondition(result.status === 0, `Could not clear the simulated folder marker: ${result.stderr}`);
  result = run("/usr/bin/xattr", ["-w", "com.apple.quarantine", syntheticQuarantine, installerApp]);
  requireCondition(result.status === 0, `Could not quarantine the simulated installer app: ${result.stderr}`);
  result = run("/bin/bash", [helper, installerApp, extractedFolder]);
  requireCondition(
    result.status === 0 && result.stdout.trim() === installerApp,
    "The installer-app quarantine marker was not detected exactly."
  );

  const packager = readFileSync(packagerPath, "utf8");
  const readme = readFileSync(readmePath, "utf8");
  for (const required of [
    '"$RESOURCE_DIR/detect-quarantine"',
    "LEKH_UNSIGNED_FIRST_RUN_STATUS=quarantined",
    "Control-click or right-click Lekh Keyboard Test Installer.app.",
    "Choose Open, then click Open again.",
    "xattr -dr com.apple.quarantine",
    "LEKH_INSTALLER_WALKTHROUGH_ONLY",
    "LEKH_MACOS_PACKAGE_WALKTHROUGH_ONLY",
    "verify-unsigned-first-run-walkthrough"
  ]) {
    requireCondition(packager.includes(required), `Packaged first-run flow is missing: ${required}`);
  }
  requireCondition(
    readme.includes("Control-click or right-click `Lekh Keyboard Test Installer.app`, choose Open, then click Open again"),
    "End-user instructions do not prefer right-click → Open."
  );
  requireCondition(
    readme.includes('xattr -dr com.apple.quarantine "/path/to/Lekh Keyboard Test Installer.app"'),
    "End-user instructions do not contain the bounded one-line unquarantine fallback."
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

const resultLines = [
  "PASS — a clean extracted folder is not misclassified as quarantined.",
  "PASS — a simulated downloaded-folder quarantine marker is detected.",
  "PASS — a simulated installer-app quarantine marker is detected.",
  "PASS — first run reports the detected quarantine state in plain language.",
  "PASS — Control-click/right-click → Open is the preferred opening path.",
  "PASS — the fallback is one xattr command scoped to the installer app.",
  "PASS — packaged ZIP verification executes the no-install walkthrough path.",
  "RESULT — C2 unsigned first-run walkthrough passed."
];
const receipt = `# C2 macOS Unsigned First-Run Walkthrough\n\nCommand: \`node scripts/check-macos-unsigned-install-ux.mjs --check-receipt\`\n\n\`\`\`text\n${resultLines.join("\n")}\n\`\`\`\n`;

if (process.argv.includes("--check-receipt")) {
  const committed = readFileSync(receiptPath, "utf8");
  requireCondition(committed === receipt, "The committed C2 walkthrough receipt is stale.");
}

console.log(resultLines.join("\n"));
