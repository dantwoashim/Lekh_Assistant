import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const REPORT_PATH = path.join(ROOT, "bench", "reports", "typing-session-report.json");
const OUT_DIR = path.join(ROOT, "data", "keyboard-corpus", "review", "v0.1");
const OUT_JSON = path.join(OUT_DIR, "benchmark_failure_buckets.json");
const OUT_QUEUE = path.join(OUT_DIR, "benchmark_failure_review_queue.jsonl");

fs.mkdirSync(OUT_DIR, { recursive: true });

const report = fs.existsSync(REPORT_PATH)
  ? JSON.parse(fs.readFileSync(REPORT_PATH, "utf8"))
  : { generatedAt: null, failures: [], results: [], failedSessions: 0 };

const failures = Array.isArray(report.failures)
  ? report.failures
  : Array.isArray(report.results)
    ? report.results.filter((row) => !row.passed)
    : [];

const buckets = {};
const queue = [];

for (const failure of failures) {
  const bucket = classifyFailure(failure);
  buckets[bucket] ??= { count: 0, examples: [] };
  buckets[bucket].count += 1;
  if (buckets[bucket].examples.length < 20) {
    buckets[bucket].examples.push({
      id: failure.id,
      suite: failure.suite,
      mode: failure.mode,
      finalDisplayText: failure.finalDisplayText,
      candidates: failure.candidateTexts?.slice?.(0, 8) ?? [],
      failureReason: failure.failureReason,
    });
  }
  queue.push({
    queueId: `bench_review_${String(queue.length + 1).padStart(6, "0")}`,
    fixtureId: failure.id,
    suite: failure.suite,
    bucket,
    priority: priorityFor(bucket),
    action: actionFor(bucket),
    dataPackVersion: "keyboard-pack-v0.1",
    candidateTexts: failure.candidateTexts?.slice?.(0, 8) ?? [],
    finalDisplayText: failure.finalDisplayText,
    notes: "Review failure, update data/ranking, compile new data pack version, rerun benchmark.",
  });
}

const summary = {
  generatedAt: new Date().toISOString(),
  sourceReport: path.relative(ROOT, REPORT_PATH),
  reportGeneratedAt: report.generatedAt ?? null,
  failedSessions: failures.length,
  buckets,
  loop: [
    "benchmark",
    "failure buckets",
    "review queue",
    "data/ranking update",
    "new data pack version",
    "rerun",
  ],
};

fs.writeFileSync(OUT_JSON, `${JSON.stringify(summary, null, 2)}\n`);
fs.writeFileSync(OUT_QUEUE, `${queue.map((row) => JSON.stringify(row)).join("\n")}${queue.length ? "\n" : ""}`);
console.log(JSON.stringify(summary, null, 2));

function classifyFailure(failure) {
  if ((failure.duplicateCandidateCount ?? 0) > 0) return "candidate-dedupe";
  if (failure.shortcutSequenceValid === false) return "shortcut-sequence";
  if (failure.proofHintHit === false && failure.suite === "proofread-live") return "proofread-miss";
  if (failure.dictionaryHit === false && failure.suite === "dictionary-lookup") return "dictionary-miss";
  if (failure.memoryBoostHit === false && failure.suite === "memory-ranking") return "memory-ranking";
  if (failure.nextWordHit === false && failure.suite === "next-word") return "next-word-miss";
  if (failure.labelHit === false) return "label-miss";
  if (failure.top3Hit === false) return "recall-top3";
  if (failure.top1Hit === false) return "ranking-top1";
  if (failure.primaryPrefixHit === false) return "composition-preview";
  return "unknown";
}

function priorityFor(bucket) {
  if (["candidate-dedupe", "shortcut-sequence", "composition-preview"].includes(bucket)) return "P0";
  if (["recall-top3", "ranking-top1", "proofread-miss", "dictionary-miss", "next-word-miss"].includes(bucket)) return "P1";
  return "P2";
}

function actionFor(bucket) {
  return {
    "candidate-dedupe": "fix candidate merge/dedupe and add regression fixture",
    "shortcut-sequence": "fix shortcut assignment after final sort",
    "proofread-miss": "add or review D5 proofread correction row",
    "dictionary-miss": "add or review D1 dictionary alias row",
    "memory-ranking": "adjust memory boost/ranking guard",
    "next-word-miss": "add or review D7 context row",
    "label-miss": "add or review Romanized label alias",
    "recall-top3": "add missing alias/phrase row and rerank",
    "ranking-top1": "adjust ranking weight or promote row quality",
    "composition-preview": "fix composition/display text logic",
    unknown: "manual triage",
  }[bucket] ?? "manual triage";
}
