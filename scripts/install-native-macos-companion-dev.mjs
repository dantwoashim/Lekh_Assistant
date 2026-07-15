#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const source = join(root, "release", "Lekh Keyboard Companion.app");
const applications = join(homedir(), "Applications");
const destination = join(applications, "Lekh Keyboard Companion.app");
const staging = join(applications, `.Lekh Keyboard Companion.app.installing.${process.pid}`);
const backup = join(applications, `.Lekh Keyboard Companion.app.backup.${process.pid}`);
const executable = join(staging, "Contents", "MacOS", "LekhKeyboardCompanion");
const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`.trim());
  }
  return result.stdout.trim();
}

if (process.platform !== "darwin") throw new Error("The native companion can only be installed on macOS.");
if (!existsSync(source)) throw new Error("Native companion package is missing. Run npm run package:macos:unsigned first.");

mkdirSync(applications, { recursive: true });
rmSync(staging, { recursive: true, force: true });
rmSync(backup, { recursive: true, force: true });

try {
  run("ditto", ["--norsrc", "--noextattr", source, staging]);
  const archs = run("lipo", ["-archs", executable]).split(/\s+/).sort();
  if (!archs.includes("arm64") || !archs.includes("x86_64")) {
    throw new Error(`Refusing to install a non-universal companion: ${archs.join(", ")}`);
  }
  run("codesign", ["--verify", "--deep", "--strict", staging]);

  if (existsSync(destination)) renameSync(destination, backup);
  renameSync(staging, destination);
  spawnSync(lsregister, ["-u", source], { cwd: root, encoding: "utf8", stdio: "ignore" });
  run(lsregister, ["-f", destination]);
  rmSync(backup, { recursive: true, force: true });
  console.log(JSON.stringify({
    status: "installed-native-companion-dev",
    destination,
    architectures: archs,
    note: "This is an ad-hoc development build. Production distribution still requires Developer ID signing and notarization."
  }, null, 2));
} catch (error) {
  rmSync(staging, { recursive: true, force: true });
  if (!existsSync(destination) && existsSync(backup)) renameSync(backup, destination);
  throw error;
}
