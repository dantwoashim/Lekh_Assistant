import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT,
  validateNeuralNativeServiceBenchmarkReport
} from "./neural-native-service-benchmark-evidence.mjs";

const root = process.cwd();

describe("full native neural-service benchmark evidence", () => {
  it("freezes one warm-up plus 48 measured passes over five tokens", () => {
    expect(NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT).toEqual({
      orderedTokens: [
        "prashasan",
        "nagarikta",
        "mantralaya",
        "sambidhan",
        "paryatan"
      ],
      warmupPasses: 1,
      measuredPasses: 48,
      targetP95Ms: 50
    });
    expect(
      NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT.orderedTokens.length *
        NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT.measuredPasses
    ).toBe(240);
  });

  it("accepts only the complete 240-sample steady-state structure", () => {
    expect(
      validateNeuralNativeServiceBenchmarkReport(validReport())
    ).toEqual({
      valid: true,
      issueCodes: []
    });
  });

  for (const [label, mutate, issue] of [
    [
      "legacy three-pass schedule",
      (value) => {
        value.benchmarkPasses = 3;
        value.measuredPasses = 2;
        value.steadyStateSamples = 10;
      },
      "neural-native-service-benchmark.workload-invalid"
    ],
    [
      "placement-capture substitution",
      (value) => {
        value.placementCapture = true;
      },
      "neural-native-service-benchmark.workload-invalid"
    ],
    [
      "reordered workload",
      (value) => {
        value.workloadTokens.reverse();
      },
      "neural-native-service-benchmark.workload-invalid"
    ],
    [
      "missing token stream",
      (value) => {
        delete value.byTokenMs.paryatan;
      },
      "neural-native-service-benchmark.samples-invalid"
    ],
    [
      "short per-token stream",
      (value) => {
        value.byTokenMs.prashasan.pop();
      },
      "neural-native-service-benchmark.samples-invalid"
    ],
    [
      "non-finite sample",
      (value) => {
        value.byTokenMs.prashasan[0] = Number.NaN;
      },
      "neural-native-service-benchmark.samples-invalid"
    ],
    [
      "negative sample",
      (value) => {
        value.byTokenMs.prashasan[0] = -1;
      },
      "neural-native-service-benchmark.samples-invalid"
    ],
    [
      "wrong latency target",
      (value) => {
        value.targetP95Ms = 49;
      },
      "neural-native-service-benchmark.performance-invalid"
    ],
    [
      "missing performance",
      (value) => {
        delete value.performance;
      },
      "neural-native-service-benchmark.performance-invalid"
    ],
    [
      "non-finite performance",
      (value) => {
        value.performance.p95Ms = Number.NaN;
      },
      "neural-native-service-benchmark.performance-invalid"
    ],
    [
      "negative performance",
      (value) => {
        value.performance.p50Ms = -1;
      },
      "neural-native-service-benchmark.performance-invalid"
    ],
    [
      "non-monotonic percentiles",
      (value) => {
        value.performance.p50Ms = 2;
      },
      "neural-native-service-benchmark.performance-invalid"
    ],
    [
      "unlisted performance field",
      (value) => {
        value.performance.meanMs = 1;
      },
      "neural-native-service-benchmark.performance-invalid"
    ],
    [
      "percentiles inconsistent with raw samples",
      (value) => {
        value.performance.p95Ms = 1.1;
        value.performance.p99Ms = 1.1;
      },
      "neural-native-service-benchmark.performance-invalid"
    ]
  ]) {
    it(`rejects ${label}`, () => {
      const report = validReport();
      mutate(report);
      const validation =
        validateNeuralNativeServiceBenchmarkReport(report);
      expect(validation.valid).toBe(false);
      expect(validation.issueCodes).toContain(issue);
    });
  }

  it("binds the Swift producer to 48 full passes and eight capture passes", () => {
    const source = readFileSync(
      join(
        root,
        "native/macos-imk/skeleton/Tests/" +
          "LekhInputMethodBehaviorProbe/main.swift"
      ),
      "utf8"
    );
    expect(source).toContain("let benchmarkWarmupPasses = 1");
    expect(source).toContain(
      "let benchmarkMeasuredPasses = placementCapture ? 8 : 48"
    );
    expect(source).toContain(
      "let benchmarkIterations = benchmarkWarmupPasses + " +
        "benchmarkMeasuredPasses"
    );
  });

  it.skipIf(process.platform === "win32")(
    "makes the benchmark CLI reject a structurally short probe report",
    () => {
      mkdirSync(join(root, ".tmp"), { recursive: true });
      const fixtureRoot = mkdtempSync(
        join(root, ".tmp/neural-native-service-contract-")
      );
      try {
        const bundle = join(
          fixtureRoot,
          "Lekh Keyboard.imkdevbundle"
        );
        const resources = join(bundle, "Contents", "Resources");
        mkdirSync(resources, { recursive: true });
        writeFileSync(
          join(resources, "LekhNeuralTransliterator.manifest.json"),
          "{}\n"
        );
        writeFileSync(
          join(resources, "LekhNeuralTransliterator.vocab.json"),
          "{}\n"
        );
        const fakeSwift = join(fixtureRoot, "bin", "swift");
        mkdirSync(dirname(fakeSwift), { recursive: true });
        writeFileSync(fakeSwift, fakeSwiftSource());
        chmodSync(fakeSwift, 0o755);
        const reportPath = join(fixtureRoot, "report.json");
        const result = spawnSync(
          process.execPath,
          [
            join(root, "scripts/benchmark-neural-native-service.mjs"),
            "--bundle",
            bundle,
            "--report",
            reportPath
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              PATH: `${dirname(fakeSwift)}${delimiter}${process.env.PATH ?? ""}`
            },
            encoding: "utf8"
          }
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "Full native neural-service benchmark workload drifted from " +
            "its closed contract"
        );
        expect(result.stderr).toContain(
          "neural-native-service-benchmark.workload-invalid"
        );
        expect(existsSync(reportPath)).toBe(false);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    }
  );
});

