#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  validateNeuralSelectionReport
} from "./lib/neural-model-selection.mjs";
import {
  inspectContainedRegularFile
} from "./lib/neural-artifact-filesystem.mjs";
import {
  verifyNeuralProductionPromotionReceipt
} from "./lib/neural-production-promotion-receipt.mjs";
import {
  canonicalNeuralTrainingConfigPath,
  resolveNeuralTrainingLayout
} from "./lib/neural-training-contract.mjs";

const THROUGH_VALUES = new Set(["phase3-6", "phase3-9", "phase0-10"]);
const PRODUCTION_DIRECTORY =
  "models/macos/LekhNeuralTransliterator.production";

export function buildNeuralProductionGatePlan(options) {
  const root = resolve(options.repoRoot);
  const through = options.through ?? "phase0-10";
  if (!THROUGH_VALUES.has(through)) {
    throw new TypeError(`Unsupported production gate range: ${through}.`);
  }
  if (!Array.isArray(options.candidateSpecifications) ||
      options.candidateSpecifications.length < 2) {
    throw new TypeError(
      "Production re-verification requires at least two candidate specifications."
    );
  }
  const productionRoot = resolve(root, PRODUCTION_DIRECTORY);
  const canonicalNativeReport = resolve(
    root,
    "reports/neural-native-service-e2e-production-report.json"
  );
  const commands = [];
  const add = (label, script, args = []) => {
    commands.push({
      label,
      executable: process.execPath,
      args: [resolve(root, script), ...args]
    });
  };

  if (through === "phase0-10") {
    add(
      "phase0-contract",
      "scripts/check-neural-production-contract.mjs"
    );
    add(
      "phase1-gold",
      "scripts/validate-neural-gold-eval.mjs",
      ["--production"]
    );
    add(
      "phase2-dataset",
      "scripts/build-neural-open-vocab-dataset.mjs",
      ["--production", "--check"]
    );
  }

  add(
    "phase4-training-contract",
    "scripts/check-neural-training-contract.mjs",
    [
      "--production",
      "--config",
      options.configPath,
      "--candidate-root",
      options.candidateRoot
    ]
  );
  add(
    "phase5-evaluation",
    "scripts/evaluate-neural-open-vocab-model.mjs",
    [
      "--production",
      "--predictions",
      options.predictionsPath,
      "--export-report",
      options.exportReportPath,
      "--report",
      resolve(
        root,
        "reports/neural-open-vocab-evaluation-reverification.json"
      )
    ]
  );
  add(
    "phase5-runtime-placement",
    "scripts/check-neural-runtime-placement-evidence.mjs",
    [
      "--artifact-root",
      productionRoot,
      "--evidence",
      options.runtimePlacementEvidence
    ]
  );
  add(
    "phase5-native-service",
    "scripts/benchmark-neural-native-service.mjs",
    [
      "--production",
      "--bundle",
      options.bundle,
      "--runtime-placement-evidence",
      options.runtimePlacementEvidence
    ]
  );
  add(
    "phase5-coreml-device",
    "scripts/benchmark-neural-coreml-device.mjs",
    [
      "--production",
      "--artifact-root",
      productionRoot,
      "--measurements",
      canonicalNativeReport
    ]
  );
  add(
    "phase6-native-integration",
    "scripts/check-neural-native-integration.mjs",
    ["--production", "--artifact-root", productionRoot]
  );
  add(
    "phase6-runtime-conformance",
    "scripts/check-neural-runtime-manifest-conformance.mjs",
    [
      "--production",
      "--artifact-root",
      productionRoot,
      "--e2e-report",
      canonicalNativeReport
    ]
  );

  if (through !== "phase3-6") {
    add(
      "phase8-training-run",
      "scripts/prepare-neural-training-run.mjs",
      [
        "--production",
        "--config",
        options.configPath,
        "--candidate-root",
        options.candidateRoot
      ]
    );
    add(
      "phase9-model-selection",
      "scripts/check-neural-model-selection.mjs",
      [
        "--production",
        ...options.candidateSpecifications.flatMap((path) => [
          "--candidate-spec",
          path
        ]),
        "--report",
        resolve(
          root,
          "reports/neural-model-selection-reverification-report.json"
        )
      ]
    );
    add(
      "phase9-promotion",
      "scripts/check-neural-production-promotion.mjs",
      ["--production"]
    );
  }

  if (through === "phase0-10") {
    add(
      "phase9-readiness",
      "scripts/check-neural-transliteration-readiness.mjs",
      ["--production", "--artifact-root", productionRoot]
    );
    add(
      "phase10-final-readiness",
      "scripts/check-neural-sota-worldclass.mjs",
      ["--production"]
    );
  }
  return commands;
}

