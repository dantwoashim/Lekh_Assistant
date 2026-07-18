import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = resolve(import.meta.dirname, "..");
const ARTIFACT_PATH = resolve(ROOT, "docs/evidence/composition-work-bound.json");
const CONTRACT_PATH = resolve(ROOT, "data/engine/lekh-engine-contract.v1.json");
const SCRIPT_PATH = resolve(ROOT, "scripts/benchmark-composition-work-bound.ts");
const EXACT_COMMAND = "npx vite-node scripts/benchmark-composition-work-bound.ts --write";
const BOUNDS = [128, 192, 256, 512] as const;
const DEFAULT_BATCHES = 3;
const DEFAULT_SAMPLES = 1_000;
const DEFAULT_WARMUP = 100;
const SOURCE_PATHS = measuredSourcePaths();

interface Metrics {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

interface BatchResult extends Metrics {
  batch: number;
  samples: number;
}

interface WorkerResult extends Metrics {
  boundUtf16CodeUnits: number;
  batches: BatchResult[];
  pipelineAssertions: {
    exactBoundAccepted: boolean;
    candidatesObserved: boolean;
    proofHintsObserved: boolean;
    trainedModelCandidateObserved: boolean;
    semanticSha256CandidateIdsObserved: boolean;
  };
}

const args = new Set(process.argv.slice(2));
if (args.has("--check")) {
  checkArtifact();
} else if (args.has("--worker")) {
  await runWorker();
} else {
  runParent(args.has("--write"));
}

function runParent(write: boolean): void {
  const startedAt = performance.now();
  const cases = BOUNDS.map((bound) => runIsolatedBound(bound));
  const contract = parseJson(CONTRACT_PATH) as {
    hotPathPolicy: { deterministicP99Milliseconds: number; maximumCompositionUtf16CodeUnits: number };
  };
  const selectedBound = contract.hotPathPolicy.maximumCompositionUtf16CodeUnits;
  if (selectedBound !== BOUNDS[0]) {
    throw new Error(`Expected canonical composition bound ${BOUNDS[0]}, received ${selectedBound}.`);
  }
  const selectedCase = cases.find((item) => item.boundUtf16CodeUnits === selectedBound);
  if (!selectedCase || selectedCase.p99Ms > contract.hotPathPolicy.deterministicP99Milliseconds) {
    throw new Error("The canonical composition bound missed its deterministic p99 target.");
  }

  const cpu = cpus()[0];
  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    exactCommand: EXACT_COMMAND,
    benchmark: "LocalKeyboardEngine composition work bound",
    canonicalBoundUtf16CodeUnits: selectedBound,
    deterministicP99TargetMs: contract.hotPathPolicy.deterministicP99Milliseconds,
    decision: "128 UTF-16 code units remains the canonical production composition bound.",
    method: {
      batches: DEFAULT_BATCHES,
      samplesPerBatch: DEFAULT_SAMPLES,
      warmupUpdatesPerCase: DEFAULT_WARMUP,
      workload: "Two single-token Romanized compositions differ in their final code unit and are padded to the exact candidate bound.",
      cacheControl: "Two exact-length inputs alternate on one session so every measured update misses the refresh cache.",
      garbageCollection: "Each isolated worker requests a full garbage collection between batches when the runtime exposes it.",
      isolation: "Each candidate bound runs in a fresh process. The imported contract value is raised before the unchanged LocalKeyboardEngine module loads so rejected bounds exercise the same real refresh path used at 128.",
      timedPath: "LocalKeyboardEngine.updateComposition -> refresh -> proofread scan -> candidate/model generation -> final candidate semantic SHA-256 IDs.",
      validation: "Untimed real-engine probes require a proofread hint, a trained-model candidate, semantic SHA-256 candidate IDs, candidates, and exact-bound acceptance before samples are accepted."
    },
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      platform: platform(),
      osRelease: release(),
      architecture: process.arch,
      cpuModel: cpu?.model ?? "unknown",
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytesAtReport: freemem()
    },
    durationMs: round(performance.now() - startedAt),
    sourceIntegrity: Object.fromEntries(SOURCE_PATHS.map((path) => [path, sha256(resolve(ROOT, path))])),
    cases
  };

  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  if (write) {
    mkdirSync(resolve(ROOT, "docs/evidence"), { recursive: true });
    writeFileSync(ARTIFACT_PATH, json);
    console.log(`Wrote ${relative(ROOT, ARTIFACT_PATH)}.`);
  }
  console.log(json.trimEnd());
}

