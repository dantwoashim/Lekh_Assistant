#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const startedAt = performance.now();
const appBundle = join(root, "release", "native", "macos", "Lekh Keyboard.app");
const plistPath = join(appBundle, "Contents", "Info.plist");
const executablePath = join(appBundle, "Contents", "MacOS", "LekhInputMethodApp");
const runtimePackPath = join(appBundle, "Contents", "Resources", "runtime-suggestions.json");
const failures = [];

if (!existsSync(appBundle)) failures.push("IMK dev app bundle is missing.");
if (!existsSync(plistPath)) failures.push("IMK Info.plist is missing.");
if (!existsSync(executablePath)) failures.push("IMK executable is missing.");
if (!existsSync(runtimePackPath)) failures.push("IMK runtime suggestions pack is missing.");
if (existsSync(executablePath) && !(statSync(executablePath).mode & 0o111)) failures.push("IMK executable is not executable.");

if (existsSync(plistPath)) {
  const plist = readFileSync(plistPath, "utf8");
  for (const marker of [
    "com.lekh.inputmethod.keyboard",
    "InputMethodConnectionName",
    "Lekh_Keyboard_Connection",
    "InputMethodServerControllerClass",
    "LekhInputController",
    "tsInputMethodCharacterRepertoireKey",
    "Latn",
    "Deva"
  ]) {
    if (!plist.includes(marker)) failures.push(`Info.plist missing ${marker}.`);
  }
}

if (existsSync(runtimePackPath)) {
  const pack = readFileSync(runtimePackPath, "utf8");
  for (const marker of ["\"words\"", "\"phrases\"", "\"names\"", "swasthya", "स्वास्थ्य"]) {
    if (!pack.includes(marker)) failures.push(`Runtime suggestions pack missing ${marker}.`);
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  command: "npm run check:macos-imk-bundle",
  suite: "macos-imk-dev-bundle",
  durationMs: Math.round(performance.now() - startedAt),
  status: failures.length === 0 ? "passed" : "failed",
  appBundle,
  failures
};

mkdirSync(join(root, "reports"), { recursive: true });
writeFileSync(join(root, "reports", "macos-imk-dev-bundle-check.json"), `${JSON.stringify(report, null, 2)}\n`);

if (failures.length > 0) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status: "passed", report: "reports/macos-imk-dev-bundle-check.json", appBundle }, null, 2));
