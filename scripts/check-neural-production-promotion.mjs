#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { performance } from "node:perf_hooks";
import {
  verifyNeuralProductionPromotionReceipt
} from "./lib/neural-production-promotion-receipt.mjs";

const ROOT = canonicalDirectory(process.cwd(), "Repository root");
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const production = args.flags.has("production");
const canonicalProductionDirectory = join(
  ROOT,
  "models",
  "macos",
  "LekhNeuralTransliterator.production"
);
const productionDirectory = safePath(
  value(args, "production-dir") ?? canonicalProductionDirectory,
  "Production neural directory"
);
const reportPath = safeOutputPath(
  value(args, "report") ??
    join(
      ROOT,
      "reports",
      production
        ? "neural-production-promotion-production-report.json"
        : "neural-production-promotion-report.json"
    )
);
const failures = [];
const warnings = [];

if (production && productionDirectory !== canonicalProductionDirectory) {
  failures.push(
    "Production Phase 9 forbids --production-dir; the canonical promoted " +
    "directory is mandatory."
  );
}

let verification = null;
if (!existsSync(productionDirectory)) {
  if (production) {
    failures.push(
      "Canonical promoted neural directory is missing; no production receipt exists."
    );
  } else {
    warnings.push(
      "No promoted neural directory exists; the development promotion guard remains active."
    );
  }
} else {
  try {
    verification = verifyNeuralProductionPromotionReceipt({
      repoRoot: ROOT,
      productionDirectory
    });
  } catch (error) {
    failures.push(errorMessage(error));
  }
}

const status = failures.length === 0
  ? production
    ? "passed-production-phase9-promotion"
    : verification
      ? "passed-phase9-promotion-receipt"
      : "passed-phase9-promotion-guard"
  : production
    ? "failed-production-phase9-promotion"
    : "failed-phase9-promotion";
const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  command: "node scripts/check-neural-production-promotion.mjs",
  suite: "neural-production-promotion",
  durationMs: Math.round(performance.now() - startedAt),
  phase: 9,
  production,
  status,
  productionDirectory: portable(productionDirectory),
  verification,
  failures,
  warnings
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  status,
  report: portable(reportPath),
  promotionId: verification?.promotionId ?? null,
  artifactSetSha256: verification?.artifactSetSha256 ?? null,
  failures,
  warnings
}, null, 2)}\n`);
process.exitCode = failures.length === 0 ? 0 : 1;

function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--production") {
      if (flags.has("production")) fail("Duplicate --production flag.");
      flags.add("production");
      continue;
    }
    if (!["--production-dir", "--report"].includes(argument)) {
      fail(`Unknown Phase 9 argument ${argument}.`);
    }
    const name = argument.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) fail(`Missing value for ${argument}.`);
    if (values.has(name)) fail(`Duplicate ${argument}.`);
    values.set(name, next);
    index += 1;
  }
  return { flags, values };
}

function value(parsed, name) {
  return parsed.values.get(name);
}

function safePath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} path must be a non-empty string.`);
  }
  const path = isAbsolute(value) ? resolve(value) : resolve(ROOT, value);
  const child = relative(ROOT, path);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    fail(`${label} path escapes the repository.`);
  }
  return path;
}

function safeOutputPath(value) {
  return safePath(value, "Phase 9 report");
}

function canonicalDirectory(path, label) {
  const resolved = resolve(path);
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`${label} must be a real directory.`);
  }
  return realpathSync(resolved);
}

function portable(path) {
  return relative(ROOT, resolve(path)).split(sep).join("/");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(message) {
  throw new Error(message);
}
