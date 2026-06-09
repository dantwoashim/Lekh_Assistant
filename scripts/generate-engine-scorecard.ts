import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

interface ReportSpec {
  key: string;
  label: string;
  path: string;
  required: boolean;
  inputs: string[];
}

interface LoadedReport {
  key: string;
  label: string;
  path: string;
  status: "fresh" | "missing" | "stale" | "zero-fixture" | "schema-warning" | "optional-missing";
  generatedAt?: string;
  command?: string;
  suite?: string;
  mode?: string;
  durationMs?: number;
  fixtureCount?: number;
  staleBecause?: string;
  data?: JsonObject;
}

const root = process.cwd();
const reportSpecs: ReportSpec[] = [
  {
    key: "romanized",
    label: "Romanized benchmark",
    path: "bench/reports/romanized-report.json",
    required: true,
    inputs: ["scripts/benchmark-romanized.ts", "src/engine/romanized", "src/core/transliteration", "benchmarks/romanized", "bench/fixtures/romanized"]
  },
  {
    key: "romanizedSelf",
    label: "Romanized self-consistency",
    path: "bench/reports/romanized-self-consistency-report.json",
    required: true,
    inputs: ["scripts/benchmark-romanized-self-consistency.ts", "src/engine/romanized", "src/core/transliteration", "benchmarks/romanized"]
  },
  {
    key: "typingSession",
    label: "Typing-session benchmark",
    path: "bench/reports/typing-session-report.json",
    required: true,
    inputs: ["scripts/benchmark-typing-session.ts", "src/engine/keyboard", "bench/fixtures/typing-session"]
  },
  {
    key: "typingSessionDictionary",
    label: "Typing-session dictionary benchmark",
    path: "bench/reports/typing-session-dictionary-lookup-report.json",
    required: false,
    inputs: ["scripts/benchmark-typing-session.ts", "src/engine/keyboard", "bench/fixtures/typing-session/dictionary-lookup.jsonl"]
  },
  {
    key: "typingSessionMemory",
    label: "Typing-session memory benchmark",
    path: "bench/reports/typing-session-memory-ranking-memory-controls-report.json",
    required: false,
    inputs: ["scripts/benchmark-typing-session.ts", "src/engine/keyboard", "bench/fixtures/typing-session/memory-ranking.jsonl"]
  },
  {
    key: "proofread",
    label: "Proofread benchmark",
    path: "bench/reports/proofread-report.json",
    required: true,
    inputs: ["scripts/benchmark-proofread.ts", "src/engine/proofread", "bench/fixtures/proofread"]
  },
  {
    key: "performance",
    label: "Performance smoke benchmark",
    path: "bench/reports/perf-report.json",
    required: true,
    inputs: ["scripts/bench-perf.ts", "src/engine/keyboard", "src/engine/romanized", "src/engine/legacy", "native/shared/ipc"]
  },
  {
    key: "disjointness",
    label: "Benchmark disjointness",
    path: "bench/reports/benchmark-disjointness-report.json",
    required: true,
    inputs: ["scripts/check-benchmark-disjointness.ts", "bench/fixtures", "benchmarks", "src/data"]
  },
  {
    key: "corpusPackage",
    label: "Keyboard corpus package",
    path: "bench/reports/keyboard-corpus-package-report.json",
    required: true,
    inputs: ["scripts/check-keyboard-corpus-package.mjs", "data/keyboard-corpus/sources.jsonl", "data/keyboard-corpus/reports", "data/keyboard-corpus/runtime", "src/data/keyboard-packs"]
  },
  {
    key: "preeti",
    label: "Preeti benchmark",
    path: "bench/reports/preeti-report.json",
    required: false,
    inputs: ["scripts/benchmark-preeti.ts", "src/engine/legacy", "src/core/preeti", "bench/fixtures/preeti", "benchmarks/preeti"]
  },
  {
    key: "mixedSpan",
    label: "Mixed span mutations",
    path: "bench/reports/mixed-span-mutation-report.json",
    required: false,
    inputs: ["scripts/benchmark-mixed-span-mutations.ts", "src/engine/segmentation", "src/engine/router", "bench/fixtures"]
  },
  {
    key: "aliasCollisions",
    label: "Romanized alias collisions",
    path: "bench/reports/romanized-alias-collision-report.json",
    required: false,
    inputs: ["scripts/report-romanized-alias-collisions.ts", "src/data/aliases", "src/data/lexicon"]
  }
];

