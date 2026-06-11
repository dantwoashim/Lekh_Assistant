#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const startedAt = performance.now();
const skeletonDir = join(root, "native", "macos-imk", "skeleton");
const reportPath = join(root, "reports", "macos-imk-dev-package-report.json");
const appBundle = join(root, "release", "native", "macos", "Lekh Keyboard.app");
const executableName = "LekhInputMethodApp";

function finish(status, details, exitCode) {
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        command: "npm run package:macos:imk:dev",
        suite: "macos-imk-dev-package",
        durationMs: Math.round(performance.now() - startedAt),
        status,
        ...details
      },
      null,
      2
    )}\n`
  );
  console.log(JSON.stringify({ status, report: "reports/macos-imk-dev-package-report.json", ...details }, null, 2));
  process.exit(exitCode);
}

if (process.platform !== "darwin") {
  finish("blocked-native-environment", { reason: "macOS IMK dev bundle must be built on macOS.", currentPlatform: `${process.platform}-${process.arch}` }, 2);
}

const build = spawnSync("swift", ["build", "--product", executableName], { cwd: skeletonDir, encoding: "utf8", stdio: "pipe" });
if (build.status !== 0) {
  finish("failed", { step: "swift-build", stdout: build.stdout, stderr: build.stderr }, build.status ?? 1);
}

const executable = join(skeletonDir, ".build", "debug", executableName);
if (!existsSync(executable)) {
  finish("failed", { step: "artifact", reason: `Missing Swift executable at ${executable}` }, 1);
}

rmSync(appBundle, { recursive: true, force: true });
mkdirSync(join(appBundle, "Contents", "MacOS"), { recursive: true });
mkdirSync(join(appBundle, "Contents", "Resources"), { recursive: true });
copyFileSync(join(skeletonDir, "Info.plist"), join(appBundle, "Contents", "Info.plist"));
copyFileSync(executable, join(appBundle, "Contents", "MacOS", executableName));
copyFileSync(
  join(root, "src", "data", "keyboard-packs", "v0.1", "runtime-suggestions.json"),
  join(appBundle, "Contents", "Resources", "runtime-suggestions.json")
);
chmodSync(join(appBundle, "Contents", "MacOS", executableName), 0o755);

finish("passed-unsigned-dev", {
  artifact: appBundle,
  installCommand: "native/macos-imk/skeleton/install-dev.sh",
  uninstallCommand: "native/macos-imk/skeleton/uninstall-dev.sh",
  signed: false
}, 0);
