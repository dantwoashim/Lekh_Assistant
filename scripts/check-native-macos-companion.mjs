#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const startedAt = performance.now();
const appBundle = join(root, "release", "Lekh Keyboard Companion.app");
const plistPath = join(appBundle, "Contents", "Info.plist");
const executable = join(appBundle, "Contents", "MacOS", "LekhKeyboardCompanion");
const failures = [];

if (!existsSync(appBundle)) failures.push("Native companion app bundle is missing.");
if (!existsSync(plistPath)) failures.push("Native companion Info.plist is missing.");
if (!existsSync(executable)) failures.push("Native companion executable is missing.");

let plist = "";
if (existsSync(plistPath)) {
  plist = readFileSync(plistPath, "utf8");
  if (!plist.includes("public.app-category.utilities")) failures.push("Companion must use the Utilities app category.");
  if (plist.includes("NSAllowsArbitraryLoads")) failures.push("Companion must not allow arbitrary network loads.");
  for (const key of [
    "NSCameraUsageDescription",
    "NSMicrophoneUsageDescription",
    "NSAudioCaptureUsageDescription",
    "NSBluetoothAlwaysUsageDescription",
    "NSBluetoothPeripheralUsageDescription",
    "NSLocationUsageDescription"
  ]) {
    if (plist.includes(`<key>${key}</key>`)) failures.push(`Companion declares unused hardware capability ${key}.`);
  }
}

let architectures = [];
if (existsSync(executable)) {
  const lipo = spawnSync("lipo", ["-archs", executable], { encoding: "utf8" });
  architectures = lipo.status === 0 ? lipo.stdout.trim().split(/\s+/).sort() : [];
  if (!architectures.includes("arm64") || !architectures.includes("x86_64")) {
    failures.push(`Native companion must be universal; found ${architectures.join(", ") || "unknown"}.`);
  }
}

if (existsSync(join(appBundle, "Contents", "Frameworks", "Electron Framework.framework"))) {
  failures.push("macOS companion must not embed Electron Framework.");
}
if (existsSync(join(appBundle, "Contents", "Resources", "app.asar"))) {
  failures.push("macOS companion must not package a browser renderer archive.");
}

const verificationRoot = mkdtempSync(join(tmpdir(), "lekh-companion-verify-"));
const verificationBundle = join(verificationRoot, "Lekh Keyboard Companion.app");
if (existsSync(appBundle)) {
  const copy = spawnSync("ditto", ["--norsrc", "--noextattr", appBundle, verificationBundle], { encoding: "utf8" });
  if (copy.status !== 0) failures.push(`Could not create clean transport copy: ${copy.stderr}`);
}
const verify = existsSync(verificationBundle)
  ? spawnSync("codesign", ["--verify", "--deep", "--strict", verificationBundle], { encoding: "utf8" })
  : { status: 1, stderr: "missing clean transport copy" };
if (verify.status !== 0) failures.push(`Code signature verification failed: ${verify.stderr}`);

const size = existsSync(appBundle)
  ? Number(spawnSync("du", ["-sk", appBundle], { encoding: "utf8" }).stdout.trim().split(/\s+/)[0] || 0) * 1024
  : 0;
if (size > 10 * 1024 * 1024) failures.push(`Native companion exceeds 10 MiB: ${size} bytes.`);

const report = {
  generatedAt: new Date().toISOString(),
  command: "npm run check:macos-companion-package",
  suite: "native-macos-companion-check",
  durationMs: Math.round(performance.now() - startedAt),
  status: failures.length === 0 ? "passed" : "failed",
  appBundle,
  architectures,
  bundleBytes: size,
  electronFrameworkPresent: existsSync(join(appBundle, "Contents", "Frameworks", "Electron Framework.framework")),
  signatureVerifiedOnCleanTransportCopy: verify.status === 0,
  failures
};

rmSync(verificationRoot, { recursive: true, force: true });

mkdirSync(join(root, "reports"), { recursive: true });
writeFileSync(join(root, "reports", "macos-companion-package-check.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) process.exit(1);
