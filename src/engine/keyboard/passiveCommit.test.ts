import { describe, expect, it } from "vitest";
import passiveCommitPolicy from "../../../data/engine/lekh-experimental-passive-commit.v1.json";
import tokenCandidatePack from "../../../data/engine/lekh-token-candidates.v1.json";
import {
  createKeyboardEngine,
  defaultTypingContext
} from "./index";
import { createExperimentalKeyboardEngineForPolicyTests } from "./experimentalPassiveCommitEngine.test-support";
import {
  EXPERIMENTAL_PASSIVE_COMMIT_POLICY_ID,
  experimentalPassiveSpaceCandidate,
  validateExperimentalPassiveCommitPolicyValue,
  validateExperimentalPassiveCommitPolicy
} from "./passiveCommit";
import type { CandidateUpdate, KeyboardEngine, KeyboardKeyEvent, KeyboardMode } from "./types";
import { sha256Hex } from "../util/sha256";

const spaceKey: KeyboardKeyEvent = {
  key: " ",
  code: "Space",
  modifiers: { shift: false, ctrl: false, alt: false, meta: false },
  timestamp: 1,
  platform: "test"
};

interface MutablePassiveCommitPolicy extends Record<string, unknown> {
  productionEligible: boolean;
  minimumInputCodePoints: number;
  sourceContract: { canonicalJsonSha256: string };
  entries: Array<{
    output: string;
    evidence: { humanRatedSamples: number };
  }>;
}

function experimentalEngine(): KeyboardEngine {
  return createExperimentalKeyboardEngineForPolicyTests();
}

function spaceCommit(engine: KeyboardEngine, input: string, mode: KeyboardMode = "romanized-traditional") {
  const sessionId = engine.beginSession(defaultTypingContext(mode));
  engine.updateComposition(sessionId, input, input.length);
  return { sessionId, update: engine.processKeyStroke(sessionId, spaceKey) };
}

