const splitNames = Object.freeze(["train", "dev", "test"]);
const trainerCombiningMarks = /[\u093C-\u094D\u0951-\u0957ँंः]/u;
const asciiDigit = /[0-9]/u;
const asciiLetter = /[a-z]/u;
const asciiLetterOnly = /^[a-z]+$/u;
const devanagariDigit = /[\u0966-\u096F]/u;
const unicodePunctuation = /\p{P}/u;
const unicodeControl = /[\p{Cc}\p{Cf}]/u;
const bidiControl = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const joinControl = /[\u200C\u200D]/u;

export const DEFAULT_NEURAL_SEQUENCE_LIMITS = Object.freeze({
  tensorLength: 32,
  inputContentCapacity: 31,
  outputContentCapacity: 30
});

export function normalizeAuditInput(value) {
  return String(value ?? "").trim().toLowerCase().normalize("NFC").replace(/\s+/gu, " ");
}

export function normalizeAuditOutput(value) {
  return String(value ?? "").trim().normalize("NFC");
}

export function trainerOutputGraphemes(value) {
  const output = [];
  for (const character of normalizeAuditOutput(value)) {
    if (output.length > 0 && trainerCombiningMarks.test(character)) output[output.length - 1] += character;
    else output.push(character);
  }
  return output;
}

export function createEvaluationIdentityIndex(name, rows) {
  const inputs = new Set();
  const targets = new Set();
  const pairs = new Set();
  let negativeRows = 0;
  for (const row of rows) {
    const input = normalizeAuditInput(row?.input);
    if (!input) continue;
    inputs.add(input);
    const outputs = row?.expectedAction === "no-neural-candidate"
      ? []
      : [...(row?.expected ?? []), ...(row?.acceptable ?? [])];
    if (outputs.length === 0) negativeRows += 1;
    for (const output of outputs) {
      const target = normalizeAuditOutput(output);
      if (!target) continue;
      targets.add(target);
      pairs.add(pairKey(input, target));
    }
  }
  return Object.freeze({ name, rowCount: rows.length, negativeRows, inputs, targets, pairs });
}

