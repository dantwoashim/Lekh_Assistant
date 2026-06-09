#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const startedAt = performance.now();
const releaseDir = join(root, "release");
const installer = existsSync(releaseDir) ? findSetupExe(releaseDir) : undefined;
const unpackedExecutable = existsSync(releaseDir) ? findUnpackedExe(releaseDir) : undefined;
const report = {
  generatedAt: new Date().toISOString(),
  command: "npm run check:windows-release",
  suite: "windows-release-artifacts",
  durationMs: Math.round(performance.now() - startedAt),
  status: installer ? "passed-dev-installer" : "failed",
  installer,
  unpackedExecutable,
  signed: false,
  note:
    "This check confirms a Windows NSIS setup .exe exists. Authenticode signature verification must be run on Windows after package:windows with CSC_LINK/CSC_KEY_PASSWORD."
};

mkdirSync(join(root, "reports"), { recursive: true });
writeFileSync(join(root, "reports", "windows-release-artifacts-report.json"), `${JSON.stringify(report, null, 2)}\n`);

if (!installer) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status: report.status, installer, report: "reports/windows-release-artifacts-report.json" }, null, 2));

function findSetupExe(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const nested = findSetupExe(full);
      if (nested) return nested;
    }
    if (/Setup.*\.exe$/i.test(entry)) return full;
  }
  return undefined;
}

function findUnpackedExe(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const nested = findUnpackedExe(full);
      if (nested) return nested;
    }
    if (/Lekh Keyboard Companion\.exe$/i.test(entry)) return full;
  }
  return undefined;
}
