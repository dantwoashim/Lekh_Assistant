const splitPriority = Object.freeze({ train: 1, validation: 2, test: 3 });

export const AKSHARANTAR_IMPORT_CONTENT_IDENTITY = "aksharantar-nepali-import-v1-test-over-validation-over-train";
export const AKSHARANTAR_DUPLICATE_PAIR_RESOLUTION = "test-over-validation-over-train";

export function orderAksharantarMembersByHeldOutPrecedence(members) {
  if (!Array.isArray(members)) throw new TypeError("Aksharantar members must be an array.");
  for (const member of members) priorityFor(member?.split);
  return [...members].sort((left, right) =>
    priorityFor(right?.split) - priorityFor(left?.split) ||
    String(left?.member ?? "").localeCompare(String(right?.member ?? ""))
  );
}

export class AksharantarCanonicalPairTracker {
  #lastPriority = Number.POSITIVE_INFINITY;
  #seenPairs = new Set();

  observe(input, target, split) {
    const priority = priorityFor(split);
    if (priority > this.#lastPriority) {
      throw new TypeError("Aksharantar members must be consumed in test > validation > train precedence order.");
    }
    this.#lastPriority = priority;
    const key = `${String(input)}\0${String(target)}`;
    if (this.#seenPairs.has(key)) return false;
    this.#seenPairs.add(key);
    return true;
  }
}

export function aksharantarSplitPriority(split) {
  return priorityFor(split);
}

export function createDeterministicAksharantarImportManifest({
  sourceId,
  upstream,
  files,
  output,
  counts,
  rejected,
  maxRows,
  failures,
  warnings
}) {
  return {
    schemaVersion: 1,
    contentIdentity: AKSHARANTAR_IMPORT_CONTENT_IDENTITY,
    sourceId,
    upstream,
    files,
    output,
    counts,
    rejected,
    maxRows,
    policy: {
      normalizeInput: "lowercase trim NFC collapse whitespace",
      normalizeOutput: "trim NFC collapse whitespace",
      activeTokenOnly: true,
      rejectWhitespaceInputs: true,
      rejectWhitespaceOutputs: true,
      rejectLatinOutputs: true,
      rejectNonLatinInputs: true,
      preserveUpstreamSourceAndScore: true,
      duplicatePairResolution: AKSHARANTAR_DUPLICATE_PAIR_RESOLUTION,
      rawUpstreamDataCommitted: false
    },
    failures: [...failures],
    warnings: [...warnings]
  };
}

function priorityFor(split) {
  const priority = splitPriority[split];
  if (!priority) throw new TypeError(`Unsupported Aksharantar split: ${split}`);
  return priority;
}
