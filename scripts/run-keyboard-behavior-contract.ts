import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  loadBehaviorCorpus,
  runBehaviorContract,
  stableJson
} from "./lib/keyboard-behavior-contract";

const defaultCorpus = fileURLToPath(new URL(
  "../contracts/keyboard-behavior/v1/lekh-keyboard-behavior.v1.jsonl",
  import.meta.url
));

export function runKeyboardBehaviorContractCli(args: string[]): number {
  if (args.length > 1 || args[0] === "--help") {
    process.stderr.write("Usage: vite-node scripts/run-keyboard-behavior-contract.ts [corpus.jsonl]\n");
    return args[0] === "--help" ? 0 : 2;
  }
  const corpusPath = resolve(args[0] ?? defaultCorpus);
  try {
    const cases = loadBehaviorCorpus(corpusPath);
    const evidence = runBehaviorContract(cases);
    for (const row of evidence) process.stdout.write(`${stableJson(row)}\n`);
    process.stderr.write(`keyboard-behavior-contract: ${evidence.length}/${cases.length} passed (${corpusPath})\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`keyboard-behavior-contract: FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

process.exitCode = runKeyboardBehaviorContractCli(process.argv.slice(2));