export function resolveNeuralProductionGateContext(options) {
  const root = realpathSync(resolve(options.repoRoot));
  const verification = verifyNeuralProductionPromotionReceipt({
    repoRoot: root,
    productionDirectory: PRODUCTION_DIRECTORY
  });
  const configPath = canonicalNeuralTrainingConfigPath(
    verification.modelId,
    root
  );
  const config = readJson(configPath, "Selected training config");
  const layout = resolveNeuralTrainingLayout(config, configPath, root);
  const candidateManifest = containedPath(
    root,
    verification.retainedInputs.candidateManifest.path,
    "Retained candidate manifest"
  );
  const candidateRoot = dirname(candidateManifest);
  if (candidateRoot !== layout.candidateRoot) {
    throw new TypeError(
      "Promoted candidate root does not match the selected model's canonical " +
      "training layout."
    );
  }
  const selectionPath = containedPath(
    root,
    verification.retainedInputs.selectionReport.path,
    "Retained selection report"
  );
  const selection = validateNeuralSelectionReport(
    readJson(selectionPath, "Retained selection report")
  );
  const candidateSpecifications = verifyRetainedSelectionEvidence({
    repoRoot: root,
    selection
  });
  if (candidateSpecifications.length < 2) {
    throw new TypeError(
      "Retained model selection does not contain two qualified candidates."
    );
  }
  return {
    verification,
    configPath,
    candidateRoot,
    candidateSpecifications,
    predictionsPath: containedPath(
      root,
      verification.retainedInputs.predictions.path,
      "Retained gold predictions"
    ),
    exportReportPath: containedPath(
      root,
      verification.retainedInputs.exportReport.path,
      "Retained export report"
    )
  };
}

export function verifyRetainedSelectionEvidence(options) {
  const root = realpathSync(resolve(options.repoRoot));
  const candidateSpecifications = [];
  for (const candidate of options.selection.candidates) {
    for (const [name, expected] of Object.entries(candidate.evidence)) {
      const evidence = inspectContainedRegularFile(root, expected.path, {
        label: `Candidate ${candidate.candidateId} ${name}`,
        maxBytes: 256 * 1024 * 1024
      });
      if (evidence.sha256 !== expected.sha256) {
        throw new TypeError(
          `Candidate ${candidate.candidateId} ${name} changed after the ` +
          "retained model selection was created."
        );
      }
      if (name === "specification") {
        candidateSpecifications.push(evidence.path);
      }
    }
  }
  if (candidateSpecifications.length !== options.selection.candidates.length) {
    throw new TypeError(
      "Every retained model-selection candidate must bind one specification."
    );
  }
  return candidateSpecifications;
}