function runIsolatedBound(bound: number): WorkerResult {
  const viteNode = resolve(ROOT, "node_modules/vite-node/vite-node.mjs");
  const output = execFileSync(
    process.execPath,
    ["--expose-gc", viteNode, SCRIPT_PATH, "--worker", `--bound=${bound}`],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );
  return JSON.parse(output) as WorkerResult;
}

async function runWorker(): Promise<void> {
  const bound = readPositiveIntegerArg("--bound");
  if (!BOUNDS.includes(bound as (typeof BOUNDS)[number])) {
    throw new Error(`Unsupported composition bound ${bound}.`);
  }

  const contractModule = await import("../data/engine/lekh-engine-contract.v1.json");
  const contract = contractModule.default;
  contract.hotPathPolicy.maximumCompositionUtf16CodeUnits = bound;
  const { createKeyboardEngine, defaultTypingContext } = await import("../src/engine/keyboard/index");
  const engine = createKeyboardEngine();
  await engine.warm({ timeoutMs: 5_000 });
  const sessionId = engine.beginSession({
    ...defaultTypingContext("romanized"),
    activeDomains: ["government"],
    enableNextWordPrediction: true,
    showRomanizedLabels: true
  });

  const modelProbe = engine.updateComposition(sessionId, "ramro x", 7);
  const trainedModelCandidateObserved = modelProbe.candidates.some((candidate) =>
    candidate.reason.some((reason) => reason.includes("trained prediction model"))
  );
  const semanticSha256CandidateIdsObserved = modelProbe.candidates.some((candidate) =>
    /^candidate-[a-f0-9]{32}$/.test(candidate.id)
  );
  const proofSessionId = engine.beginSession(defaultTypingContext("unicode-proofread"));
  const proofProbe = engine.updateComposition(proofSessionId, "सवस्थ्य", "सवस्थ्य".length);
  const proofHintsObserved = proofProbe.proofHints.some((hint) => hint.suggestion === "स्वास्थ्य");
  engine.endSession(proofSessionId);

  const inputs = [exactLengthInput(bound, "a"), exactLengthInput(bound, "b")];
  let candidatesObserved = false;
  let exactBoundAccepted = false;
  for (let index = 0; index < DEFAULT_WARMUP; index += 1) {
    const input = inputs[index % inputs.length];
    const update = engine.updateComposition(sessionId, input, input.length);
    assertMeasuredUpdate(update, bound);
    exactBoundAccepted ||= update.compositionText.length === bound;
    candidatesObserved ||= update.candidates.length > 0;
  }

  const pipelineAssertions = {
    exactBoundAccepted,
    candidatesObserved,
    proofHintsObserved,
    trainedModelCandidateObserved,
    semanticSha256CandidateIdsObserved
  };
  if (Object.values(pipelineAssertions).some((value) => !value)) {
    throw new Error(`Real-engine pipeline assertion failed at bound ${bound}: ${JSON.stringify(pipelineAssertions)}`);
  }

  const batches: BatchResult[] = [];
  const allTimings: number[] = [];
  for (let batch = 1; batch <= DEFAULT_BATCHES; batch += 1) {
    globalThis.gc?.();
    const timings: number[] = [];
    for (let index = 0; index < DEFAULT_SAMPLES; index += 1) {
      const input = inputs[index % inputs.length];
      const start = performance.now();
      const update = engine.updateComposition(sessionId, input, input.length);
      timings.push(performance.now() - start);
      assertMeasuredUpdate(update, bound);
    }
    allTimings.push(...timings);
    batches.push({ batch, samples: timings.length, ...metrics(timings) });
  }
  await engine.shutdown();
  process.stdout.write(JSON.stringify({
    boundUtf16CodeUnits: bound,
    batches,
    ...metrics(allTimings),
    pipelineAssertions
  } satisfies WorkerResult));
}

