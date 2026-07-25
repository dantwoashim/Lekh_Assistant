#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
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
  verifyNeuralTrainingCandidate
} from "./lib/neural-training-artifact-contract.mjs";

const ROOT = realpathSync(process.cwd());
const startedAt = performance.now();
const DEFAULT_CONFIG =
  "data/neural/training/open-vocab-seq2seq-v1.config.json";
const COMMAND = "node scripts/check-neural-training-contract.mjs";

let parsed;
try {
  parsed = parseArguments(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 2;
}

if (parsed) {
  const production = parsed.flags.has("production");
  let reportPath;
  try {
    reportPath = safeOutputPath(
      parsed.values.get("report") ??
        join(
          ROOT,
          "reports",
          production
            ? "neural-training-contract-production-report.json"
            : "neural-training-contract-report.json"
        )
    );
    const verification = verifyNeuralTrainingCandidate({
      repoRoot: ROOT,
      production,
      configPath: parsed.values.get("config") ?? DEFAULT_CONFIG,
      candidateRoot: parsed.values.get("candidate-root")
    });
    const report = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      command: COMMAND,
      suite: "neural-training-contract",
      durationMs: Math.round(performance.now() - startedAt),
      phase: 4,
      ...verification
    };
    writeReportAtomically(reportPath, report);
    process.stdout.write(`${JSON.stringify({
      status: report.status,
      report: portable(reportPath),
      production,
      modelId: report.modelId ?? null,
      runtimeModelContract: report.runtimeModelContract ?? null,
      artifactSetSha256: report.artifactSetSha256 ?? null,
      trainingRunId: report.trainingRunId ?? null,
      exportRunId: report.exportRunId ?? null,
      failures: report.failures,
      warnings: report.warnings
    }, null, 2)}\n`);
    process.exitCode = report.failures.length === 0 ? 0 : 1;
  } catch (error) {
    const failure = errorMessage(error);
    const report = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      command: COMMAND,
      suite: "neural-training-contract",
      durationMs: Math.round(performance.now() - startedAt),
      phase: 4,
      production,
      status: production
        ? "failed-production-phase4-training-contract"
        : "failed-phase4-training-contract",
      failures: [failure],
      warnings: []
    };
    if (reportPath) {
      try {
        writeReportAtomically(reportPath, report);
      } catch (writeError) {
        process.stderr.write(
          `${failure}\nUnable to write failure report: ${errorMessage(writeError)}\n`
        );
        process.exitCode = 1;
      }
    } else {
      process.stderr.write(`${failure}\n`);
    }
    if (reportPath) {
      process.stdout.write(`${JSON.stringify({
        status: report.status,
        report: portable(reportPath),
        production,
        failures: report.failures,
        warnings: []
      }, null, 2)}\n`);
    }
    process.exitCode = 1;
  }
}

function parseArguments(argv) {
  const flags = new Set();
  const values = new Map();
  const flagOptions = new Set(["production"]);
  const valueOptions = new Set(["config", "candidate-root", "report"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--") || token === "--") {
      throw new TypeError(`Unexpected positional argument: ${token}`);
    }
    const option = token.slice(2);
    if (flagOptions.has(option)) {
      if (flags.has(option)) {
        throw new TypeError(`Duplicate option: --${option}`);
      }
      flags.add(option);
      continue;
    }
    if (!valueOptions.has(option)) {
      throw new TypeError(`Unknown option: --${option}`);
    }
    if (values.has(option)) {
      throw new TypeError(`Duplicate option: --${option}`);
    }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 ||
        value.startsWith("--")) {
      throw new TypeError(`Missing value for --${option}`);
    }
    values.set(option, value);
    index += 1;
  }
  return { flags, values };
}

function safeOutputPath(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Report path must be a non-empty string.");
  }
  const path = isAbsolute(value) ? resolve(value) : resolve(ROOT, value);
  const child = relative(ROOT, path);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) ||
      isAbsolute(child)) {
    throw new TypeError("Report path must remain inside the repository.");
  }
  if (!path.endsWith(".json")) {
    throw new TypeError("Report path must end in .json.");
  }
  assertNoSymlinkComponents(path);
  return path;
}

function assertNoSymlinkComponents(path) {
  const child = relative(ROOT, path);
  let current = ROOT;
  for (const component of child.split(sep).filter(Boolean)) {
    current = join(current, component);
    if (!existsSync(current)) break;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new TypeError(
        `Report path contains a symbolic-link component: ${portable(current)}.`
      );
    }
  }
}

function writeReportAtomically(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  assertNoSymlinkComponents(path);
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify(report, null, 2)}\n`,
      { flag: "wx", mode: 0o600 }
    );
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
}

function portable(path) {
  return relative(ROOT, resolve(path)).split(sep).join("/");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