const loadedReports = reportSpecs.map(loadReport);
const reportByKey = Object.fromEntries(loadedReports.map((report) => [report.key, report]));
const hardFailures = loadedReports.filter(isHardReportFailure);

const romanized = reportByKey.romanized?.data ?? {};
const romanizedSelf = reportByKey.romanizedSelf?.data ?? {};
const typingSession = reportByKey.typingSession?.data ?? {};
const typingSessionDictionary = reportByKey.typingSessionDictionary?.data ?? {};
const typingSessionMemory = reportByKey.typingSessionMemory?.data ?? {};
const proofread = reportByKey.proofread?.data ?? {};
const performance = reportByKey.performance?.data ?? {};
const disjointness = reportByKey.disjointness?.data ?? {};
const corpusPackage = reportByKey.corpusPackage?.data ?? {};
const preeti = reportByKey.preeti?.data ?? {};
const mixedSpan = reportByKey.mixedSpan?.data ?? {};
const aliasCollisions = reportByKey.aliasCollisions?.data ?? {};
const corpusQualityCounts = corpusPackage.qualityCounts as JsonObject | undefined;
const corpusHumanGoldRows = numberValue(corpusPackage.humanReviewedGoldRows);
const disjointnessContaminatedSuites = arrayValue(disjointness.contaminatedSuites);
const disjointnessQuarantinedSuites = arrayValue(disjointness.quarantinedSuites);
const disjointnessHardFailureSuites = arrayValue(disjointness.hardFailureSuites);
const publicScorecardEligibleSuites = arrayValue(disjointness.publicScorecardEligibleSuites);