function exactLengthInput(bound: number, tail: string): string {
  if (tail.length > bound) throw new Error(`Tail is longer than bound ${bound}.`);
  const input = `${"a".repeat(bound - tail.length)}${tail}`;
  if (input.length !== bound) throw new Error(`Generated ${input.length} UTF-16 units for bound ${bound}.`);
  return input;
}

function assertMeasuredUpdate(update: { action: string; compositionText: string; candidates: unknown[] }, bound: number): void {
  if (update.action !== "compose" || update.compositionText.length !== bound || update.candidates.length === 0) {
    throw new Error(`Bound ${bound} did not traverse the candidate refresh path.`);
  }
}

function metrics(values: number[]): Metrics {
  const sorted = values.slice().sort((left, right) => left - right);
  return {
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: round(sorted.at(-1) ?? 0)
  };
}

function percentile(sorted: number[], proportion: number): number {
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * proportion) - 1));
  return round(sorted[index] ?? 0);
}

function checkArtifact(): void {
  const artifact = parseJson(ARTIFACT_PATH) as {
    schemaVersion: number;
    exactCommand: string;
    canonicalBoundUtf16CodeUnits: number;
    deterministicP99TargetMs: number;
    method: { batches: number; samplesPerBatch: number; warmupUpdatesPerCase: number };
    sourceIntegrity: Record<string, string>;
    cases: WorkerResult[];
  };
  const contract = parseJson(CONTRACT_PATH) as {
    hotPathPolicy: {
      maximumCompositionUtf16CodeUnits: number;
      deterministicP99Milliseconds: number;
    };
  };
  if (artifact.schemaVersion !== 1 || artifact.exactCommand !== EXACT_COMMAND) {
    throw new Error("Composition benchmark artifact metadata is invalid.");
  }
  if (artifact.canonicalBoundUtf16CodeUnits !== contract.hotPathPolicy.maximumCompositionUtf16CodeUnits) {
    throw new Error("Composition benchmark artifact does not match the canonical engine contract.");
  }
  if (!isFiniteNonNegative(artifact.deterministicP99TargetMs) ||
      artifact.deterministicP99TargetMs !== contract.hotPathPolicy.deterministicP99Milliseconds) {
    throw new Error("Composition benchmark p99 target does not match the canonical engine contract.");
  }
  if (
    artifact.method.batches !== DEFAULT_BATCHES ||
    artifact.method.samplesPerBatch !== DEFAULT_SAMPLES ||
    artifact.method.warmupUpdatesPerCase !== DEFAULT_WARMUP
  ) {
    throw new Error("Composition benchmark artifact sample policy is invalid.");
  }
  if (artifact.cases.map((item) => item.boundUtf16CodeUnits).join(",") !== BOUNDS.join(",")) {
    throw new Error("Composition benchmark artifact does not contain the required ordered bounds.");
  }
  for (const [caseIndex, item] of artifact.cases.entries()) {
    if (item.boundUtf16CodeUnits !== BOUNDS[caseIndex]) {
      throw new Error(`Composition benchmark case ${caseIndex} has the wrong bound.`);
    }
    validateMetrics(item, `case ${item.boundUtf16CodeUnits}`);
    if (item.batches.length !== DEFAULT_BATCHES ||
        Object.keys(item.pipelineAssertions).sort().join("\u0000") !== [
          "candidatesObserved",
          "exactBoundAccepted",
          "proofHintsObserved",
          "semanticSha256CandidateIdsObserved",
          "trainedModelCandidateObserved"
        ].sort().join("\u0000") ||
        Object.values(item.pipelineAssertions).some((value) => value !== true)) {
      throw new Error(`Composition benchmark case ${item.boundUtf16CodeUnits} is incomplete.`);
    }
    for (const [batchIndex, batch] of item.batches.entries()) {
      if (batch.batch !== batchIndex + 1 || batch.samples !== DEFAULT_SAMPLES) {
        throw new Error(`Composition benchmark case ${item.boundUtf16CodeUnits} batch ${batchIndex + 1} has invalid sample metadata.`);
      }
      validateMetrics(batch, `case ${item.boundUtf16CodeUnits} batch ${batch.batch}`);
    }
    const batchMinimumP99 = Math.min(...item.batches.map((batch) => batch.p99Ms));
    const batchMaximumP99 = Math.max(...item.batches.map((batch) => batch.p99Ms));
    if (item.p99Ms < batchMinimumP99 || item.p99Ms > batchMaximumP99 ||
        item.maxMs !== Math.max(...item.batches.map((batch) => batch.maxMs))) {
      throw new Error(`Composition benchmark case ${item.boundUtf16CodeUnits} aggregate metrics are inconsistent.`);
    }
  }
  const selected = artifact.cases.find((item) => item.boundUtf16CodeUnits === artifact.canonicalBoundUtf16CodeUnits);
  if (!selected || selected.p99Ms > artifact.deterministicP99TargetMs) {
    throw new Error("Canonical composition benchmark result misses its deterministic p99 target.");
  }
  for (const path of SOURCE_PATHS) {
    if (artifact.sourceIntegrity[path] !== sha256(resolve(ROOT, path))) {
      throw new Error(`Composition benchmark source hash is stale: ${path}`);
    }
  }
  const recordedPaths = Object.keys(artifact.sourceIntegrity).sort();
  if (recordedPaths.join("\u0000") !== SOURCE_PATHS.join("\u0000")) {
    throw new Error("Composition benchmark source inventory is not exact.");
  }
  console.log("Composition work-bound evidence integrity check passed.");
}

