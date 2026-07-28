#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import {
  inspectContainedRegularFile
} from "./lib/neural-artifact-filesystem.mjs";
import {
  resolveNeuralArtifactDescriptor
} from "./lib/neural-artifact-descriptor.mjs";
import {
  validateNeuralRuntimePlacementEvidence
} from "./lib/neural-runtime-placement-evidence.mjs";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const artifactRoot = safePath(
  args.get("artifact-root") ??
    "models/macos/LekhNeuralTransliterator.production",
  "Neural artifact root"
);
const evidencePath = safePath(
  args.get("evidence") ??
    "reports/neural-runtime-placement-evidence.json",
  "Runtime-placement evidence"
);
const reportPath = safePath(
  args.get("report") ??
    "reports/neural-runtime-placement-validation.json",
  "Runtime-placement validation report"
);
const failures = [];
let descriptor = null;
let evidence = null;
let evidenceSha256 = null;

try {
  descriptor = resolveNeuralArtifactDescriptor({
    repoRoot: root,
    manifestPath: join(
      artifactRoot,
      "LekhNeuralTransliterator.manifest.json"
    ),
    vocabPath: join(
      artifactRoot,
      "LekhNeuralTransliterator.vocab.json"
    ),
    artifactDirectory: artifactRoot,
    verifyExportArtifacts: false
  });
} catch (error) {
  failures.push(
    "Neural artifact set is invalid: " +
    (error instanceof Error ? error.message : String(error))
  );
}
try {
  const file = inspectContainedRegularFile(root, evidencePath, {
    label: "Neural runtime-placement evidence",
    includeContents: true,
    maxBytes: 4 * 1024 * 1024
  });
  evidence = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(file.contents)
  );
  evidenceSha256 = file.sha256;
} catch (error) {
  failures.push(
    "Runtime-placement evidence is not safe strict UTF-8 JSON: " +
    (error instanceof Error ? error.message : String(error))
  );
}

const validation = descriptor && evidence
  ? validateNeuralRuntimePlacementEvidence(evidence, {
      artifactDescriptor: descriptor
    })
  : null;
if (validation) failures.push(...validation.issueCodes);
const status = failures.length === 0
  ? "passed-neural-runtime-placement"
  : "failed-neural-runtime-placement";
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  command: "node scripts/check-neural-runtime-placement-evidence.mjs",
  suite: "neural-runtime-placement",
  status,
  artifactRoot: portable(artifactRoot),
  artifactSetSha256: descriptor?.artifactSetSha256 ?? null,
  evidence: portable(evidencePath),
  evidenceSha256,
  neuralEngineClaimAllowed:
    validation?.neuralEngineClaimAllowed === true,
  failures
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  status,
  report: portable(reportPath),
  artifactSetSha256: report.artifactSetSha256,
  neuralEngineClaimAllowed: report.neuralEngineClaimAllowed,
  failures
}, null, 2)}\n`);
process.exitCode = failures.length === 0 ? 0 : 1;

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (![
      "--artifact-root",
      "--evidence",
      "--report"
    ].includes(argument)) {
      throw new TypeError(
        `Unknown runtime-placement argument ${argument}.`
      );
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new TypeError(`Missing value for ${argument}.`);
    }
    const name = argument.slice(2);
    if (values.has(name)) {
      throw new TypeError(`Duplicate ${argument}.`);
    }
    values.set(name, next);
    index += 1;
  }
  return values;
}

function safePath(value, label) {
  const path = resolve(root, value);
  const child = relative(root, path);
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    child === "" ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    throw new TypeError(`${label} must remain inside the repository.`);
  }
  return path;
}

function portable(path) {
  return relative(root, path).split(sep).join("/");
}
