#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (!argument.startsWith("--")) continue;
  args.set(argument.slice(2), process.argv[index + 1] ?? "1");
  index += 1;
}
const bundle = args.get("bundle") ?? process.env.LEKH_NEURAL_BENCH_BUNDLE ?? join(
  homedir(),
  "Library",
  "Caches",
  "LekhKeyboardBuild",
  "native",
  "macos",
  "Lekh Keyboard.imkdevbundle"
);
const report = args.get("report") ?? join(root, "reports", "neural-native-service-e2e-report.json");
const model = join(bundle, "Contents", "Resources", "LekhNeuralTransliterator.mlmodelc");
const manifest = join(bundle, "Contents", "Resources", "LekhNeuralTransliterator.manifest.json");
const vocab = join(bundle, "Contents", "Resources", "LekhNeuralTransliterator.vocab.json");
for (const required of [bundle, model, manifest, vocab]) {
  if (!existsSync(required)) {
    console.error(`Missing packaged neural benchmark input: ${required}`);
    process.exit(2);
  }
}

const result = spawnSync(
  "swift",
  ["run", "--configuration", "release", "LekhInputMethodBehaviorProbe"],
  {
    cwd: join(root, "native", "macos-imk", "skeleton"),
    env: {
      ...process.env,
      LEKH_NEURAL_BENCH_BUNDLE: bundle,
      LEKH_NEURAL_BENCH_REPORT: report
    },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  }
);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(report)) {
  console.error("Behavior probe passed but did not create the end-to-end neural report.");
  process.exit(1);
}
const parsed = JSON.parse(readFileSync(report, "utf8"));
if (parsed.status !== "passed-experimental" || parsed.performance?.p95Ms >= parsed.targetP95Ms) {
  console.error(`End-to-end neural service gate failed: ${JSON.stringify(parsed.performance)}`);
  process.exit(1);
}
console.log(JSON.stringify({
  status: parsed.status,
  report: relative(root, report),
  performance: parsed.performance,
  singleForwardBenchmarkIsConsumerLatency: parsed.singleForwardBenchmarkIsConsumerLatency
}, null, 2));
