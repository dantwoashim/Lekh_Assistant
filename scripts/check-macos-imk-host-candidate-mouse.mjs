#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  automationPermissionPrecondition,
  consoleSessionPrecondition,
  currentInputSource,
  exactRuntimeHealthIssues,
  installedBundleIdentity,
  lekhInputSourceId,
  prepareExactTextEdit,
  processExecutablePath,
  processIdentity,
  readRuntimeHealth,
  removeProbeFile,
  restorePreference as restoreExactPreference,
  restoreExactInputSource,
  run,
  snapshotPreference as snapshotExactPreference,
  terminateColdTextEdit,
  terminateExactProcess,
  wait,
  waitForExactRuntimeHealth,
  writePreference
} from "./lib/macos-imk-host-harness.mjs";
import {
  acquireCandidateMouseRecoveryLock,
  assertCandidateMouseRecoveryGuardianAlive,
  candidatePreferenceRecoveryEntries,
  createCandidateMouseTemporaryDocument,
  ensureCandidateMouseButtonReleased,
  launchCandidateMouseRecoveryGuardian,
  markCandidateMouseRecoveryComplete,
  prepareCandidateMouseRecovery,
  recoverCandidateMouseState,
  releaseCandidateMouseRecoveryLock,
  signalCandidateMouseRecoveryGuardianCompletion,
  triggerCandidateMouseRecoveryGuardian,
  updateCandidateMouseRecovery,
  waitForCandidateMouseRecoveryGuardian
} from "./lib/macos-candidate-mouse-recovery.mjs";
import {
  buildCandidateMouseReport,
  captureCandidateMouseEvidenceProvenance,
  CANDIDATE_MOUSE_EVIDENCE_SOURCE_PATHS
} from "./lib/macos-candidate-mouse-report.mjs";
import { artifactProvenanceEvidence } from "./lib/macos-imk-build-identity.mjs";
import {
  inspectExactTextEditPassively,
  passiveExactTextEditInspectionSource
} from "./lib/macos-textedit-passive-inspection.mjs";
import { startCandidateTextEditCustodian } from "./lib/macos-candidate-textedit-custody.mjs";

const root = process.cwd();
const startedAt = performance.now();
const appBundle = join(homedir(), "Library", "Input Methods", "Lekh Keyboard.app");
const registerScript = join(root, "native", "macos-imk", "skeleton", "register-dev.swift");
const restoreScript = join(root, "native", "macos-imk", "skeleton", "restore-system-keyboard.sh");
const runtimeHealthPath = join(homedir(), "Library", "Application Support", "Lekh Keyboard", "runtime-health.v1.json");
const reportPath = join(root, "reports", "macos-imk-host-candidate-mouse.json");
let tempTextEditFile = null;
const documentPrefix = "probe ";
const token = "pani";
const preferencesDomain = "com.lekh.inputmethod.LekhKeyboard";
const preferencesNotification = "com.lekh.inputmethod.preferences.changed";
const preferenceKeys = {
  personalization: "LekhPersonalizationEnabled",
  diagnostics: "LekhHostProbeDiagnosticsEnabled",
  inlinePreview: "LekhInlinePreviewEnabled",
  customCandidatePanel: "LekhCustomCandidatePanelEnabled",
  nativeMode: "LekhNativeTypingMode",
  nativeModeChosen: "LekhNativeTypingModeChosen.v2"
};
const failures = [];

class ProbeFinished extends Error {}

let result = null;
let coldTextEditPid = null;
let coldTextEditIdentity = null;
let realTempTextEditFile = null;
let previousInputSource = null;
let preferenceSnapshots = null;
let bundleIdentity = null;
let runtimeEvidence = null;
let cleanupEvidence = null;
let runtimeEpochBaseline = null;
let sourceProvenanceBaseline = null;
let evidenceProvenance = null;
let artifactProvenanceBaseline = null;
let artifactProvenance = null;
let pointerBaselineRestored = true;
let recoveryLock = null;
let recoveryTransaction = null;
let recoveryGuardian = null;
let recoveryGuardianPromise = null;
let finalizationPromise = null;
let reportWritten = false;
let terminationRequested = false;
let activeSyntheticHelper = null;
const runtimeEpochCheckpoints = [];
const recoveryEvidence = {
  lockAcquired: false,
  startupDisposition: "unverified",
  guardianReady: false,
  guardianDisposition: "unverified",
  durableJournalRemoved: false
};
const proofEvidence = {
  personalizationDisabled: false,
  candidatePanelIdentifierMatched: false,
  candidateCount: 0,
  firstTwoRowsDistinctDevanagariTokens: false,
  markedCompositionMatchedFirstCandidate: false,
  passivePostconditionCount: 0,
  postconditionsPassivelyObserved: false,
  dragAwayPreservedComposition: false,
  dragAwayPanelRemainedVisible: false,
  nonFirstCandidateCommitted: false,
  firstCandidateNotCommitted: false,
  noCandidateRowsAfterCommit: false,
  frontmostTextEditPreserved: false,
  exactTextEditFrontmostInvariantPreserved: false,
  dragCancellationReceiptActivationMatched: false,
  dragCancellationReceiptDelta: null,
  dragCancellationReceiptTimestampCausal: false,
  clickCancellationReceiptActivationMatched: false,
  clickCancellationReceiptDelta: null,
  clickCancellationReceiptTimestampUnchanged: false,
  dragGesture: null,
  clickGesture: null
};

function conclude(status, details = {}, code = 0) {
  result = { status, details, code };
  throw new ProbeFinished(status);
}

function blocked(step, details = {}) {
  failures.push(`Automation was blocked at ${step}.`);
  conclude("blocked-automation", {
    step,
    note: "The candidate mouse proof needs Accessibility and Input Monitoring permission for exact AX geometry and CGEvent delivery.",
    ...details
  }, 2);
}

function failed(step, message, details = {}) {
  failures.push(message);
  conclude("failed", { step, ...details }, 1);
}

function finishMouseGestureFailure(step, gesture) {
  if (gesture.failureKind === "permission-blocked") {
    blocked(step, { mouseGesture: gesture });
  }
  failed(
    step,
    "The guarded mouse helper violated an event, pointer, routing, or evidence invariant.",
    { mouseGesture: gesture }
  );
}

function notifyPreferencesChanged() {
  return run("notifyutil", ["-p", preferencesNotification]);
}

function refreshCurrentPassProvenance(finalResult) {
  if (
    finalResult.status !== "passed" ||
    !evidenceProvenance ||
    !artifactProvenance ||
    !runtimeEpochBaseline
  ) return;
  const currentSource = captureCandidateMouseEvidenceProvenance(root);
  const expectedSource = { ...evidenceProvenance, stableDuringProbe: false };
  const sourceStillCurrent = JSON.stringify(currentSource) === JSON.stringify(expectedSource);
  evidenceProvenance = { ...currentSource, stableDuringProbe: sourceStillCurrent };

  const currentArtifact = artifactProvenanceEvidence({
    root,
    appBundle,
    bundleIdentity: installedBundleIdentity(appBundle),
    runtimeRecord: readRuntimeHealth(runtimeHealthPath).record,
    evidenceRevision: currentSource.gitRevision
  });
  const expectedArtifact = { ...artifactProvenance, stableDuringProbe: undefined };
  delete expectedArtifact.stableDuringProbe;
  const artifactStillCurrent = currentArtifact.localArtifactIntegrityVerified === true &&
    JSON.stringify(currentArtifact.artifactProvenance) === JSON.stringify(expectedArtifact);
  artifactProvenance = {
    ...currentArtifact.artifactProvenance,
    stableDuringProbe: artifactStillCurrent
  };
}

function writeReport() {
  if (reportWritten) return;
  reportWritten = true;
  const finalResult = result ?? { status: "failed", details: { step: "unknown" }, code: 1 };
  refreshCurrentPassProvenance(finalResult);
  mkdirSync(join(root, "reports"), { recursive: true });
  const report = buildCandidateMouseReport({
    generatedAt: new Date().toISOString(),
    durationMs: performance.now() - startedAt,
    status: finalResult.status,
    step: finalResult.details?.step ?? (finalResult.status === "passed" ? "complete" : "unknown"),
    failureCount: failures.length,
    bundleIdentity,
    epoch: {
      pinned: Boolean(runtimeEpochBaseline),
      processIdentifier: runtimeEpochBaseline?.record?.processIdentifier ?? null,
      activationIdentifier: runtimeEpochBaseline?.record?.activationIdentifier ?? null,
      controllerInstanceIdentifier: runtimeEpochBaseline?.record?.controllerInstanceIdentifier ?? null,
      checkpoints: runtimeEpochCheckpoints
    },
    sourceProvenance: evidenceProvenance,
    artifactProvenance,
    recovery: recoveryEvidence,
    cleanup: cleanupEvidence,
    proof: proofEvidence
  });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const effectiveExitCode = finalResult.status === "passed" && report.status !== "passed"
    ? 1
    : finalResult.code;
  console[effectiveExitCode === 0 ? "log" : effectiveExitCode === 2 ? "warn" : "error"](JSON.stringify(report, null, 2));
  process.exitCode = effectiveExitCode;
}

function boundedAppend(current, chunk, limit = 512 * 1024) {
  const next = current + chunk;
  return Buffer.byteLength(next, "utf8") <= limit ? next : current;
}

function registerActiveSyntheticHelper({ child, closed, kind }) {
  if (activeSyntheticHelper !== null) {
    throw new Error("A synthetic event helper is already under custody.");
  }
  const state = {
    child,
    closed,
    kind,
    identity: null,
    journaled: false,
    stopPromise: null
  };
  activeSyntheticHelper = state;
  return state;
}

function journalActiveSyntheticHelper(state, executablePath) {
  if (activeSyntheticHelper !== state || state.journaled) {
    throw new Error("Synthetic helper custody changed before authorization.");
  }
  const observed = processIdentity(state.child.pid);
  if (
    observed.status !== 0 ||
    observed.state !== "running" ||
    observed.executablePath !== executablePath
  ) {
    throw new Error("Synthetic helper process identity could not be pinned.");
  }
  assertCandidateMouseRecoveryGuardianAlive(recoveryGuardian);
  const durable = updateCandidateMouseRecovery(recoveryTransaction, {
    gestureHelperProcess: {
      processIdentifier: observed.processIdentifier,
      executablePath: observed.executablePath,
      role: state.kind
    }
  }).gestureHelperProcess;
  if (
    durable?.processIdentifier !== observed.processIdentifier ||
    durable?.executablePath !== observed.executablePath ||
    durable?.processStartToken !== observed.processStartToken ||
    durable?.role !== state.kind
  ) {
    throw new Error("Durable synthetic helper identity did not match the live process epoch.");
  }
  state.identity = Object.freeze({
    processIdentifier: durable.processIdentifier,
    executablePath: durable.executablePath,
    processStartToken: durable.processStartToken
  });
  state.journaled = true;
  assertCandidateMouseRecoveryGuardianAlive(recoveryGuardian);
}

function clearActiveSyntheticHelperJournal(state) {
  if (!state.journaled) return;
  assertCandidateMouseRecoveryGuardianAlive(recoveryGuardian);
  updateCandidateMouseRecovery(recoveryTransaction, { gestureHelperProcess: null });
  state.journaled = false;
  assertCandidateMouseRecoveryGuardianAlive(recoveryGuardian);
}

async function retireSyntheticHelper(state) {
  clearActiveSyntheticHelperJournal(state);
  if (activeSyntheticHelper === state) activeSyntheticHelper = null;
}

async function stopAndAwaitActiveSyntheticHelper() {
  const state = activeSyntheticHelper;
  if (!state) return true;
  if (state.stopPromise) return state.stopPromise;
  state.stopPromise = (async () => {
    try { state.child.stdin.end(); } catch {}
    if (state.child.exitCode === null && state.child.signalCode === null) {
      let identity = state.identity;
      if (!identity && Number.isInteger(state.child.pid)) {
        const observed = processIdentity(state.child.pid);
        if (observed.status === 0 && observed.state === "running") {
          identity = {
            processIdentifier: observed.processIdentifier,
            executablePath: observed.executablePath,
            processStartToken: observed.processStartToken
          };
        }
      }
      if (identity) {
        const termination = terminateExactProcess(identity, {
          termTimeoutMs: 1_500,
          killTimeoutMs: 1_000,
          pollIntervalMs: 25
        });
        if (termination.status !== 0 || termination.terminated !== true) return false;
      } else {
        // This branch is limited to a child that never reached READY and was
        // therefore never authorized to synthesize an event.
        state.child.kill("SIGTERM");
      }
    }
    const completion = await Promise.race([
      state.closed,
      new Promise((resolve) => setTimeout(() => resolve(null), 3_000))
    ]);
    if (!completion) return false;
    try {
      await retireSyntheticHelper(state);
    } catch {
      return false;
    }
    return true;
  })();
  return state.stopPromise;
}

async function awaitSyntheticHelperClosure(state, timeoutMs) {
  if (!state || activeSyntheticHelper !== state) {
    return { timedOut: false, stopped: true, completion: await state?.closed };
  }
  const timedOut = Symbol("synthetic-helper-timeout");
  const completion = await Promise.race([
    state.closed,
    new Promise((resolve) => setTimeout(() => resolve(timedOut), timeoutMs))
  ]);
  if (completion !== timedOut) {
    return { timedOut: false, stopped: true, completion };
  }
  return {
    timedOut: true,
    stopped: await stopAndAwaitActiveSyntheticHelper(),
    completion: null
  };
}

async function launchColdTextEditUnderCustody(documentPath) {
  const parentIdentity = processIdentity(process.pid);
  if (parentIdentity.status !== 0 || parentIdentity.state !== "running") {
    return { status: 3, pid: null, stderr: "The TextEdit-launch parent epoch could not be pinned." };
  }
  let custodian;
  let state = null;
  try {
    custodian = startCandidateTextEditCustodian({ documentPath, parentIdentity });
    await custodian.waitForReady();
    state = registerActiveSyntheticHelper({
      child: custodian.child,
      closed: custodian.closed,
      kind: "textedit-launch-custodian"
    });
    const liveHelper = processIdentity(custodian.pid);
    if (liveHelper.status !== 0 || liveHelper.state !== "running") {
      throw new Error("TextEdit-launch custodian identity was unavailable at READY.");
    }
    journalActiveSyntheticHelper(state, liveHelper.executablePath);
    if (terminationRequested) throw new Error("Probe termination began before TextEdit launch authorization.");
    custodian.authorizeLaunch(state.identity);
    const host = await custodian.waitForHost();
    if (terminationRequested) throw new Error("Probe termination began before TextEdit host publication.");
    assertCandidateMouseRecoveryGuardianAlive(recoveryGuardian);
    const durable = updateCandidateMouseRecovery(recoveryTransaction, {
      hostProcess: {
        processIdentifier: host.processIdentifier,
        executablePath: host.executablePath
      }
    }).hostProcess;
    if (
      durable?.processIdentifier !== host.processIdentifier ||
      durable?.executablePath !== host.executablePath ||
      durable?.processStartToken !== host.processStartToken
    ) throw new Error("Durable TextEdit identity did not match the custodian's live host epoch.");
    assertCandidateMouseRecoveryGuardianAlive(recoveryGuardian);
    if (terminationRequested) throw new Error("Probe termination began before TextEdit custody release.");
    custodian.releaseToRecovery(durable);
    await custodian.waitForReleased();
    const closure = await awaitSyntheticHelperClosure(state, 3_000);
    if (closure.timedOut || !closure.completion) {
      throw new Error("TextEdit-launch custodian exceeded its bounded RELEASE shutdown window.");
    }
    const completion = closure.completion;
    if (completion.status !== 0 || completion.signal !== null) {
      throw new Error("TextEdit-launch custodian did not close at its RELEASE boundary.");
    }
    await retireSyntheticHelper(state);
    return {
      status: 0,
      pid: host.processIdentifier,
      launchedAtMs: host.launchedAtUnixMs,
      executablePath: host.executablePath,
      processStartToken: host.processStartToken,
      launchMethod: "ready-go-durable-host-release"
    };
  } catch (error) {
    try { custodian?.abort(); } catch {}
    if (state && activeSyntheticHelper === state) {
      await stopAndAwaitActiveSyntheticHelper();
    } else if (custodian) {
      await Promise.race([
        custodian.closed,
        new Promise((resolve) => setTimeout(resolve, 3_000))
      ]);
    }
    const output = custodian?.output() ?? { stdout: "", stderr: "", protocolError: null };
    return {
      status: 3,
      pid: null,
      stdout: output.stdout,
      stderr: [error.message, output.protocolError, output.stderr].filter(Boolean).join(" ")
    };
  }
}

