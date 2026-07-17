import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertPreeti, convertRomanized, createKeyboardEngine, defaultTypingContext } from "../src/engine";
import { keyboardMemoryCandidates } from "../src/engine/keyboard/memory";
import { IPC_SCHEMA_VERSION, createIpcRequest } from "../native/shared/ipc/messages";
import type { CorrectionMemoryEntry } from "../src/engine/memory";
import type { KeyboardSession } from "../src/engine/keyboard";

interface PerfCase {
  name: string;
  gateMs: number;
  iterations: number;
  run: () => void | Promise<void>;
}

interface PerfReport {
  name: string;
  iterations: number;
  gateMs: number;
  minMs: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
  targetMissed: boolean;
  grosslySlow: boolean;
}

const hostileRomanized = [
  "mero NID form ma naam wrong cha",
  "PDF ma date milena",
  "email address test@example.com ho",
  "phone number 9841000000 ho",
  "ward-05 ko online form submit bhayena",
  "X-ray report upload garna mildaina",
  "Form No. 2079-080 ko record system ma dekhaudaina",
  "user le correct final output herna parcha",
  'phrase detect garna "swasthya" example parcha'
].join(" ");

const preetiChunk = "sfof{no PDF NID email@test.com Form No. 2079-080 ward-05 X-ray report online form\n";
const mixedPreeti5kb = preetiChunk.repeat(Math.ceil(5120 / preetiChunk.length)).slice(0, 5120);
const mode = process.env.LEKH_PERF_MODE === "full" ? "full" : "smoke";

const romanizedEngine = createKeyboardEngine();
const romanizedSession = romanizedEngine.beginSession({
  ...defaultTypingContext("romanized"),
  activeDomains: ["government"],
  showRomanizedLabels: true
});

const traditionalEngine = createKeyboardEngine();
const traditionalSession = traditionalEngine.beginSession({
  ...defaultTypingContext("traditional"),
  showRomanizedLabels: true
});

const proofreadEngine = createKeyboardEngine();
const proofreadSession = proofreadEngine.beginSession(defaultTypingContext("unicode-proofread"));

const dictionaryEngine = createKeyboardEngine();

const memorySession: KeyboardSession = {
  sessionId: "perf-memory-session",
  context: defaultTypingContext("romanized"),
  mode: "romanized",
  compositionText: "prabin",
  caret: "prabin".length,
  candidates: [],
  proofHints: [],
  lastUpdateTime: 0,
  lastCommittedText: "",
  commitEpoch: 0,
  warnings: [],
  committedHistory: []
};
const memoryEntries: CorrectionMemoryEntry[] = [
  memoryEntry("prabin", "प्रबिनको", 7),
  memoryEntry("prabin", "प्रवीण", 3),
  memoryEntry("prabin", "प्रबिन", 2)
];

const commitEngine = createKeyboardEngine();
const commitSession = commitEngine.beginSession(defaultTypingContext("romanized"));

