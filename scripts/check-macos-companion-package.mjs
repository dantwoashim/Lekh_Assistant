#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const root = process.cwd();
const startedAt = performance.now();
const appBundle = join(root, "release", "Lekh Keyboard Companion.app");
const asarPath = join(appBundle, "Contents", "Resources", "app.asar");
const icuPath = join(appBundle, "Contents", "Frameworks", "Electron Framework.framework", "Resources", "icudtl.dat");

const failures = [];

if (!existsSync(appBundle)) failures.push("Stable top-level macOS companion app bundle is missing.");
if (!existsSync(asarPath)) failures.push("Packaged app.asar is missing.");
if (!existsSync(icuPath)) failures.push("Electron framework ICU data is missing; app bundle copy is corrupt.");

let indexHtml = "";
if (existsSync(asarPath)) {
  indexHtml = asar.extractFile(asarPath, "dist/index.html").toString();
  if (!indexHtml.includes("<title>Lekh Keyboard Companion</title>")) {
    failures.push("Packaged index.html has stale title metadata.");
  }
  if (/src=\"\/assets\//.test(indexHtml) || /href=\"\/assets\//.test(indexHtml)) {
    failures.push("Packaged index.html uses absolute /assets paths and will blank under file://.");
  }
  if (!/src=\"\.\/assets\//.test(indexHtml)) {
    failures.push("Packaged index.html does not use relative ./assets script paths.");
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  command: "npm run check:macos-companion-package",
  suite: "macos-companion-package",
  durationMs: Math.round(performance.now() - startedAt),
  appBundle,
  status: failures.length === 0 ? "passed" : "failed",
  failures
};

mkdirSync(join(root, "reports"), { recursive: true });
writeFileSync(join(root, "reports", "macos-companion-package-check.json"), `${JSON.stringify(report, null, 2)}\n`);

if (failures.length > 0) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status: "passed", report: "reports/macos-companion-package-check.json", appBundle }, null, 2));