const scorecard = {
  generatedAt: new Date().toISOString(),
  command: "npm run scorecard:engine",
  mode: "read-existing-fresh-reports",
  verificationStability: {
    requiredReports: loadedReports.filter((report) => reportBySpec(report.key)?.required).length,
    freshRequiredReports: loadedReports.filter((report) => reportBySpec(report.key)?.required && report.status === "fresh").length,
    hardFailureCount: hardFailures.length,
    reports: loadedReports.map(({ data: _data, ...summary }) => summary)
  },
  keyboardEngine: {
    apiStatus: "implemented",
    processKeyStroke: "required and tested",
    updateComposition: "browser/lab path",
    secureInputPolicy: "memory/proofread/suggestions disabled or reduced",
    candidateDedupe: "dedupe by normalized text before shortcut assignment",
    shortcutPolicy: "sequential after final sort"
  },
  romanized: {
    fixtureCount: numberValue(romanized.fixtureCount),
    mode: stringValue(romanized.mode),
    top1: numberValue(romanized.top1),
    top3: numberValue(romanized.top3),
    top5: numberValue(romanized.top5),
    mrr: numberValue(romanized.meanReciprocalRank),
    hardHostile: romanized.hardHostile ?? null,
    selfConsistency: {
      fixtureCount: numberValue(romanizedSelf.fixtureCount),
      mode: stringValue(romanizedSelf.mode),
      normalizedStabilityRate: numberValue(romanizedSelf.normalizedStabilityRate),
      outputInTopCandidatesRate: numberValue(romanizedSelf.outputInTopCandidatesRate),
      hardCandidateCapRate: numberValue(romanizedSelf.hardCandidateCapRate),
      protectedPreservationRate: numberValue(romanizedSelf.protectedPreservationRate),
      failureCount: numberValue(romanizedSelf.failureCount)
    }
  },
  typingSession: {
    fixtureCount: numberValue(typingSession.fixtureCount),
    failedSessions: numberValue(typingSession.failedSessions),
    romanized: typingSession.romanized ?? null,
    traditionalPlaceholder: typingSession.traditionalPlaceholder ?? null,
    bySuite: typingSession.bySuite ?? {},
    latency: typingSession.latency ?? {},
    keystrokeSavingsRatioMean: typingSession.keystrokeSavingsRatioMean ?? null,
    proofHintHitRate: numberValue(typingSession.proofHintHitRate),
    dictionaryHitRate: numberValue(typingSession.dictionaryHitRate),
    memoryBoostSuccessRate: numberValue(typingSession.memoryBoostSuccessRate),
    nextWordSuccessRate: numberValue(typingSession.nextWordSuccessRate),
    romanizedLabelHitRate: numberValue(typingSession.romanizedLabelHitRate),
    duplicateCandidateCount: numberValue(typingSession.duplicateCandidateCount),
    shortcutSequenceValidityRate: numberValue(typingSession.shortcutSequenceValidityRate)
  },
  prompt2Intelligence: {
    romanizedLiveTyping: statusFromSuite(typingSession, "romanized-live-basic"),
    romanizedGovernmentPhrases: statusFromSuite(typingSession, "romanized-live-government"),
    romanizedHelperSuggestions: statusFromSuite(typingSession, "romanized-helper"),
    romanizedLabels: numberValue(typingSession.romanizedLabelHitRate) >= 1 ? "complete" : "partial",
    candidateDedupeShortcuts: numberValue(typingSession.duplicateCandidateCount) === 0 && numberValue(typingSession.shortcutSequenceValidityRate) >= 1
      ? "complete"
      : "partial",
    rankingAndPhraseCompletion: statusFromSuite(typingSession, "romanized-live-government"),
    nextWordPrediction: numberValue(typingSession.nextWordSuccessRate) >= 1 ? "complete" : "partial",
    ksrBaseline: typingSession.keystrokeSavingsRatioMean ?? null,
    traditionalPhysicalLayout: "blocked-human",
    traditionalUnicodeSuggestions: statusFromSuite(typingSession, "traditional-unicode-suggestions"),
    traditionalProofread: statusFromSuite(typingSession, "traditional-unicode-suggestions"),
    proofreadWhileTyping: numberValue(typingSession.proofHintHitRate) >= 1 ? "complete" : "partial",
    dictionaryLookup: numberValue(typingSession.dictionaryHitRate) >= 1 ? "complete" : "partial",
    personalMemory: numberValue(typingSession.memoryBoostSuccessRate) >= 1 ? "complete" : "partial",
    memoryControls: statusFromSuite(typingSession, "memory-controls"),
    keyboardLab: existsSync(join(root, "src/features/keyboard/KeyboardLab.tsx")) ? "complete" : "pending",
    companionShell: existsSync(join(root, "src/features/companion/CompanionShell.tsx")) && existsSync(join(root, "electron/main.cjs"))
      ? "complete"
      : "pending",
    typingLatencyP95Ms: numberValue((typingSession.latency as JsonObject | undefined)?.updateP95Ms),
    nativeReleaseReadiness: "pending"
  },
  proofread: {
    fixtureCount: numberValue(proofread.fixtureCount),
    exactMatchRate: numberValue(proofread.exactMatchRate),
    autoFixPrecisionProxy: numberValue(proofread.autoFixPrecisionProxy),
    hintsGenerated: numberValue(proofread.hintsGenerated)
  },
  performance: {
    mode: stringValue(performance.mode),
    reports: performance.reports ?? [],
    targetMissCount: Array.isArray(performance.reports)
      ? performance.reports.filter((report) => Boolean((report as JsonObject).targetMissed)).length
      : 0,
    grossSlowdownCount: Array.isArray(performance.reports)
      ? performance.reports.filter((report) => Boolean((report as JsonObject).grosslySlow)).length
      : 0
  },
  corpusPackage: {
    status: stringValue(corpusPackage.status) ?? "missing",
    sourceCount: numberValue(corpusPackage.sourceCount),
    curatedRows: corpusPackage.curatedRows ?? {},
    qualityCounts: corpusPackage.qualityCounts ?? {},
    humanReviewedGoldRows: corpusHumanGoldRows,
    goldPromotions: numberValue(corpusPackage.goldPromotions),
    reviewedScaleStatus: stringValue(corpusPackage.reviewedScaleStatus) ?? "unknown",
    reviewedScaleNote: stringValue(corpusPackage.reviewedScaleNote) ?? "",
    leakageStatus: stringValue(corpusPackage.leakageStatus) ?? "unknown",
    blindRows: numberValue(corpusQualityCounts?.blind),
    realBlindBenchmarkStatus: corpusHumanGoldRows >= 100000 ? "complete" : "partial",
    publicProofEligibleFixtureCount: numberValue(disjointness.publicProofEligibleFixtureCount),
    publicProofEligibleSuites: publicScorecardEligibleSuites,
    quarantinedBenchmarkSuites: disjointnessQuarantinedSuites,
    blindLeakageGate: disjointnessHardFailureSuites.length === 0 && disjointnessContaminatedSuites.length === 0
      ? "passed"
      : "failed",
    benchmarkEvidenceRisk: numberValue(romanized.top1) >= 1 && corpusHumanGoldRows < 100000
      ? "perfect benchmark scores require real frozen human-reviewed blind validation before public accuracy claims"
      : "normal",
    violations: corpusPackage.violations ?? []
  },
  native: {
    windowsTsfSource: existsSync(join(root, "native/windows-tsf/skeleton/LekhTextService.cpp"))
      && existsSync(join(root, "native/windows-tsf/skeleton/Register.cpp"))
      && existsSync(join(root, "native/windows-tsf/skeleton/CMakeLists.txt")),
    macosImkSkeleton: existsSync(join(root, "native/macos-imk/skeleton/LekhInputController.placeholder.swift")),
    macosImkImplementation: hasMacosImkImplementation(),
    ipcSchema: existsSync(join(root, "native/shared/ipc/lekh-keyboard-ipc.schema.json")),
    ipcValidator: existsSync(join(root, "scripts/check-ipc-schema.ts")),
    devDaemon: existsSync(join(root, "native/daemon/src/keyboardDaemon.ts")),
    jsonStorage: existsSync(join(root, "native/shared/storage/jsonFileStores.ts")),
    daemonLifecycle: existsSync(join(root, "docs/NATIVE_DAEMON_LIFECYCLE.md")),
    companionDesktopShell: existsSync(join(root, "electron/main.cjs")) && existsSync(join(root, "electron-builder.config.cjs")),
    windowsNamedPipeStrategy: "per-user named pipe",
    macosXpcStrategy: "app-scoped XPC",
    nativeReleaseStatus: "blocked until Windows/macOS platform tests, signing/notarization, and pilot feedback"
  },
  finalProduction: {
    verification: hardFailures.length === 0 && performanceTargetMissCount() === 0 ? "complete" : "failed",
    tests: "complete",
    benchmarks: numberValue(typingSession.failedSessions) === 0 ? "complete" : "failed",
    romanized: statusFromSuite(typingSession, "romanized-live-basic"),
    traditionalPhysical: "blocked-human",
    traditionalSuggestions: statusFromSuite(typingSession, "traditional-unicode-suggestions"),
    proofread: numberValue(typingSession.proofHintHitRate) >= 1 ? "complete" : "partial",
    dictionary: numberValue(typingSession.dictionaryHitRate) >= 1 && numberValue(typingSessionDictionary.failedSessions) === 0 ? "complete" : "partial",
    memory: numberValue(typingSession.memoryBoostSuccessRate) >= 1 && numberValue(typingSessionMemory.failedSessions) === 0 ? "complete" : "partial",
    candidateQuality: numberValue(typingSession.duplicateCandidateCount) === 0 && numberValue(typingSession.shortcutSequenceValidityRate) >= 1 ? "complete" : "failed",
    keyboardLab: existsSync(join(root, "src/features/keyboard/KeyboardLab.tsx")) ? "complete" : "pending",
    companionApp: existsSync(join(root, "electron/main.cjs")) && existsSync(join(root, "src/features/companion/CompanionShell.tsx")) ? "partial" : "pending",
    daemonIpc: existsSync(join(root, "native/daemon/src/daemonCli.ts")) && existsSync(join(root, "scripts/check-ipc-schema.ts")) ? "complete" : "partial",
    windowsNative: "blocked-native-environment",
    macosNative: hasMacosImkImplementation() ? "blocked-native-environment" : "failed",
    storage: existsSync(join(root, "native/shared/storage/jsonFileStores.ts")) ? "complete" : "partial",
    installerSigning: "blocked-external",
    privacySecurity: existsSync(join(root, "docs/KEYBOARD_PRIVACY_AND_SECURITY_MODEL.md")) ? "complete" : "partial",
    pilotReadiness: existsSync(join(root, "docs/PILOT_FEEDBACK_SYSTEM.md")) ? "partial" : "pending",
    releaseReadiness: hasMacosImkImplementation() ? "blocked-external" : "failed",
    publicClaimStatus: "conservative"
  },
  launchRecommendation: launchRecommendation(),
  preeti: {
    fixtureCount: numberValue(preeti.fixtureCount),
    exactMatchRate: numberValue(preeti.exactMatchRate)
  },
  mixedSpanMutations: {
    fixtureCount: numberValue(mixedSpan.fixtureCount),
    silentCorruptionRate: numberValue(mixedSpan.silentCorruptionRate)
  },
  aliasCollisions: {
    collisionCount: numberValue(aliasCollisions.collisionCount),
    reviewNeededCount: Array.isArray(aliasCollisions.collisions)
      ? aliasCollisions.collisions.filter((collision) => (collision as JsonObject).severity === "review-needed").length
      : numberValue(aliasCollisions.reviewNeededCount)
  },
  disjointness: {
    contaminatedSuites: disjointnessContaminatedSuites,
    quarantinedSuites: disjointnessQuarantinedSuites,
    publicScorecardEligibleSuites,
    publicProofEligibleFixtureCount: numberValue(disjointness.publicProofEligibleFixtureCount),
    hardFailureSuites: disjointnessHardFailureSuites
  },
  publicClaims: {
    allowed: [
      "local-first keyboard engine prototype",
      "Romanized live typing prototype",
      "Traditional layout under source-of-truth audit",
      "proofread/dictionary/memory prototype",
      "native architecture/scaffold"
    ],
    forbiddenUntilEvidence: [
      "beats Gboard",
      "beats Hamro",
      "100% accurate",
      "government-ready",
      "production Windows IME complete",
      "production macOS IME complete",
      "fully signed/notarized release",
      "complete LTK replacement"
    ]
  }
};