const cases: PerfCase[] = [
  {
    name: "50-token hostile Romanized mixed sentence",
    gateMs: 30,
    iterations: iterations(80),
    run: () => {
      convertRomanized(hostileRomanized, { mode: "romanized-mixed", benchmark: true });
    }
  },
  {
    name: "5KB mixed Preeti paragraph",
    gateMs: 100,
    iterations: iterations(40),
    run: () => {
      convertPreeti(mixedPreeti5kb, { mode: "preeti-mixed", benchmark: true });
    }
  },
  {
    name: "KeyboardEngine warm startup",
    gateMs: 500,
    iterations: iterations(25),
    run: async () => {
      const engine = createKeyboardEngine();
      await engine.warm({ timeoutMs: 50 });
      await engine.shutdown();
    }
  },
  {
    name: "KeyboardEngine partial warm timeout",
    gateMs: 50,
    iterations: iterations(25),
    run: async () => {
      const engine = createKeyboardEngine();
      await engine.warm({ timeoutMs: 1 });
      await engine.shutdown();
    }
  },
  {
    name: "Keyboard Romanized live update",
    gateMs: 20,
    iterations: iterations(120),
    run: () => {
      romanizedEngine.updateComposition(romanizedSession, "swasthya karyalaya", "swasthya karyalaya".length);
    }
  },
  {
    name: "Keyboard candidate count cap",
    gateMs: 20,
    iterations: iterations(120),
    run: () => {
      const update = romanizedEngine.updateComposition(romanizedSession, "swas", "swas".length);
      if (update.candidates.length > 8) {
        throw new Error(`candidate cap exceeded: ${update.candidates.length}`);
      }
    }
  },
  {
    name: "Keyboard Traditional Unicode suggestion",
    gateMs: 20,
    iterations: iterations(120),
    run: () => {
      traditionalEngine.updateComposition(traditionalSession, "जिल्ला प्रशा", "जिल्ला प्रशा".length);
    }
  },
  {
    name: "Keyboard proofread hint update",
    gateMs: 40,
    iterations: iterations(120),
    run: () => {
      proofreadEngine.updateComposition(proofreadSession, "विद्यालय को", "विद्यालय को".length);
    }
  },
  {
    name: "Keyboard dictionary lookup",
    gateMs: 30,
    iterations: iterations(120),
    run: () => {
      dictionaryEngine.lookupDictionary("swasthya", defaultTypingContext("dictionary-lookup"));
    }
  },
  {
    name: "Keyboard memory ranking update",
    gateMs: 10,
    iterations: iterations(120),
    run: () => {
      const candidates = keyboardMemoryCandidates("prabin", memoryEntries, memorySession);
      if (candidates[0]?.text !== "प्रबिनको") {
        throw new Error("memory ranking did not preserve the strongest local preference");
      }
    }
  },
  {
    name: "Keyboard candidate commit",
    gateMs: 10,
    iterations: iterations(120),
    run: () => {
      const update = commitEngine.updateComposition(commitSession, "jilla", "jilla".length);
      if (update.primary) {
        commitEngine.commitCandidate(commitSession, update.primary.id);
      }
    }
  },
  {
    name: "Native IPC JSON envelope simulation",
    gateMs: 10,
    iterations: iterations(120),
    run: () => {
      const request = createIpcRequest("session.updateComposition", {
        sessionId: romanizedSession,
        sessionEpoch: 1,
        input: "swasthya",
        cursor: "swasthya".length
      }, "perf-ipc");
      const serialized = JSON.stringify(request);
      const parsed = JSON.parse(serialized) as typeof request;
      if (parsed.type !== "session.updateComposition" || parsed.version !== IPC_SCHEMA_VERSION) {
        throw new Error("IPC envelope did not roundtrip");
      }
    }
  }
];

const startedAt = Date.now();
const reports = [];
for (const perfCase of cases) {
  reports.push(await runPerfCase(perfCase));
}

const report = {
  generatedAt: new Date().toISOString(),
  command: mode === "full" ? "npm run bench:perf:full" : "npm run bench:perf:smoke",
  suite: "performance",
  mode,
  durationMs: Date.now() - startedAt,
  note: "Performance smoke benchmark. It uses one untimed warmup per case, reports p95 gates, and fails on any p95 target miss.",
  reports
};

mkdirSync(join(process.cwd(), "bench/reports"), { recursive: true });
writeFileSync(join(process.cwd(), "bench/reports/perf-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

if (reports.some((report) => report.targetMissed)) {
  process.exit(1);
}

async function runPerfCase(perfCase: PerfCase): Promise<PerfReport> {
  const timings: number[] = [];
  await perfCase.run();
  for (let index = 0; index < perfCase.iterations; index += 1) {
    const start = Date.now();
    await perfCase.run();
    timings.push(Date.now() - start);
  }
  timings.sort((a, b) => a - b);
  const sum = timings.reduce((total, value) => total + value, 0);
  const p95Index = Math.min(timings.length - 1, Math.ceil(timings.length * 0.95) - 1);
  const p95Ms = timings[p95Index];
  return {
    name: perfCase.name,
    iterations: perfCase.iterations,
    gateMs: perfCase.gateMs,
    minMs: timings[0],
    meanMs: Number((sum / timings.length).toFixed(2)),
    p95Ms,
    maxMs: timings[timings.length - 1],
    targetMissed: p95Ms > perfCase.gateMs,
    grosslySlow: p95Ms > perfCase.gateMs * 10
  };
}

function iterations(fullCount: number): number {
  return mode === "full" ? fullCount : Math.max(20, Math.ceil(fullCount / 4));
}

function memoryEntry(inputRomanized: string, chosenOutput: string, frequency: number): CorrectionMemoryEntry {
  return {
    id: `perf-${inputRomanized}-${frequency}`,
    inputRomanized,
    chosenOutput,
    normalizedInput: inputRomanized,
    normalizedOutput: chosenOutput,
    rejectedAlternatives: [],
    context: {
      leftWindow: "",
      rightWindow: ""
    },
    source: "import",
    frequency,
    confidenceAtSelection: 0.9,
    timestamps: {
      firstSeen: "2026-01-01T00:00:00.000Z",
      lastUsed: "2026-01-01T00:00:00.000Z"
    },
    decayWeight: 1
  };
}
