import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKeyboardEngine, defaultTypingContext } from "../src/engine/keyboard";
import type { CandidateUpdate, KeyboardKeyEvent, KeyboardMode } from "../src/engine/keyboard";
import { nowMs } from "../src/engine/util/time";

interface TypingSessionFixture {
  id: string;
  suite?: string;
  mode: KeyboardMode;
  keystrokes?: string[];
  input?: string;
  dictionaryQuery?: string;
  memoryTrain?: {
    input: string;
    candidateText: string;
    pinned?: boolean;
    blocked?: boolean;
  };
  secureInput?: boolean;
  showRomanizedLabels?: boolean;
  commitInput?: string;
  expectedTopCandidates?: string[];
  expectedCandidateIncludes?: string[];
  expectedCandidateExcludes?: string[];
  expectedLabels?: string[];
  expectedPrimaryPrefix?: string;
  expectedProofHints?: string[];
  expectedDictionaryWords?: string[];
  expectedFollowups?: string[];
  expectedAction: "candidates" | "placeholder" | "lookup" | "proofread" | "memory" | "next-word";
  notes: string;
}

interface SessionResult {
  id: string;
  mode: KeyboardMode;
  passed: boolean;
  top1Hit: boolean;
  top3Hit: boolean;
  primaryPrefixHit: boolean;
  finalDisplayText: string;
  candidateTexts: string[];
  latencyMs: number[];
  commitLatencyMs: number;
  keystrokeSavingsRatio: number | null;
  warnings: string[];
  suite: string;
  proofHintHit: boolean;
  dictionaryHit: boolean;
  memoryBoostHit: boolean;
  nextWordHit: boolean;
  labelHit: boolean;
  labelExpectationCount: number;
  duplicateCandidateCount: number;
  shortcutSequenceValid: boolean;
  failureReason?: string;
}

const FIXTURES = [
  "bench/fixtures/typing-session/romanized-basic.jsonl",
  "bench/fixtures/typing-session/romanized-government.jsonl",
  "bench/fixtures/typing-session/traditional-placeholder.jsonl",
  "bench/fixtures/typing-session/romanized-live-basic.jsonl",
  "bench/fixtures/typing-session/romanized-live-government.jsonl",
  "bench/fixtures/typing-session/romanized-helper.jsonl",
  "bench/fixtures/typing-session/romanized-protected.jsonl",
  "bench/fixtures/typing-session/traditional-unicode-suggestions.jsonl",
  "bench/fixtures/typing-session/proofread-live.jsonl",
  "bench/fixtures/typing-session/dictionary-lookup.jsonl",
  "bench/fixtures/typing-session/memory-ranking.jsonl",
  "bench/fixtures/typing-session/next-word.jsonl"
];