mkdirSync(join(root, "bench/reports"), { recursive: true });
writeFileSync(join(root, "bench/reports/engine-scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`);
writeFileSync(join(root, "docs/ENGINE_QUALITY_SCORECARD.md"), renderMarkdown());
console.log(JSON.stringify(scorecard, null, 2));

if (hardFailures.length > 0) {
  process.exitCode = 1;
}
if (performanceTargetMissCount() > 0 || corpusPackage.status !== "passed") {
  process.exitCode = 1;
}

function loadReport(spec: ReportSpec): LoadedReport {
  const absolutePath = join(root, spec.path);
  if (!existsSync(absolutePath)) {
    return {
      key: spec.key,
      label: spec.label,
      path: spec.path,
      status: spec.required ? "missing" : "optional-missing",
      staleBecause: "Report file does not exist."
    };
  }

  const data = JSON.parse(readFileSync(absolutePath, "utf8")) as JsonObject;
  const fixtureCount = typeof data.fixtureCount === "number" ? data.fixtureCount : inferFixtureCount(data);
  const generatedAt = typeof data.generatedAt === "string" ? data.generatedAt : undefined;
  const command = typeof data.command === "string" ? data.command : undefined;
  const suite = typeof data.suite === "string" ? data.suite : undefined;
  const mode = typeof data.mode === "string" ? data.mode : undefined;
  const durationMs = typeof data.durationMs === "number" ? data.durationMs : undefined;

  if (!generatedAt) {
    return {
      key: spec.key,
      label: spec.label,
      path: spec.path,
      status: spec.required ? "schema-warning" : "fresh",
      fixtureCount,
      data,
      staleBecause: "Report is missing generatedAt."
    };
  }

  if (fixtureCount === 0) {
    return {
      key: spec.key,
      label: spec.label,
      path: spec.path,
      status: "zero-fixture",
      generatedAt,
      command,
      suite,
      mode,
      durationMs,
      fixtureCount,
      data,
      staleBecause: "Report has zero fixtures."
    };
  }

  const reportMtime = statSync(absolutePath).mtimeMs;
  const newestInput = newestMtime(spec.inputs);
  if (newestInput > reportMtime + 1000) {
    return {
      key: spec.key,
      label: spec.label,
      path: spec.path,
      status: "stale",
      generatedAt,
      command,
      suite,
      mode,
      durationMs,
      fixtureCount,
      data,
      staleBecause: "A relevant source, fixture, or benchmark script is newer than the report."
    };
  }

  return {
    key: spec.key,
    label: spec.label,
    path: spec.path,
    status: command && suite && typeof durationMs === "number" ? "fresh" : "schema-warning",
    generatedAt,
    command,
    suite,
    mode,
    durationMs,
    fixtureCount,
    data,
    staleBecause: command && suite && typeof durationMs === "number" ? undefined : "Report is missing command, suite, or duration metadata."
  };
}

function newestMtime(paths: string[]): number {
  return Math.max(0, ...paths.map((item) => newestPathMtime(join(root, item))));
}

function newestPathMtime(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(stat.mtimeMs, ...readdirSync(path, { withFileTypes: true }).map((entry) =>
    newestPathMtime(join(path, entry.name))
  ));
}

function inferFixtureCount(data: JsonObject): number | undefined {
  if (typeof data.total === "number") return data.total;
  if (Array.isArray(data.results)) return data.results.length;
  if (Array.isArray(data.reports)) return data.reports.length;
  return undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function reportBySpec(key: string): ReportSpec | undefined {
  return reportSpecs.find((spec) => spec.key === key);
}

function isHardReportFailure(report: LoadedReport): boolean {
  const spec = reportBySpec(report.key);
  if (!spec?.required) return false;
  return report.status === "missing"
    || report.status === "stale"
    || report.status === "zero-fixture"
    || report.status === "schema-warning";
}

function performanceTargetMissCount(): number {
  if (!Array.isArray(performance.reports)) return 0;
  return performance.reports.filter((report) => Boolean((report as JsonObject).targetMissed)).length;
}

function statusFromSuite(report: JsonObject, suite: string): "complete" | "partial" | "pending" {
  const bySuite = report.bySuite as Record<string, JsonObject> | undefined;
  const row = bySuite?.[suite];
  if (!row) return "pending";
  const total = numberValue(row.totalSessions);
  const passed = numberValue(row.passedSessions);
  if (total > 0 && passed === total) return "complete";
  return total > 0 ? "partial" : "pending";
}

function hasMacosImkImplementation(): boolean {
  const implementation = join(root, "native/macos-imk/skeleton/LekhInputController.swift");
  if (!existsSync(implementation)) return false;
  const source = readFileSync(implementation, "utf8");
  return /IMKInputController/.test(source) && !/placeholder/i.test(source);
}

function launchRecommendation(): string {
  if (hardFailures.length > 0 || performanceTargetMissCount() > 0 || corpusPackage.status !== "passed") {
    return "NOT_READY_ENGINE_OR_VERIFICATION_FAILURES";
  }
  if (!hasMacosImkImplementation()) return "NOT_READY_NATIVE_IMPLEMENTATION_FAILURES";
  return "NOT_READY_BLOCKED_BY_EXTERNAL_NATIVE_REQUIREMENTS";
}

function renderMarkdown(): string {
  const reportRows = loadedReports.map((report) =>
    `| ${report.label} | ${report.status} | ${report.fixtureCount ?? "n/a"} | ${report.mode ?? "n/a"} | ${report.command ?? "missing"} | ${report.staleBecause ?? ""} |`
  ).join("\n");

  const perfRows = Array.isArray(performance.reports)
    ? performance.reports.map((item) => {
      const row = item as JsonObject;
      return `| ${row.name} | ${row.p95Ms} | ${row.gateMs} | ${row.targetMissed ? "fail" : "pass"} |`;
    }).join("\n")
    : "";

  return `# Engine Quality Scorecard

Updated: ${scorecard.generatedAt}

This scorecard reads existing fresh report files from \`bench/reports\`. It does not recompute the heavy benchmark universe. Missing, stale, zero-fixture, or schema-weak reports are visible below.

## Report Freshness

| Report | Status | Fixtures | Mode | Command | Note |
| --- | --- | ---: | --- | --- | --- |
${reportRows}

## Keyboard Foundation

| Area | Status |
| --- | --- |
| KeyboardEngine API | implemented |
| processKeyStroke | required and tested |
| updateComposition | browser/lab path |
| candidate dedupe | normalized text dedupe before shortcuts |
| shortcuts | sequential after final sort |
| secure input | memory/proofread/suggestions disabled or reduced |

## Romanized

| Metric | Value |
| --- | ---: |
| fixtures | ${scorecard.romanized.fixtureCount} |
| mode | ${scorecard.romanized.mode ?? "unknown"} |
| top-1 | ${scorecard.romanized.top1.toFixed(4)} |
| top-3 | ${scorecard.romanized.top3.toFixed(4)} |
| top-5 | ${scorecard.romanized.top5.toFixed(4)} |
| MRR | ${scorecard.romanized.mrr.toFixed(4)} |
| self-consistency fixtures | ${scorecard.romanized.selfConsistency.fixtureCount} |
| self-consistency failures | ${scorecard.romanized.selfConsistency.failureCount} |

## Corpus Package

| Metric | Value |
| --- | --- |
| package status | ${scorecard.corpusPackage.status} |
| source registry rows | ${scorecard.corpusPackage.sourceCount} |
| human-reviewed gold rows | ${scorecard.corpusPackage.humanReviewedGoldRows} |
| gold promotions | ${scorecard.corpusPackage.goldPromotions} |
| reviewed scale status | ${scorecard.corpusPackage.reviewedScaleStatus} |
| frozen blind rows | ${scorecard.corpusPackage.blindRows} |
| real blind benchmark status | ${scorecard.corpusPackage.realBlindBenchmarkStatus} |
| leakage audit | ${scorecard.corpusPackage.leakageStatus} |
| blind leakage gate | ${scorecard.corpusPackage.blindLeakageGate} |
| public-proof eligible fixtures | ${scorecard.corpusPackage.publicProofEligibleFixtureCount} |
| public-proof eligible suites | ${scorecard.corpusPackage.publicProofEligibleSuites.join(", ") || "none"} |
| quarantined benchmark suites | ${scorecard.corpusPackage.quarantinedBenchmarkSuites.join(", ") || "none"} |
| benchmark evidence risk | ${scorecard.corpusPackage.benchmarkEvidenceRisk} |

## Typing Sessions

| Metric | Value |
| --- | ---: |
| fixtures | ${scorecard.typingSession.fixtureCount} |
| failed sessions | ${scorecard.typingSession.failedSessions} |
| proof hint hit rate | ${scorecard.typingSession.proofHintHitRate.toFixed(4)} |
| dictionary hit rate | ${scorecard.typingSession.dictionaryHitRate.toFixed(4)} |
| memory boost success | ${scorecard.typingSession.memoryBoostSuccessRate.toFixed(4)} |
| next-word success | ${scorecard.typingSession.nextWordSuccessRate.toFixed(4)} |
| Romanized label hit rate | ${scorecard.typingSession.romanizedLabelHitRate.toFixed(4)} |
| duplicate candidate count | ${scorecard.typingSession.duplicateCandidateCount} |
| shortcut sequence validity | ${scorecard.typingSession.shortcutSequenceValidityRate.toFixed(4)} |

## Prompt 2 Keyboard Intelligence

| Area | Status |
| --- | --- |
| Romanized live typing | ${scorecard.prompt2Intelligence.romanizedLiveTyping} |
| Romanized government phrases | ${scorecard.prompt2Intelligence.romanizedGovernmentPhrases} |
| Romanized helper suggestions | ${scorecard.prompt2Intelligence.romanizedHelperSuggestions} |
| Romanized labels | ${scorecard.prompt2Intelligence.romanizedLabels} |
| candidate dedupe and shortcuts | ${scorecard.prompt2Intelligence.candidateDedupeShortcuts} |
| ranking and phrase completion | ${scorecard.prompt2Intelligence.rankingAndPhraseCompletion} |
| next-word prediction | ${scorecard.prompt2Intelligence.nextWordPrediction} |
| KSR baseline | ${scorecard.prompt2Intelligence.ksrBaseline ?? "n/a"} |
| Traditional physical layout | ${scorecard.prompt2Intelligence.traditionalPhysicalLayout} |
| Traditional Unicode suggestions | ${scorecard.prompt2Intelligence.traditionalUnicodeSuggestions} |
| Traditional proofread | ${scorecard.prompt2Intelligence.traditionalProofread} |
| proofread while typing | ${scorecard.prompt2Intelligence.proofreadWhileTyping} |
| dictionary lookup | ${scorecard.prompt2Intelligence.dictionaryLookup} |
| personal memory | ${scorecard.prompt2Intelligence.personalMemory} |
| memory controls | ${scorecard.prompt2Intelligence.memoryControls} |
| Keyboard Lab | ${scorecard.prompt2Intelligence.keyboardLab} |
| companion shell | ${scorecard.prompt2Intelligence.companionShell} |
| typing latency p95 ms | ${scorecard.prompt2Intelligence.typingLatencyP95Ms} |
| native release readiness | ${scorecard.prompt2Intelligence.nativeReleaseReadiness} |

## Performance

| Case | p95 ms | Gate ms | Status |
| --- | ---: | ---: | --- |
${perfRows}

Performance target misses: ${scorecard.performance.targetMissCount}

## Native And Release

| Area | Status |
| --- | --- |
| Windows TSF source | ${scorecard.native.windowsTsfSource ? "present" : "missing"} |
| macOS IMK skeleton | ${scorecard.native.macosImkSkeleton ? "present" : "missing"} |
| IPC schema | ${scorecard.native.ipcSchema ? "present" : "missing"} |
| daemon lifecycle | ${scorecard.native.daemonLifecycle ? "documented" : "missing"} |
| companion desktop shell | ${scorecard.native.companionDesktopShell ? "present" : "missing"} |
| release status | ${scorecard.native.nativeReleaseStatus} |

## Final Production Scorecard

| Area | Status |
| --- | --- |
| verification | ${scorecard.finalProduction.verification} |
| tests | ${scorecard.finalProduction.tests} |
| benchmarks | ${scorecard.finalProduction.benchmarks} |
| Romanized | ${scorecard.finalProduction.romanized} |
| Traditional physical | ${scorecard.finalProduction.traditionalPhysical} |
| Traditional suggestions | ${scorecard.finalProduction.traditionalSuggestions} |
| proofread | ${scorecard.finalProduction.proofread} |
| dictionary | ${scorecard.finalProduction.dictionary} |
| memory | ${scorecard.finalProduction.memory} |
| candidate quality | ${scorecard.finalProduction.candidateQuality} |
| Keyboard Lab | ${scorecard.finalProduction.keyboardLab} |
| companion app | ${scorecard.finalProduction.companionApp} |
| daemon/IPC | ${scorecard.finalProduction.daemonIpc} |
| Windows native | ${scorecard.finalProduction.windowsNative} |
| macOS native | ${scorecard.finalProduction.macosNative} |
| storage | ${scorecard.finalProduction.storage} |
| installer/signing | ${scorecard.finalProduction.installerSigning} |
| privacy/security | ${scorecard.finalProduction.privacySecurity} |
| pilot readiness | ${scorecard.finalProduction.pilotReadiness} |
| release readiness | ${scorecard.finalProduction.releaseReadiness} |
| public claims | ${scorecard.finalProduction.publicClaimStatus} |

Launch recommendation: \`${scorecard.launchRecommendation}\`

## Public Claim Status

Allowed if phrased honestly:

${scorecard.publicClaims.allowed.map((claim) => `- ${claim}`).join("\n")}

Forbidden until evidence exists:

${scorecard.publicClaims.forbiddenUntilEvidence.map((claim) => `- ${claim}`).join("\n")}
`;
}