function main() {
  const root = realpathSync(resolve(process.cwd()));
  const startedAt = performance.now();
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2), root);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 2;
    return;
  }
  const reportPath = parsed.reportPath;
  let context;
  try {
    context = resolveNeuralProductionGateContext({ repoRoot: root });
  } catch (error) {
    const report = finishReport({
      root,
      reportPath,
      startedAt,
      through: parsed.through,
      status: "failed-neural-production-reverification",
      context: null,
      commands: [],
      failures: [errorMessage(error)]
    });
    process.stderr.write(`${JSON.stringify(summary(report), null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const plan = buildNeuralProductionGatePlan({
    repoRoot: root,
    through: parsed.through,
    configPath: context.configPath,
    candidateRoot: context.candidateRoot,
    candidateSpecifications: context.candidateSpecifications,
    predictionsPath: context.predictionsPath,
    exportReportPath: context.exportReportPath,
    runtimePlacementEvidence: parsed.runtimePlacementEvidence,
    bundle: parsed.bundle
  });
  const results = [];
  for (const command of plan) {
    const commandStartedAt = performance.now();
    const result = spawnSync(command.executable, command.args, {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    results.push({
      label: command.label,
      command: [
        portable(root, command.executable),
        ...command.args.map((argument) => portableArgument(root, argument))
      ],
      durationMs: Math.round(performance.now() - commandStartedAt),
      exitCode: result.status,
      signal: result.signal,
      spawnError: result.error ? errorMessage(result.error) : null,
      stdoutSha256: sha256(result.stdout ?? ""),
      stderrSha256: sha256(result.stderr ?? "")
    });
  }
  const failures = results
    .filter((result) =>
      result.exitCode !== 0 ||
      result.signal !== null ||
      result.spawnError !== null
    )
    .map((result) =>
      `${result.label} failed with ` +
      `${result.spawnError ?? result.signal ?? `exit ${result.exitCode}`}.`
    );
  const report = finishReport({
    root,
    reportPath,
    startedAt,
    through: parsed.through,
    status: failures.length === 0
      ? "passed-neural-production-reverification"
      : "failed-neural-production-reverification",
    context: {
      modelId: context.verification.modelId,
      runtimeModelContract: context.verification.runtimeModelContract,
      trainingRunId: context.verification.trainingRunId,
      exportRunId: context.verification.exportRunId,
      promotionId: context.verification.promotionId,
      selectionId: context.verification.selectionId,
      artifactSetSha256: context.verification.artifactSetSha256,
      config: portable(root, context.configPath),
      candidateRoot: portable(root, context.candidateRoot),
      candidateSpecifications: context.candidateSpecifications.map((path) =>
        portable(root, path)
      ),
      runtimePlacementEvidence: portable(
        root,
        parsed.runtimePlacementEvidence
      ),
      bundle: portableArgument(root, parsed.bundle)
    },
    commands: results,
    failures
  });
  process.stdout.write(`${JSON.stringify(summary(report), null, 2)}\n`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

function parseArguments(argv, root) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (![
      "--bundle",
      "--report",
      "--runtime-placement-evidence",
      "--through"
    ].includes(argument)) {
      throw new TypeError(
        `Unknown neural production re-verification argument ${argument}.`
      );
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new TypeError(`Missing value for ${argument}.`);
    }
    const name = argument.slice(2);
    if (values.has(name)) {
      throw new TypeError(`Duplicate ${argument}.`);
    }
    values.set(name, value);
    index += 1;
  }
  const through = values.get("through") ?? "phase0-10";
  if (!THROUGH_VALUES.has(through)) {
    throw new TypeError(
      "--through must be phase3-6, phase3-9, or phase0-10."
    );
  }
  if (!values.has("runtime-placement-evidence")) {
    throw new TypeError(
      "--runtime-placement-evidence is required and must come from the exact " +
      "packaged production workload."
    );
  }
  const runtimePlacementEvidence = containedPath(
    root,
    values.get("runtime-placement-evidence"),
    "Runtime-placement evidence"
  );
  const reportPath = containedOutputPath(
    root,
    values.get("report") ??
      "reports/neural-production-reverification-report.json"
  );
  const bundle = resolve(
    values.get("bundle") ??
      join(
        homedir(),
        "Library",
        "Caches",
        "LekhKeyboardBuild",
        "native",
        "macos",
        "Lekh Keyboard.imkdevbundle"
      )
  );
  return {
    through,
    runtimePlacementEvidence,
    reportPath,
    bundle
  };
}

function containedPath(root, value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} path must be a non-empty string.`);
  }
  const path = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const child = relative(root, path);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) ||
      isAbsolute(child)) {
    throw new TypeError(`${label} path must remain inside the repository.`);
  }
  if (!existsSync(path)) {
    throw new TypeError(`${label} is missing: ${portable(root, path)}.`);
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(path) !== path) {
    throw new TypeError(`${label} must be a real regular file.`);
  }
  return path;
}

function containedOutputPath(root, value) {
  const path = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const allowedRoots = [
    resolve(root, "reports"),
    resolve(root, ".tmp")
  ];
  if (!path.endsWith(".json") ||
      !allowedRoots.some((allowedRoot) =>
        isStrictlyWithin(allowedRoot, path)
      )) {
    throw new TypeError(
      "Production re-verification report must be a JSON file under reports/ or .tmp/."
    );
  }
  let current = root;
  for (const component of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, component);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) {
      throw new TypeError(
        "Production re-verification report path contains a symbolic link."
      );
    }
  }
  return path;
}

function isStrictlyWithin(parent, child) {
  const candidate = relative(parent, child);
  return candidate !== "" &&
    candidate !== ".." &&
    !candidate.startsWith(`..${sep}`) &&
    !isAbsolute(candidate);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new TypeError(`${label} is invalid JSON: ${errorMessage(error)}`);
  }
}

function finishReport({
  root,
  reportPath,
  startedAt,
  through,
  status,
  context,
  commands,
  failures
}) {
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-neural-production-readiness.mjs",
    suite: "neural-production-reverification",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    through,
    context,
    commands,
    failures
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.tmp-${process.pid}`;
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify(report, null, 2)}\n`,
      { flag: "wx", mode: 0o600 }
    );
    renameSync(temporary, reportPath);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
  return {
    ...report,
    report: portable(root, reportPath)
  };
}

function summary(report) {
  return {
    status: report.status,
    report: report.report,
    through: report.through,
    modelId: report.context?.modelId ?? null,
    artifactSetSha256: report.context?.artifactSetSha256 ?? null,
    failures: report.failures
  };
}

function portable(root, path) {
  const child = relative(root, resolve(path));
  return child && child !== ".." && !child.startsWith(`..${sep}`) &&
      !isAbsolute(child)
    ? child.split(sep).join("/")
    : resolve(path);
}

function portableArgument(root, value) {
  if (typeof value !== "string" || value.length === 0) return value;
  return isAbsolute(value) ? portable(root, value) : value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) main();
