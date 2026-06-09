#!/usr/bin/env node
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

const root = process.cwd();
const distAssets = join(root, "dist", "assets");
const reportPath = join(root, "reports", "bundle-budget-report.json");
const maxGeneralJsBytes = 500 * 1024;
const maxEntryJsBytes = 250 * 1024;
const allowedLargeLazyChunks = [
  /^keyboard-lexicon-data-/,
  /^keyboard-runtime-pack-/,
  /^vendor-hunspell-/,
];

const jsAssets = readdirSync(distAssets)
  .filter((entry) => entry.endsWith(".js"))
  .map((entry) => {
    const path = join(distAssets, entry);
    const bytes = statSync(path).size;
    const allowedLarge = allowedLargeLazyChunks.some((pattern) => pattern.test(entry));
    const entryLike = /^index-/.test(entry);
    const budget = entryLike ? maxEntryJsBytes : maxGeneralJsBytes;
    return {
      file: relative(root, path),
      bytes,
      budget,
      entryLike,
      allowedLarge,
      ok: allowedLarge || bytes <= budget,
    };
  });

const violations = jsAssets.filter((asset) => !asset.ok);
const report = {
  generatedAt: new Date().toISOString(),
  command: "npm run check:bundle-budget",
  suite: "bundle-budget",
  fixtureCount: jsAssets.length,
  status: violations.length === 0 ? "passed" : "failed",
  policy: {
    maxGeneralJsBytes,
    maxEntryJsBytes,
    allowedLargeLazyChunks: allowedLargeLazyChunks.map(String),
    note: "Large Nepali lexicon/runtime and Hunspell chunks are allowed only as lazy local data packs. Any other oversized app or feature chunk fails.",
  },
  assets: jsAssets,
  violations,
};

mkdirSync(join(root, "reports"), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

if (violations.length > 0) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  status: report.status,
  checked: jsAssets.length,
  report: "reports/bundle-budget-report.json",
}, null, 2));
