import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convert } from "../src/engine";
import type { EngineMode } from "../src/engine/types";
import { assertNonEmptySuite, isDirectCli } from "./lib/cli";
import { generateMixedSpanMutationFixtures } from "./generate-mixed-span-mutation-fixtures";

interface MixedSpanFixture {
  id: string;
  suite: string;
  mode: EngineMode;
  input: string;
  expectedOutput: string;
  expectedAction?: "auto" | "candidates" | "warn" | "preserve" | "refuse";
  expectedPreserved?: string[];
  severity?: string;
  notes?: string;
}

interface MixedSpanFailure {
  id: string;
  input: string;
  expectedOutput: string;
  actualOutput: string;
  category: "output-mismatch" | "protected-corruption" | "silent-corruption" | "action-mismatch";
  action?: string;
}

export interface MixedSpanMutationReport {
  generatedAt: string;
  fixtureCount: number;
  exactOutputRate: number;
  actionMatchRate: number;
  protectedPreservationRate: number;
  silentCorruptionRate: number;
  bySuite: Record<string, {
    fixtureCount: number;
    exactOutputRate: number;
    silentCorruptionRate: number;
  }>;
  failures: MixedSpanFailure[];
}

const root = process.cwd();

export function runMixedSpanMutationBenchmark(): MixedSpanMutationReport {
  generateMixedSpanMutationFixtures();
  const fixtures = loadFixtures();
  assertNonEmptySuite("mixed-span-mutations", fixtures.length);
  const failures: MixedSpanFailure[] = [];
  const bucket = new Map<string, { total: number; exact: number; silent: number }>();
  let exact = 0;
  let actionMatches = 0;
  let preservedTotal = 0;
  let preservedHits = 0;
  let silentCorruptions = 0;

  for (const fixture of fixtures) {
    const result = convert(fixture.input, { mode: fixture.mode, benchmark: true });
    const suite = fixture.suite;
    const stats = bucket.get(suite) ?? { total: 0, exact: 0, silent: 0 };
    stats.total += 1;

    const outputMatches = result.normalizedOutput === fixture.expectedOutput;
    if (outputMatches) {
      exact += 1;
      stats.exact += 1;
    }
    if (!outputMatches) {
      const silent = (result.action ?? "auto") === "auto" && !result.warnings.some((warning) => warning.severity !== "info");
      if (silent) {
        silentCorruptions += 1;
        stats.silent += 1;
      }
      failures.push({
        id: fixture.id,
        input: fixture.input,
        expectedOutput: fixture.expectedOutput,
        actualOutput: result.normalizedOutput,
        category: silent ? "silent-corruption" : "output-mismatch",
        action: result.action
      });
    }

    if (!fixture.expectedAction || result.action === fixture.expectedAction || (fixture.expectedAction === "auto" && result.action === undefined)) {
      actionMatches += 1;
    } else {
      failures.push({
        id: fixture.id,
        input: fixture.input,
        expectedOutput: fixture.expectedOutput,
        actualOutput: result.normalizedOutput,
        category: "action-mismatch",
        action: result.action
      });
    }

    for (const preserved of fixture.expectedPreserved ?? []) {
      preservedTotal += 1;
      if (result.normalizedOutput.includes(preserved)) {
        preservedHits += 1;
      } else {
        failures.push({
          id: fixture.id,
          input: fixture.input,
          expectedOutput: fixture.expectedOutput,
          actualOutput: result.normalizedOutput,
          category: "protected-corruption",
          action: result.action
        });
      }
    }

    bucket.set(suite, stats);
  }

  return {
    generatedAt: new Date().toISOString(),
    fixtureCount: fixtures.length,
    exactOutputRate: exact / fixtures.length,
    actionMatchRate: actionMatches / fixtures.length,
    protectedPreservationRate: preservedTotal === 0 ? 1 : preservedHits / preservedTotal,
    silentCorruptionRate: silentCorruptions / fixtures.length,
    bySuite: Object.fromEntries([...bucket.entries()].map(([suite, stats]) => [suite, {
      fixtureCount: stats.total,
      exactOutputRate: stats.exact / stats.total,
      silentCorruptionRate: stats.silent / stats.total
    }])),
    failures
  };
}

function loadFixtures(): MixedSpanFixture[] {
  return [
    ...readJsonl(join(root, "bench/fixtures/preeti/mixed-unicode-legacy-islands.jsonl")),
    ...readJsonl(join(root, "bench/fixtures/romanized/hostile-heldout/mixed-office-root-cause.jsonl")),
    ...readJsonl(join(root, "bench/fixtures/mixed-span-mutations/generated.jsonl"))
  ];
}

function readJsonl(path: string): MixedSpanFixture[] {
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];
  return raw.split(/\r?\n/).map((line) => JSON.parse(line) as MixedSpanFixture);
}

if (isDirectCli(import.meta.url)) {
  const startedAt = Date.now();
  const report = runMixedSpanMutationBenchmark();
  const reportWithMetadata = {
    ...report,
    command: "npm run benchmark:mixed-span-mutations",
    suite: "mixed-span-mutations",
    mode: "full",
    durationMs: Date.now() - startedAt
  };
  mkdirSync(join(root, "bench/reports"), { recursive: true });
  writeFileSync(join(root, "bench/reports/mixed-span-mutation-report.json"), `${JSON.stringify(reportWithMetadata, null, 2)}\n`);
  console.log(JSON.stringify(reportWithMetadata, null, 2));
  if (report.failures.some((failure) => failure.category === "silent-corruption")) {
    process.exitCode = 1;
  }
}