function validReport() {
  const contract = NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT;
  return {
    placementCapture: false,
    workloadTokens: [...contract.orderedTokens],
    benchmarkPasses:
      contract.warmupPasses + contract.measuredPasses,
    warmupPasses: contract.warmupPasses,
    measuredPasses: contract.measuredPasses,
    warmupRequests:
      contract.orderedTokens.length * contract.warmupPasses,
    steadyStateSamples:
      contract.orderedTokens.length * contract.measuredPasses,
    targetP95Ms: contract.targetP95Ms,
    performance: { p50Ms: 1, p95Ms: 1, p99Ms: 1 },
    byTokenMs: Object.fromEntries(
      contract.orderedTokens.map((token) => [
        token,
        Array(contract.measuredPasses).fill(1)
      ])
    )
  };
}

function fakeSwiftSource() {
  return `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const reportPath = process.env.LEKH_NEURAL_BENCH_REPORT;
const payload = {
  runNonce: process.env.LEKH_NEURAL_BENCH_NONCE,
  bundle: process.env.LEKH_NEURAL_BENCH_BUNDLE,
  status: "passed-experimental",
  placementCapture: false,
  workloadTokens: ["prashasan", "nagarikta", "mantralaya", "sambidhan", "paryatan"],
  benchmarkPasses: 3,
  warmupPasses: 1,
  measuredPasses: 2,
  warmupRequests: 5,
  steadyStateSamples: 10,
  byTokenMs: Object.fromEntries(
    ["prashasan", "nagarikta", "mantralaya", "sambidhan", "paryatan"]
      .map((token) => [token, [1, 1]])
  ),
  targetP95Ms: 50,
  performance: { p50Ms: 1, p95Ms: 1, p99Ms: 1 }
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(payload));
`;
}