export function runTypingSessionBenchmark() {
  const start = Date.now();
  const suiteFilter = parseSuiteFilter();
  const fixtures = FIXTURES.flatMap(readJsonl).filter((fixture) => {
    if (suiteFilter.length === 0) return true;
    return suiteFilter.includes(fixture.suite ?? inferSuite(fixture));
  });
  if (fixtures.length === 0) {
    throw new Error("Typing-session benchmark has zero fixtures.");
  }

  const results = fixtures.map(runFixture);
  const romanized = results.filter((result) => result.mode === "romanized");
  const traditionalPlaceholder = results.filter((result) => result.mode === "traditional");
  const bySuite = summarizeBySuite(results);
  const failures = results.filter((result) => !result.passed);
  const allLatencies = results.flatMap((result) => result.latencyMs);
  const commitLatencies = results.map((result) => result.commitLatencyMs);

  const report = {
    generatedAt: new Date().toISOString(),
    command: suiteFilter.length === 0 ? "npm run benchmark:typing-session" : `npm run benchmark:typing-session -- ${suiteFilter.join(",")}`,
    suite: suiteFilter.length === 0 ? "typing-session" : `typing-session:${suiteFilter.join(",")}`,
    mode: "full",
    durationMs: Date.now() - start,
    fixtureCount: fixtures.length,
    romanized: summarize(romanized),
    traditionalPlaceholder: summarize(traditionalPlaceholder),
    bySuite,
    latency: {
      candidateP50Ms: percentile(allLatencies, 0.5),
      candidateP95Ms: percentile(allLatencies, 0.95),
      updateP95Ms: percentile(allLatencies, 0.95),
      commitP95Ms: percentile(commitLatencies, 0.95)
    },
    keystrokeSavingsRatioMean: mean(results.map((result) => result.keystrokeSavingsRatio).filter((value): value is number => value !== null)),
    proofHintHitRate: suiteHitRate(results, "proofread-live", "proofHintHit"),
    dictionaryHitRate: suiteHitRate(results, "dictionary-lookup", "dictionaryHit"),
    memoryBoostSuccessRate: suiteHitRate(results, "memory-ranking", "memoryBoostHit"),
    nextWordSuccessRate: suiteHitRate(results, "next-word", "nextWordHit"),
    romanizedLabelHitRate: ratio(
      results.filter((result) => result.mode === "romanized" && result.labelExpectationCount > 0 && result.labelHit).length,
      results.filter((result) => result.mode === "romanized" && result.labelExpectationCount > 0).length
    ),
    duplicateCandidateCount: results.reduce((sum, result) => sum + result.duplicateCandidateCount, 0),
    shortcutSequenceValidityRate: ratio(results.filter((result) => result.shortcutSequenceValid).length, results.length),
    failedSessions: failures.length,
    warnings: Array.from(new Set(results.flatMap((result) => result.warnings))),
    failures,
    results
  };

  const reportPath = process.env.LEKH_TYPING_SESSION_REPORT ??
    (suiteFilter.length === 0
      ? "bench/reports/typing-session-report.json"
      : `bench/reports/typing-session-${suiteFilter.join("-")}-report.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.env.LEKH_BENCHMARK_CLI === "1" && process.env.LEKH_BENCHMARK_IMPORT !== "1") {
  const report = runTypingSessionBenchmark();
  console.log(JSON.stringify(report, null, 2));
  if (report.failedSessions > 0) {
    process.exitCode = 1;
  }
}

function runFixture(fixture: TypingSessionFixture): SessionResult {
  const engine = createKeyboardEngine();
  const context = {
    ...defaultTypingContext(fixture.mode),
    showRomanizedLabels: fixture.showRomanizedLabels ?? true,
    secureInput: fixture.secureInput ?? false
  };
  const sessionId = engine.beginSession({
    ...context,
    activeDomains: fixture.mode === "romanized" ? ["government"] : [],
    preserveEnglish: true
  });
  let update: CandidateUpdate = engine.updateComposition(sessionId, "", 0);
  const latencyMs: number[] = [];

  if (fixture.memoryTrain) {
    if (fixture.memoryTrain.pinned || fixture.memoryTrain.blocked) {
      engine.learnCorrection({
        inputRomanized: fixture.memoryTrain.input,
        chosenOutput: fixture.memoryTrain.candidateText,
        source: "user-add-dictionary",
        frequency: fixture.memoryTrain.pinned ? 3 : 1,
        pinned: fixture.memoryTrain.pinned,
        blocked: fixture.memoryTrain.blocked
      });
    } else {
      const trained = engine.updateComposition(sessionId, fixture.memoryTrain.input, fixture.memoryTrain.input.length);
      const selected = trained.candidates.find((candidate) => candidate.text === fixture.memoryTrain?.candidateText);
      if (selected) engine.commitCandidate(sessionId, selected.id);
    }
  }

  if (fixture.dictionaryQuery) {
    const rows = engine.lookupDictionary(fixture.dictionaryQuery, context);
    const dictionaryHit = (fixture.expectedDictionaryWords ?? []).every((word) => rows.some((row) => row.word === word));
    return resultFromFixture(fixture, update, [], 0, null, {
      dictionaryHit,
      candidateTexts: rows.map((row) => row.word),
      passedOverride: dictionaryHit
    });
  }

  const input = fixture.input ?? (fixture.keystrokes ?? []).join("");
  const useNativeKeystrokePath = Boolean(fixture.keystrokes) && !isFullSpanCompositionFixture(fixture);
  if (useNativeKeystrokePath && fixture.keystrokes) {
    for (const stroke of fixture.keystrokes) {
      update = engine.processKeyStroke(sessionId, keyEvent(stroke));
      if (typeof update.latencyMs === "number") latencyMs.push(update.latencyMs);
    }
  } else {
    update = engine.updateComposition(sessionId, input, input.length);
    if (typeof update.latencyMs === "number") latencyMs.push(update.latencyMs);
  }

  const commitStart = nowMs();
  const committed = update.primary ? engine.commitCandidate(sessionId, update.primary.id) : engine.commitRaw(sessionId);
  const commitLatencyMs = nowMs() - commitStart;
  return resultFromFixture(fixture, update, latencyMs, commitLatencyMs, committed.committedText, {
    followups: committed.followupCandidates?.map((candidate) => candidate.text) ?? []
  });
}

function isFullSpanCompositionFixture(fixture: TypingSessionFixture): boolean {
  return fixture.mode === "romanized" &&
    fixture.expectedAction === "candidates" &&
    Boolean(fixture.keystrokes?.some((stroke) => /\s/.test(stroke)));
}

function resultFromFixture(
  fixture: TypingSessionFixture,
  update: CandidateUpdate,
  latencyMs: number[],
  commitLatencyMs: number,
  committedText: string | null,
  extra: {
    dictionaryHit?: boolean;
    candidateTexts?: string[];
    followups?: string[];
    passedOverride?: boolean;
  } = {}
): SessionResult {
  const candidateTexts = update.candidates.map((candidate) => candidate.text);
  const measuredCandidates = extra.candidateTexts ?? candidateTexts;
  const expectedTopCandidates = fixture.expectedTopCandidates ?? [];
  const expectedCandidateExcludes = fixture.expectedCandidateExcludes ?? [];
  const expectedLabels = fixture.expectedLabels ?? [];
  const top1Hit = expectedTopCandidates.length === 0 || expectedTopCandidates.includes(measuredCandidates[0] ?? "");
  const top3Hit = expectedTopCandidates.length === 0 || measuredCandidates.slice(0, 3).some((candidate) => expectedTopCandidates.includes(candidate));
  const inclusionHit = (fixture.expectedCandidateIncludes ?? []).every((candidate) => measuredCandidates.includes(candidate));
  const exclusionHit = expectedCandidateExcludes.every((candidate) => !measuredCandidates.includes(candidate));
  const candidateLabels = update.candidates.map((candidate) => candidate.label).filter((label): label is string => Boolean(label));
  const labelHit = expectedLabels.length === 0 || expectedLabels.every((label) => candidateLabels.includes(label));
  const duplicateCandidateCount = measuredCandidates.length - new Set(measuredCandidates).size;
  const shortcutSequenceValid = update.candidates.every((candidate, index) => candidate.shortcut === String(index + 1));
  const primaryPrefixHit = !fixture.expectedPrimaryPrefix || update.displayText.startsWith(fixture.expectedPrimaryPrefix);
  const placeholderOk = fixture.expectedAction !== "placeholder" || update.warnings.some((warning) => /Traditional layout mapping pending/.test(warning));
  const expectedProofHints = fixture.expectedProofHints ?? [];
  const expectedFollowups = fixture.expectedFollowups ?? [];
  const proofHintHit = expectedProofHints.length > 0 &&
    expectedProofHints.every((suggestion) => update.proofHints.some((hint) => hint.suggestion === suggestion));
  const dictionaryHit = extra.dictionaryHit ?? false;
  const memoryBoostHit = fixture.expectedAction === "memory" && update.candidates[0]?.type === "personal";
  const nextWordHit = expectedFollowups.length > 0 &&
    expectedFollowups.every((text) => (extra.followups ?? []).includes(text));
  const specialOk =
    (fixture.expectedProofHints?.length ? proofHintHit : true) &&
    (fixture.expectedAction === "lookup" ? dictionaryHit : true) &&
    (fixture.expectedAction === "memory" ? memoryBoostHit : true) &&
    (fixture.expectedFollowups?.length ? nextWordHit : true);
  const passed = extra.passedOverride ?? (
    top1Hit &&
    top3Hit &&
    inclusionHit &&
    exclusionHit &&
    labelHit &&
    duplicateCandidateCount === 0 &&
    shortcutSequenceValid &&
    primaryPrefixHit &&
    placeholderOk &&
    specialOk
  );
  return {
    id: fixture.id,
    suite: fixture.suite ?? inferSuite(fixture),
    mode: fixture.mode,
    passed,
    top1Hit,
    top3Hit,
    primaryPrefixHit,
    finalDisplayText: update.displayText,
    candidateTexts: measuredCandidates,
    latencyMs,
    commitLatencyMs,
    keystrokeSavingsRatio: committedText && (fixture.keystrokes?.length ?? fixture.input?.length)
      ? 1 - (((fixture.keystrokes?.length ?? fixture.input?.length) ?? 0) / Array.from(committedText).length)
      : null,
    warnings: update.warnings,
    proofHintHit,
    dictionaryHit,
    memoryBoostHit,
    nextWordHit,
    labelHit,
    labelExpectationCount: expectedLabels.length,
    duplicateCandidateCount,
    shortcutSequenceValid,
    failureReason: passed ? undefined : `Expected top ${expectedTopCandidates.join(", ") || "(none)"}, includes ${(fixture.expectedCandidateIncludes ?? []).join(", ") || "(none)"}, excludes ${expectedCandidateExcludes.join(", ") || "(none)"}, labels ${expectedLabels.join(", ") || "(none)"}, prefix ${fixture.expectedPrimaryPrefix ?? "(none)"}`
  };
}

function readJsonl(path: string): TypingSessionFixture[] {
  return readFileSync(join(process.cwd(), path), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TypingSessionFixture);
}

function parseSuiteFilter(): string[] {
  return (process.env.LEKH_TYPING_SESSION_SUITE ?? "")
    .split(",")
    .map((suite) => suite.trim())
    .filter(Boolean);
}

function keyEvent(value: string): KeyboardKeyEvent {
  return {
    key: value,
    code: value === " " ? "Space" : value.length === 1 ? `Key${value.toUpperCase()}` : value,
    modifiers: { shift: /[A-Z]/.test(value), ctrl: false, alt: false, meta: false },
    timestamp: nowMs(),
    platform: "test"
  };
}

function summarize(items: SessionResult[]) {
  return {
    totalSessions: items.length,
    top1HitRate: ratio(items.filter((item) => item.top1Hit).length, items.length),
    top3HitRate: ratio(items.filter((item) => item.top3Hit).length, items.length),
    failedSessions: items.filter((item) => !item.passed).length,
    placeholderSessions: items.filter((item) =>
      item.warnings.some((warning) => /Traditional layout mapping pending/.test(warning))
    ).length
  };
}

function summarizeBySuite(items: SessionResult[]) {
  const suites = Array.from(new Set(items.map((item) => item.suite))).sort();
  return Object.fromEntries(suites.map((suite) => {
    const rows = items.filter((item) => item.suite === suite);
    return [suite, {
      totalSessions: rows.length,
      passedSessions: rows.filter((row) => row.passed).length,
      top1HitRate: ratio(rows.filter((row) => row.top1Hit).length, rows.length),
      top3HitRate: ratio(rows.filter((row) => row.top3Hit).length, rows.length),
      failedSessions: rows.filter((row) => !row.passed).length
    }];
  }));
}

function inferSuite(fixture: TypingSessionFixture): string {
  if (fixture.expectedAction === "lookup") return "dictionary-lookup";
  if (fixture.expectedAction === "proofread") return "proofread-live";
  if (fixture.expectedAction === "memory") return "memory-ranking";
  if (fixture.expectedAction === "next-word") return "next-word";
  if (fixture.expectedAction === "placeholder") return "traditional-placeholder";
  return "romanized-live";
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function suiteHitRate(items: SessionResult[], suite: string, key: "proofHintHit" | "dictionaryHit" | "memoryBoostHit" | "nextWordHit"): number {
  const rows = items.filter((item) => item.suite === suite);
  return ratio(rows.filter((row) => row[key]).length, rows.length);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