describe("experimental passive Space commits", () => {
  it("keeps the closed policy bound to its exact production-ineligible source contract", () => {
    expect(validateExperimentalPassiveCommitPolicy()).toEqual([]);
    expect(passiveCommitPolicy.productionEligible).toBe(false);
    expect(passiveCommitPolicy.activation).toBe("opaque-test-build-capability-only");
  });

  it.each(passiveCommitPolicy.entries.flatMap((entry) => [
    { ...entry, mode: "romanized" as const },
    { ...entry, mode: "romanized-traditional" as const }
  ]))(
    "commits authorized row $input exactly in $mode without creating learning authority",
    ({ input, output, mode }) => {
      const engine = experimentalEngine();
      const { sessionId, update } = spaceCommit(engine, input, mode);

      expect(update.action).toBe("commit");
      expect(update.committedText).toBe(`${output} `);
      expect(update.committedText?.endsWith("  ")).toBe(false);
      expect(update.compositionText).toBe("");
      expect(engine.learnCommittedCorrection(sessionId, 1)).toBe(false);
    }
  );

  it.each([
    "swas", "swasthyaa", "Swasthya", "mero ghar", "prabin", "niraj", "unknownzz",
    "hello", "apple", "health", "code", "le", "ko", "cha", "ho", "xa", "lai", "ani", "aba",
    "nepal", "nepali"
  ])("preserves raw text for unauthorized, ambiguous, name, English, or non-exact input %s", (input) => {
    const engine = experimentalEngine();
    const { update } = spaceCommit(engine, input);

    expect(update.action).toBe("commit");
    expect(update.committedText).toBe(`${input} `);
  });

  it("keeps IPC-shaped context unable to activate the experiment", () => {
    const engine = createKeyboardEngine();
    const context = {
      ...defaultTypingContext("romanized-traditional"),
      passiveDelimiterPolicy: "experimental-exact-token"
    };
    const sessionId = engine.beginSession(context);
    engine.updateComposition(sessionId, "swasthya", 8);

    expect(engine.processKeyStroke(sessionId, spaceKey).committedText).toBe("swasthya ");
  });

  it("keeps production engine objects free of experimental and arbitrary-commit capabilities", () => {
    const engine = createKeyboardEngine();
    expect("experimentalPassiveCommitPolicyId" in engine).toBe(false);
    expect("commitCandidateWithoutLearning" in engine).toBe(false);

    const mutable = engine as KeyboardEngine & Record<string, unknown>;
    mutable.experimentalPassiveCommitPolicyId = EXPERIMENTAL_PASSIVE_COMMIT_POLICY_ID;
    const { update } = spaceCommit(engine, "swasthya");
    expect(update.committedText).toBe("swasthya ");
  });

  it("exposes the immutable policy identity used by the test-only authority", () => {
    expect(EXPERIMENTAL_PASSIVE_COMMIT_POLICY_ID).toBe(passiveCommitPolicy.id);
  });

  it.each([
    ["additional authority field", (policy: MutablePassiveCommitPolicy) => { policy.unexpected = true; }],
    ["production promotion", (policy: MutablePassiveCommitPolicy) => { policy.productionEligible = true; }],
    ["source digest drift", (policy: MutablePassiveCommitPolicy) => { policy.sourceContract.canonicalJsonSha256 = "0".repeat(64); }],
    ["input bound drift", (policy: MutablePassiveCommitPolicy) => { policy.minimumInputCodePoints = 65; }],
    ["oversized output", (policy: MutablePassiveCommitPolicy) => { policy.entries[0]!.output = "क".repeat(129); }],
    ["evidence overclaim", (policy: MutablePassiveCommitPolicy) => { policy.entries[0]!.evidence.humanRatedSamples = 1; }]
  ] as const)("fails closed on policy mutation: %s", (_label, mutate) => {
    const policy = structuredClone(passiveCommitPolicy) as unknown as MutablePassiveCommitPolicy;
    mutate(policy);
    expect(validateExperimentalPassiveCommitPolicyValue(policy, tokenCandidatePack)).not.toEqual([]);
  });

  it("fails closed when the bound source row changes", () => {
    const source = structuredClone(tokenCandidatePack);
    const row = source.rows.find((item) => item.input === "swasthya")!;
    row.outputs[0]!.confidence = 0.1;
    const policy = structuredClone(passiveCommitPolicy);
    policy.sourceContract.canonicalJsonSha256 = sha256Hex(JSON.stringify(source));

    expect(validateExperimentalPassiveCommitPolicyValue(policy, source)).not.toEqual([]);
  });

  it.each([
    ["range", (update: CandidateUpdate) => { update.primary!.replaceRange = [1, 8]; }],
    ["confidence", (update: CandidateUpdate) => { update.primary!.confidence = 0.1; }],
    ["reason", (update: CandidateUpdate) => { update.primary!.reason = ["forged source"]; }],
    ["type", (update: CandidateUpdate) => { update.primary!.type = "phrase"; }]
  ] as const)("rejects forged candidate %s authority", (_label, mutate) => {
    const engine = createKeyboardEngine();
    const context = defaultTypingContext("romanized-traditional");
    const sessionId = engine.beginSession(context);
    const canonical = engine.updateComposition(sessionId, "swasthya", 8);
    const forged = structuredClone(canonical);
    mutate(forged);

    expect(experimentalPassiveSpaceCandidate(
      "swasthya",
      forged,
      context,
      EXPERIMENTAL_PASSIVE_COMMIT_POLICY_ID
    )).toBeUndefined();
  });

  it("recomputes exact authorization after the candidate set changes", () => {
    const engine = experimentalEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized-traditional"));
    engine.updateComposition(sessionId, "swasthya", 8);
    engine.updateComposition(sessionId, "swas", 4);

    expect(engine.processKeyStroke(sessionId, spaceKey).committedText).toBe("swas ");
  });

  it("does not mint a new learning grant and revokes a stale older grant", () => {
    const engine = experimentalEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized-traditional"));
    const first = engine.updateComposition(sessionId, "ramro", 5);
    expect(first.primary).toBeDefined();
    expect(engine.commitCandidate(sessionId, first.primary!.id).commitEpoch).toBe(1);

    engine.updateComposition(sessionId, "swasthya", 8);
    expect(engine.processKeyStroke(sessionId, spaceKey).committedText).toBe("स्वास्थ्य ");
    expect(engine.learnCommittedCorrection(sessionId, 2)).toBe(false);
    expect(engine.learnCommittedCorrection(sessionId, 1)).toBe(false);
  });

  it("keeps default Space and experimental Enter raw", () => {
    const defaultEngine = createKeyboardEngine();
    expect(spaceCommit(defaultEngine, "swasthya").update.committedText).toBe("swasthya ");

    const engine = experimentalEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized-traditional"));
    engine.updateComposition(sessionId, "swasthya", 8);
    expect(engine.processKeyStroke(sessionId, {
      ...spaceKey,
      key: "Enter",
      code: "Enter"
    }).committedText).toBe("swasthya\n");
  });
});