export class NeuralDatasetQualityAccumulator {
  #limits;
  #evaluationIndexes;
  #rows = 0;
  #splitCounts = countsForSplits();
  #actionCounts = {};
  #categoryCounts = {};
  #categoryBySplit = nestedCountsForSplits();
  #sourceMembershipCounts = {};
  #sourceMembershipBySplit = nestedCountsForSplits();
  #primarySourceCounts = {};
  #sourceTierCounts = {};
  #reviewTierCounts = {};
  #inputCodePoints = mapsForSplits();
  #outputCodePoints = mapsForSplits();
  #outputGraphemes = mapsForSplits();
  #inputLengths = mapsForSplits();
  #outputLengths = mapsForSplits();
  #inputUnicodeLengths = mapsForSplits();
  #outputUnicodeLengths = mapsForSplits();
  #weightCounts = new Map();
  #weightSum = 0;
  #weightsBySplit = Object.fromEntries(splitNames.map((split) => [split, { count: 0, sum: 0 }]));
  #inputTargets = new Map();
  #invalidCounts = {};
  #invalidExamples = {};
  #mix = {
    inputLettersOnly: 0,
    inputContainsDigit: 0,
    inputContainsPunctuation: 0,
    inputMixedLetterDigit: 0,
    inputUnsupportedByTrainer: 0,
    outputContainsDevanagariDigit: 0,
    outputContainsPunctuation: 0,
    inputPunctuationCodePoints: new Map(),
    outputPunctuationCodePoints: new Map()
  };
  #lengthRisks = {
    inputOverTensorLength: 0,
    inputOverContentCapacity: 0,
    outputOverTensorLength: 0,
    outputOverContentCapacity: 0,
    inputAtContentCapacity: 0,
    outputAtContentCapacity: 0
  };
  #longestInputs = [];
  #longestOutputs = [];
  #unseenRows = Object.fromEntries(splitNames.map((split) => [split, {
    inputCharacterRows: 0,
    outputGraphemeRows: 0,
    inputExamples: [],
    outputExamples: []
  }]));
  #evaluationOverlap;

  constructor({ limits = DEFAULT_NEURAL_SEQUENCE_LIMITS, evaluationIndexes = [] } = {}) {
    this.#limits = Object.freeze({ ...limits });
    this.#evaluationIndexes = [...evaluationIndexes];
    this.#evaluationOverlap = Object.fromEntries(this.#evaluationIndexes.map((index) => [
      index.name,
      Object.fromEntries(splitNames.map((split) => [split, newOverlapAccumulator()]))
    ]));
  }

  add(row, declaredSplit, location = "<row>") {
    const split = splitNames.includes(declaredSplit) ? declaredSplit : String(row?.split ?? "unknown");
    this.#rows += 1;
    increment(this.#splitCounts, split);
    if (row?.split !== declaredSplit) this.#invalid("split-mismatch", row, location);
    increment(this.#actionCounts, String(row?.action ?? "<missing>"));
    increment(this.#categoryCounts, String(row?.category ?? "<missing>"));
    increment(this.#categoryBySplit[split] ??= {}, String(row?.category ?? "<missing>"));
    increment(this.#sourceTierCounts, String(row?.sourceTier ?? "<missing>"));
    increment(this.#reviewTierCounts, String(row?.reviewTier ?? "<missing>"));

    const sourceIds = Array.isArray(row?.sourceIds) ? [...new Set(row.sourceIds.map(String))].sort() : [];
    if (sourceIds.length === 0) this.#invalid("missing-source", row, location);
    for (const sourceId of sourceIds) {
      increment(this.#sourceMembershipCounts, sourceId);
      increment(this.#sourceMembershipBySplit[split] ??= {}, sourceId);
    }
    increment(this.#primarySourceCounts, sourceIds[0] ?? "<missing>");

    const rawInput = String(row?.input ?? "");
    const rawTarget = row?.target === null ? null : String(row?.target ?? "");
    const input = normalizeAuditInput(rawInput);
    const target = rawTarget === null ? null : normalizeAuditOutput(rawTarget);
    this.#auditText(rawInput, "input", row, location);
    if (rawTarget !== null) this.#auditText(rawTarget, "output", row, location);
    if (rawInput !== input) this.#invalid("input-not-canonical", row, location);
    if (rawTarget !== target) this.#invalid("output-not-canonical", row, location);
    if (!input) this.#invalid("empty-input", row, location);
    if (target === null || !target) this.#invalid("empty-output", row, location);
    if (target !== null && /\s/u.test(target)) this.#invalid("output-whitespace", row, location);

    const inputCharacters = [...input];
    const outputCharacters = target === null ? [] : [...target];
    const outputTokens = target === null ? [] : trainerOutputGraphemes(target);
    const inputUnicodeGraphemes = unicodeGraphemes(input);
    const outputUnicodeGraphemes = target === null ? [] : unicodeGraphemes(target);
    updateFrequency(this.#inputCodePoints[split], inputCharacters);
    updateFrequency(this.#outputCodePoints[split], outputCharacters);
    updateFrequency(this.#outputGraphemes[split], outputTokens);
    incrementMap(this.#inputLengths[split], inputCharacters.length);
    incrementMap(this.#outputLengths[split], outputTokens.length);
    incrementMap(this.#inputUnicodeLengths[split], inputUnicodeGraphemes.length);
    incrementMap(this.#outputUnicodeLengths[split], outputUnicodeGraphemes.length);
    keepLongest(this.#longestInputs, { id: row?.id, split, input, length: inputCharacters.length });
    if (target !== null) keepLongest(this.#longestOutputs, { id: row?.id, split, input, target, length: outputTokens.length });

    if (inputCharacters.length > this.#limits.tensorLength) this.#lengthRisks.inputOverTensorLength += 1;
    if (inputCharacters.length > this.#limits.inputContentCapacity) this.#lengthRisks.inputOverContentCapacity += 1;
    if (inputCharacters.length === this.#limits.inputContentCapacity) this.#lengthRisks.inputAtContentCapacity += 1;
    if (outputTokens.length > this.#limits.tensorLength) this.#lengthRisks.outputOverTensorLength += 1;
    if (outputTokens.length > this.#limits.outputContentCapacity) this.#lengthRisks.outputOverContentCapacity += 1;
    if (outputTokens.length === this.#limits.outputContentCapacity) this.#lengthRisks.outputAtContentCapacity += 1;

    this.#auditMix(input, target);
    this.#auditWeight(row?.weight, split, row, location);
    this.#auditConflict(input, target);
    this.#auditEvaluationOverlap(input, target, row, split);

    if (split !== "train") {
      const unseenInput = inputCharacters.filter((token) => !this.#inputCodePoints.train.has(token));
      const unseenOutput = outputTokens.filter((token) => !this.#outputGraphemes.train.has(token));
      if (unseenInput.length > 0) {
        this.#unseenRows[split].inputCharacterRows += 1;
        keepExample(this.#unseenRows[split].inputExamples, { id: row?.id, input, tokens: [...new Set(unseenInput)] });
      }
      if (unseenOutput.length > 0) {
        this.#unseenRows[split].outputGraphemeRows += 1;
        keepExample(this.#unseenRows[split].outputExamples, { id: row?.id, input, target, tokens: [...new Set(unseenOutput)] });
      }
    }
  }

  addInvalidJson(split, location, message) {
    this.#rows += 1;
    increment(this.#splitCounts, split);
    this.#invalid("invalid-json", { id: null, message }, location);
  }

  finalize({ dataset, artifacts }) {
    const conflicts = [];
    let conflictingInputs = 0;
    let conflictingRows = 0;
    let maximumTargetsPerInput = 1;
    for (const [input, value] of this.#inputTargets) {
      if (typeof value === "string") continue;
      conflictingInputs += 1;
      conflictingRows += value.rows;
      maximumTargetsPerInput = Math.max(maximumTargetsPerInput, value.targets.size);
      if (conflicts.length < 20) conflicts.push({ input, rows: value.rows, targets: [...value.targets].sort() });
    }

    const evaluationLeakage = Object.fromEntries(this.#evaluationIndexes.map((index) => [index.name, {
      reference: {
        rows: index.rowCount,
        negativeRows: index.negativeRows,
        uniqueInputs: index.inputs.size,
        uniqueTargets: index.targets.size,
        exactPairs: index.pairs.size
      },
      byDatasetSplit: Object.fromEntries(splitNames.map((split) => [
        split,
        finalizeOverlap(this.#evaluationOverlap[index.name][split])
      ])),
      trainVocabularyCoverage: evaluationVocabularyCoverage(index, this.#inputCodePoints.train, this.#outputGraphemes.train)
    }]));

    const balance = {
      splits: withShares(this.#splitCounts, this.#rows),
      actions: withShares(this.#actionCounts, this.#rows),
      categories: withShares(this.#categoryCounts, this.#rows),
      categoriesBySplit: mapObjectValues(this.#categoryBySplit, (counts) => withShares(counts, sumValues(counts))),
      sourceMemberships: withShares(this.#sourceMembershipCounts, this.#rows),
      sourceMembershipsBySplit: mapObjectValues(this.#sourceMembershipBySplit, (counts, split) => withShares(counts, this.#splitCounts[split] ?? 0)),
      primarySources: withShares(this.#primarySourceCounts, this.#rows),
      sourceTiers: withShares(this.#sourceTierCounts, this.#rows),
      reviewTiers: withShares(this.#reviewTierCounts, this.#rows)
    };

    const vocabulary = {
      inputCodePoints: vocabularyReport(this.#inputCodePoints),
      outputCodePoints: vocabularyReport(this.#outputCodePoints),
      outputTrainerGraphemes: vocabularyReport(this.#outputGraphemes),
      unseenRowsComparedWithTrain: this.#unseenRows
    };
    const lengths = {
      limits: this.#limits,
      trainerSemantics: {
        input: "Unicode code points plus EOS; content capacity is tensorLength - 1",
        output: "Lekh Devanagari grapheme tokens plus SOS/EOS; content capacity is tensorLength - 2"
      },
      inputTrainerTokens: histogramReport(this.#inputLengths),
      outputTrainerGraphemes: histogramReport(this.#outputLengths),
      inputUnicodeGraphemes: histogramReport(this.#inputUnicodeLengths),
      outputUnicodeGraphemes: histogramReport(this.#outputUnicodeLengths),
      capacityRisk: {
        ...this.#lengthRisks,
        rowsThatWouldBeSilentlyTruncated: 0,
        behavior: "The current loader rejects over-capacity rows before encode(); it does not silently truncate them.",
        trainingWouldAbort: this.#lengthRisks.inputOverContentCapacity > 0 || this.#lengthRisks.outputOverContentCapacity > 0
      },
      longestInputs: this.#longestInputs,
      longestOutputs: this.#longestOutputs
    };
    const weights = weightReport(this.#weightCounts, this.#weightSum, this.#rows, this.#weightsBySplit);
    const conflictsReport = { conflictingInputs, conflictingRows, maximumTargetsPerInput, examples: conflicts };
    const invalid = {
      totalIssues: sumValues(this.#invalidCounts),
      counts: sortedObject(this.#invalidCounts),
      examples: sortedObject(this.#invalidExamples)
    };
    const punctuationAndDigits = {
      ...this.#mix,
      inputPunctuationCodePoints: frequencySummary(this.#mix.inputPunctuationCodePoints),
      outputPunctuationCodePoints: frequencySummary(this.#mix.outputPunctuationCodePoints)
    };
    delete punctuationAndDigits.inputPunctuationCodePointsMap;
    delete punctuationAndDigits.outputPunctuationCodePointsMap;

    const report = {
      schemaVersion: 1,
      contentIdentity: "lekh-neural-open-vocab-data-quality-audit-v1",
      dataset,
      artifacts,
      rowsAudited: this.#rows,
      balance,
      vocabulary,
      lengths,
      conflicts: conflictsReport,
      invalidUnicodeAndStructure: invalid,
      punctuationAndDigits,
      weights,
      evaluationLeakage
    };
    report.findings = buildFindings(report);
    report.status = report.findings.some((finding) => finding.severity === "error")
      ? "failed-data-quality-audit"
      : "passed-data-quality-audit-with-observations";
    return report;
  }

  #auditText(value, side, row, location) {
    if (hasUnpairedSurrogate(value)) this.#invalid(`${side}-unpaired-surrogate`, row, location);
    if (value.includes("\uFFFD")) this.#invalid(`${side}-replacement-character`, row, location);
    if (containsNoncharacter(value)) this.#invalid(`${side}-unicode-noncharacter`, row, location);
    if (bidiControl.test(value)) this.#invalid(`${side}-bidi-control`, row, location);
    if (side === "input" && unicodeControl.test(value)) this.#invalid("input-control-or-format", row, location);
    if (side === "output") {
      for (const character of value) {
        const codePoint = character.codePointAt(0);
        const allowed = (codePoint >= 0x0900 && codePoint <= 0x097F) || joinControl.test(character);
        if (!allowed) this.#invalid("output-unsupported-scalar", row, location);
        if (unicodeControl.test(character) && !joinControl.test(character)) this.#invalid("output-control-or-format", row, location);
      }
    }
    if (value !== value.normalize("NFC")) this.#invalid(`${side}-not-nfc`, row, location);
  }

  #auditMix(input, target) {
    const containsLetter = asciiLetter.test(input);
    const containsDigit = asciiDigit.test(input);
    const punctuation = [...input].filter((character) => !/[a-z0-9]/u.test(character));
    if (asciiLetterOnly.test(input)) this.#mix.inputLettersOnly += 1;
    if (containsDigit) this.#mix.inputContainsDigit += 1;
    if (punctuation.length > 0) this.#mix.inputContainsPunctuation += 1;
    if (containsLetter && containsDigit) this.#mix.inputMixedLetterDigit += 1;
    if (!asciiLetterOnly.test(input)) this.#mix.inputUnsupportedByTrainer += 1;
    updateFrequency(this.#mix.inputPunctuationCodePoints, punctuation);
    if (target === null) return;
    if (devanagariDigit.test(target)) this.#mix.outputContainsDevanagariDigit += 1;
    const outputPunctuation = [...target].filter((character) => unicodePunctuation.test(character));
    if (outputPunctuation.length > 0) this.#mix.outputContainsPunctuation += 1;
    updateFrequency(this.#mix.outputPunctuationCodePoints, outputPunctuation);
  }

  #auditWeight(value, split, row, location) {
    const weight = Number(value);
    if (!Number.isFinite(weight) || weight <= 0) {
      this.#invalid("invalid-weight", row, location);
      return;
    }
    incrementMap(this.#weightCounts, weight);
    this.#weightSum += weight;
    this.#weightsBySplit[split] ??= { count: 0, sum: 0 };
    this.#weightsBySplit[split].count += 1;
    this.#weightsBySplit[split].sum += weight;
  }

  #auditConflict(input, target) {
    const identity = target ?? "<NO_NEURAL_CANDIDATE>";
    const existing = this.#inputTargets.get(input);
    if (existing === undefined) {
      this.#inputTargets.set(input, identity);
      return;
    }
    if (typeof existing === "string") {
      if (existing !== identity) this.#inputTargets.set(input, { targets: new Set([existing, identity]), rows: 2 });
      return;
    }
    existing.targets.add(identity);
    existing.rows += 1;
  }

  #auditEvaluationOverlap(input, target, row, split) {
    for (const index of this.#evaluationIndexes) {
      const overlap = this.#evaluationOverlap[index.name][split];
      if (index.inputs.has(input)) {
        overlap.inputRows += 1;
        overlap.inputs.add(input);
        keepExample(overlap.examples, { id: row?.id, input, target, match: "input" });
      }
      if (target !== null && index.targets.has(target)) {
        overlap.targetRows += 1;
        overlap.targets.add(target);
        keepExample(overlap.examples, { id: row?.id, input, target, match: "target" });
      }
      if (target !== null && index.pairs.has(pairKey(input, target))) {
        overlap.exactPairRows += 1;
        overlap.pairs.add(pairKey(input, target));
        keepExample(overlap.examples, { id: row?.id, input, target, match: "exact-pair" });
      }
    }
  }

  #invalid(code, row, location) {
    increment(this.#invalidCounts, code);
    this.#invalidExamples[code] ??= [];
    keepExample(this.#invalidExamples[code], { location, id: row?.id ?? null, input: row?.input ?? null, target: row?.target ?? null });
  }
}

function unicodeGraphemes(value) {
  if (typeof Intl?.Segmenter !== "function") return [...String(value)];
  return [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(String(value))].map(({ segment }) => segment);
}

function vocabularyReport(maps) {
  const global = mergeFrequencyMaps(splitNames.map((split) => maps[split]));
  const trainTokens = new Set(maps.train.keys());
  return {
    global: frequencySummary(global),
    bySplit: Object.fromEntries(splitNames.map((split) => [split, frequencySummary(maps[split])])),
    unseenFromTrain: Object.fromEntries(["dev", "test"].map((split) => [
      split,
      frequencySummary(new Map([...maps[split]].filter(([token]) => !trainTokens.has(token))))
    ]))
  };
}

function frequencySummary(frequencies) {
  const entries = [...frequencies].map(([token, count]) => ({ token, codePoints: codePointLabel(token), count }));
  entries.sort((left, right) => right.count - left.count || left.token.localeCompare(right.token));
  return {
    distinct: entries.length,
    occurrences: entries.reduce((sum, entry) => sum + entry.count, 0),
    singletons: entries.filter((entry) => entry.count === 1).length,
    top: entries.slice(0, 30),
    rare: [...entries].sort((left, right) => left.count - right.count || left.token.localeCompare(right.token)).slice(0, 30)
  };
}

function histogramReport(histograms) {
  return Object.fromEntries(splitNames.map((split) => [split, summarizeHistogram(histograms[split])]));
}

function summarizeHistogram(histogram) {
  const total = [...histogram.values()].reduce((sum, count) => sum + count, 0);
  const sorted = [...histogram].sort(([left], [right]) => Number(left) - Number(right));
  return {
    rows: total,
    min: sorted[0]?.[0] ?? 0,
    p50: histogramQuantile(sorted, total, 0.5),
    p90: histogramQuantile(sorted, total, 0.9),
    p95: histogramQuantile(sorted, total, 0.95),
    p99: histogramQuantile(sorted, total, 0.99),
    p999: histogramQuantile(sorted, total, 0.999),
    max: sorted.at(-1)?.[0] ?? 0,
    tail: Object.fromEntries(sorted.filter(([length]) => Number(length) >= 24).map(([length, count]) => [length, count]))
  };
}

function weightReport(histogram, sum, rows, bySplit) {
  const sorted = [...histogram].sort(([left], [right]) => Number(left) - Number(right));
  return {
    min: sorted[0]?.[0] ?? null,
    max: sorted.at(-1)?.[0] ?? null,
    mean: round(sum / Math.max(rows, 1)),
    p50: histogramQuantile(sorted, rows, 0.5),
    p90: histogramQuantile(sorted, rows, 0.9),
    p99: histogramQuantile(sorted, rows, 0.99),
    distribution: Object.fromEntries(sorted.map(([weight, count]) => [weight, { count, share: round(count / Math.max(rows, 1)) }])),
    bySplit: Object.fromEntries(Object.entries(bySplit).map(([split, value]) => [split, {
      count: value.count,
      mean: round(value.sum / Math.max(value.count, 1))
    }]))
  };
}

function evaluationVocabularyCoverage(index, trainInputCharacters, trainOutputGraphemes) {
  const inputCharacters = new Set([...index.inputs].flatMap((input) => [...input]));
  const outputTokens = new Set([...index.targets].flatMap(trainerOutputGraphemes));
  const unseenInputs = [...inputCharacters].filter((token) => !trainInputCharacters.has(token)).sort();
  const unseenOutputs = [...outputTokens].filter((token) => !trainOutputGraphemes.has(token)).sort();
  return {
    inputCharacters: inputCharacters.size,
    unseenInputCharacters: unseenInputs.map(tokenDescriptor),
    outputGraphemes: outputTokens.size,
    unseenOutputGraphemes: unseenOutputs.map(tokenDescriptor)
  };
}

function buildFindings(report) {
  const findings = [];
  const corruptArtifacts = Object.values(report.artifacts?.splits ?? {}).filter((artifact) => !artifact.integrityMatches);
  const corruptReferences = Object.values(report.artifacts?.evaluationReferences ?? {})
    .flatMap((reference) => reference.suites ?? [])
    .filter((artifact) => !artifact.integrityMatches);
  if (corruptArtifacts.length + corruptReferences.length > 0) {
    findings.push(finding("error", "artifact-integrity-mismatch", `${corruptArtifacts.length} dataset split(s) and ${corruptReferences.length} evaluation suite(s) do not match their manifests.`, {
      datasetSplits: corruptArtifacts.map((artifact) => artifact.path),
      evaluationSuites: corruptReferences.map((artifact) => artifact.path)
    }));
  }
  const declaredCounts = report.dataset?.declaredCounts ?? {};
  const observedCounts = Object.fromEntries(splitNames.map((split) => [
    split,
    Number(report.artifacts?.splits?.[split]?.observed?.rows ?? 0)
  ]));
  const declaredTotal = Number(report.dataset?.declaredRows);
  const declaredCountSum = splitNames.reduce((sum, split) => sum + Number(declaredCounts[split] ?? 0), 0);
  const countMismatch = splitNames.some((split) => Number(declaredCounts[split]) !== observedCounts[split]);
  if (!Number.isFinite(declaredTotal) || declaredTotal !== report.rowsAudited || declaredCountSum !== declaredTotal || countMismatch) {
    findings.push(finding("error", "declared-row-count-mismatch", "Dataset manifest row totals do not reconcile with the streamed artifacts.", {
      declaredTotal: report.dataset?.declaredRows ?? null,
      declaredCounts,
      declaredCountSum,
      observedTotal: report.rowsAudited,
      observedCounts
    }));
  }
  const invalid = report.invalidUnicodeAndStructure.totalIssues;
  if (invalid > 0) findings.push(finding("error", "invalid-rows", `${invalid} invalid Unicode/structure issue(s) were detected.`, report.invalidUnicodeAndStructure.counts));
  const inputOver = report.lengths.capacityRisk.inputOverContentCapacity;
  const outputOver = report.lengths.capacityRisk.outputOverContentCapacity;
  if (inputOver + outputOver > 0) findings.push(finding("error", "trainer-length-incompatibility", `${inputOver} input row(s) and ${outputOver} output row(s) exceed effective content capacity; training aborts rather than silently truncating.`, report.lengths.capacityRisk));
  const unsupported = report.punctuationAndDigits.inputUnsupportedByTrainer;
  if (unsupported > 0) findings.push(finding("error", "trainer-input-alphabet-incompatibility", `${unsupported} row(s) contain digits or punctuation rejected by the current letters-only trainer input check.`, {
    digitRows: report.punctuationAndDigits.inputContainsDigit,
    punctuationRows: report.punctuationAndDigits.inputContainsPunctuation
  }));
  const outputDigitRows = report.punctuationAndDigits.outputContainsDevanagariDigit;
  const outputPunctuationRows = report.punctuationAndDigits.outputContainsPunctuation;
  if (outputDigitRows + outputPunctuationRows > 0) findings.push(finding("warning", "output-digit-or-punctuation-tail", `${outputDigitRows} row(s) contain Devanagari digits and ${outputPunctuationRows} row(s) contain punctuation.`, {
    outputDigitRows,
    outputPunctuationRows,
    punctuationCodePoints: report.punctuationAndDigits.outputPunctuationCodePoints
  }));
  for (const [name, leakage] of Object.entries(report.evaluationLeakage)) {
    const train = leakage.byDatasetSplit.train;
    if (train.inputRows + train.targetRows + train.exactPairRows > 0) {
      findings.push(finding("error", `${name}-train-leakage`, `${name} identities overlap the training split.`, train));
    }
  }
  if (report.conflicts.conflictingInputs > 0) findings.push(finding("warning", "conflicting-targets", `${report.conflicts.conflictingInputs} normalized inputs map to multiple targets.`, {
    rows: report.conflicts.conflictingRows,
    maximumTargetsPerInput: report.conflicts.maximumTargetsPerInput
  }));
  const dominant = Object.entries(report.balance.primarySources).sort(([, left], [, right]) => right.count - left.count)[0];
  if (dominant?.[1]?.share >= 0.9) findings.push(finding("warning", "source-concentration", `${dominant[0]} supplies ${round(dominant[1].share * 100)}% of rows.`, dominant[1]));
  const lowCategories = Object.entries(report.balance.categories).filter(([, value]) => value.share < 0.001);
  if (lowCategories.length > 0) findings.push(finding("warning", "underrepresented-categories", `${lowCategories.length} categor${lowCategories.length === 1 ? "y is" : "ies are"} below 0.1% of rows.`, Object.fromEntries(lowCategories)));
  const outputVocabulary = report.vocabulary.outputTrainerGraphemes;
  if (outputVocabulary.bySplit.train.singletons > 0) findings.push(finding("warning", "sparse-output-token-tail", `${outputVocabulary.bySplit.train.singletons} trainer output tokens occur only once in train.`, {
    trainDistinct: outputVocabulary.bySplit.train.distinct,
    trainSingletons: outputVocabulary.bySplit.train.singletons,
    globalDistinct: outputVocabulary.global.distinct,
    globalSingletons: outputVocabulary.global.singletons
  }));
  for (const split of ["dev", "test"]) {
    const unseen = report.vocabulary.unseenRowsComparedWithTrain[split];
    if (unseen.inputCharacterRows + unseen.outputGraphemeRows > 0) findings.push(finding("warning", `${split}-unseen-vocabulary`, `${split} contains rows with vocabulary absent from train.`, unseen));
  }
  if (findings.length === 0) findings.push(finding("info", "no-material-data-risk", "No audited incompatibility, leakage, or representation warning was detected.", {}));
  return findings;
}

function finding(severity, code, message, evidence) {
  return { severity, code, message, evidence };
}

function newOverlapAccumulator() {
  return { inputRows: 0, targetRows: 0, exactPairRows: 0, inputs: new Set(), targets: new Set(), pairs: new Set(), examples: [] };
}

function finalizeOverlap(value) {
  return {
    inputRows: value.inputRows,
    targetRows: value.targetRows,
    exactPairRows: value.exactPairRows,
    uniqueInputs: value.inputs.size,
    uniqueTargets: value.targets.size,
    uniquePairs: value.pairs.size,
    examples: value.examples
  };
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) return true;
  }
  return false;
}

function containsNoncharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if ((codePoint >= 0xFDD0 && codePoint <= 0xFDEF) || (codePoint & 0xFFFF) === 0xFFFE || (codePoint & 0xFFFF) === 0xFFFF) return true;
  }
  return false;
}

function pairKey(input, target) {
  return `${input}\0${target}`;
}

function mapsForSplits() {
  return Object.fromEntries(splitNames.map((split) => [split, new Map()]));
}

function countsForSplits() {
  return Object.fromEntries(splitNames.map((split) => [split, 0]));
}

function nestedCountsForSplits() {
  return Object.fromEntries(splitNames.map((split) => [split, {}]));
}

function increment(object, key, amount = 1) {
  object[key] = (object[key] ?? 0) + amount;
}

function incrementMap(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function updateFrequency(map, values) {
  for (const value of values) incrementMap(map, value);
}

function mergeFrequencyMaps(maps) {
  const result = new Map();
  for (const map of maps) for (const [key, count] of map) incrementMap(result, key, count);
  return result;
}

function histogramQuantile(sortedEntries, total, quantile) {
  if (total <= 0) return null;
  const threshold = Math.max(1, Math.ceil(total * quantile));
  let cumulative = 0;
  for (const [value, count] of sortedEntries) {
    cumulative += count;
    if (cumulative >= threshold) return Number(value);
  }
  return Number(sortedEntries.at(-1)?.[0] ?? 0);
}

function keepLongest(values, candidate, maximum = 10) {
  values.push(candidate);
  values.sort((left, right) => right.length - left.length || String(left.id).localeCompare(String(right.id)));
  if (values.length > maximum) values.length = maximum;
}

function keepExample(values, candidate, maximum = 10) {
  if (values.length < maximum && !values.some((value) => JSON.stringify(value) === JSON.stringify(candidate))) values.push(candidate);
}

function withShares(counts, total) {
  return Object.fromEntries(Object.entries(sortedObject(counts)).map(([key, count]) => [key, { count, share: round(count / Math.max(total, 1)) }]));
}

function sortedObject(object) {
  return Object.fromEntries(Object.entries(object).sort(([left], [right]) => left.localeCompare(right)));
}

function mapObjectValues(object, mapper) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, mapper(value, key)]));
}

function sumValues(object) {
  return Object.values(object).reduce((sum, value) => sum + Number(value), 0);
}

function round(value) {
  return Number(Number(value).toFixed(8));
}

function tokenDescriptor(token) {
  return { token, codePoints: codePointLabel(token) };
}

function codePointLabel(value) {
  return [...String(value)].map((character) => `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`).join(" ");
}