async function postTextEditKeys(keyCodes, targetPid) {
  if (
    !runtimeEpochBaseline ||
    targetPid !== coldTextEditPid ||
    targetPid !== coldTextEditIdentity?.pid ||
    !realTempTextEditFile
  ) {
    return { status: 3, stdout: "", stderr: "Exact key-helper custody was unavailable." };
  }
  const parentIdentity = processIdentity(process.pid);
  if (parentIdentity.status !== 0 || parentIdentity.state !== "running") {
    return { status: 3, stdout: "", stderr: "The probe parent process epoch could not be pinned." };
  }
  const helper = spawn("/usr/bin/swift", ["-e", targetedKeyPostingSource({
    keyCodes,
    targetPid,
    targetExecutablePath: coldTextEditIdentity.executablePath,
    targetProcessStartToken: coldTextEditIdentity.processStartToken,
    temporaryDocumentPath: realTempTextEditFile,
    parentIdentity,
    expectedRuntimeEpoch: gestureRuntimeEpoch()
  })], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let outputOverflow = false;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  helper.stdout.setEncoding("utf8");
  helper.stderr.setEncoding("utf8");
  helper.stdout.on("data", (chunk) => {
    const next = boundedAppend(stdout, chunk);
    if (next === stdout && chunk.length > 0) outputOverflow = true;
    stdout = next;
    const line = stdout.split(/\r?\n/u).find((item) => item.startsWith("LEKH_KEY_READY:"));
    if (!line) return;
    try {
      resolveReady(JSON.parse(Buffer.from(line.slice("LEKH_KEY_READY:".length), "base64").toString("utf8")));
    } catch {
      resolveReady(false);
    }
  });
  helper.stderr.on("data", (chunk) => {
    const next = boundedAppend(stderr, chunk);
    if (next === stderr && chunk.length > 0) outputOverflow = true;
    stderr = next;
  });
  const closed = new Promise((resolveClosed) => {
    helper.once("error", (error) => {
      resolveReady(false);
      resolveClosed({ status: 3, signal: null, error });
    });
    helper.once("close", (status, signal) => {
      resolveReady(false);
      resolveClosed({ status: status ?? 3, signal, error: null });
    });
  });
  let state;
  try {
    state = registerActiveSyntheticHelper({ child: helper, closed, kind: "targeted-keys" });
  } catch (error) {
    helper.stdin.end();
    helper.kill("SIGTERM");
    await closed;
    return { status: 3, stdout: "", stderr: error.message };
  }
  const readiness = await Promise.race([
    ready,
    new Promise((resolve) => setTimeout(() => resolve(false), 8_000))
  ]);
  const readyIsExact = readiness?.schemaVersion === 1 &&
    readiness?.processIdentifier === helper.pid &&
    readiness?.eventCount === keyCodes.length;
  if (terminationRequested || !readyIsExact) {
    const stopped = await stopAndAwaitActiveSyntheticHelper();
    return {
      status: 3,
      stdout: "",
      stderr: stopped ? "Key helper was not authorized." : "Key helper could not be stopped exactly."
    };
  }
  const helperIdentity = processIdentity(helper.pid);
  try {
    if (helperIdentity.status !== 0 || helperIdentity.state !== "running") {
      throw new Error("Key helper process identity was unavailable at READY.");
    }
    journalActiveSyntheticHelper(state, helperIdentity.executablePath);
    if (terminationRequested) throw new Error("Probe termination began before key-helper authorization.");
    helper.stdin.end("GO\n");
  } catch (error) {
    await stopAndAwaitActiveSyntheticHelper();
    return { status: 3, stdout: "", stderr: error.message };
  }
  const closure = await awaitSyntheticHelperClosure(state, 5_000);
  if (closure.timedOut || !closure.completion) {
    return {
      status: 3,
      stdout,
      stderr: closure.stopped
        ? "Key helper exceeded its bounded post-GO execution window."
        : "Key helper timed out and exact termination remains unproven."
    };
  }
  const completion = closure.completion;
  if (terminationRequested) {
    return { status: 3, stdout: "", stderr: "Key helper was interrupted." };
  }
  try {
    await retireSyntheticHelper(state);
  } catch (error) {
    return { status: 3, stdout: "", stderr: error.message };
  }
  const line = stdout.trim().split(/\r?\n/u).at(-1) ?? "";
  let evidence = null;
  try { evidence = JSON.parse(line); } catch {}
  const expectedGuardChecks = keyCodes.length * 2;
  const valid = completion.status === 0 && completion.signal === null && !outputOverflow &&
    evidence?.schemaVersion === 1 &&
    evidence?.completed === true &&
    evidence?.eventCount === keyCodes.length &&
    evidence?.downCount === keyCodes.length &&
    evidence?.upCount === keyCodes.length &&
    evidence?.guardCheckCount === expectedGuardChecks &&
    evidence?.compensatingKeyUpCount === 0;
  return {
    status: valid ? 0 : completion.status || 3,
    stdout,
    stderr,
    evidence
  };
}

function inspectCandidatePostcondition() {
  const observation = inspectExactTextEditPassively(coldTextEditPid, realTempTextEditFile);
  if (observation.status === 0) proofEvidence.passivePostconditionCount += 1;
  return observation;
}

function candidateDragCancellationReceipt() {
  const read = readRuntimeHealth(runtimeHealthPath);
  const record = read.record;
  const expected = runtimeEpochBaseline?.record;
  const timestamp = typeof record?.lastCandidateDragCancellationAt === "string"
    ? record.lastCandidateDragCancellationAt
    : null;
  const timestampMs = timestamp === null ? null : Date.parse(timestamp);
  const count = Number.isInteger(record?.candidateDragCancellationCount)
    ? record.candidateDragCancellationCount
    : null;
  const activationMatched = Boolean(expected) &&
    record?.processIdentifier === expected.processIdentifier &&
    record?.controllerInstanceIdentifier === expected.controllerInstanceIdentifier &&
    record?.activationIdentifier === expected.activationIdentifier &&
    record?.controllerIsActive === true;
  const countAndTimestampValid = Number.isInteger(count) &&
    count >= 0 &&
    count <= 10_000 &&
    ((count === 0 && timestamp === null) || (count > 0 && Number.isFinite(timestampMs)));
  return {
    readable: read.readError === null || read.readError === undefined,
    activationMatched,
    countAndTimestampValid,
    count,
    timestamp,
    timestampMs
  };
}

function waitForCandidateDragCancellationReceipt({ baseline, notBeforeSecondMs, timeoutMs = 3_000 }) {
  const deadline = Date.now() + timeoutMs;
  let latest = candidateDragCancellationReceipt();
  while (Date.now() < deadline) {
    latest = candidateDragCancellationReceipt();
    const delta = Number.isInteger(latest.count) ? latest.count - baseline.count : null;
    const timestampCausal = Number.isFinite(latest.timestampMs) &&
      latest.timestampMs >= notBeforeSecondMs &&
      latest.timestampMs >= (baseline.timestampMs ?? 0) &&
      latest.timestampMs <= Math.ceil(Date.now() / 1_000) * 1_000;
    if (
      latest.readable &&
      latest.activationMatched &&
      latest.countAndTimestampValid &&
      delta === 1 &&
      timestampCausal
    ) {
      return { ...latest, delta, timestampCausal };
    }
    if (Number.isInteger(delta) && delta > 1) {
      return { ...latest, delta, timestampCausal };
    }
    wait(25);
  }
  const delta = Number.isInteger(latest.count) ? latest.count - baseline.count : null;
  return {
    ...latest,
    delta,
    timestampCausal: Number.isFinite(latest.timestampMs) &&
      latest.timestampMs >= notBeforeSecondMs &&
      latest.timestampMs >= (baseline.timestampMs ?? 0) &&
      latest.timestampMs <= Math.ceil(Date.now() / 1_000) * 1_000
  };
}

function waitForCandidateSurface(inputMethodPid, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = { status: 3, surface: null, stderr: "Candidate surface was not queried." };
  while (Date.now() < deadline) {
    latest = candidateSurface(inputMethodPid);
    const window = latest.surface?.windows?.find((item) =>
      item.identifier === "lekh.candidatePanel" &&
      item.role === "AXWindow" &&
      item.rows?.some((row) => row.identifier === "lekh.candidate.0") &&
      item.rows?.some((row) => row.identifier === "lekh.candidate.1")
    );
    if (latest.status === 0 && window) return { ...latest, window };
    wait(100);
  }
  return latest;
}

function candidateText(row) {
  const fields = String(row?.label ?? "").split(",").map((field) => field.trim());
  const text = fields[1] ?? "";
  return text;
}

function validateCandidateSurface(observation, step) {
  const window = observation.window;
  if (!window) failed(step, "The exact AXWindow lekh.candidatePanel was not present.", observation);
  const first = window.rows.find((row) => row.identifier === "lekh.candidate.0");
  const second = window.rows.find((row) => row.identifier === "lekh.candidate.1");
  const firstText = candidateText(first);
  const secondText = candidateText(second);
  const frameIsValid = (row) =>
    row?.role === "AXButton" &&
    Number.isFinite(row?.frame?.x) &&
    Number.isFinite(row?.frame?.y) &&
    row.frame.width >= 80 &&
    row.frame.height >= 20 &&
    containsFrame(window.frame, row.frame);
  if (!frameIsValid(first) || !frameIsValid(second)) {
    failed(step, "Candidate rows 0 and 1 did not expose valid button geometry inside the exact panel window.", observation);
  }
  if (
    !firstText ||
    !secondText ||
    firstText === secondText ||
    !/\p{Script=Devanagari}/u.test(firstText) ||
    !/\p{Script=Devanagari}/u.test(secondText) ||
    /\s/u.test(firstText) ||
    /\s/u.test(secondText)
  ) {
    failed(step, "The first two candidate labels did not expose two distinct Devanagari tokens.", {
      firstText,
      secondText,
      observation
    });
  }
  proofEvidence.candidatePanelIdentifierMatched = true;
  proofEvidence.candidateCount = window.rows.filter((row) => row.identifier.startsWith("lekh.candidate.")).length;
  proofEvidence.firstTwoRowsDistinctDevanagariTokens = true;
  return { window, first, second, firstText, secondText };
}

function containsFrame(outer, inner) {
  const tolerance = 1;
  return inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance;
}

function center(frame) {
  return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

const pinnedBundleFields = [
  "bundlePath",
  "executablePath",
  "bundleIdentifier",
  "shortVersion",
  "buildVersion",
  "connectionName",
  "executableSha256",
  "codeDirectoryHash"
];
const pinnedRuntimeFields = [
  "bundleIdentifier",
  "bundleVersion",
  "connectionName",
  "processIdentifier",
  "executableStartedAt",
  "serverStartedAt",
  "controllerInitializedAt",
  "controllerActivatedAt",
  "controllerInstanceIdentifier",
  "activationIdentifier",
  "controllerIsActive"
];

function changedPinnedFields(expected, observed, fields) {
  return fields.filter((field) => expected?.[field] !== observed?.[field]);
}

function verifyPinnedRuntimeEpoch(label) {
  if (!runtimeEpochBaseline) {
    runtimeEpochCheckpoints.push({ label, verified: false });
    failed(label, "The installed/runtime epoch was not pinned before a gesture.");
  }
  const observedBundle = installedBundleIdentity(appBundle);
  const observedHealth = readRuntimeHealth(runtimeHealthPath);
  const observedProcessIdentity = processIdentity(runtimeEpochBaseline.record.processIdentifier);
  const bundleChanges = changedPinnedFields(runtimeEpochBaseline.bundleIdentity, observedBundle, pinnedBundleFields);
  const runtimeChanges = changedPinnedFields(runtimeEpochBaseline.record, observedHealth.record, pinnedRuntimeFields);
  const healthIssues = exactRuntimeHealthIssues({
    record: observedHealth.record,
    runtimeHealthPath,
    bundleIdentity: observedBundle,
    activatedAfterMs: runtimeEpochBaseline.activatedAfterMs,
    healthMtimeMs: observedHealth.mtimeMs ?? null
  });
  const processIdentityStable = observedProcessIdentity.status === 0 &&
    observedProcessIdentity.state === "running" &&
    observedProcessIdentity.executablePath === runtimeEpochBaseline.processIdentity.executablePath &&
    observedProcessIdentity.processStartToken === runtimeEpochBaseline.processIdentity.processStartToken;
  const verified = bundleChanges.length === 0 && runtimeChanges.length === 0 &&
    healthIssues.length === 0 && processIdentityStable;
  runtimeEpochCheckpoints.push({ label, verified });
  if (!verified) {
    failed(label, "The installed bundle or resident IMK runtime changed during candidate proof execution.", {
      bundleChanges,
      runtimeChanges,
      healthIssues,
      processIdentityStable
    });
  }
  return true;
}

function armMouseRecovery({ releasePoint, originalPointer, initialLeftButtonReleased }) {
  assertCandidateMouseRecoveryGuardianAlive(recoveryGuardian);
  updateCandidateMouseRecovery(recoveryTransaction, {
    mouseSafety: {
      mayBeDown: true,
      releasePoint,
      originalPointer,
      initialLeftButtonReleased
    }
  });
  pointerBaselineRestored = false;
  assertCandidateMouseRecoveryGuardianAlive(recoveryGuardian);
}

function disarmMouseRecovery() {
  updateCandidateMouseRecovery(recoveryTransaction, {
    mouseSafety: {
      mayBeDown: false,
      releasePoint: null,
      originalPointer: null,
      initialLeftButtonReleased: null
    }
  });
  pointerBaselineRestored = true;
  assertCandidateMouseRecoveryGuardianAlive(recoveryGuardian);
}

async function composeAndOpenChoices(inputMethodPid, step) {
  const prepared = prepareExactTextEdit(coldTextEditPid, realTempTextEditFile, documentPrefix);
  if (prepared.status !== 0 || prepared.snapshot?.text !== documentPrefix) blocked(`${step}-prepare-document`, prepared);
  if (currentInputSource().id !== lekhInputSourceId) {
    failed(`${step}-source`, "The exact Lekh source was not current before composing candidates.");
  }
  const typing = await postTextEditKeys([35, 0, 45, 34, 125], coldTextEditPid);
  if (typing.status !== 0) blocked(`${step}-post-token-and-down`, { stdout: typing.stdout, stderr: typing.stderr });
  wait(250);
  const surface = waitForCandidateSurface(inputMethodPid);
  const validated = validateCandidateSurface(surface, `${step}-candidate-surface`);
  const composition = inspectCandidatePostcondition();
  const documentText = composition.snapshot?.text ?? "";
  const actual = documentText.startsWith(documentPrefix)
    ? documentText.slice(documentPrefix.length)
    : documentText;
  if (composition.status !== 0 || actual !== validated.firstText) {
    failed(`${step}-composition`, "The visible marked composition did not equal the exact first candidate preview.", {
      rawToken: token,
      expectedVisibleComposition: validated.firstText,
      actual,
      accessibility: composition.snapshot,
      surface: surface.surface
    });
  }
  proofEvidence.markedCompositionMatchedFirstCandidate = true;
  return {
    composition: composition.snapshot,
    visibleCompositionText: actual,
    surface: surface.surface,
    ...validated
  };
}

function targetedKeyCompileFixture() {
  return targetedKeyPostingSource({
    keyCodes: [35, 0, 45, 34, 125],
    targetPid: 1,
    targetExecutablePath: "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit",
    targetProcessStartToken: "1:1",
    temporaryDocumentPath: "/private/tmp/lekh-candidate-compile-only.txt",
    parentIdentity: {
      processIdentifier: 2,
      executablePath: "/usr/bin/true",
      processStartToken: "1:1"
    },
    expectedRuntimeEpoch: {
      bundlePath: appBundle,
      executablePath: join(appBundle, "Contents", "MacOS", "LekhInputMethodApp"),
      executableSha256: "a".repeat(64),
      bundleIdentifier: "com.lekh.inputmethod.LekhKeyboard",
      buildVersion: "1",
      connectionName: "com.lekh.inputmethod.LekhKeyboard_Connection",
      runtimeHealthPath,
      processIdentifier: 3,
      processStartToken: "1:1",
      controllerInstanceIdentifier: "00000000-0000-0000-0000-000000000000",
      activationIdentifier: "00000000-0000-0000-0000-000000000000",
      executableStartedAt: "2026-01-01T00:00:00Z",
      serverStartedAt: "2026-01-01T00:00:00Z",
      controllerInitializedAt: "2026-01-01T00:00:00Z",
      controllerActivatedAt: "2026-01-01T00:00:00Z"
    }
  });
}

if (process.env.LEKH_CANDIDATE_KEY_COMPILE_ONLY === "1") {
  const compilation = run("/usr/bin/swiftc", ["-warnings-as-errors", "-typecheck", "-"], {
    input: targetedKeyCompileFixture()
  });
  console.log(JSON.stringify({
    status: compilation.status === 0 ? "passed" : "failed",
    check: {
      name: "targeted-keys",
      status: compilation.status,
      stdout: compilation.stdout,
      stderr: compilation.stderr
    }
  }, null, 2));
  process.exit(compilation.status === 0 ? 0 : 1);
}

if (process.env.LEKH_CANDIDATE_MOUSE_COMPILE_ONLY === "1") {
  const sources = [
    { name: "candidate-surface", source: candidateSurfaceSource(1) },
    {
      name: "passive-textedit-inspection",
      source: passiveExactTextEditInspectionSource(2, "/private/tmp/lekh-candidate-compile-only.txt")
    },
    {
      name: "mouse-gesture",
      source: mouseGestureSource({
        inputMethodPid: 1,
        textEditPid: 1,
        start: { x: 10, y: 10 },
        end: { x: 20, y: 20 },
        candidateWindowFrame: { x: 0, y: 0, width: 100, height: 100 },
        expectedStartIdentifier: "lekh.candidate.1",
        expectedEndIdentifier: "lekh.candidate.0",
        expectedRuntimeEpoch: {
          bundlePath: appBundle,
          executablePath: join(appBundle, "Contents", "MacOS", "LekhInputMethodApp"),
          executableSha256: "a".repeat(64),
          bundleIdentifier: "com.lekh.inputmethod.LekhKeyboard",
          buildVersion: "1",
          connectionName: "com.lekh.inputmethod.LekhKeyboard_Connection",
          runtimeHealthPath,
          processIdentifier: 1,
          processStartToken: "1:1",
          textEditExecutablePath: "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit",
          textEditProcessStartToken: "1:1",
          temporaryDocumentPath: "/private/tmp/lekh-candidate-compile-only.txt",
          controllerInstanceIdentifier: "00000000-0000-0000-0000-000000000000",
          activationIdentifier: "00000000-0000-0000-0000-000000000000",
          executableStartedAt: "2026-01-01T00:00:00Z",
          serverStartedAt: "2026-01-01T00:00:00Z",
          controllerInitializedAt: "2026-01-01T00:00:00Z",
          controllerActivatedAt: "2026-01-01T00:00:00Z"
        },
        drag: true
      })
    },
    { name: "targeted-keys", source: targetedKeyCompileFixture() }
  ];
  const checks = sources.map(({ name, source }) => {
    const compilation = run("/usr/bin/swiftc", ["-warnings-as-errors", "-typecheck", "-"], { input: source });
    return { name, status: compilation.status, stdout: compilation.stdout, stderr: compilation.stderr };
  });
  console.log(JSON.stringify({ status: checks.every((check) => check.status === 0) ? "passed" : "failed", checks }, null, 2));
  process.exit(checks.every((check) => check.status === 0) ? 0 : 1);
}

process.once("SIGINT", () => handleTerminationSignal("SIGINT"));
process.once("SIGTERM", () => handleTerminationSignal("SIGTERM"));

try {
  if (process.platform !== "darwin") failed("platform", "Candidate mouse proof must run on macOS.", { platform: process.platform });
  if (![appBundle, registerScript, restoreScript].every(existsSync)) {
    failed("preflight", "Installed Lekh bundle or host-probe support script is missing.");
  }

  const consoleSession = consoleSessionPrecondition();
  if (!consoleSession.eligible) {
    blocked("host-session-precondition", {
      prerequisite: {
        ...consoleSession,
        message: `${consoleSession.message} Run the probe from the active, logged-in, unlocked desktop session.`
      },
      sideEffectsPrevented: {
        preferencesChanged: true,
        inputSourceChanged: true,
        hostApplicationLaunched: true
      },
      note: `${consoleSession.message} No Lekh preference was changed, no input source was changed, and TextEdit was not launched.`
    });
  }

  const automationPermissions = automationPermissionPrecondition();
  if (automationPermissions.status !== 0) {
    failed(
      "automation-permission-precondition",
      "Could not read the exact Accessibility/Input Monitoring permission state.",
      { automationPermissions }
    );
  }
  if (
    !automationPermissions.accessibilityTrusted ||
    !automationPermissions.eventPostAccess ||
    !automationPermissions.eventListenAccess
  ) {
    blocked("automation-permissions", {
      prerequisite: {
        ...automationPermissions,
        eventListenAccessRequired: true
      },
      sideEffectsPrevented: {
        preferencesChanged: true,
        inputSourceChanged: true,
        hostApplicationLaunched: true,
        mouseEventPosted: true
      }
    });
  }

  sourceProvenanceBaseline = captureCandidateMouseEvidenceProvenance(root);
  if (
    sourceProvenanceBaseline.schemaVersion !== 1 ||
    sourceProvenanceBaseline.sourceStatusReadable !== true ||
    sourceProvenanceBaseline.sourceFilesClean !== true ||
    !sourceProvenanceBaseline.gitRevision ||
    !sourceProvenanceBaseline.gitTree ||
    sourceProvenanceBaseline.sources.length !== CANDIDATE_MOUSE_EVIDENCE_SOURCE_PATHS.length ||
    sourceProvenanceBaseline.sources.some((source, index) =>
      source.path !== CANDIDATE_MOUSE_EVIDENCE_SOURCE_PATHS[index] || !source.sha256
    )
  ) {
    failed(
      "source-provenance-precondition",
      "Candidate evidence must start from a readable, clean repository with every proof source hashed."
    );
  }

  try {
    recoveryLock = acquireCandidateMouseRecoveryLock();
    recoveryEvidence.lockAcquired = true;
    const startupRecovery = recoverCandidateMouseState({ lock: recoveryLock });
    recoveryEvidence.startupDisposition = startupRecovery.status;
    if (!["no-recovery-required", "recovered"].includes(startupRecovery.status)) {
      failed("startup-recovery", "A prior candidate-mouse probe could not be recovered exactly.");
    }
  } catch (error) {
    if (error instanceof ProbeFinished) throw error;
    if (error?.code === "candidate-recovery-lock-busy") {
      blocked("recovery-lock-busy", {
        note: "Another live candidate-mouse proof owns the exact recovery lock; no probe state was changed."
      });
    }
    failed("prepare-recovery-lock", "Could not establish exclusive crash recovery for the candidate-mouse proof.");
  }

  previousInputSource = currentInputSource();
  if (previousInputSource.status !== 0 || !previousInputSource.id) {
    failed("snapshot-input-source", "Could not snapshot the user's exact current input source.", previousInputSource);
  }
  const capturedPreferenceSnapshots = Object.fromEntries(
    Object.entries(preferenceKeys).map(([name, key]) => [
      name,
      snapshotExactPreference(preferencesDomain, key)
    ])
  );
  if (Object.values(capturedPreferenceSnapshots).some((snapshot) => snapshot.status !== 0)) {
    failed(
      "snapshot-preferences",
      "Could not snapshot every exact current-user/any-host preference before mutation."
    );
  }
  // Opaque binary property-list snapshots stay in memory and are never
  // serialized into the content-bearing probe report.
  preferenceSnapshots = { ...capturedPreferenceSnapshots };
  try {
    tempTextEditFile = createCandidateMouseTemporaryDocument(recoveryLock, documentPrefix);
    realTempTextEditFile = realpathSync(tempTextEditFile);
    recoveryTransaction = prepareCandidateMouseRecovery({
      lock: recoveryLock,
      priorInputSourceIdentifier: previousInputSource.id,
      preferences: candidatePreferenceRecoveryEntries(
        Object.fromEntries(Object.values(capturedPreferenceSnapshots).map((snapshot) => [snapshot.key, snapshot]))
      ),
      temporaryDocumentPath: tempTextEditFile
    });
    recoveryGuardianPromise = launchCandidateMouseRecoveryGuardian({
      lock: recoveryLock,
      transaction: recoveryTransaction
    });
    recoveryGuardian = await recoveryGuardianPromise;
    if (terminationRequested) throw new ProbeFinished("interrupted");
    recoveryEvidence.guardianReady = assertCandidateMouseRecoveryGuardianAlive(recoveryGuardian);
  } catch (error) {
    if (error instanceof ProbeFinished) throw error;
    failed("prepare-recovery-guardian", "Could not start durable candidate-mouse crash recovery before mutation.");
  }
  const preferenceWrites = [
    writePreference(preferencesDomain, preferenceKeys.personalization, false),
    writePreference(preferencesDomain, preferenceKeys.diagnostics, true),
    writePreference(preferencesDomain, preferenceKeys.inlinePreview, false),
    writePreference(preferencesDomain, preferenceKeys.customCandidatePanel, true),
    writePreference(preferencesDomain, preferenceKeys.nativeMode, "romanized-traditional"),
    writePreference(preferencesDomain, preferenceKeys.nativeModeChosen, true)
  ];
  const preferenceNotification = notifyPreferencesChanged();
  if (
    preferenceWrites.some((write) => write.status !== 0 || write.readBackEqual !== true) ||
    preferenceNotification.status !== 0
  ) {
    failed("prepare-test-preferences", "Could not isolate the candidate-panel probe preferences.");
  }
  proofEvidence.personalizationDisabled = true;

  bundleIdentity = installedBundleIdentity(appBundle);
  const priorHealth = readRuntimeHealth(runtimeHealthPath);

  const selection = run("swift", [registerScript, appBundle, "--select-only"]);
  const selectedSource = currentInputSource();
  if (selection.status !== 0 || selectedSource.id !== lekhInputSourceId) {
    failed("select-before-host-launch", "Could not select the installed Lekh .Main source before launching TextEdit.", {
      selectStatus: selection.status,
      selectStdout: selection.stdout,
      selectStderr: selection.stderr,
      selectedSource
    });
  }

  const coldLaunch = await launchColdTextEditUnderCustody(realTempTextEditFile);
  coldTextEditPid = coldLaunch.pid;
  coldTextEditIdentity = coldLaunch;
  if (coldLaunch.status !== 0 || !Number.isInteger(coldTextEditPid)) blocked("launch-fresh-textedit", coldLaunch);
  const initialDocument = prepareExactTextEdit(coldTextEditPid, realTempTextEditFile, documentPrefix);
  if (initialDocument.status !== 0) blocked("prepare-exact-textedit", initialDocument);
  const runtime = waitForExactRuntimeHealth({
    runtimeHealthPath,
    bundleIdentity,
    activatedAfterMs: coldLaunch.launchedAtMs,
    previousActivation: priorHealth.record?.controllerActivatedAt ?? null,
    previousActivationIdentifier: priorHealth.record?.activationIdentifier ?? null,
    previousHealthMtimeMs: priorHealth.mtimeMs ?? null
  });
  runtimeEvidence = {
    verified: runtime.verified,
    readError: runtime.readError,
    issues: runtime.issues,
    mtimeMs: runtime.mtimeMs ?? null,
    record: runtime.record
  };
  if (!runtime.verified) {
    failed("verify-exact-imk-runtime", "The cold TextEdit context did not activate the exact installed Lekh PID/build.", {
      coldLaunch,
      runtimeHealth: runtimeEvidence
    });
  }
  const inputMethodPid = runtime.record.processIdentifier;
  const inputMethodProcessIdentity = processIdentity(inputMethodPid);
  if (
    inputMethodProcessIdentity.status !== 0 ||
    inputMethodProcessIdentity.state !== "running" ||
    inputMethodProcessIdentity.executablePath !== bundleIdentity.executablePath
  ) {
    failed("verify-imk-process-instance", "The resident IMK process-start epoch could not be pinned exactly.");
  }
  runtimeEpochBaseline = Object.freeze({
    bundleIdentity: Object.freeze({ ...bundleIdentity }),
    record: Object.freeze({ ...runtime.record }),
    processIdentity: Object.freeze({ ...inputMethodProcessIdentity }),
    activatedAfterMs: coldLaunch.launchedAtMs
  });
  runtimeEpochCheckpoints.push({ label: "initial-runtime-pin", verified: true });
  const initialArtifact = artifactProvenanceEvidence({
    root,
    appBundle,
    bundleIdentity,
    runtimeRecord: runtime.record,
    evidenceRevision: sourceProvenanceBaseline.gitRevision
  });
  if (!initialArtifact.localArtifactIntegrityVerified) {
    failed(
      "local-artifact-integrity-precondition",
      "The installed manifest, executable, running code, and evidence revision are not internally consistent.",
      { artifactIssueCodes: initialArtifact.issues }
    );
  }
  artifactProvenanceBaseline = initialArtifact.artifactProvenance;

  const dragChoices = await composeAndOpenChoices(inputMethodPid, "drag-away");
  const dragStart = center(dragChoices.second.frame);
  const dragEnd = center(dragChoices.first.frame);
  verifyPinnedRuntimeEpoch("before-drag-gesture");
  const dragReceiptBaseline = candidateDragCancellationReceipt();
  if (
    !dragReceiptBaseline.readable ||
    !dragReceiptBaseline.activationMatched ||
    !dragReceiptBaseline.countAndTimestampValid
  ) {
    failed(
      "drag-cancellation-receipt-baseline",
      "The activation-scoped, content-free cancellation counter was not valid immediately before the drag.",
      { receipt: dragReceiptBaseline }
    );
  }
  // Runtime-health ISO-8601 dates have one-second precision. The exact counter
  // baseline supplies event causality; this lower bound prevents an older
  // activation receipt from being paired with the current gesture.
  const dragReceiptNotBeforeSecondMs = Math.floor(Date.now() / 1_000) * 1_000;
  const drag = await postMouseGesture({
    inputMethodPid,
    textEditPid: coldTextEditPid,
    start: dragStart,
    end: dragEnd,
    candidateWindowFrame: dragChoices.window.frame,
    expectedStartIdentifier: dragChoices.second.identifier,
    expectedEndIdentifier: dragChoices.first.identifier,
    expectedRuntimeEpoch: gestureRuntimeEpoch(),
    drag: true
  });
  if (terminationRequested) throw new ProbeFinished("interrupted");
  if (drag.status !== 0) finishMouseGestureFailure("drag-away-mouse-events", drag);
  disarmMouseRecovery();
  proofEvidence.dragGesture = drag.evidence;
  const dragReceiptAfter = waitForCandidateDragCancellationReceipt({
    baseline: dragReceiptBaseline,
    notBeforeSecondMs: dragReceiptNotBeforeSecondMs
  });
  if (
    !dragReceiptAfter.readable ||
    !dragReceiptAfter.activationMatched ||
    !dragReceiptAfter.countAndTimestampValid ||
    dragReceiptAfter.delta !== 1 ||
    dragReceiptAfter.timestampCausal !== true
  ) {
    failed(
      "assert-drag-cancellation-runtime-receipt",
      "The exact custom-candidate activation did not publish one causal, content-free drag-cancellation receipt.",
      { baseline: dragReceiptBaseline, after: dragReceiptAfter }
    );
  }
  proofEvidence.dragCancellationReceiptActivationMatched = true;
  proofEvidence.dragCancellationReceiptDelta = dragReceiptAfter.delta;
  proofEvidence.dragCancellationReceiptTimestampCausal = true;
  wait(350);
  const afterDrag = inspectCandidatePostcondition();
  const afterDragDocument = afterDrag.snapshot?.text ?? "";
  const afterDragText = afterDragDocument.startsWith(documentPrefix)
    ? afterDragDocument.slice(documentPrefix.length)
    : afterDragDocument;
  const dragSurfaceAfter = waitForCandidateSurface(inputMethodPid, 1_500);
  if (
    afterDrag.status !== 0 ||
    afterDragText !== dragChoices.visibleCompositionText ||
    dragSurfaceAfter.window?.rows?.filter((row) => row.identifier.startsWith("lekh.candidate.")).length < 2
  ) {
    failed("assert-drag-away-cancellation", "Dragging from candidate 2 onto candidate 1 committed or dismissed a candidate.", {
      afterDragText,
      expectedVisibleComposition: dragChoices.visibleCompositionText,
      accessibility: afterDrag.snapshot,
      dragSurfaceAfter
    });
  }
  proofEvidence.dragAwayPreservedComposition = true;
  proofEvidence.dragAwayPanelRemainedVisible = true;

  // End the first composition without committing a candidate. Two Escapes are
  // the controller's explicit revert-then-dismiss contract.
  const dismiss = await postTextEditKeys([53, 53], coldTextEditPid);
  if (dismiss.status !== 0) blocked("dismiss-after-drag-away", { stdout: dismiss.stdout, stderr: dismiss.stderr });
  wait(250);

  const clickChoices = await composeAndOpenChoices(inputMethodPid, "non-first-click");
  if (clickChoices.secondText !== dragChoices.secondText) {
    failed("candidate-order-stability", "The non-first candidate changed between drag-away and click trials.", {
      dragSecond: dragChoices.secondText,
      clickSecond: clickChoices.secondText
    });
  }
  const clickPoint = center(clickChoices.second.frame);
  verifyPinnedRuntimeEpoch("before-click-gesture");
  const click = await postMouseGesture({
    inputMethodPid,
    textEditPid: coldTextEditPid,
    start: clickPoint,
    end: clickPoint,
    candidateWindowFrame: clickChoices.window.frame,
    expectedStartIdentifier: clickChoices.second.identifier,
    expectedEndIdentifier: clickChoices.second.identifier,
    expectedRuntimeEpoch: gestureRuntimeEpoch(),
    drag: false
  });
  if (terminationRequested) throw new ProbeFinished("interrupted");
  if (click.status !== 0) finishMouseGestureFailure("non-first-mouse-click", click);
  disarmMouseRecovery();
  proofEvidence.clickGesture = click.evidence;
  wait(550);

  const clickReceiptAfter = candidateDragCancellationReceipt();
  const clickReceiptDelta = Number.isInteger(clickReceiptAfter.count)
    ? clickReceiptAfter.count - dragReceiptAfter.count
    : null;
  const clickReceiptTimestampUnchanged = clickReceiptAfter.timestamp === dragReceiptAfter.timestamp;
  if (
    !clickReceiptAfter.readable ||
    !clickReceiptAfter.activationMatched ||
    !clickReceiptAfter.countAndTimestampValid ||
    clickReceiptDelta !== 0 ||
    !clickReceiptTimestampUnchanged
  ) {
    failed(
      "assert-click-did-not-report-drag-cancellation",
      "A normal inside-row click changed the activation-scoped drag-cancellation receipt.",
      { afterDrag: dragReceiptAfter, afterClick: clickReceiptAfter, clickReceiptDelta }
    );
  }
  proofEvidence.clickCancellationReceiptActivationMatched = true;
  proofEvidence.clickCancellationReceiptDelta = clickReceiptDelta;
  proofEvidence.clickCancellationReceiptTimestampUnchanged = true;

  const accepted = inspectCandidatePostcondition();
  const acceptedDocument = accepted.snapshot?.text ?? "";
  const acceptedText = acceptedDocument.startsWith(documentPrefix)
    ? acceptedDocument.slice(documentPrefix.length)
    : acceptedDocument;
  const surfaceAfterClick = candidateSurface(inputMethodPid);
  const remainingCandidateRows = surfaceAfterClick.surface?.windows
    ?.flatMap((window) => window.rows ?? [])
    .filter((row) => row.identifier.startsWith("lekh.candidate.")) ?? [];
  if (
    accepted.status !== 0 ||
    acceptedText !== clickChoices.secondText ||
    acceptedText === clickChoices.firstText ||
    currentInputSource().id !== lekhInputSourceId ||
    accepted.snapshot?.frontmostPid !== coldTextEditPid ||
    remainingCandidateRows.length !== 0
  ) {
    failed("assert-non-first-mouse-acceptance", "The exact second candidate was not cleanly committed by the mouse click.", {
      acceptedText,
      expectedSecond: clickChoices.secondText,
      firstCandidate: clickChoices.firstText,
      accessibility: accepted.snapshot,
      remainingCandidateRows,
      surfaceAfterClick
    });
  }
  verifyPinnedRuntimeEpoch("final-runtime-pass");
  proofEvidence.nonFirstCandidateCommitted = true;
  proofEvidence.firstCandidateNotCommitted = true;
  proofEvidence.noCandidateRowsAfterCommit = true;
  proofEvidence.frontmostTextEditPreserved = true;
  proofEvidence.exactTextEditFrontmostInvariantPreserved = true;
  proofEvidence.postconditionsPassivelyObserved = proofEvidence.passivePostconditionCount === 4;
  if (!proofEvidence.postconditionsPassivelyObserved) {
    failed("passive-postcondition-count", "Every candidate result must be observed by the strictly passive TextEdit inspector.");
  }

  const finalSourceProvenance = captureCandidateMouseEvidenceProvenance(root);
  const sourceStable = JSON.stringify(finalSourceProvenance) === JSON.stringify(sourceProvenanceBaseline);
  if (!sourceStable) {
    failed("source-provenance-changed", "The repository revision, cleanliness, or proof-source bytes changed during candidate evidence collection.");
  }
  evidenceProvenance = { ...finalSourceProvenance, stableDuringProbe: true };
  const finalArtifact = artifactProvenanceEvidence({
    root,
    appBundle,
    bundleIdentity: installedBundleIdentity(appBundle),
    runtimeRecord: readRuntimeHealth(runtimeHealthPath).record,
    evidenceRevision: finalSourceProvenance.gitRevision
  });
  const artifactStable = finalArtifact.localArtifactIntegrityVerified === true &&
    JSON.stringify(finalArtifact.artifactProvenance) === JSON.stringify(artifactProvenanceBaseline);
  if (!artifactStable) {
    failed(
      "local-artifact-integrity-changed",
      "The installed manifest, executable, running code, or source binding changed during candidate evidence collection.",
      { artifactIssueCodes: finalArtifact.issues }
    );
  }
  artifactProvenance = { ...finalArtifact.artifactProvenance, stableDuringProbe: true };

  conclude("passed", { step: "complete" }, 0);
} catch (error) {
  if (!(error instanceof ProbeFinished)) {
    failures.push("An unexpected internal candidate-probe failure occurred.");
    result = { status: "failed", details: { step: "internal-failure" }, code: 1 };
  }
} finally {
  await finalizeProbe();
}

function performCleanup() {
  const cleanupFailures = [];
  const mouseRelease = ensureCandidateMouseButtonReleased({ forcePost: false });
  const cleanup = {
    textEditTerminated: !Number.isInteger(coldTextEditPid),
    inputSourceRestored: !previousInputSource?.id,
    preferencesRestored: !preferenceSnapshots,
    temporaryDocumentRemoved: !tempTextEditFile || !existsSync(tempTextEditFile),
    mouseButtonReleased: mouseRelease.status === 0 && mouseRelease.released === true,
    pointerRestored: pointerBaselineRestored
  };
  if (!cleanup.mouseButtonReleased) cleanupFailures.push("Candidate mouse button state could not be returned to released.");
  if (!cleanup.pointerRestored) cleanupFailures.push("Candidate pointer position could not be returned to its pre-gesture baseline.");
  if (Number.isInteger(coldTextEditPid)) {
    const termination = terminateColdTextEdit(coldTextEditIdentity);
    cleanup.textEditTerminated = termination.status === 0 && termination.terminated === true;
    if (termination.status !== 0) cleanupFailures.push(termination.note);
  }
  if (previousInputSource?.id) {
    const restored = restoreExactInputSource(previousInputSource.id);
    const observedSource = currentInputSource();
    cleanup.inputSourceRestored = restored.status === 0 && observedSource.id === previousInputSource.id;
    if (!cleanup.inputSourceRestored) {
      run(restoreScript, []);
      cleanupFailures.push("Could not restore the exact prior input source.");
    }
  }
  if (preferenceSnapshots) {
    const preferenceRestores = Object.fromEntries(
      Object.entries(preferenceSnapshots).map(([name, snapshot]) => {
        const restored = restoreExactPreference(preferencesDomain, preferenceKeys[name], snapshot);
        return [name, {
          status: restored.status,
          readBackEqual: restored.readBackEqual === true
        }];
      })
    );
    const preferenceNotification = notifyPreferencesChanged();
    cleanup.preferencesRestored =
      Object.values(preferenceRestores).every((restore) => restore.status === 0 && restore.readBackEqual) &&
      preferenceNotification.status === 0;
    if (!cleanup.preferencesRestored) {
      cleanupFailures.push("Could not restore every isolated candidate-probe preference exactly.");
    }
  }
  if (tempTextEditFile && existsSync(tempTextEditFile)) {
    removeProbeFile(tempTextEditFile);
    cleanup.temporaryDocumentRemoved = !existsSync(tempTextEditFile);
    if (!cleanup.temporaryDocumentRemoved) {
      cleanupFailures.push("Could not remove the candidate-probe temporary document.");
    }
  }
  cleanupEvidence = cleanup;
  return cleanupFailures;
}

async function settleRecovery(cleanupFailures) {
  try {
    if (!recoveryGuardian && recoveryGuardianPromise) {
      recoveryGuardian = await recoveryGuardianPromise;
      recoveryEvidence.guardianReady = assertCandidateMouseRecoveryGuardianAlive(recoveryGuardian);
    }
    if (recoveryTransaction && recoveryGuardian) {
      assertCandidateMouseRecoveryGuardianAlive(recoveryGuardian);
      const normalCompletionEligible = !terminationRequested &&
        result?.status === "passed" &&
        cleanupFailures.length === 0 &&
        Object.values(cleanupEvidence).every(Boolean);
      if (normalCompletionEligible) {
        markCandidateMouseRecoveryComplete(recoveryTransaction, cleanupEvidence);
        signalCandidateMouseRecoveryGuardianCompletion(recoveryGuardian);
        const settlement = await waitForCandidateMouseRecoveryGuardian(recoveryGuardian);
        recoveryEvidence.guardianDisposition = settlement.disposition;
        if (settlement.status !== "completed" || settlement.disposition !== "normal-completion") {
          cleanupFailures.push("Candidate recovery guardian did not accept exact normal completion.");
        }
      } else {
        triggerCandidateMouseRecoveryGuardian(recoveryGuardian);
        const settlement = await waitForCandidateMouseRecoveryGuardian(recoveryGuardian);
        recoveryEvidence.guardianDisposition = settlement.disposition;
        if (settlement.status !== "completed" || settlement.disposition !== "crash-recovery") {
          cleanupFailures.push("Candidate recovery guardian could not complete fail-safe recovery.");
        }
      }
      recoveryEvidence.durableJournalRemoved = !existsSync(recoveryTransaction.journalPath);
      if (!recoveryEvidence.durableJournalRemoved) {
        cleanupFailures.push("Candidate recovery journal remains because exact settlement was not proven.");
      }
    } else if (recoveryTransaction && recoveryLock) {
      const recovery = recoverCandidateMouseState({ lock: recoveryLock });
      recoveryEvidence.guardianDisposition = recovery.status === "recovered" ? "crash-recovery" : "unverified";
      recoveryEvidence.durableJournalRemoved = !existsSync(recoveryTransaction.journalPath);
      if (recovery.status !== "recovered") cleanupFailures.push("Local candidate recovery did not complete exactly.");
    }
  } catch {
    cleanupFailures.push("Candidate recovery settlement failed closed.");
    if (recoveryGuardian) {
      try {
        triggerCandidateMouseRecoveryGuardian(recoveryGuardian);
        const settlement = await waitForCandidateMouseRecoveryGuardian(recoveryGuardian);
        recoveryEvidence.guardianDisposition = settlement.disposition;
        recoveryEvidence.durableJournalRemoved = recoveryTransaction
          ? !existsSync(recoveryTransaction.journalPath)
          : false;
        if (settlement.status !== "completed" || settlement.disposition !== "crash-recovery") {
          cleanupFailures.push("Candidate recovery fallback did not reach a verified safe disposition.");
        }
      } catch {
        // A durable 0600 journal remains for the next exclusive recovery owner.
      }
    }
  } finally {
    if (recoveryLock) {
      try { releaseCandidateMouseRecoveryLock(recoveryLock); }
      catch { cleanupFailures.push("Candidate recovery lock could not be released safely."); }
      recoveryLock = null;
    }
  }
}

function finalizeProbe() {
  if (finalizationPromise) return finalizationPromise;
  finalizationPromise = (async () => {
    const helperStopped = await stopAndAwaitActiveSyntheticHelper();
    const cleanupFailures = [];
    if (!helperStopped) {
      // Never race parent cleanup against a helper whose exact termination is
      // ambiguous. The durable guardian owns the only safe recovery order:
      // stop the journaled helper, release a custodied synthetic button if
      // necessary, restore the pointer, then restore host state.
      cleanupFailures.push("An active synthetic event helper could not be terminated and awaited before cleanup.");
      cleanupEvidence = {
        textEditTerminated: false,
        inputSourceRestored: false,
        preferencesRestored: false,
        temporaryDocumentRemoved: false,
        mouseButtonReleased: false,
        pointerRestored: false
      };
    } else {
      cleanupFailures.push(...performCleanup());
    }
    await settleRecovery(cleanupFailures);
    if (cleanupFailures.length > 0) {
      failures.push(...cleanupFailures);
      result = {
        status: "failed",
        details: { step: result?.details?.step ?? "cleanup-or-recovery" },
        code: 1
      };
    }
    writeReport();
  })();
  return finalizationPromise;
}

function handleTerminationSignal(signal) {
  terminationRequested = true;
  if (result?.status !== "failed") {
    failures.push("The candidate-mouse probe was interrupted.");
    result = { status: "failed", details: { step: `interrupted-${signal.toLowerCase()}` }, code: 1 };
  }
  void finalizeProbe().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
}

function candidateSurface(inputMethodPid) {
  const probe = run("swift", ["-e", candidateSurfaceSource(inputMethodPid)]);
  const line = probe.stdout.trim().split(/\r?\n/).at(-1) ?? "";
  let surface = null;
  try {
    surface = JSON.parse(line);
  } catch {
    // Preserve compiler/AX diagnostics below.
  }
  return {
    status: probe.status === 0 && surface ? 0 : probe.status || 3,
    surface,
    stdout: probe.stdout,
    stderr: probe.stderr
  };
}

function gestureRuntimeEpoch() {
  const record = runtimeEpochBaseline.record;
  return {
    bundlePath: runtimeEpochBaseline.bundleIdentity.bundlePath,
    executablePath: runtimeEpochBaseline.bundleIdentity.executablePath,
    executableSha256: runtimeEpochBaseline.bundleIdentity.executableSha256,
    bundleIdentifier: runtimeEpochBaseline.bundleIdentity.bundleIdentifier,
    buildVersion: runtimeEpochBaseline.bundleIdentity.buildVersion,
    connectionName: runtimeEpochBaseline.bundleIdentity.connectionName,
    runtimeHealthPath,
    processIdentifier: record.processIdentifier,
    processStartToken: runtimeEpochBaseline.processIdentity.processStartToken,
    textEditExecutablePath: coldTextEditIdentity.executablePath,
    textEditProcessStartToken: coldTextEditIdentity.processStartToken,
    temporaryDocumentPath: realTempTextEditFile,
    controllerInstanceIdentifier: record.controllerInstanceIdentifier,
    activationIdentifier: record.activationIdentifier,
    executableStartedAt: record.executableStartedAt,
    serverStartedAt: record.serverStartedAt,
    controllerInitializedAt: record.controllerInitializedAt,
    controllerActivatedAt: record.controllerActivatedAt
  };
}

async function postMouseGesture({
  inputMethodPid,
  textEditPid,
  start,
  end,
  candidateWindowFrame,
  expectedStartIdentifier,
  expectedEndIdentifier,
  expectedRuntimeEpoch,
  drag
}) {
  const helper = spawn("/usr/bin/swift", ["-e", mouseGestureSource({
    inputMethodPid,
    textEditPid,
    start,
    end,
    candidateWindowFrame,
    expectedStartIdentifier,
    expectedEndIdentifier,
    expectedRuntimeEpoch,
    drag
  })], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let outputOverflow = false;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const appendBounded = (current, chunk) => {
    const next = current + chunk;
    if (Buffer.byteLength(next, "utf8") > 512 * 1024) {
      outputOverflow = true;
      return current;
    }
    return next;
  };
  helper.stdout.setEncoding("utf8");
  helper.stderr.setEncoding("utf8");
  helper.stdout.on("data", (chunk) => {
    stdout = appendBounded(stdout, chunk);
    const readyLine = stdout.split(/\r?\n/u).find((line) => line.startsWith("LEKH_GESTURE_READY:"));
    if (readyLine) {
      try {
        const decoded = Buffer.from(readyLine.slice("LEKH_GESTURE_READY:".length), "base64").toString("utf8");
        resolveReady(JSON.parse(decoded));
      } catch {
        resolveReady(false);
      }
    }
  });
  helper.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
  const closed = new Promise((resolveClosed) => {
    helper.once("error", (error) => {
      resolveReady(false);
      resolveClosed({ status: 3, signal: null, error });
    });
    helper.once("close", (status, signal) => {
      resolveReady(false);
      resolveClosed({ status: status ?? 3, signal, error: null });
    });
  });
  let helperState;
  try {
    helperState = registerActiveSyntheticHelper({ child: helper, closed, kind: "mouse-gesture" });
  } catch {
    helper.stdin.end();
    helper.kill("SIGTERM");
    await closed;
    return {
      status: 3,
      automationExitStatus: 3,
      failureKind: "invariant-failed",
      permissionRecheck: null,
      evidence: null,
      stdout: "",
      stderr: ""
    };
  }
  const readyTimeout = new Promise((resolveReadyTimeout) =>
    setTimeout(() => resolveReadyTimeout(false), 5_000));
  const readiness = await Promise.race([ready, readyTimeout]);
  const sourceIsExecuting = readiness &&
    readiness.schemaVersion === 1 &&
    readiness.processIdentifier === helper.pid &&
    readiness.originalPointer &&
    Number.isFinite(readiness.originalPointer.x) &&
    Number.isFinite(readiness.originalPointer.y) &&
    typeof readiness.initialLeftButtonReleased === "boolean";
  if (terminationRequested) {
    // READY proves the helper is still blocked before every event. EOF makes
    // it exit side-effect-free; never journal or authorize it after cleanup
    // has started.
    await stopAndAwaitActiveSyntheticHelper();
    return {
      status: 3,
      automationExitStatus: 3,
      failureKind: "invariant-failed",
      permissionRecheck: null,
      evidence: null,
      stdout: "",
      stderr: ""
    };
  }
  if (!sourceIsExecuting || readiness.initialLeftButtonReleased !== true) {
    await stopAndAwaitActiveSyntheticHelper();
    return {
      status: 3,
      automationExitStatus: 3,
      failureKind: readiness?.initialLeftButtonReleased === false
        ? "physical-button-not-released"
        : "invariant-failed",
      permissionRecheck: null,
      evidence: null,
      stdout: "",
      stderr: ""
    };
  }
  let helperExecutablePath = "";
  const identityDeadline = Date.now() + 3_000;
  while (sourceIsExecuting && Date.now() < identityDeadline && Number.isInteger(helper.pid) && !helperExecutablePath) {
    helperExecutablePath = processExecutablePath(helper.pid);
    if (!helperExecutablePath) wait(25);
  }
  if (!sourceIsExecuting || !Number.isInteger(helper.pid) || !helperExecutablePath) {
    await stopAndAwaitActiveSyntheticHelper();
    return {
      status: 3,
      automationExitStatus: 3,
      failureKind: "invariant-failed",
      permissionRecheck: null,
      evidence: null,
      stdout: "",
      stderr: ""
    };
  }
  try {
    journalActiveSyntheticHelper(helperState, helperExecutablePath);
    updateCandidateMouseRecovery(recoveryTransaction, {
      mouseSafety: {
        mayBeDown: false,
        releasePoint: end,
        originalPointer: readiness.originalPointer,
        initialLeftButtonReleased: true
      }
    });
    assertCandidateMouseRecoveryGuardianAlive(recoveryGuardian);
    armMouseRecovery({
      releasePoint: end,
      originalPointer: readiness.originalPointer,
      initialLeftButtonReleased: true
    });
    helper.stdin.end("GO\n");
  } catch {
    await stopAndAwaitActiveSyntheticHelper();
    return {
      status: 3,
      automationExitStatus: 3,
      failureKind: "invariant-failed",
      permissionRecheck: null,
      evidence: null,
      stdout: "",
      stderr: ""
    };
  }
  const closure = await awaitSyntheticHelperClosure(helperState, 8_000);
  if (closure.timedOut || !closure.completion) {
    return {
      status: 3,
      automationExitStatus: 3,
      failureKind: "helper-timeout",
      permissionRecheck: null,
      evidence: null,
      stdout,
      stderr
    };
  }
  const completion = closure.completion;
  if (!terminationRequested) {
    try {
      await retireSyntheticHelper(helperState);
    } catch {
      return {
        status: 3,
        automationExitStatus: completion.status,
        failureKind: "invariant-failed",
        permissionRecheck: null,
        evidence: null,
        stdout: "",
        stderr: ""
      };
    }
  }
  const line = stdout.trim().split(/\r?\n/).at(-1) ?? "";
  let evidence = null;
  try {
    evidence = JSON.parse(line);
  } catch {
    // Preserve compiler/event diagnostics below.
  }
  const expectedButtonSequence = drag ? ["down", "drag", "up"] : ["down", "up"];
  const exactSequence = (observed) =>
    Array.isArray(observed) &&
    observed.length === expectedButtonSequence.length &&
    observed.every((item, index) => item === expectedButtonSequence[index]);
  const valid = completion.status === 0 && completion.signal === null && !outputOverflow &&
    evidence?.exactWindowOwnerPreflight === true &&
    evidence?.candidateWindowFramePreflight === true &&
    evidence?.exactCandidateAXHitPreflight === true &&
    evidence?.mouseRoutingWindowPreflight === true &&
    evidence?.mouseRouteEvidence?.finalTaggedRoutedMove === "start" &&
    evidence?.preButtonRecheck?.frontmostTextEdit === true &&
    evidence?.preButtonRecheck?.inputSource === true &&
    evidence?.preButtonRecheck?.exactAXTargets === true &&
    evidence?.preButtonRecheck?.exactTextEditContext === true &&
    evidence?.runtimeEpochPreflight === true &&
    evidence?.preButtonRecheck?.runtimeEpoch === true &&
    evidence?.preButtonRecheck?.noMoveOrDelayBeforeMouseDown === true &&
    Number.isFinite(evidence?.preButtonRecheck?.recheckToMouseDownPostStartNs) &&
    evidence.preButtonRecheck.recheckToMouseDownPostStartNs >= 0 &&
    evidence.preButtonRecheck.recheckToMouseDownPostStartNs <= 10_000_000 &&
    Number.isFinite(evidence?.preButtonRecheck?.routeToMouseDownPostStartNs) &&
    evidence.preButtonRecheck.routeToMouseDownPostStartNs >= 0 &&
    evidence.preButtonRecheck.routeToMouseDownPostStartNs <= 50_000_000 &&
    exactSequence(evidence?.expectedButtonSequence) &&
    exactSequence(evidence?.postedButtonSequence) &&
    exactSequence(evidence?.observedButtonSequence) &&
    evidence?.buttonSequenceComplete === true &&
    evidence?.fallbackMouseUpPosted === false &&
    evidence?.fallbackMouseUpObserved === false &&
    evidence?.frontmostTextEditPreflight === true &&
    evidence?.exactTextEditContextPreflight === true &&
    evidence?.pointerRestored === true &&
    evidence?.gesture === (drag ? "drag-away" : "click");
  const permissionRecheck = !valid &&
    completion.status === 16 &&
    evidence?.preflightFailure === "mouse-route-listener-unavailable"
    ? automationPermissionPrecondition()
    : null;
  const permissionBlocked =
    evidence?.tapCreationListenAccessOnFailure === false &&
    permissionRecheck?.status === 0 &&
    permissionRecheck.eventListenAccess === false &&
    evidence?.mouseButtonEventPosted === false &&
    Array.isArray(evidence?.postedButtonSequence) &&
    evidence.postedButtonSequence.length === 0;
  return {
    status: valid ? 0 : completion.status || 3,
    automationExitStatus: completion.status,
    failureKind: valid ? null : permissionBlocked ? "permission-blocked" : "invariant-failed",
    permissionRecheck,
    evidence,
    // Child output is intentionally returned only to in-memory validation and
    // is structurally impossible to serialize in the fixed-schema report.
    stdout,
    stderr
  };
}

function targetedKeyPostingSource({
  keyCodes,
  targetPid,
  targetExecutablePath,
  targetProcessStartToken,
  temporaryDocumentPath,
  parentIdentity,
  expectedRuntimeEpoch
}) {
  if (
    !Array.isArray(keyCodes) ||
    keyCodes.length === 0 ||
    keyCodes.some((code) => !Number.isInteger(code) || code < 0 || code > 127)
  ) {
    throw new Error("Targeted key codes must be a non-empty bounded integer sequence.");
  }
  const rows = keyCodes.map((code) => `(code: ${code}, flags: CGEventFlags())`).join(",\n  ");
  const custody = Buffer.from(JSON.stringify({
    target: {
      processIdentifier: targetPid,
      executablePath: targetExecutablePath,
      processStartToken: targetProcessStartToken
    },
    parent: {
      processIdentifier: parentIdentity.processIdentifier,
      executablePath: parentIdentity.executablePath,
      processStartToken: parentIdentity.processStartToken
    },
    temporaryDocumentPath,
    runtime: expectedRuntimeEpoch
  }), "utf8").toString("base64");
  return `
import AppKit
import ApplicationServices
import Carbon
import CryptoKit
import CoreGraphics
import Darwin
import Foundation

guard let custodyData = Data(base64Encoded: ${JSON.stringify(custody)}),
      let custody = try JSONSerialization.jsonObject(with: custodyData) as? [String: Any],
      let target = custody["target"] as? [String: Any],
      let parent = custody["parent"] as? [String: Any],
      let expectedRuntimeEpoch = custody["runtime"] as? [String: Any],
      let targetPidNumber = target["processIdentifier"] as? NSNumber,
      let targetExecutablePath = target["executablePath"] as? String,
      let targetProcessStartToken = target["processStartToken"] as? String,
      let parentPidNumber = parent["processIdentifier"] as? NSNumber,
      let parentExecutablePath = parent["executablePath"] as? String,
      let parentProcessStartToken = parent["processStartToken"] as? String,
      let temporaryDocumentPath = custody["temporaryDocumentPath"] as? String
else { exit(79) }

let targetPid = targetPidNumber.int32Value
let parentPid = parentPidNumber.int32Value
let expectedEventCount = ${keyCodes.length}

func canonicalPath(_ path: String) -> String {
  URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
}

func runningProcessMatches(_ pid: pid_t, path: String, startToken: String) -> Bool {
  guard pid > 1, kill(pid, 0) == 0 else { return false }
  var buffer = [CChar](repeating: 0, count: 4096)
  let pathLength = proc_pidpath(pid, &buffer, UInt32(buffer.count))
  var info = proc_bsdinfo()
  let expectedInfoSize = Int32(MemoryLayout<proc_bsdinfo>.stride)
  let observedInfoSize = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, expectedInfoSize)
  guard pathLength > 0,
        observedInfoSize == expectedInfoSize,
        info.pbi_status != UInt32(SZOMB) else { return false }
  let observedPath = canonicalPath(String(cString: buffer))
  let observedStartToken = "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)"
  return observedPath == canonicalPath(path) && observedStartToken == startToken
}

func sha256(_ path: String) -> String {
  guard let data = try? Data(contentsOf: URL(fileURLWithPath: path), options: [.mappedIfSafe]) else {
    return ""
  }
  return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func currentInputSourceID() -> String {
  let inputSource = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
  return TISGetInputSourceProperty(inputSource, kTISPropertyInputSourceID)
    .map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? ""
}

func axAttribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
  var raw: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name, &raw) == .success else { return nil }
  return raw
}

func axElementAttribute(_ element: AXUIElement, _ name: CFString) -> AXUIElement? {
  guard let raw = axAttribute(element, name),
        CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
  return (raw as! AXUIElement)
}

func axStringAttribute(_ element: AXUIElement, _ name: CFString) -> String {
  axAttribute(element, name) as? String ?? ""
}

func canonicalDocumentPath(_ raw: CFTypeRef?) -> String {
  if let url = raw as? URL, url.isFileURL { return canonicalPath(url.path) }
  guard let string = raw as? String else { return "" }
  if let url = URL(string: string), url.isFileURL { return canonicalPath(url.path) }
  return string.hasPrefix("/") ? canonicalPath(string) : ""
}

func focusedExactTextEditDocumentMatches() -> Bool {
  guard NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid else { return false }
  let app = AXUIElementCreateApplication(targetPid)
  guard let focusedWindow = axElementAttribute(app, kAXFocusedWindowAttribute as CFString),
        let focusedEditor = axElementAttribute(app, kAXFocusedUIElementAttribute as CFString),
        canonicalDocumentPath(axAttribute(focusedWindow, kAXDocumentAttribute as CFString)) == temporaryDocumentPath,
        axStringAttribute(focusedEditor, kAXRoleAttribute as CFString) == kAXTextAreaRole as String,
        (axAttribute(focusedEditor, kAXFocusedAttribute as CFString) as? Bool) == true
  else { return false }

  var focusedEditorPid = pid_t(0)
  guard AXUIElementGetPid(focusedEditor, &focusedEditorPid) == .success,
        focusedEditorPid == targetPid else { return false }
  let windows = axAttribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
  let exactDocumentWindows = windows.filter {
    canonicalDocumentPath(axAttribute($0, kAXDocumentAttribute as CFString)) == temporaryDocumentPath
  }
  guard exactDocumentWindows.count == 1, CFEqual(focusedWindow, exactDocumentWindows[0]) else {
    return false
  }

  var cursor: AXUIElement? = focusedEditor
  for _ in 0..<24 {
    guard let element = cursor else { break }
    if CFEqual(element, focusedWindow) { return true }
    cursor = axElementAttribute(element, kAXParentAttribute as CFString)
  }
  return false
}

func runtimeEpochMatches() -> Bool {
  let requiredStringKeys = [
    "bundlePath", "executablePath", "executableSha256", "bundleIdentifier",
    "buildVersion", "connectionName", "runtimeHealthPath", "processStartToken",
    "controllerInstanceIdentifier", "activationIdentifier", "executableStartedAt",
    "serverStartedAt", "controllerInitializedAt", "controllerActivatedAt"
  ]
  guard requiredStringKeys.allSatisfy({ expectedRuntimeEpoch[$0] is String }),
        let expectedPid = expectedRuntimeEpoch["processIdentifier"] as? NSNumber,
        let bundlePath = expectedRuntimeEpoch["bundlePath"] as? String,
        let executablePath = expectedRuntimeEpoch["executablePath"] as? String,
        let executableSha256 = expectedRuntimeEpoch["executableSha256"] as? String,
        let bundleIdentifier = expectedRuntimeEpoch["bundleIdentifier"] as? String,
        let buildVersion = expectedRuntimeEpoch["buildVersion"] as? String,
        let connectionName = expectedRuntimeEpoch["connectionName"] as? String,
        let healthPath = expectedRuntimeEpoch["runtimeHealthPath"] as? String,
        let processStartToken = expectedRuntimeEpoch["processStartToken"] as? String,
        expectedPid.int32Value > 1,
        runningProcessMatches(expectedPid.int32Value, path: executablePath, startToken: processStartToken),
        sha256(executablePath) == executableSha256
  else { return false }

  let plistPath = URL(fileURLWithPath: bundlePath).appendingPathComponent("Contents/Info.plist").path
  guard let plistData = try? Data(contentsOf: URL(fileURLWithPath: plistPath)),
        let plist = try? PropertyListSerialization.propertyList(from: plistData, format: nil),
        let info = plist as? [String: Any],
        info["CFBundleIdentifier"] as? String == bundleIdentifier,
        info["CFBundleVersion"] as? String == buildVersion,
        info["InputMethodConnectionName"] as? String == connectionName,
        let healthData = try? Data(contentsOf: URL(fileURLWithPath: healthPath)),
        let health = try? JSONSerialization.jsonObject(with: healthData) as? [String: Any],
        (health["processIdentifier"] as? NSNumber)?.int32Value == expectedPid.int32Value,
        health["bundleIdentifier"] as? String == bundleIdentifier,
        health["bundleVersion"] as? String == buildVersion,
        health["connectionName"] as? String == connectionName,
        health["controllerIsActive"] as? Bool == true
  else { return false }
  let epochKeys = [
    "controllerInstanceIdentifier", "activationIdentifier", "executableStartedAt",
    "serverStartedAt", "controllerInitializedAt", "controllerActivatedAt"
  ]
  return epochKeys.allSatisfy { health[$0] as? String == expectedRuntimeEpoch[$0] as? String }
}

func exactEventCustodyMatches() -> Bool {
  getppid() == parentPid &&
    runningProcessMatches(parentPid, path: parentExecutablePath, startToken: parentProcessStartToken) &&
    runningProcessMatches(targetPid, path: targetExecutablePath, startToken: targetProcessStartToken) &&
    focusedExactTextEditDocumentMatches() &&
    currentInputSourceID() == "${lekhInputSourceId}" &&
    runtimeEpochMatches()
}

let readiness: [String: Any] = [
  "schemaVersion": 1,
  "processIdentifier": getpid(),
  "eventCount": expectedEventCount
]
let readinessData = try! JSONSerialization.data(withJSONObject: readiness, options: [.sortedKeys])
print("LEKH_KEY_READY:\(readinessData.base64EncodedString())")
fflush(stdout)
guard readLine(strippingNewline: true) == "GO" else { exit(78) }

let source = CGEventSource(stateID: .hidSystemState)
let events: [(code: CGKeyCode, flags: CGEventFlags)] = [
  ${rows}
]
var downCount = 0
var upCount = 0
var guardCheckCount = 0
var compensatingKeyUpCount = 0
var outstandingKey: CGKeyCode?

func emit(completed: Bool, failureKind: String?) -> Never {
  let output: [String: Any] = [
    "schemaVersion": 1,
    "completed": completed,
    "eventCount": expectedEventCount,
    "downCount": downCount,
    "upCount": upCount,
    "guardCheckCount": guardCheckCount,
    "compensatingKeyUpCount": compensatingKeyUpCount,
    "failureKind": failureKind ?? NSNull()
  ]
  let data = try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
  print(String(decoding: data, as: UTF8.self))
  fflush(stdout)
  exit(completed ? 0 : 80)
}

func failGuard(_ phase: String) -> Never {
  // A normal event is posted only after the full custody guard. If focus or
  // source changes after a down, a compensating up is permitted only for the
  // still-exact TextEdit process instance; it cannot insert content and avoids
  // leaving that exact host with an unmatched key-down.
  if let outstandingKey,
     runningProcessMatches(targetPid, path: targetExecutablePath, startToken: targetProcessStartToken),
     let release = CGEvent(keyboardEventSource: source, virtualKey: outstandingKey, keyDown: false) {
    release.postToPid(targetPid)
    compensatingKeyUpCount += 1
  }
  emit(completed: false, failureKind: phase)
}

for event in events {
  guard let down = CGEvent(keyboardEventSource: source, virtualKey: event.code, keyDown: true),
        let up = CGEvent(keyboardEventSource: source, virtualKey: event.code, keyDown: false)
  else { emit(completed: false, failureKind: "event-creation-failed") }
  down.flags = event.flags
  up.flags = event.flags
  guard exactEventCustodyMatches() else { failGuard("guard-before-down") }
  guardCheckCount += 1
  down.postToPid(targetPid)
  downCount += 1
  outstandingKey = event.code
  usleep(35_000)
  guard exactEventCustodyMatches() else { failGuard("guard-before-up") }
  guardCheckCount += 1
  up.postToPid(targetPid)
  upCount += 1
  outstandingKey = nil
  usleep(65_000)
}
emit(completed: true, failureKind: nil)
`;
}

function candidateSurfaceSource(inputMethodPid) {
  return `
import ApplicationServices
import Foundation

let targetPid = pid_t(${inputMethodPid})

func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
  return value
}

func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String {
  attribute(element, name) as? String ?? ""
}

func pointAttribute(_ element: AXUIElement, _ name: CFString) -> CGPoint? {
  guard let raw = attribute(element, name) else { return nil }
  let value = raw as! AXValue
  var point = CGPoint.zero
  guard AXValueGetValue(value, .cgPoint, &point) else { return nil }
  return point
}

func sizeAttribute(_ element: AXUIElement, _ name: CFString) -> CGSize? {
  guard let raw = attribute(element, name) else { return nil }
  let value = raw as! AXValue
  var size = CGSize.zero
  guard AXValueGetValue(value, .cgSize, &size) else { return nil }
  return size
}

func frame(_ element: AXUIElement) -> [String: Double]? {
  guard let point = pointAttribute(element, kAXPositionAttribute as CFString),
        let size = sizeAttribute(element, kAXSizeAttribute as CFString) else { return nil }
  return ["x": point.x, "y": point.y, "width": size.width, "height": size.height]
}

func candidateRows(in element: AXUIElement, depth: Int = 0) -> [[String: Any]] {
  guard depth < 14 else { return [] }
  var output: [[String: Any]] = []
  let identifier = stringAttribute(element, "AXIdentifier" as CFString)
  if identifier.hasPrefix("lekh.candidate."), let elementFrame = frame(element) {
    output.append([
      "identifier": identifier,
      "role": stringAttribute(element, kAXRoleAttribute as CFString),
      "label": stringAttribute(element, kAXTitleAttribute as CFString).isEmpty
        ? stringAttribute(element, kAXDescriptionAttribute as CFString)
        : stringAttribute(element, kAXTitleAttribute as CFString),
      "frame": elementFrame
    ])
  }
  let children = attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
  for child in children {
    output.append(contentsOf: candidateRows(in: child, depth: depth + 1))
  }
  return output
}

let app = AXUIElementCreateApplication(targetPid)
let windows = attribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
var outputWindows: [[String: Any]] = []
for window in windows {
  guard let windowFrame = frame(window) else { continue }
  outputWindows.append([
    "identifier": stringAttribute(window, "AXIdentifier" as CFString),
    "role": stringAttribute(window, kAXRoleAttribute as CFString),
    "label": stringAttribute(window, kAXTitleAttribute as CFString).isEmpty
      ? stringAttribute(window, kAXDescriptionAttribute as CFString)
      : stringAttribute(window, kAXTitleAttribute as CFString),
    "frame": windowFrame,
    "rows": candidateRows(in: window).sorted {
      ($0["identifier"] as? String ?? "") < ($1["identifier"] as? String ?? "")
    }
  ])
}
let output: [String: Any] = ["processIdentifier": targetPid, "windows": outputWindows]
let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
`;
}

function mouseGestureSource({
  inputMethodPid,
  textEditPid,
  start,
  end,
  candidateWindowFrame,
  expectedStartIdentifier,
  expectedEndIdentifier,
  expectedRuntimeEpoch,
  drag
}) {
  const runtimeEpochBase64 = Buffer.from(JSON.stringify(expectedRuntimeEpoch), "utf8").toString("base64");
  return `
import AppKit
import ApplicationServices
import Carbon
import CryptoKit
import CoreGraphics
import Darwin
import Dispatch
import Foundation

// The helper cannot synthesize any mouse event until its exact PID, executable
// path, process-start epoch, pointer/button baseline, and SHA-256 are durable in
// the parent-held recovery journal. Parent
// death before this one-line authorization produces EOF and a side-effect-free
// exit; parent death afterward lets the guardian terminate this exact helper
// before posting its compensating mouse-up.
guard let custodiedOriginalPointer = CGEvent(source: nil)?.location else { exit(77) }
let custodiedInitialLeftButtonReleased = !CGEventSource.buttonState(
  .combinedSessionState,
  button: .left
)
let readiness: [String: Any] = [
  "schemaVersion": 1,
  "processIdentifier": getpid(),
  "originalPointer": [
    "x": custodiedOriginalPointer.x,
    "y": custodiedOriginalPointer.y
  ],
  "initialLeftButtonReleased": custodiedInitialLeftButtonReleased
]
let readinessData = try! JSONSerialization.data(withJSONObject: readiness, options: [.sortedKeys])
print("LEKH_GESTURE_READY:\(readinessData.base64EncodedString())")
fflush(stdout)
guard readLine(strippingNewline: true) == "GO" else { exit(78) }

let inputMethodPid = pid_t(${inputMethodPid})
let textEditPid = pid_t(${textEditPid})
let startPoint = CGPoint(x: ${start.x}, y: ${start.y})
let endPoint = CGPoint(x: ${end.x}, y: ${end.y})
let candidateAXFrame = CGRect(
  x: ${candidateWindowFrame.x},
  y: ${candidateWindowFrame.y},
  width: ${candidateWindowFrame.width},
  height: ${candidateWindowFrame.height}
)
let expectedStartIdentifier = ${JSON.stringify(expectedStartIdentifier)}
let expectedEndIdentifier = ${JSON.stringify(expectedEndIdentifier)}
let shouldDrag = ${drag ? "true" : "false"}
guard let runtimeEpochData = Data(base64Encoded: ${JSON.stringify(runtimeEpochBase64)}),
      let expectedRuntimeEpoch = try JSONSerialization.jsonObject(with: runtimeEpochData) as? [String: Any]
else { exit(79) }

func canonicalPath(_ path: String) -> String {
  URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
}

func processPath(_ pid: pid_t) -> String {
  var buffer = [CChar](repeating: 0, count: 4096)
  let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
  return length > 0 ? canonicalPath(String(cString: buffer)) : ""
}

func processStartToken(_ pid: pid_t) -> String {
  var info = proc_bsdinfo()
  let expectedSize = Int32(MemoryLayout<proc_bsdinfo>.stride)
  let observedSize = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, expectedSize)
  guard observedSize == expectedSize else { return "" }
  return "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)"
}

func sha256(_ path: String) -> String {
  guard let data = try? Data(contentsOf: URL(fileURLWithPath: path), options: [.mappedIfSafe]) else { return "" }
  return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func runtimeEpochMatches() -> Bool {
  let stringKeys = [
    "bundlePath", "executablePath", "executableSha256", "bundleIdentifier",
    "buildVersion", "connectionName", "runtimeHealthPath",
    "processStartToken", "textEditExecutablePath", "textEditProcessStartToken",
    "temporaryDocumentPath",
    "controllerInstanceIdentifier", "activationIdentifier", "executableStartedAt",
    "serverStartedAt", "controllerInitializedAt", "controllerActivatedAt"
  ]
  guard stringKeys.allSatisfy({ expectedRuntimeEpoch[$0] is String }),
        let expectedPidNumber = expectedRuntimeEpoch["processIdentifier"] as? NSNumber,
        expectedPidNumber.int32Value == inputMethodPid,
        let expectedBundlePath = expectedRuntimeEpoch["bundlePath"] as? String,
        let expectedExecutablePath = expectedRuntimeEpoch["executablePath"] as? String,
        let expectedExecutableSha256 = expectedRuntimeEpoch["executableSha256"] as? String,
        let expectedBundleIdentifier = expectedRuntimeEpoch["bundleIdentifier"] as? String,
        let expectedBuildVersion = expectedRuntimeEpoch["buildVersion"] as? String,
        let expectedConnectionName = expectedRuntimeEpoch["connectionName"] as? String,
        let expectedHealthPath = expectedRuntimeEpoch["runtimeHealthPath"] as? String,
        let expectedProcessStartToken = expectedRuntimeEpoch["processStartToken"] as? String,
        let expectedTextEditExecutablePath = expectedRuntimeEpoch["textEditExecutablePath"] as? String,
        let expectedTextEditProcessStartToken = expectedRuntimeEpoch["textEditProcessStartToken"] as? String,
        let expectedTemporaryDocumentPath = expectedRuntimeEpoch["temporaryDocumentPath"] as? String,
        canonicalPath(expectedBundlePath) == expectedBundlePath,
        canonicalPath(expectedExecutablePath) == expectedExecutablePath,
        canonicalPath(expectedTextEditExecutablePath) == expectedTextEditExecutablePath,
        canonicalPath(expectedTemporaryDocumentPath) == expectedTemporaryDocumentPath,
        processPath(inputMethodPid) == expectedExecutablePath,
        processStartToken(inputMethodPid) == expectedProcessStartToken,
        processPath(textEditPid) == expectedTextEditExecutablePath,
        processStartToken(textEditPid) == expectedTextEditProcessStartToken,
        sha256(expectedExecutablePath) == expectedExecutableSha256
  else { return false }

  let plistPath = URL(fileURLWithPath: expectedBundlePath)
    .appendingPathComponent("Contents/Info.plist").path
  guard let plistData = try? Data(contentsOf: URL(fileURLWithPath: plistPath)),
        let plist = try? PropertyListSerialization.propertyList(from: plistData, format: nil),
        let info = plist as? [String: Any],
        info["CFBundleIdentifier"] as? String == expectedBundleIdentifier,
        info["CFBundleVersion"] as? String == expectedBuildVersion,
        info["InputMethodConnectionName"] as? String == expectedConnectionName,
        let healthData = try? Data(contentsOf: URL(fileURLWithPath: expectedHealthPath)),
        let health = try? JSONSerialization.jsonObject(with: healthData) as? [String: Any],
        (health["processIdentifier"] as? NSNumber)?.int32Value == inputMethodPid,
        health["bundleIdentifier"] as? String == expectedBundleIdentifier,
        health["bundleVersion"] as? String == expectedBuildVersion,
        health["connectionName"] as? String == expectedConnectionName,
        health["controllerIsActive"] as? Bool == true
  else { return false }

  let epochKeys = [
    "controllerInstanceIdentifier", "activationIdentifier", "executableStartedAt",
    "serverStartedAt", "controllerInitializedAt", "controllerActivatedAt"
  ]
  return epochKeys.allSatisfy { key in
    health[key] as? String == expectedRuntimeEpoch[key] as? String
  }
}
let automationPermissionState: [String: Bool] = [
  "accessibilityTrusted": AXIsProcessTrusted(),
  "eventPostAccess": CGPreflightPostEventAccess(),
  "eventListenAccess": CGPreflightListenEventAccess()
]

func currentInputSourceID() -> String {
  let source = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
  return TISGetInputSourceProperty(source, kTISPropertyInputSourceID)
    .map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? ""
}

func rectJSON(_ rect: CGRect) -> [String: Double] {
  ["x": rect.origin.x, "y": rect.origin.y, "width": rect.width, "height": rect.height]
}

func pointJSON(_ point: CGPoint) -> [String: Double] {
  ["x": point.x, "y": point.y]
}

struct WindowObservation {
  let pid: pid_t
  let windowID: Int
  let bounds: CGRect
  let layer: Int
  let alpha: Double
  let onScreen: Bool

  var json: [String: Any] {
    [
      "pid": pid,
      "windowNumber": windowID,
      "bounds": rectJSON(bounds),
      "layer": layer,
      "alpha": alpha,
      "onScreen": onScreen
    ]
  }
}

let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let windows: [WindowObservation] = rows.compactMap { row in
  guard let owner = row[kCGWindowOwnerPID as String] as? NSNumber,
        let windowNumber = row[kCGWindowNumber as String] as? NSNumber,
        let boundsDictionary = row[kCGWindowBounds as String] as? [String: Any],
        let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary) else { return nil }
  return WindowObservation(
    pid: pid_t(owner.int32Value),
    windowID: windowNumber.intValue,
    bounds: bounds,
    layer: (row[kCGWindowLayer as String] as? NSNumber)?.intValue ?? Int.min,
    alpha: (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? -1,
    onScreen: (row[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
  )
}

func topmostWindow(at point: CGPoint) -> WindowObservation? {
  for window in windows where window.bounds.contains(point) {
    return window
  }
  return nil
}

func rectDelta(_ lhs: CGRect, _ rhs: CGRect) -> CGFloat {
  max(
    abs(lhs.origin.x - rhs.origin.x),
    abs(lhs.origin.y - rhs.origin.y),
    abs(lhs.width - rhs.width),
    abs(lhs.height - rhs.height)
  )
}

func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String {
  var raw: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name, &raw) == .success else { return "" }
  return raw as? String ?? ""
}

func axAttribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
  var raw: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name, &raw) == .success else { return nil }
  return raw
}

func axElementAttribute(_ element: AXUIElement, _ name: CFString) -> AXUIElement? {
  guard let raw = axAttribute(element, name),
        CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
  return (raw as! AXUIElement)
}

func axBooleanAttribute(_ element: AXUIElement, _ name: CFString) -> Bool {
  axAttribute(element, name) as? Bool ?? false
}

func canonicalDocumentPath(_ raw: CFTypeRef?) -> String {
  if let url = raw as? URL, url.isFileURL { return canonicalPath(url.path) }
  guard let string = raw as? String else { return "" }
  if let url = URL(string: string), url.isFileURL { return canonicalPath(url.path) }
  return string.hasPrefix("/") ? canonicalPath(string) : ""
}

func element(_ child: AXUIElement, descendsFrom ancestor: AXUIElement) -> Bool {
  var current: AXUIElement? = child
  for _ in 0..<32 {
    guard let element = current else { return false }
    if CFEqual(element, ancestor) { return true }
    current = axElementAttribute(element, kAXParentAttribute as CFString)
  }
  return false
}

func exactTextEditContext() -> Bool {
  let expectedDocumentPath = expectedRuntimeEpoch["temporaryDocumentPath"] as? String ?? ""
  let app = AXUIElementCreateApplication(textEditPid)
  let windows = axAttribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
  let exactWindows = windows.filter {
    canonicalDocumentPath(axAttribute($0, kAXDocumentAttribute as CFString)) == expectedDocumentPath
  }
  guard exactWindows.count == 1,
        axBooleanAttribute(app, kAXFrontmostAttribute as CFString),
        let focusedWindow = axElementAttribute(app, kAXFocusedWindowAttribute as CFString),
        let mainWindow = axElementAttribute(app, kAXMainWindowAttribute as CFString),
        let focusedEditor = axElementAttribute(app, kAXFocusedUIElementAttribute as CFString),
        CFEqual(focusedWindow, exactWindows[0]),
        CFEqual(mainWindow, exactWindows[0]),
        element(focusedEditor, descendsFrom: exactWindows[0]),
        stringAttribute(focusedEditor, kAXRoleAttribute as CFString) == (kAXTextAreaRole as String),
        axBooleanAttribute(focusedEditor, kAXFocusedAttribute as CFString) else { return false }
  return true
}

func parent(_ element: AXUIElement) -> AXUIElement? {
  var raw: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &raw) == .success else { return nil }
  return (raw as! AXUIElement)
}

func accessibilityHit(at point: CGPoint, expectedRowIdentifier: String) -> [String: Any] {
  var hit: AXUIElement?
  let error = AXUIElementCopyElementAtPosition(
    AXUIElementCreateSystemWide(),
    Float(point.x),
    Float(point.y),
    &hit
  )
  guard error == .success, let hit else {
    return [
      "error": error.rawValue,
      "expectedRowIdentifier": expectedRowIdentifier,
      "exactProcess": false,
      "expectedRow": false,
      "candidatePanel": false
    ]
  }

  var identifiers: [String] = []
  var allExactProcess = true
  var current: AXUIElement? = hit
  for _ in 0..<20 {
    guard let element = current else { break }
    var elementPid = pid_t(0)
    if AXUIElementGetPid(element, &elementPid) != .success || elementPid != inputMethodPid {
      allExactProcess = false
    }
    let identifier = stringAttribute(element, "AXIdentifier" as CFString)
    if !identifier.isEmpty { identifiers.append(identifier) }
    current = parent(element)
  }
  return [
    "error": error.rawValue,
    "expectedRowIdentifier": expectedRowIdentifier,
    "identifiers": identifiers,
    "exactProcess": allExactProcess,
    "expectedRow": identifiers.contains(expectedRowIdentifier),
    "candidatePanel": identifiers.contains("lekh.candidatePanel")
  ]
}

let mainDisplayBounds = CGDisplayBounds(CGMainDisplayID())
func flipAcrossMainDisplay(_ point: CGPoint) -> CGPoint {
  CGPoint(x: point.x, y: mainDisplayBounds.minY + mainDisplayBounds.maxY - point.y)
}
func flipAcrossMainDisplay(_ rect: CGRect) -> CGRect {
  CGRect(
    x: rect.origin.x,
    y: mainDisplayBounds.minY + mainDisplayBounds.maxY - rect.maxY,
    width: rect.width,
    height: rect.height
  )
}

struct CoordinateVariant {
  let name: String
  let start: CGPoint
  let end: CGPoint
  let panelFrame: CGRect
}

var coordinateVariants = [
  CoordinateVariant(name: "identity", start: startPoint, end: endPoint, panelFrame: candidateAXFrame)
]
let flippedPanelFrame = flipAcrossMainDisplay(candidateAXFrame)
if rectDelta(flippedPanelFrame, candidateAXFrame) > 0.5 {
  coordinateVariants.append(CoordinateVariant(
    name: "main-display-y-flip",
    start: flipAcrossMainDisplay(startPoint),
    end: flipAcrossMainDisplay(endPoint),
    panelFrame: flippedPanelFrame
  ))
}

let imkWindows = windows.filter { $0.pid == inputMethodPid }
let panelMatches = coordinateVariants.flatMap { variant in
  imkWindows
    .filter { rectDelta($0.bounds, variant.panelFrame) <= 3 }
    .map { (variant: variant, window: $0) }
}
let diagnosticVariants: [[String: Any]] = coordinateVariants.map { variant in
  let topmostStart = topmostWindow(at: variant.start)
  let topmostEnd = topmostWindow(at: variant.end)
  return [
    "name": variant.name,
    "start": pointJSON(variant.start),
    "end": pointJSON(variant.end),
    "panelFrame": rectJSON(variant.panelFrame),
    "topmostStart": topmostStart?.json ?? NSNull(),
    "topmostEnd": topmostEnd?.json ?? NSNull(),
    "matchingIMKWindowNumbers": imkWindows
      .filter { rectDelta($0.bounds, variant.panelFrame) <= 3 }
      .map(\\.windowID)
  ]
}

var preflightMouseMoveEventsPosted = false
var originalPointerForCleanup: CGPoint?
var mouseRouteEvidence: [String: Any]?
var preButtonRecheckEvidence: [String: Any]?
let expectedButtonSequence = shouldDrag ? ["down", "drag", "up"] : ["down", "up"]
var postedButtonSequence: [String] = []
var fallbackMouseUpPosted = false
var fallbackMouseUpObserved = false
var buttonSequenceFailureReason: String?
var preButtonRecheckCompletedAtNs: UInt64?
var finalStartRouteObservedAtNs: UInt64?
var tapCreationListenAccessOnFailure: Bool?
var runtimeEpochPreflight = false

struct MouseRouteObservation {
  let windowUnderPointer: Int64
  let windowThatCanHandleEvent: Int64
  let location: CGPoint
  let observedAtNs: UInt64

  var json: [String: Any] {
    [
      "windowUnderPointer": windowUnderPointer,
      "windowThatCanHandleEvent": windowThatCanHandleEvent,
      "location": pointJSON(location),
      "observedAtNs": observedAtNs
    ]
  }
}

final class MouseRouteCapture {
  static let routeMarker: Int64 = 0x4C454B4800000001
  static let buttonMarker: Int64 = 0x4C454B4800000002
  static let fallbackMarker: Int64 = 0x4C454B4800000003
  var routeObservation: MouseRouteObservation?
  var observedButtonSequence: [String] = []
}

let routeCapture = MouseRouteCapture()

func emitPreflightFailure(reason: String, exitCode: Int32) -> Never {
  var pointerRestoredAfterPreflight: Any = NSNull()
  if preflightMouseMoveEventsPosted, let originalPointerForCleanup {
    CGWarpMouseCursorPosition(originalPointerForCleanup)
    usleep(80_000)
    if let restored = CGEvent(source: nil)?.location {
      pointerRestoredAfterPreflight =
        abs(restored.x - originalPointerForCleanup.x) <= 2 &&
        abs(restored.y - originalPointerForCleanup.y) <= 2
    }
  }
  let output: [String: Any] = [
    "gesture": shouldDrag ? "drag-away" : "click",
    "preflightFailure": reason,
    "frontmostTextEditPreflight": NSWorkspace.shared.frontmostApplication?.processIdentifier == textEditPid,
    "inputSourcePreflight": currentInputSourceID() == "${lekhInputSourceId}",
    "runtimeEpochPreflight": runtimeEpochPreflight,
    "candidateAXFrame": rectJSON(candidateAXFrame),
    "expectedStartIdentifier": expectedStartIdentifier,
    "expectedEndIdentifier": expectedEndIdentifier,
    "automationPermissionState": automationPermissionState,
    "tapCreationListenAccessOnFailure":
      tapCreationListenAccessOnFailure.map { $0 as Any } ?? NSNull(),
    "coordinateVariants": diagnosticVariants,
    "imkWindows": imkWindows.map(\\.json),
    "windowListCount": windows.count,
    "mouseRouteEvidence": mouseRouteEvidence ?? NSNull(),
    "preButtonRecheck": preButtonRecheckEvidence ?? NSNull(),
    "preflightMouseMoveEventsPosted": preflightMouseMoveEventsPosted,
    "expectedButtonSequence": expectedButtonSequence,
    "postedButtonSequence": postedButtonSequence,
    "observedButtonSequence": routeCapture.observedButtonSequence,
    "fallbackMouseUpPosted": fallbackMouseUpPosted,
    "fallbackMouseUpObserved": fallbackMouseUpObserved,
    "mouseButtonEventPosted": !postedButtonSequence.isEmpty,
    "pointerRestoredAfterPreflight": pointerRestoredAfterPreflight
  ]
  let data = try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
  print(String(decoding: data, as: UTF8.self))
  fputs("Candidate gesture helper failed after applying its pointer/button safety cleanup.\\n", stderr)
  exit(exitCode)
}

guard NSWorkspace.shared.frontmostApplication?.processIdentifier == textEditPid else {
  emitPreflightFailure(reason: "frontmost-textedit-mismatch", exitCode: 10)
}
guard exactTextEditContext() else {
  emitPreflightFailure(reason: "exact-textedit-context-mismatch", exitCode: 22)
}
guard currentInputSourceID() == "${lekhInputSourceId}" else {
  emitPreflightFailure(reason: "input-source-mismatch", exitCode: 11)
}
runtimeEpochPreflight = runtimeEpochMatches()
guard runtimeEpochPreflight else {
  emitPreflightFailure(reason: "runtime-epoch-mismatch", exitCode: 21)
}
guard panelMatches.count == 1 else {
  emitPreflightFailure(
    reason: panelMatches.isEmpty ? "candidate-window-not-found" : "candidate-window-ambiguous",
    exitCode: 12
  )
}
let selectedVariant = panelMatches[0].variant
let candidateWindow = panelMatches[0].window
let eventStartPoint = selectedVariant.start
let eventEndPoint = selectedVariant.end
let startHit = accessibilityHit(at: eventStartPoint, expectedRowIdentifier: expectedStartIdentifier)
let endHit = accessibilityHit(at: eventEndPoint, expectedRowIdentifier: expectedEndIdentifier)
guard startHit["exactProcess"] as? Bool == true,
      startHit["expectedRow"] as? Bool == true,
      startHit["candidatePanel"] as? Bool == true,
      endHit["exactProcess"] as? Bool == true,
      endHit["expectedRow"] as? Bool == true,
      endHit["candidatePanel"] as? Bool == true else {
  emitPreflightFailure(reason: "candidate-row-ax-hit-mismatch", exitCode: 15)
}

let source = CGEventSource(stateID: .hidSystemState)
let originalPointer = custodiedOriginalPointer
originalPointerForCleanup = originalPointer
defer { CGWarpMouseCursorPosition(originalPointer) }
guard custodiedInitialLeftButtonReleased,
      !CGEventSource.buttonState(.combinedSessionState, button: .left) else {
  emitPreflightFailure(reason: "physical-left-button-not-released", exitCode: 13)
}

func makeButtonEvent(_ type: CGEventType, point: CGPoint, marker: Int64) -> CGEvent? {
  let event = CGEvent(
    mouseEventSource: source,
    mouseType: type,
    mouseCursorPosition: point,
    mouseButton: .left
  )
  event?.setIntegerValueField(.eventSourceUserData, value: marker)
  return event
}

guard let mouseDownEvent = makeButtonEvent(
        .leftMouseDown,
        point: eventStartPoint,
        marker: MouseRouteCapture.buttonMarker
      ),
      let mouseUpEvent = makeButtonEvent(
        .leftMouseUp,
        point: eventEndPoint,
        marker: MouseRouteCapture.buttonMarker
      ),
      let fallbackMouseUpEvent = makeButtonEvent(
        .leftMouseUp,
        point: eventEndPoint,
        marker: MouseRouteCapture.fallbackMarker
      ) else {
  emitPreflightFailure(reason: "button-event-precreation-failed", exitCode: 18)
}
var buttonEvents: [(label: String, event: CGEvent)] = [("down", mouseDownEvent)]
if shouldDrag {
  guard let mouseDragEvent = makeButtonEvent(
          .leftMouseDragged,
          point: eventEndPoint,
          marker: MouseRouteCapture.buttonMarker
        ) else {
    emitPreflightFailure(reason: "button-event-precreation-failed", exitCode: 18)
  }
  buttonEvents.append(("drag", mouseDragEvent))
}
buttonEvents.append(("up", mouseUpEvent))

let routeCallback: CGEventTapCallBack = { _, type, event, userInfo in
  guard let userInfo else {
    return Unmanaged.passUnretained(event)
  }
  let capture = Unmanaged<MouseRouteCapture>.fromOpaque(userInfo).takeUnretainedValue()
  let marker = event.getIntegerValueField(.eventSourceUserData)
  if type == .mouseMoved, marker == MouseRouteCapture.routeMarker {
    capture.routeObservation = MouseRouteObservation(
      windowUnderPointer: event.getIntegerValueField(.mouseEventWindowUnderMousePointer),
      windowThatCanHandleEvent: event.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent),
      location: event.location,
      observedAtNs: DispatchTime.now().uptimeNanoseconds
    )
  } else if marker == MouseRouteCapture.buttonMarker {
    let label: String?
    switch type {
    case .leftMouseDown: label = "down"
    case .leftMouseDragged: label = "drag"
    case .leftMouseUp: label = "up"
    default: label = nil
    }
    if let label { capture.observedButtonSequence.append(label) }
  } else if type == .leftMouseUp, marker == MouseRouteCapture.fallbackMarker {
    capture.observedButtonSequence.append("fallback-up")
  }
  return Unmanaged.passUnretained(event)
}
let eventMask =
  (CGEventMask(1) << CGEventType.mouseMoved.rawValue) |
  (CGEventMask(1) << CGEventType.leftMouseDown.rawValue) |
  (CGEventMask(1) << CGEventType.leftMouseDragged.rawValue) |
  (CGEventMask(1) << CGEventType.leftMouseUp.rawValue)
guard let routeTap = CGEvent.tapCreate(
  tap: .cgAnnotatedSessionEventTap,
  place: .headInsertEventTap,
  options: .listenOnly,
  eventsOfInterest: eventMask,
  callback: routeCallback,
  userInfo: Unmanaged.passUnretained(routeCapture).toOpaque()
) else {
  // Bind the blocked classification to the same helper and the exact instant
  // tap creation failed; a startup snapshot is not sufficient evidence.
  tapCreationListenAccessOnFailure = CGPreflightListenEventAccess()
  emitPreflightFailure(reason: "mouse-route-listener-unavailable", exitCode: 16)
}
let routeRunLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, routeTap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), routeRunLoopSource, .defaultMode)
CGEvent.tapEnable(tap: routeTap, enable: true)
defer {
  CGEvent.tapEnable(tap: routeTap, enable: false)
  CFRunLoopRemoveSource(CFRunLoopGetCurrent(), routeRunLoopSource, .defaultMode)
}

func routedWindow(at point: CGPoint) -> MouseRouteObservation? {
  routeCapture.routeObservation = nil
  guard let move = CGEvent(
    mouseEventSource: source,
    mouseType: .mouseMoved,
    mouseCursorPosition: point,
    mouseButton: .left
  ) else { return nil }
  move.setIntegerValueField(.eventSourceUserData, value: MouseRouteCapture.routeMarker)
  preflightMouseMoveEventsPosted = true
  move.post(tap: .cghidEventTap)
  let deadline = Date().addingTimeInterval(0.75)
  while routeCapture.routeObservation == nil, Date() < deadline {
    CFRunLoopRunInMode(.defaultMode, 0.05, true)
  }
  return routeCapture.routeObservation
}

func routeMatches(_ observation: MouseRouteObservation?, point: CGPoint) -> Bool {
  guard let observation else { return false }
  return observation.windowThatCanHandleEvent == Int64(candidateWindow.windowID) &&
    abs(observation.location.x - point.x) <= 2 &&
    abs(observation.location.y - point.y) <= 2
}

// Route the release point first and the press point last. The final tagged
// routed move therefore leaves the pointer at the already-proven press target.
let endRoute = routedWindow(at: eventEndPoint)
let startRoute = routedWindow(at: eventStartPoint)
finalStartRouteObservedAtNs = startRoute?.observedAtNs
mouseRouteEvidence = [
  "start": startRoute?.json ?? NSNull(),
  "end": endRoute?.json ?? NSNull(),
  "expectedCandidateWindowNumber": candidateWindow.windowID,
  "finalTaggedRoutedMove": "start"
]
guard routeMatches(startRoute, point: eventStartPoint),
      routeMatches(endRoute, point: eventEndPoint) else {
  emitPreflightFailure(reason: "candidate-window-mouse-routing-mismatch", exitCode: 17)
}

func observedSequenceEquals(_ expected: [String], timeout: TimeInterval = 0.75) -> Bool {
  let deadline = Date().addingTimeInterval(timeout)
  while routeCapture.observedButtonSequence.count < expected.count, Date() < deadline {
    CFRunLoopRunInMode(.defaultMode, 0.025, true)
  }
  return routeCapture.observedButtonSequence == expected
}

func postFallbackMouseUp() {
  guard !fallbackMouseUpPosted else { return }
  fallbackMouseUpEvent.post(tap: .cghidEventTap)
  postedButtonSequence.append("fallback-up")
  fallbackMouseUpPosted = true
  let deadline = Date().addingTimeInterval(0.75)
  while !routeCapture.observedButtonSequence.contains("fallback-up"), Date() < deadline {
    CFRunLoopRunInMode(.defaultMode, 0.025, true)
  }
  fallbackMouseUpObserved = routeCapture.observedButtonSequence.contains("fallback-up")
}

func refreshPreButtonStateEvidence() -> Bool {
  let frontmostTextEdit =
    NSWorkspace.shared.frontmostApplication?.processIdentifier == textEditPid
  let inputSource = currentInputSourceID() == "${lekhInputSourceId}"
  let runtimeEpoch = runtimeEpochMatches()
  let exactTextEdit = exactTextEditContext()
  let startHit = accessibilityHit(
    at: eventStartPoint,
    expectedRowIdentifier: expectedStartIdentifier
  )
  let exactPressAXTarget =
    startHit["exactProcess"] as? Bool == true &&
    startHit["expectedRow"] as? Bool == true &&
    startHit["candidatePanel"] as? Bool == true
  preButtonRecheckEvidence = [
    "frontmostTextEdit": frontmostTextEdit,
    "inputSource": inputSource,
    "runtimeEpoch": runtimeEpoch,
    "exactTextEditContext": exactTextEdit,
    "exactAXTargets": exactPressAXTarget,
    "startAXHit": startHit
  ]
  preButtonRecheckCompletedAtNs = DispatchTime.now().uptimeNanoseconds
  return frontmostTextEdit && inputSource && runtimeEpoch && exactTextEdit && exactPressAXTarget
}

func postPrecreatedButtonSequence() -> Bool {
  routeCapture.observedButtonSequence = []
  postedButtonSequence = []
  buttonSequenceFailureReason = nil
  var mouseDownOutstanding = false
  defer {
    if mouseDownOutstanding {
      postFallbackMouseUp()
    }
  }
  // This is the final operation before the precreated down event. In
  // particular there is no sleep and no replacement mouse-move event.
  guard refreshPreButtonStateEvidence() else {
    buttonSequenceFailureReason = "pre-button-state-recheck-failed"
    return false
  }
  for item in buttonEvents {
    if item.label == "down" {
      let mouseDownPostStartedAtNs = DispatchTime.now().uptimeNanoseconds
      guard let routeObservedAtNs = finalStartRouteObservedAtNs,
            let recheckCompletedAtNs = preButtonRecheckCompletedAtNs,
            mouseDownPostStartedAtNs >= routeObservedAtNs,
            mouseDownPostStartedAtNs >= recheckCompletedAtNs else {
        buttonSequenceFailureReason = "button-event-monotonic-clock-invalid"
        return false
      }
      let routeToMouseDownPostStartNs = mouseDownPostStartedAtNs - routeObservedAtNs
      let recheckToMouseDownPostStartNs = mouseDownPostStartedAtNs - recheckCompletedAtNs
      let withinTOCTOUBounds =
        routeToMouseDownPostStartNs <= 50_000_000 &&
        recheckToMouseDownPostStartNs <= 10_000_000
      preButtonRecheckEvidence?["routeToMouseDownPostStartNs"] = routeToMouseDownPostStartNs
      preButtonRecheckEvidence?["recheckToMouseDownPostStartNs"] = recheckToMouseDownPostStartNs
      preButtonRecheckEvidence?["noMoveOrDelayBeforeMouseDown"] = withinTOCTOUBounds
      guard withinTOCTOUBounds else {
        buttonSequenceFailureReason = "button-event-toctou-bound-exceeded"
        return false
      }
      mouseDownOutstanding = true
      item.event.post(tap: .cghidEventTap)
    } else {
      item.event.post(tap: .cghidEventTap)
    }
    postedButtonSequence.append(item.label)
    guard observedSequenceEquals(postedButtonSequence) else {
      buttonSequenceFailureReason = "button-event-observation-mismatch"
      return false
    }
    if item.label == "up" { mouseDownOutstanding = false }
  }
  let complete = postedButtonSequence == expectedButtonSequence &&
    routeCapture.observedButtonSequence == expectedButtonSequence
  if !complete { buttonSequenceFailureReason = "button-event-sequence-incomplete" }
  return complete
}

let buttonSequenceComplete = postPrecreatedButtonSequence()
guard buttonSequenceComplete else {
  emitPreflightFailure(
    reason: buttonSequenceFailureReason ?? "button-event-sequence-incomplete",
    exitCode: 20
  )
}

CGWarpMouseCursorPosition(originalPointer)
usleep(80_000)
let restoredPointer = CGEvent(source: nil)?.location ?? CGPoint(x: CGFloat.infinity, y: CGFloat.infinity)
let pointerRestored = abs(restoredPointer.x - originalPointer.x) <= 2 && abs(restoredPointer.y - originalPointer.y) <= 2

let output: [String: Any] = [
  "gesture": shouldDrag ? "drag-away" : "click",
  "exactWindowOwnerPreflight": true,
  "candidateWindowFramePreflight": true,
  "exactCandidateAXHitPreflight": true,
  "mouseRoutingWindowPreflight": true,
  "frontmostTextEditPreflight": true,
  "exactTextEditContextPreflight": true,
  "inputSourcePreflight": true,
  "runtimeEpochPreflight": runtimeEpochPreflight,
  "coordinateVariant": selectedVariant.name,
  "windowNumber": candidateWindow.windowID,
  "windowBounds": rectJSON(candidateWindow.bounds),
  "candidateAXFrame": rectJSON(candidateAXFrame),
  "start": pointJSON(eventStartPoint),
  "end": pointJSON(eventEndPoint),
  "startAXHit": startHit,
  "endAXHit": endHit,
  "mouseRouteEvidence": mouseRouteEvidence ?? NSNull(),
  "preButtonRecheck": preButtonRecheckEvidence ?? NSNull(),
  "expectedButtonSequence": expectedButtonSequence,
  "postedButtonSequence": postedButtonSequence,
  "observedButtonSequence": routeCapture.observedButtonSequence,
  "buttonSequenceComplete": buttonSequenceComplete,
  "fallbackMouseUpPosted": fallbackMouseUpPosted,
  "fallbackMouseUpObserved": fallbackMouseUpObserved,
  "originalPointer": ["x": originalPointer.x, "y": originalPointer.y],
  "restoredPointer": ["x": restoredPointer.x, "y": restoredPointer.y],
  "pointerRestored": pointerRestored
]
let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
if !pointerRestored { exit(14) }
`;
}
