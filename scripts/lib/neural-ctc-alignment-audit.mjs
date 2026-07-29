import {
  DEVANAGARI_WORD_SEQUENCE_VALIDATOR_ID,
  validateDevanagariWordSequence
} from "./devanagari-word-sequence.mjs";

const SPLITS = Object.freeze(["train", "dev", "test"]);
const ASCII_ROMAN_TOKEN = /^[a-z]+$/u;

export function normalizeCTCAuditInput(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFC")
    .replace(/\s+/gu, " ");
}

export function normalizeCTCAuditOutput(value) {
  return String(value ?? "").trim().normalize("NFC");
}

export function ctcRequiredTimeSteps(value) {
  const tokens = Array.isArray(value) ? value : [...normalizeCTCAuditOutput(value)];
  let repeatedAdjacentTokens = 0;
  for (let index = 1; index < tokens.length; index += 1) {
    if (tokens[index] === tokens[index - 1]) repeatedAdjacentTokens += 1;
  }
  return tokens.length + repeatedAdjacentTokens;
}

export class NeuralCTCAlignmentAccumulator {
  #maxInputLength;
  #outputTimeSteps;
  #trainingComplete = false;
  #splitStates = Object.fromEntries(
    SPLITS.map((split) => [split, createDatasetState(split)])
  );
  #trainInputVocabulary = new Map();
  #trainOutputVocabulary = new Map();
  #evaluationStates = {};

  constructor({ maxInputLength = 32, outputTimeSteps = 32 } = {}) {
    if (!Number.isSafeInteger(maxInputLength) || maxInputLength < 2) {
      throw new Error("CTC audit maxInputLength must be an integer of at least 2.");
    }
    if (!Number.isSafeInteger(outputTimeSteps) || outputTimeSteps < 1) {
      throw new Error("CTC audit outputTimeSteps must be a positive integer.");
    }
    this.#maxInputLength = maxInputLength;
    this.#outputTimeSteps = outputTimeSteps;
  }

  add(row, declaredSplit, location = "<row>") {
    if (!SPLITS.includes(declaredSplit)) {
      throw new Error(`Unsupported CTC audit split: ${declaredSplit}`);
    }
    if (declaredSplit !== "train" && !this.#trainingComplete) {
      throw new Error("CTC audit must finish the training split before held-out rows.");
    }
    if (declaredSplit === "train" && this.#trainingComplete) {
      throw new Error("CTC audit cannot accept training rows after the vocabulary is frozen.");
    }

    const state = this.#splitStates[declaredSplit];
    state.rows += 1;
    if (row?.split !== declaredSplit) {
      state.splitMismatchRows += 1;
      keepExample(state.examples.splitMismatch, example(row, location));
    }
    if (row?.action !== "produce-candidate") {
      state.nonCandidateRows += 1;
      return;
    }
    state.candidateRows += 1;

    const input = analyzeInput(
      row?.input,
      this.#maxInputLength,
      declaredSplit === "train" ? null : this.#trainInputVocabulary
    );
    addHistogram(state.inputContentLengths, input.scalars.length);
    if (input.scalars.length === this.#maxInputLength - 1) {
      state.inputAtContentCapacityRows += 1;
    }
    if (!input.validAlphabet || !input.normalized) {
      state.inputInvalidRows += 1;
      keepExample(state.examples.invalidInput, {
        ...example(row, location),
        normalizedInput: input.normalized,
        issueCodes: input.issueCodes
      });
    }
    if (input.overCapacity) {
      state.inputOverCapacityRows += 1;
      keepExample(state.examples.inputOverCapacity, {
        ...example(row, location),
        normalizedInput: input.normalized,
        scalarLength: input.scalars.length,
        contentCapacity: this.#maxInputLength - 1
      });
    }
    if (input.unseenScalars.length > 0) {
      state.inputUnseenScalarRows += 1;
      addFrequencies(state.unseenInputScalars, input.unseenScalars);
      keepExample(state.examples.unseenInputScalars, {
        ...example(row, location),
        normalizedInput: input.normalized,
        unseenScalars: uniqueSorted(input.unseenScalars)
      });
    }
    if (declaredSplit === "train" && input.validAlphabet && !input.overCapacity) {
      addFrequencies(this.#trainInputVocabulary, input.scalars);
    }

    const targets = normalizedDatasetTargets(row);
    state.targetVariants += targets.length;
    if (targets.length === 0) {
      state.missingPrimaryTargetRows += 1;
      state.primaryInvalidRows += 1;
      state.rowsWithNoRepresentableTarget += 1;
      keepExample(state.examples.invalidPrimaryTarget, {
        ...example(row, location),
        issueCodes: ["empty"]
      });
      return;
    }

    const primary = analyzeTarget(
      targets[0],
      this.#outputTimeSteps,
      declaredSplit === "train" ? null : this.#trainOutputVocabulary
    );
    addHistogram(state.primaryScalarLengths, primary.scalars.length);
    addHistogram(state.primaryRequiredTimeSteps, primary.requiredTimeSteps);
    if (primary.requiredTimeSteps === this.#outputTimeSteps) {
      state.primaryAtAlignmentCapacityRows += 1;
    }
    if (primary.repeatedAdjacentScalars > 0) {
      state.primaryRepeatedScalarRows += 1;
      state.primaryRepeatedScalarBoundaries += primary.repeatedAdjacentScalars;
    }
    if (!primary.validSequence) {
      state.primaryInvalidRows += 1;
      keepExample(state.examples.invalidPrimaryTarget, {
        ...example(row, location),
        target: primary.normalized,
        issueCodes: primary.issueCodes
      });
    }
    if (primary.scalarOverflow) {
      state.primaryScalarOverflowRows += 1;
      keepExample(state.examples.primaryScalarOverflow, targetExample(
        row,
        location,
        primary,
        this.#outputTimeSteps
      ));
    }
    if (primary.alignmentOverflow) {
      state.primaryAlignmentOverflowRows += 1;
      keepExample(state.examples.primaryAlignmentOverflow, targetExample(
        row,
        location,
        primary,
        this.#outputTimeSteps
      ));
    }
    if (primary.unseenScalars.length > 0) {
      state.primaryUnseenScalarRows += 1;
      addFrequencies(state.unseenOutputScalars, primary.unseenScalars);
      keepExample(state.examples.unseenPrimaryOutputScalars, {
        ...example(row, location),
        target: primary.normalized,
        unseenScalars: uniqueSorted(primary.unseenScalars)
      });
    }
    if (
      declaredSplit === "train" &&
      primary.validSequence &&
      !primary.scalarOverflow &&
      !primary.alignmentOverflow
    ) {
      addFrequencies(this.#trainOutputVocabulary, primary.scalars);
    }

    let representableVariants = 0;
    targets.forEach((target, index) => {
      const analysis = index === 0
        ? primary
        : analyzeTarget(
          target,
          this.#outputTimeSteps,
          declaredSplit === "train" ? null : this.#trainOutputVocabulary
        );
      if (!analysis.validSequence) {
        state.invalidTargetVariants += 1;
        keepExample(state.examples.invalidTargetVariant, targetExample(
          row,
          location,
          analysis,
          this.#outputTimeSteps
        ));
      }
      if (analysis.scalarOverflow) {
        state.scalarOverflowTargetVariants += 1;
      }
      if (analysis.alignmentOverflow) {
        state.alignmentOverflowTargetVariants += 1;
        keepExample(state.examples.alignmentOverflowTargetVariant, targetExample(
          row,
          location,
          analysis,
          this.#outputTimeSteps
        ));
      }
      if (analysis.unseenScalars.length > 0) {
        state.unseenScalarTargetVariants += 1;
      }
      const outputRepresentable =
        analysis.validSequence &&
        !analysis.scalarOverflow &&
        !analysis.alignmentOverflow &&
        (
          declaredSplit === "train" ||
          analysis.unseenScalars.length === 0
        );
      if (input.representable && outputRepresentable) {
        representableVariants += 1;
      }
    });
    if (representableVariants === 0) {
      state.rowsWithNoRepresentableTarget += 1;
      keepExample(state.examples.noRepresentableTarget, {
        ...example(row, location),
        normalizedInput: input.normalized,
        targets
      });
    } else if (representableVariants < targets.length) {
      state.rowsWithPartiallyRepresentableTargets += 1;
    }
  }

  addInvalidJson(split, location, message) {
    if (!SPLITS.includes(split)) {
      throw new Error(`Unsupported CTC audit split: ${split}`);
    }
    const state = this.#splitStates[split];
    state.rows += 1;
    state.invalidJsonRows += 1;
    keepExample(state.examples.invalidJson, {
      location,
      message: String(message)
    });
  }

  finishTrainingSplit() {
    if (this.#trainingComplete) {
      throw new Error("CTC audit training vocabulary was already frozen.");
    }
    if (this.#splitStates.train.rows === 0) {
      throw new Error("CTC audit cannot freeze an empty training split.");
    }
    this.#trainingComplete = true;
  }

  addEvaluationRelease(name, rows) {
    if (!this.#trainingComplete) {
      throw new Error("CTC audit evaluation requires a frozen training vocabulary.");
    }
    if (Object.hasOwn(this.#evaluationStates, name)) {
      throw new Error(`Duplicate CTC evaluation release: ${name}`);
    }
    const state = createEvaluationState(name);
    for (const row of rows) {
      state.rows += 1;
      const input = analyzeInput(
        row?.input,
        this.#maxInputLength,
        this.#trainInputVocabulary
      );
      addHistogram(state.inputContentLengths, input.scalars.length);
      if (row?.expectedAction === "no-neural-candidate") {
        state.negativeRows += 1;
        continue;
      }
      state.positiveRows += 1;
      if (!input.representable) {
        state.inputUnrepresentableRows += 1;
        keepExample(state.examples.inputUnrepresentable, {
          id: row?.id ?? null,
          input: row?.input ?? null,
          normalizedInput: input.normalized,
          issueCodes: input.issueCodes,
          unseenScalars: uniqueSorted(input.unseenScalars)
        });
      }

      const targets = normalizedEvaluationTargets(row);
      state.targetVariants += targets.length;
      let representableTargets = 0;
      if (targets.length === 0) {
        state.positiveRowsWithoutTargets += 1;
      }
      for (const target of targets) {
        const analysis = analyzeTarget(
          target,
          this.#outputTimeSteps,
          this.#trainOutputVocabulary
        );
        addHistogram(state.targetScalarLengths, analysis.scalars.length);
        addHistogram(state.targetRequiredTimeSteps, analysis.requiredTimeSteps);
        if (!analysis.validSequence) state.invalidTargetVariants += 1;
        if (analysis.scalarOverflow) state.scalarOverflowTargetVariants += 1;
        if (analysis.alignmentOverflow) state.alignmentOverflowTargetVariants += 1;
        if (analysis.unseenScalars.length > 0) {
          state.unseenScalarTargetVariants += 1;
          addFrequencies(state.unseenOutputScalars, analysis.unseenScalars);
        }
        if (
          input.representable &&
          analysis.validSequence &&
          !analysis.scalarOverflow &&
          !analysis.alignmentOverflow &&
          analysis.unseenScalars.length === 0
        ) {
          representableTargets += 1;
        }
      }
      if (representableTargets === 0) {
        state.positiveRowsWithNoRepresentableTarget += 1;
        keepExample(state.examples.noRepresentableTarget, {
          id: row?.id ?? null,
          input: row?.input ?? null,
          normalizedInput: input.normalized,
          targets
        });
      } else {
        state.positiveRowsWithRepresentableTarget += 1;
        if (representableTargets < targets.length) {
          state.positiveRowsWithPartiallyRepresentableTargets += 1;
        }
      }
    }
    this.#evaluationStates[name] = state;
  }

  finalize({ model, dataset, artifacts }) {
    if (!this.#trainingComplete) {
      throw new Error("CTC audit cannot finalize before freezing training vocabulary.");
    }
    const splits = Object.fromEntries(
      SPLITS.map((split) => [split, finalizeDatasetState(this.#splitStates[split])])
    );
    const evaluation = Object.fromEntries(
      Object.entries(this.#evaluationStates)
        .sort(([left], [right]) => compareText(left, right))
        .map(([name, state]) => [name, finalizeEvaluationState(state)])
    );
    const summary = {
      datasetRows: SPLITS.reduce((sum, split) => sum + splits[split].rows, 0),
      datasetCandidateRows: SPLITS.reduce(
        (sum, split) => sum + splits[split].candidateRows,
        0
      ),
      datasetInputIncompatibleRows: SPLITS.reduce(
        (sum, split) =>
          sum +
          splits[split].inputInvalidRows +
          splits[split].inputOverCapacityRows +
          splits[split].inputUnseenScalarRows,
        0
      ),
      datasetInvalidTargetVariants: SPLITS.reduce(
        (sum, split) => sum + splits[split].invalidTargetVariants,
        0
      ),
      datasetPrimaryAlignmentOverflowRows: SPLITS.reduce(
        (sum, split) => sum + splits[split].primaryAlignmentOverflowRows,
        0
      ),
      heldOutPrimaryUnseenOutputRows:
        splits.dev.primaryUnseenScalarRows +
        splits.test.primaryUnseenScalarRows,
      datasetRowsWithNoRepresentableTarget: SPLITS.reduce(
        (sum, split) => sum + splits[split].rowsWithNoRepresentableTarget,
        0
      ),
      evaluationPositiveRows: Object.values(evaluation).reduce(
        (sum, state) => sum + state.positiveRows,
        0
      ),
      evaluationPositiveRowsWithNoRepresentableTarget: Object.values(
        evaluation
      ).reduce(
        (sum, state) => sum + state.positiveRowsWithNoRepresentableTarget,
        0
      )
    };
    const report = {
      schemaVersion: 1,
      contentIdentity: "lekh-neural-ctc-alignment-audit-v1",
      model: {
        ...model,
        inputTensorLength: this.#maxInputLength,
        inputContentCapacity: this.#maxInputLength - 1,
        inputEOSPositions: 1,
        outputTimeSteps: this.#outputTimeSteps,
        outputTokenization: "unicode-scalar-character",
        alignmentRule:
          "Unicode scalar count plus one mandatory blank separation for each adjacent repeated scalar.",
        outputSequenceValidation:
          DEVANAGARI_WORD_SEQUENCE_VALIDATOR_ID
      },
      dataset,
      artifacts,
      trainingVocabulary: {
        input: frequencyInventory(this.#trainInputVocabulary),
        output: frequencyInventory(this.#trainOutputVocabulary)
      },
      splits,
      evaluation,
      summary
    };
    report.findings = buildFindings(report);
    report.status = report.findings.some(
      (finding) => finding.severity === "error"
    )
      ? "failed-ctc-alignment-audit"
      : "passed-ctc-alignment-audit";
    return report;
  }
}

function analyzeInput(value, maxInputLength, vocabulary) {
  const normalized = normalizeCTCAuditInput(value);
  const scalars = [...normalized];
  const issueCodes = [];
  if (!normalized) issueCodes.push("empty");
  if (normalized && !ASCII_ROMAN_TOKEN.test(normalized)) {
    issueCodes.push("unsupported-input-scalar");
  }
  const overCapacity = scalars.length > maxInputLength - 1;
  if (overCapacity) issueCodes.push("input-content-capacity");
  const unseenScalars = vocabulary === null
    ? []
    : scalars.filter((scalar) => !vocabulary.has(scalar));
  if (unseenScalars.length > 0) issueCodes.push("unseen-input-scalar");
  const validAlphabet = Boolean(normalized) && ASCII_ROMAN_TOKEN.test(normalized);
  return {
    normalized,
    scalars,
    validAlphabet,
    overCapacity,
    unseenScalars,
    issueCodes,
    representable:
      validAlphabet &&
      !overCapacity &&
      unseenScalars.length === 0
  };
}

function analyzeTarget(value, outputTimeSteps, vocabulary) {
  const normalized = normalizeCTCAuditOutput(value);
  const scalars = [...normalized];
  const validation = validateDevanagariWordSequence(normalized);
  const requiredTimeSteps = ctcRequiredTimeSteps(scalars);
  const repeatedAdjacentScalars = requiredTimeSteps - scalars.length;
  const unseenScalars = vocabulary === null
    ? []
    : scalars.filter((scalar) => !vocabulary.has(scalar));
  return {
    normalized,
    scalars,
    validSequence: validation.valid,
    issueCodes: validation.issueCodes,
    requiredTimeSteps,
    repeatedAdjacentScalars,
    scalarOverflow: scalars.length > outputTimeSteps,
    alignmentOverflow: requiredTimeSteps > outputTimeSteps,
    unseenScalars
  };
}

function normalizedDatasetTargets(row) {
  const primary = typeof row?.target === "string" ? [row.target] : [];
  const acceptable = Array.isArray(row?.acceptable)
    ? row.acceptable.filter((value) => typeof value === "string")
    : [];
  return uniqueNormalizedOutputs([...primary, ...acceptable]);
}

function normalizedEvaluationTargets(row) {
  const expected = Array.isArray(row?.expected)
    ? row.expected.filter((value) => typeof value === "string")
    : [];
  const acceptable = Array.isArray(row?.acceptable)
    ? row.acceptable.filter((value) => typeof value === "string")
    : [];
  return uniqueNormalizedOutputs([...expected, ...acceptable]);
}

function uniqueNormalizedOutputs(values) {
  const output = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = normalizeCTCAuditOutput(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function createDatasetState(split) {
  return {
    split,
    rows: 0,
    candidateRows: 0,
    nonCandidateRows: 0,
    invalidJsonRows: 0,
    splitMismatchRows: 0,
    missingPrimaryTargetRows: 0,
    targetVariants: 0,
    inputContentLengths: new Map(),
    primaryScalarLengths: new Map(),
    primaryRequiredTimeSteps: new Map(),
    inputAtContentCapacityRows: 0,
    inputInvalidRows: 0,
    inputOverCapacityRows: 0,
    inputUnseenScalarRows: 0,
    primaryInvalidRows: 0,
    primaryScalarOverflowRows: 0,
    primaryAlignmentOverflowRows: 0,
    primaryAtAlignmentCapacityRows: 0,
    primaryRepeatedScalarRows: 0,
    primaryRepeatedScalarBoundaries: 0,
    primaryUnseenScalarRows: 0,
    invalidTargetVariants: 0,
    scalarOverflowTargetVariants: 0,
    alignmentOverflowTargetVariants: 0,
    unseenScalarTargetVariants: 0,
    rowsWithNoRepresentableTarget: 0,
    rowsWithPartiallyRepresentableTargets: 0,
    unseenInputScalars: new Map(),
    unseenOutputScalars: new Map(),
    examples: {
      invalidJson: [],
      splitMismatch: [],
      invalidInput: [],
      inputOverCapacity: [],
      unseenInputScalars: [],
      invalidPrimaryTarget: [],
      primaryScalarOverflow: [],
      primaryAlignmentOverflow: [],
      unseenPrimaryOutputScalars: [],
      invalidTargetVariant: [],
      alignmentOverflowTargetVariant: [],
      noRepresentableTarget: []
    }
  };
}

function createEvaluationState(name) {
  return {
    name,
    rows: 0,
    positiveRows: 0,
    negativeRows: 0,
    positiveRowsWithoutTargets: 0,
    positiveRowsWithRepresentableTarget: 0,
    positiveRowsWithNoRepresentableTarget: 0,
    positiveRowsWithPartiallyRepresentableTargets: 0,
    inputUnrepresentableRows: 0,
    targetVariants: 0,
    invalidTargetVariants: 0,
    scalarOverflowTargetVariants: 0,
    alignmentOverflowTargetVariants: 0,
    unseenScalarTargetVariants: 0,
    inputContentLengths: new Map(),
    targetScalarLengths: new Map(),
    targetRequiredTimeSteps: new Map(),
    unseenOutputScalars: new Map(),
    examples: {
      inputUnrepresentable: [],
      noRepresentableTarget: []
    }
  };
}

function finalizeDatasetState(state) {
  return {
    split: state.split,
    rows: state.rows,
    candidateRows: state.candidateRows,
    nonCandidateRows: state.nonCandidateRows,
    invalidJsonRows: state.invalidJsonRows,
    splitMismatchRows: state.splitMismatchRows,
    missingPrimaryTargetRows: state.missingPrimaryTargetRows,
    targetVariants: state.targetVariants,
    inputContentLength: summarizeHistogram(state.inputContentLengths),
    primaryTargetScalarLength: summarizeHistogram(state.primaryScalarLengths),
    primaryTargetRequiredTimeSteps: summarizeHistogram(
      state.primaryRequiredTimeSteps
    ),
    inputAtContentCapacityRows: state.inputAtContentCapacityRows,
    inputInvalidRows: state.inputInvalidRows,
    inputOverCapacityRows: state.inputOverCapacityRows,
    inputUnseenScalarRows: state.inputUnseenScalarRows,
    primaryInvalidRows: state.primaryInvalidRows,
    primaryScalarOverflowRows: state.primaryScalarOverflowRows,
    primaryAlignmentOverflowRows: state.primaryAlignmentOverflowRows,
    primaryAtAlignmentCapacityRows: state.primaryAtAlignmentCapacityRows,
    primaryRepeatedScalarRows: state.primaryRepeatedScalarRows,
    primaryRepeatedScalarBoundaries: state.primaryRepeatedScalarBoundaries,
    primaryUnseenScalarRows: state.primaryUnseenScalarRows,
    invalidTargetVariants: state.invalidTargetVariants,
    scalarOverflowTargetVariants: state.scalarOverflowTargetVariants,
    alignmentOverflowTargetVariants: state.alignmentOverflowTargetVariants,
    unseenScalarTargetVariants: state.unseenScalarTargetVariants,
    rowsWithNoRepresentableTarget: state.rowsWithNoRepresentableTarget,
    rowsWithPartiallyRepresentableTargets:
      state.rowsWithPartiallyRepresentableTargets,
    unseenInputScalars: frequencyInventory(state.unseenInputScalars),
    unseenOutputScalars: frequencyInventory(state.unseenOutputScalars),
    examples: state.examples
  };
}

function finalizeEvaluationState(state) {
  return {
    name: state.name,
    rows: state.rows,
    positiveRows: state.positiveRows,
    negativeRows: state.negativeRows,
    positiveRowsWithoutTargets: state.positiveRowsWithoutTargets,
    positiveRowsWithRepresentableTarget:
      state.positiveRowsWithRepresentableTarget,
    positiveRowsWithNoRepresentableTarget:
      state.positiveRowsWithNoRepresentableTarget,
    positiveRowsWithPartiallyRepresentableTargets:
      state.positiveRowsWithPartiallyRepresentableTargets,
    inputUnrepresentableRows: state.inputUnrepresentableRows,
    targetVariants: state.targetVariants,
    invalidTargetVariants: state.invalidTargetVariants,
    scalarOverflowTargetVariants: state.scalarOverflowTargetVariants,
    alignmentOverflowTargetVariants: state.alignmentOverflowTargetVariants,
    unseenScalarTargetVariants: state.unseenScalarTargetVariants,
    inputContentLength: summarizeHistogram(state.inputContentLengths),
    targetScalarLength: summarizeHistogram(state.targetScalarLengths),
    targetRequiredTimeSteps: summarizeHistogram(
      state.targetRequiredTimeSteps
    ),
    unseenOutputScalars: frequencyInventory(state.unseenOutputScalars),
    examples: state.examples
  };
}

function buildFindings(report) {
  const findings = [];
  const corruptSplits = Object.values(report.artifacts?.splits ?? {})
    .filter((artifact) => artifact.integrityMatches !== true);
  const corruptEvaluationSuites = Object.values(
    report.artifacts?.evaluationReferences ?? {}
  ).flatMap((reference) =>
    (reference.suites ?? []).filter(
      (artifact) => artifact.integrityMatches !== true
    )
  );
  if (corruptSplits.length + corruptEvaluationSuites.length > 0) {
    findings.push(finding(
      "error",
      "artifact-integrity-mismatch",
      "Dataset or evaluation bytes differ from their signed-in manifest inventory.",
      {
        datasetSplits: corruptSplits.map((artifact) => artifact.path),
        evaluationSuites: corruptEvaluationSuites.map(
          (artifact) => artifact.path
        )
      }
    ));
  }

  const declaredCounts = report.dataset?.declaredCounts ?? {};
  const observedCounts = Object.fromEntries(
    SPLITS.map((split) => [
      split,
      Number(report.artifacts?.splits?.[split]?.observed?.rows ?? 0)
    ])
  );
  const observedTotal = Object.values(observedCounts).reduce(
    (sum, value) => sum + value,
    0
  );
  if (
    observedTotal !== Number(report.dataset?.declaredRows) ||
    SPLITS.some(
      (split) => Number(declaredCounts[split]) !== observedCounts[split]
    )
  ) {
    findings.push(finding(
      "error",
      "declared-row-count-mismatch",
      "Dataset row counts do not reconcile with the active manifest.",
      {
        declaredRows: report.dataset?.declaredRows ?? null,
        declaredCounts,
        observedTotal,
        observedCounts
      }
    ));
  }

  for (const split of SPLITS) {
    const state = report.splits[split];
    const inputFailures =
      state.invalidJsonRows +
      state.splitMismatchRows +
      state.inputInvalidRows +
      state.inputOverCapacityRows +
      state.inputUnseenScalarRows;
    if (inputFailures > 0) {
      findings.push(finding(
        "error",
        `${split}-input-incompatibility`,
        `${inputFailures} ${split} row condition(s) cannot satisfy the fixed CTC input contract.`,
        {
          invalidJsonRows: state.invalidJsonRows,
          splitMismatchRows: state.splitMismatchRows,
          inputInvalidRows: state.inputInvalidRows,
          inputOverCapacityRows: state.inputOverCapacityRows,
          inputUnseenScalarRows: state.inputUnseenScalarRows
        }
      ));
    }
    if (
      state.invalidTargetVariants +
      state.primaryScalarOverflowRows +
      state.primaryAlignmentOverflowRows >
      0
    ) {
      findings.push(finding(
        "error",
        `${split}-target-incompatibility`,
        `${split} contains a structurally invalid or unalignable CTC target.`,
        {
          invalidTargetVariants: state.invalidTargetVariants,
          primaryScalarOverflowRows: state.primaryScalarOverflowRows,
          primaryAlignmentOverflowRows: state.primaryAlignmentOverflowRows
        }
      ));
    }
    if (split !== "train" && state.primaryUnseenScalarRows > 0) {
      findings.push(finding(
        "error",
        `${split}-unseen-primary-output-scalars`,
        `${state.primaryUnseenScalarRows} ${split} primary target(s) require output scalars absent from train.`,
        state.unseenOutputScalars
      ));
    }
    if (state.rowsWithNoRepresentableTarget > 0) {
      findings.push(finding(
        "error",
        `${split}-unrepresentable-rows`,
        `${state.rowsWithNoRepresentableTarget} ${split} row(s) have no target representable by the production CTC tensor and vocabulary.`,
        state.examples.noRepresentableTarget
      ));
    }
    if (state.alignmentOverflowTargetVariants > 0) {
      findings.push(finding(
        state.primaryAlignmentOverflowRows > 0 ? "error" : "warning",
        `${split}-acceptable-target-alignment-overflow`,
        `${state.alignmentOverflowTargetVariants} ${split} target variant(s) exceed the exact CTC alignment width.`,
        state.examples.alignmentOverflowTargetVariant
      ));
    }
  }

  for (const [name, state] of Object.entries(report.evaluation)) {
    if (state.positiveRowsWithoutTargets > 0) {
      findings.push(finding(
        "error",
        `${name}-missing-positive-targets`,
        `${state.positiveRowsWithoutTargets} positive ${name} row(s) have no accepted target.`,
        {}
      ));
    }
    if (state.positiveRowsWithNoRepresentableTarget > 0) {
      findings.push(finding(
        "error",
        `${name}-unrepresentable-positive-rows`,
        `${state.positiveRowsWithNoRepresentableTarget} positive ${name} row(s) cannot be represented by the production CTC tensor and train vocabulary.`,
        state.examples.noRepresentableTarget
      ));
    }
  }

  const rareOutputScalars = report.trainingVocabulary.output.tokens.filter(
    (token) => token.count <= 5
  );
  if (rareOutputScalars.length > 0) {
    findings.push(finding(
      "warning",
      "sparse-ctc-output-scalar-tail",
      `${rareOutputScalars.length} train output scalar(s) occur five times or fewer; final candidate review must inspect rare-class predictions.`,
      {
        maximumOccurrences: 5,
        tokens: rareOutputScalars
      }
    ));
  }

  const repeatedRows = SPLITS.reduce(
    (sum, split) => sum + report.splits[split].primaryRepeatedScalarRows,
    0
  );
  findings.push(finding(
    "info",
    "ctc-repeat-separation-measured",
    `${repeatedRows} dataset row(s) require at least one CTC blank separation; the reported alignment width includes every such boundary.`,
    {
      rows: repeatedRows,
      boundaries: SPLITS.reduce(
        (sum, split) =>
          sum + report.splits[split].primaryRepeatedScalarBoundaries,
        0
      )
    }
  ));
  if (!findings.some((item) => item.severity === "error")) {
    findings.push(finding(
      "info",
      "ctc-representation-contract-satisfied",
      "Every candidate dataset row and positive evaluation row is representable by the exact production CTC tensor, validator, and train vocabulary.",
      report.summary
    ));
  }
  return findings;
}

function finding(severity, code, message, evidence) {
  return { severity, code, message, evidence };
}

function summarizeHistogram(histogram) {
  const sorted = [...histogram].sort(
    ([left], [right]) => Number(left) - Number(right)
  );
  const rows = sorted.reduce((sum, [, count]) => sum + count, 0);
  const total = sorted.reduce(
    (sum, [value, count]) => sum + Number(value) * count,
    0
  );
  return {
    rows,
    min: sorted[0]?.[0] ?? null,
    mean: rows > 0 ? round(total / rows) : null,
    p50: histogramQuantile(sorted, rows, 0.5),
    p90: histogramQuantile(sorted, rows, 0.9),
    p95: histogramQuantile(sorted, rows, 0.95),
    p99: histogramQuantile(sorted, rows, 0.99),
    p999: histogramQuantile(sorted, rows, 0.999),
    max: sorted.at(-1)?.[0] ?? null,
    tail: Object.fromEntries(
      sorted.filter(([value]) => Number(value) >= 24)
    )
  };
}

function histogramQuantile(sorted, total, fraction) {
  if (total === 0) return null;
  const threshold = Math.max(1, Math.ceil(total * fraction));
  let cumulative = 0;
  for (const [value, count] of sorted) {
    cumulative += count;
    if (cumulative >= threshold) return Number(value);
  }
  return Number(sorted.at(-1)?.[0]);
}

function frequencyInventory(frequencies) {
  const entries = [...frequencies]
    .map(([token, count]) => ({
      token,
      codePoint: codePointLabel(token),
      count
    }))
    .sort((left, right) => compareText(left.token, right.token));
  return {
    distinct: entries.length,
    occurrences: entries.reduce((sum, entry) => sum + entry.count, 0),
    singletons: entries.filter((entry) => entry.count === 1).length,
    tokens: entries
  };
}

function targetExample(row, location, analysis, outputTimeSteps) {
  return {
    ...example(row, location),
    target: analysis.normalized,
    scalarLength: analysis.scalars.length,
    repeatedAdjacentScalars: analysis.repeatedAdjacentScalars,
    requiredTimeSteps: analysis.requiredTimeSteps,
    outputTimeSteps,
    issueCodes: analysis.issueCodes,
    unseenScalars: uniqueSorted(analysis.unseenScalars)
  };
}

function example(row, location) {
  return {
    location,
    id: row?.id ?? null,
    input: row?.input ?? null,
    target: row?.target ?? null
  };
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareText);
}

function codePointLabel(value) {
  return [...String(value)]
    .map((scalar) =>
      `U+${scalar.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`
    )
    .join(" ");
}

function addHistogram(histogram, value) {
  histogram.set(value, (histogram.get(value) ?? 0) + 1);
}

function addFrequencies(frequencies, values) {
  for (const value of values) {
    frequencies.set(value, (frequencies.get(value) ?? 0) + 1);
  }
}

function keepExample(values, candidate, maximum = 10) {
  if (values.length >= maximum) return;
  const identity = JSON.stringify(candidate);
  if (!values.some((value) => JSON.stringify(value) === identity)) {
    values.push(candidate);
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function round(value) {
  return Number(Number(value).toFixed(8));
}