function validateMetrics(value: Metrics, location: string): void {
  const metrics = [value.p50Ms, value.p95Ms, value.p99Ms, value.maxMs];
  if (metrics.some((metric) => !isFiniteNonNegative(metric)) ||
      value.p50Ms > value.p95Ms || value.p95Ms > value.p99Ms || value.p99Ms > value.maxMs) {
    throw new Error(`Composition benchmark ${location} metrics are invalid.`);
  }
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function measuredSourcePaths(): string[] {
  const paths = new Set<string>(["scripts/benchmark-composition-work-bound.ts"]);
  for (const [directory, extensions] of [
    ["data/engine", [".json"]],
    ["src/data/keyboard-packs/v0.1", [".json"]],
    ["src/engine", [".ts", ".json"]],
    ["src/core/dictionary", [".ts", ".json"]],
    ["src/core/normalize", [".ts", ".json"]]
  ] as const) {
    collectSourceFiles(resolve(ROOT, directory), extensions, paths);
  }
  return [...paths].sort();
}

function collectSourceFiles(directory: string, extensions: readonly string[], output: Set<string>): void {
  for (const name of readdirSync(directory).sort()) {
    const absolute = resolve(directory, name);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      collectSourceFiles(absolute, extensions, output);
      continue;
    }
    if (
      name.includes(".test.") ||
      name.includes(".test-support.") ||
      !extensions.some((extension) => name.endsWith(extension))
    ) continue;
    output.add(relative(ROOT, absolute));
  }
}

function readPositiveIntegerArg(name: string): number {
  const prefix = `${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Missing or invalid ${name} argument.`);
  return value;
}

function parseJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
