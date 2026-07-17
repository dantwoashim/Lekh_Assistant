#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  automationPermissionPrecondition,
  consoleSessionPrecondition,
  currentInputSource,
  focusAccessibilityElement,
  installedBundleIdentity,
  lekhInputSourceId,
  exactProcessIdentity,
  processIdentity,
  processExecutablePath,
  readRuntimeHealth,
  readStringArrayPreference,
  restoreExactInputSource,
  restorePreference,
  run,
  secureEventInputState,
  snapshotPreference,
  signalExactProcess,
  visibleLekhInputMethodSurfaces,
  wait,
  waitForExactRuntimeHealth,
  writePreference
} from "./lib/macos-imk-host-harness.mjs";
import {
  acquireSecureProbeRecoveryLock,
  assertSecureProbeRecoveryGuardianAlive,
  launchSecureProbeRecoveryGuardian,
  markSecureProbeRecoveryComplete,
  preferenceRecoveryEntries,
  prepareSecureProbeRecovery,
  recoverSecureProbeState,
  releaseSecureProbeRecoveryLock,
  signalSecureProbeRecoveryGuardianCompletion,
  triggerSecureProbeRecoveryGuardian,
  updateSecureProbeRecovery,
  waitForSecureProbeRecoveryGuardian
} from "./lib/macos-secure-probe-recovery.mjs";
import {
  artifactProvenanceEvidence,
  runningCodeIdentity
} from "./lib/macos-imk-build-identity.mjs";

const root = process.cwd();
const startedAt = performance.now();
const appBundle = join(homedir(), "Library", "Input Methods", "Lekh Keyboard.app");
const registerScript = join(root, "native", "macos-imk", "skeleton", "register-dev.swift");
const restoreScript = join(root, "native", "macos-imk", "skeleton", "restore-system-keyboard.sh");
const hostSourceDirectory = join(root, "native", "macos-imk", "qa-hosts", "LekhSecureFieldHost");
const hostSource = join(hostSourceDirectory, "main.swift");
const hostPlist = join(hostSourceDirectory, "Info.plist");
const runtimeHealthPath = join(homedir(), "Library", "Application Support", "Lekh Keyboard", "runtime-health.v1.json");
const databasePath = join(homedir(), "Library", "Application Support", "Lekh Keyboard", "lekh-keyboard.sqlite3");
const metricLogPath = join(homedir(), "Library", "Logs", "LekhKeyboard", "metrics.jsonl");
const reportPath = join(root, "reports", "macos-imk-host-secure-field.json");
const preferencesDomain = "com.lekh.inputmethod.LekhKeyboard";
const preferencesNotification = "com.lekh.inputmethod.preferences.changed";
const secureHostBundleIdentifier = "com.lekh.qa.SecureFieldHost";
const syntheticRawToken = "swasthya";
const syntheticExpectedText = `${syntheticRawToken} `;
const evidenceSourcePaths = [
  "scripts/check-macos-imk-host-secure-field.mjs",
  "scripts/lib/macos-imk-host-harness.mjs",
  "scripts/lib/macos-host-state-lease.mjs",
  "scripts/lib/macos-secure-probe-recovery.mjs",
  "scripts/lib/macos-imk-build-identity.mjs",
  "scripts/macos-companion-publication-lock.swift",
  "scripts/package-macos-imk-dev.mjs",
  "native/macos-imk/qa-hosts/LekhSecureFieldHost/main.swift",
  "native/macos-imk/qa-hosts/LekhSecureFieldHost/Info.plist",
  "native/macos-imk/skeleton/LekhInputController.swift",
  "native/macos-imk/skeleton/LekhRuntimeHealth.swift"
];
const failures = [];

const preferenceMutations = new Map([
  ["LekhPersonalizationEnabled", true],
  ["LekhInlinePreviewEnabled", true],
  ["LekhCustomCandidatePanelEnabled", true],
  ["LekhNextWordPredictionEnabled", true],
  ["LekhHostProbeDiagnosticsEnabled", true],
  ["LekhNativeTypingMode", "romanized-traditional"],
  ["LekhNativeTypingModeChosen.v2", true]
]);
const excludedApplicationsKey = "LekhExcludedApplicationBundleIdentifiers";

class ProbeFinished extends Error {}

let result = null;
let buildRoot = null;
let hostApp = null;
let hostExecutable = null;
let hostStatusPath = null;
let hostProcess = null;
let hostPid = null;
let hostProcessIdentity = null;
let hostLaunchedAtMs = null;
let previousInputSource = null;
let preferenceSnapshots = null;
let baselineSecureInput = null;
let secureInputObservedDuringProbe = false;
let secureInputRestored = false;
let bundleIdentity = null;
let runtimeEvidence = null;
let artifactProvenance = null;
let runtimeEpoch = null;
const runtimeEpochCheckpoints = [];
let automationEvidence = null;
const evidenceProvenance = captureEvidenceProvenance();
let cleanupEvidence = {
  hostTerminated: false,
  inputSourceRestored: false,
  preferencesRestored: false,
  secureInputReturnedToBaseline: false,
  temporaryHostRemoved: false
};
let cleanupState = "idle";
let cleanupFailuresCache = [];
let reportWritten = false;
let terminationSignal = null;
let finalizationPromise = null;
let recoveryLock = null;
let recoveryTransaction = null;
let recoveryGuardian = null;
let activeSecurePostingPromise = null;
let recoveryEvidence = {
  startup: { status: "not-checked" },
  guardian: { status: "not-started", disposition: null }
};

function conclude(status, details = {}, code = 0) {
  result = { status, details, code };
  throw new ProbeFinished(status);
}

function blocked(step, details = {}) {
  failures.push(`Automation was blocked at ${step}.`);
  conclude("blocked-automation", {
    step,
    note: "The secure-field proof requires the active unlocked desktop, Accessibility event-post access, and a causal Secure Event Input transition. It never monitors secure keystrokes.",
    ...details
  }, 2);
}

function failed(step, message, details = {}) {
  failures.push(message);
  conclude("failed", { step, ...details }, 1);
}

function notifyPreferenceChange() {
  return run("notifyutil", ["-p", preferencesNotification]);
}

function buildDisposableHost() {
  buildRoot = mkdtempSync(join(tmpdir(), "lekh-secure-field-host-"));
  chmodSync(buildRoot, 0o700);
  hostApp = join(buildRoot, "LekhSecureFieldHost.app");
  const contents = join(hostApp, "Contents");
  const macOSDirectory = join(contents, "MacOS");
  mkdirSync(macOSDirectory, { recursive: true, mode: 0o700 });
  copyFileSync(hostPlist, join(contents, "Info.plist"));
  hostExecutable = join(macOSDirectory, "LekhSecureFieldHost");
  hostStatusPath = join(buildRoot, "host-status.v1.json");

  const plistLint = run("/usr/bin/plutil", ["-lint", join(contents, "Info.plist")]);
  if (plistLint.status !== 0) {
    failed("build-secure-host", "The disposable secure-host Info.plist is invalid.");
  }
  const compile = run("/usr/bin/xcrun", [
    "swiftc", hostSource, "-O", "-framework", "AppKit", "-framework", "Carbon", "-o", hostExecutable
  ]);
  if (compile.status !== 0 || !existsSync(hostExecutable)) {
    failed("build-secure-host", "The disposable AppKit secure host did not compile.", {
      compileStatus: compile.status
    });
  }
  const sign = run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", hostApp]);
  if (sign.status !== 0) {
    failed("sign-secure-host", "The disposable AppKit secure host could not be ad-hoc signed.", {
      signStatus: sign.status
    });
  }
  hostExecutable = realpathSync(hostExecutable);
}

async function launchDisposableHost() {
  hostLaunchedAtMs = Date.now();
  hostProcess = spawn(hostExecutable, [], {
    env: {
      ...process.env,
      LEKH_SECURE_HOST_STATUS_PATH: hostStatusPath
    },
    stdio: ["pipe", "ignore", "ignore"]
  });
  hostPid = hostProcess.pid;
  if (!Number.isInteger(hostPid)) blocked("launch-secure-host", { hostPid: null });

  const expectation = Buffer.from(syntheticExpectedText, "utf8").toString("base64");
  await new Promise((resolve, reject) => {
    hostProcess.stdin.once("error", reject);
    // Keep this pipe open for the lifetime of the parent. The host treats EOF
    // as a parent-death signal and terminates its NSSecureTextField, including
    // when this Node process is killed without running JavaScript cleanup.
    hostProcess.stdin.write(`${expectation}\n`, resolve);
  }).catch(() => {
    if (terminationSignal) throw new ProbeFinished("interrupted");
    blocked("initialize-secure-host");
  });

  const initial = waitForHostStatus((status) =>
    status.schemaVersion === 1 &&
    status.processIdentifier === hostPid &&
    status.frontmost === true &&
    status.windowIsKey === true
  );
  if (!initial) blocked("wait-for-secure-host-window", { hostPid });
  const identity = processIdentity(hostPid);
  if (
    identity.status !== 0 ||
    identity.state !== "running" ||
    identity.executablePath !== hostExecutable
  ) {
    failed("verify-secure-host-process", "The fresh secure-host PID does not execute the disposable app binary.");
  }
  hostProcessIdentity = identity;
}

function readHostStatus() {
  if (!hostStatusPath || !existsSync(hostStatusPath)) return null;
  try {
    const status = JSON.parse(readFileSync(hostStatusPath, "utf8"));
    const expectedKeys = [
      "schemaVersion", "processIdentifier", "statusSequence", "publishedAtUnixMs", "phase",
      "frontmost", "windowIsKey", "calibrationFieldFocused", "secureFieldFocused",
      "secureEventInputEnabled", "calibrationReceivedUTF16Length", "secureReceivedUTF16Length",
      "secureExpectedUTF16Length", "secureExactMatch", "secureHasMarkedText",
      "secureDownCommandReceived"
    ].sort();
    if (
      !status ||
      typeof status !== "object" ||
      Array.isArray(status) ||
      Object.keys(status).sort().join("\0") !== expectedKeys.join("\0") ||
      status.schemaVersion !== 1 ||
      status.processIdentifier !== hostPid ||
      !Number.isSafeInteger(status.statusSequence) ||
      status.statusSequence <= 0 ||
      !Number.isSafeInteger(status.publishedAtUnixMs) ||
      !["calibration", "secure"].includes(status.phase) ||
      [
        "frontmost", "windowIsKey", "calibrationFieldFocused", "secureFieldFocused",
        "secureEventInputEnabled", "secureExactMatch", "secureHasMarkedText",
        "secureDownCommandReceived"
      ].some((key) => typeof status[key] !== "boolean") ||
      [
        "calibrationReceivedUTF16Length", "secureReceivedUTF16Length", "secureExpectedUTF16Length"
      ].some((key) => !Number.isSafeInteger(status[key]) || status[key] < 0)
    ) return null;
    return status;
  } catch {
    return null;
  }
}

function waitForHostStatus(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readHostStatus();
    if (status && predicate(status)) return status;
    wait(75);
  }
  return null;
}

function postEvents(events, step) {
  ensureRecoveryGuardian(step);
  if (!hostProcessIdentity) blocked(`${step}-missing-host-identity`);
  const post = run("swift", ["-e", targetedPostingSource(events, hostProcessIdentity)]);
  if (post.status !== 0) {
    blocked(step, { postStatus: post.status });
  }
}

function signalCheckpoint() {
  return new Promise((resolve) => setImmediate(resolve)).then(() => {
    throwIfTerminationRequested();
  });
}

function runBoundedAsync(command, args, { timeoutMs = 5_000, maximumOutputBytes = 16_384 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let timedOut = false;
    let spawnError = false;
    const collect = (chunks, chunk, currentBytes) => {
      const remaining = maximumOutputBytes - currentBytes;
      if (remaining <= 0) {
        overflow = true;
        return currentBytes;
      }
      const retained = chunk.subarray(0, remaining);
      chunks.push(retained);
      if (retained.length !== chunk.length) overflow = true;
      return currentBytes + retained.length;
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes = collect(stdoutChunks, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes = collect(stderrChunks, chunk, stderrBytes);
    });
    child.once("error", () => {
      spawnError = true;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1_000);
    }, timeoutMs);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({
        status: Number.isInteger(status) ? status : 3,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        overflow,
        timedOut,
        spawnError
      });
    });
  });
}

function ensureRecoveryGuardian(step) {
  if (!recoveryGuardian) {
    failed("verify-recovery-guardian", "The crash-recovery guardian was not available before a probe side effect.", {
      checkpoint: step
    });
  }
  try {
    assertSecureProbeRecoveryGuardianAlive(recoveryGuardian);
  } catch {
    failed("verify-recovery-guardian", "The crash-recovery guardian exited before the probe completed.", {
      checkpoint: step
    });
  }
}

function freshSecureHostStatus({ afterSequence = 0, timeoutMs = 1_500 } = {}) {
  return waitForHostStatus((status) =>
    status.statusSequence > afterSequence &&
    status.phase === "secure" &&
    status.frontmost === true &&
    status.windowIsKey === true &&
    status.secureFieldFocused === true &&
    status.secureEventInputEnabled === true &&
    status.publishedAtUnixMs <= Date.now() + 100 &&
    Date.now() - status.publishedAtUnixMs <= 250,
  timeoutMs);
}

function exactSecurePostingEvidence(value, expectedKeyCount) {
  const expectedKeys = [
    "schemaVersion", "preconditionPassed", "postconditionPassed", "postedKeyCount",
    "sourceIdentifierBefore", "sourceIdentifierAfter"
  ].sort();
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === expectedKeys.join("\0") &&
    value.schemaVersion === 1 &&
    value.preconditionPassed === true &&
    value.postconditionPassed === true &&
    value.postedKeyCount === expectedKeyCount &&
    typeof value.sourceIdentifierBefore === "string" &&
    value.sourceIdentifierBefore.length > 0 &&
    typeof value.sourceIdentifierAfter === "string" &&
    value.sourceIdentifierAfter.length > 0;
}

async function postSecureEvents(events, step) {
  await signalCheckpoint();
  ensureRecoveryGuardian(`${step}-before`);
  const before = freshSecureHostStatus();
  const externalBefore = secureEventInputState();
  if (
    !before ||
    externalBefore.status !== 0 ||
    externalBefore.enabled !== true ||
    !exactProcessIdentity(hostProcessIdentity).matches
  ) {
    blocked(`${step}-secure-host-precondition`, {
      freshHostStatusObserved: Boolean(before),
      globalSecureInputEnabled: externalBefore.enabled === true,
      exactHostProcess: exactProcessIdentity(hostProcessIdentity).matches,
      sideEffectsPrevented: { keyEventsPosted: true }
    });
  }

  const postingPromise = runBoundedAsync("swift", [
    "-e",
    secureTargetedPostingSource(events, hostProcessIdentity)
  ]);
  activeSecurePostingPromise = postingPromise;
  const post = await postingPromise;
  if (activeSecurePostingPromise === postingPromise) activeSecurePostingPromise = null;
  throwIfTerminationRequested();

  const line = post.stdout.trim().split(/\r?\n/).at(-1) ?? "";
  let evidence = null;
  try {
    evidence = JSON.parse(line);
  } catch {
    // Exact schema validation below is authoritative and stdout is never reported.
  }
  if (post.status !== 0 || post.signal !== null || post.overflow || post.timedOut || post.spawnError) {
    const emergencyRelease = exactProcessIdentity(hostProcessIdentity).matches
      ? run("swift", ["-e", emergencySecureKeyUpSource(events, hostProcessIdentity)])
      : { status: 0 };
    if (emergencyRelease.status !== 0) {
      failed(`${step}-emergency-key-release`, "The secure posting helper failed and its exact-host emergency key-up release could not be verified.", {
        helperExitStatus: post.status,
        emergencyReleaseStatus: emergencyRelease.status
      });
    }
    const preconditionFailure = [2, 10, 11].includes(post.status);
    if (preconditionFailure) {
      blocked(`${step}-atomic-posting-precondition`, {
        helperExitStatus: post.status,
        helperSignal: post.signal,
        helperOutputBounded: !post.overflow,
        sideEffectsPreventedOrReleased: true
      });
    }
    failed(`${step}-atomic-posting`, "The secure posting helper could not prove uninterrupted focus/SEI guards and balanced key events.", {
      helperExitStatus: post.status,
      helperSignal: post.signal,
      helperOutputBounded: !post.overflow
    });
  }
  if (!exactSecurePostingEvidence(evidence, events.length)) {
    failed(`${step}-posting-evidence`, "The secure posting helper returned malformed or incomplete content-free evidence.");
  }

  const after = freshSecureHostStatus({ afterSequence: before.statusSequence });
  const externalAfter = secureEventInputState();
  if (
    !after ||
    externalAfter.status !== 0 ||
    externalAfter.enabled !== true ||
    !exactProcessIdentity(hostProcessIdentity).matches
  ) {
    failed(`${step}-secure-host-postcondition`, "The exact secure host did not remain frontmost, focused, key, fresh, and under Secure Event Input after posting.", {
      freshHostStatusObserved: Boolean(after),
      globalSecureInputEnabled: externalAfter.enabled === true,
      exactHostProcess: exactProcessIdentity(hostProcessIdentity).matches
    });
  }
  await signalCheckpoint();
  return {
    beforeStatusSequence: before.statusSequence,
    afterStatusSequence: after.statusSequence,
    postedKeyCount: evidence.postedKeyCount,
    sourceIdentifierBefore: evidence.sourceIdentifierBefore,
    sourceIdentifierAfter: evidence.sourceIdentifierAfter
  };
}

function waitForNoVisibleLekhSurface(runtimePid, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = visibleLekhInputMethodSurfaces(runtimePid);
    if (latest.status !== 0) return { ready: false, blocked: true, latest };
    if (latest.forbiddenVisibleCount === 0) return { ready: true, blocked: false, latest };
    wait(100);
  }
  return { ready: false, blocked: false, latest };
}

function logicalDatabaseSnapshot() {
  if (!existsSync(databasePath)) return { exists: false, ready: false };
  const integrity = run("/usr/bin/sqlite3", ["-readonly", "-batch", databasePath, "PRAGMA quick_check;"]);
  const schema = run("/usr/bin/sqlite3", [
    "-readonly", "-batch", "-json", databasePath,
    "SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('user_lexicon','user_bigrams') ORDER BY name;"
  ]);
  const aggregates = run("/usr/bin/sqlite3", [
    "-readonly", "-batch", "-json", databasePath,
    `SELECT 'user_lexicon' AS table_name, COUNT(*) AS row_count,
      COALESCE(SUM(frequency), 0) AS frequency_sum, COALESCE(MAX(last_used), '') AS max_last_used
     FROM user_lexicon
     UNION ALL
     SELECT 'user_bigrams' AS table_name, COUNT(*) AS row_count,
      COALESCE(SUM(frequency), 0) AS frequency_sum, COALESCE(MAX(last_used), '') AS max_last_used
     FROM user_bigrams
     ORDER BY table_name;`
  ]);
  const digest = run("/usr/bin/sqlite3", [
    "-readonly", "-batch", databasePath,
    ".sha3sum --sha3-256 user_%"
  ]);
  let schemaRows = [];
  let aggregateRows = [];
  try {
    schemaRows = JSON.parse(schema.stdout.trim() || "[]");
    aggregateRows = JSON.parse(aggregates.stdout.trim() || "[]");
  } catch {
    return { exists: true, ready: false };
  }
  const ready = integrity.status === 0 &&
    integrity.stdout.trim() === "ok" &&
    schema.status === 0 &&
    aggregates.status === 0 &&
    digest.status === 0 &&
    schemaRows.map((row) => row.name).join(",") === "user_bigrams,user_lexicon" &&
    aggregateRows.length === 2 &&
    digest.stdout.trim().length > 0;
  return {
    exists: true,
    ready,
    aggregateRows,
    canonicalDigest: digest.stdout.trim()
  };
}

function databaseComparison(before, after) {
  const totals = (snapshot) => snapshot.aggregateRows.reduce((accumulator, row) => ({
    rowCount: accumulator.rowCount + Number(row.row_count ?? 0),
    frequency: accumulator.frequency + Number(row.frequency_sum ?? 0),
    lastUsed: [...accumulator.lastUsed, String(row.max_last_used ?? "")]
  }), { rowCount: 0, frequency: 0, lastUsed: [] });
  if (!before?.ready || !after?.ready) {
    return {
      ready: false,
      rowCountDelta: null,
      frequencyDelta: null,
      lastUsedEqual: false,
      canonicalDigestEqual: false,
      equal: false
    };
  }
  const left = totals(before);
  const right = totals(after);
  const comparison = {
    ready: true,
    rowCountDelta: right.rowCount - left.rowCount,
    frequencyDelta: right.frequency - left.frequency,
    lastUsedEqual: JSON.stringify(right.lastUsed) === JSON.stringify(left.lastUsed),
    canonicalDigestEqual: after.canonicalDigest === before.canonicalDigest
  };
  return {
    ...comparison,
    equal: comparison.rowCountDelta === 0 &&
      comparison.frequencyDelta === 0 &&
      comparison.lastUsedEqual &&
      comparison.canonicalDigestEqual
  };
}

function ghostEvidenceSnapshot() {
  const read = readRuntimeHealth(runtimeHealthPath);
  const record = read.record;
  return {
    readable: Boolean(record),
    lastGhostOfferedAt: record?.lastGhostOfferedAt ?? null,
    lastGhostAcceptedAt: record?.lastGhostAcceptedAt ?? null,
    ghostSuppressionCounts: record?.ghostSuppressionCounts ?? {}
  };
}

function ghostEvidenceEqual(before, after) {
  return before.readable && after.readable &&
    before.lastGhostOfferedAt === after.lastGhostOfferedAt &&
    before.lastGhostAcceptedAt === after.lastGhostAcceptedAt &&
    JSON.stringify(before.ghostSuppressionCounts) === JSON.stringify(after.ghostSuppressionCounts);
}

function runtimeHealthFileSnapshot() {
  if (!existsSync(runtimeHealthPath)) return { ready: false };
  try {
    const metadata = statSync(runtimeHealthPath);
    const bytes = readFileSync(runtimeHealthPath);
    const parsed = JSON.parse(bytes.toString("utf8"));
    return {
      ready: parsed && typeof parsed === "object" && !Array.isArray(parsed),
      inode: metadata.ino,
      size: metadata.size,
      modifiedAtMs: metadata.mtimeMs,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  } catch {
    return { ready: false };
  }
}

function runtimeHealthFileUnchanged(before, after) {
  return before.ready === true &&
    after.ready === true &&
    before.inode === after.inode &&
    before.size === after.size &&
    before.modifiedAtMs === after.modifiedAtMs &&
    before.sha256 === after.sha256;
}

function metricLogSnapshot() {
  if (!existsSync(metricLogPath)) return { exists: false, inode: null, size: 0 };
  const stat = statSync(metricLogPath);
  return { exists: true, inode: stat.ino, size: stat.size };
}

function inspectMetricLogAppend(before) {
  if (!existsSync(metricLogPath)) {
    return {
      reliable: !before.exists,
      appendedLineCount: 0,
      appendedByteCount: 0,
      appendedPayloadContainsSyntheticInput: false
    };
  }
  const stat = statSync(metricLogPath);
  if ((before.exists && stat.ino !== before.inode) || stat.size < before.size) {
    return {
      reliable: false,
      appendedLineCount: null,
      appendedByteCount: null,
      appendedPayloadContainsSyntheticInput: null
    };
  }
  const appendedByteCount = stat.size - (before.exists ? before.size : 0);
  return {
    reliable: true,
    appendedLineCount: appendedByteCount === 0 ? 0 : null,
    appendedByteCount,
    appendedPayloadContainsSyntheticInput: appendedByteCount === 0 ? false : null
  };
}

function unifiedLogEvidence(runtimePid, intervalStartedAtMs) {
  const logs = run("/usr/bin/log", [
    "show", "--info", "--debug", "--start", `@${Math.floor(intervalStartedAtMs / 1000)}`, "--style", "ndjson",
    "--process", String(runtimePid),
    "--predicate", 'subsystem == "com.lekh.inputmethod.keyboard"'
  ]);
  if (logs.status !== 0) {
    return { reliable: false, eventCount: 0, malformedEventCount: 0, summaryRecordCount: 0, surfaceEventCount: 0, syntheticInputMentioned: false };
  }
  let eventCount = 0;
  let malformedEventCount = 0;
  let summaryRecordCount = 0;
  let surfaceEventCount = 0;
  let syntheticInputMentioned = false;
  for (const line of logs.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const keys = event && typeof event === "object" ? Object.keys(event).sort() : [];
      if (
        keys.join(",") === "count,finished" &&
        Number.isFinite(event.count) &&
        Number.isFinite(event.finished)
      ) {
        summaryRecordCount += 1;
        continue;
      }
      const timestampMs = Date.parse(event.timestamp ?? "");
      if (
        !event ||
        typeof event !== "object" ||
        event.processID !== runtimePid ||
        event.subsystem !== "com.lekh.inputmethod.keyboard" ||
        typeof event.eventMessage !== "string" ||
        !Number.isFinite(timestampMs)
      ) {
        malformedEventCount += 1;
        continue;
      }
      if (timestampMs < intervalStartedAtMs) continue;
      const message = event.eventMessage;
      eventCount += 1;
      if (message.startsWith("surface.")) surfaceEventCount += 1;
      if (message.includes(syntheticRawToken)) syntheticInputMentioned = true;
    } catch {
      malformedEventCount += 1;
    }
  }
  return {
    reliable: malformedEventCount === 0 && summaryRecordCount === 1,
    eventCount,
    malformedEventCount,
    summaryRecordCount,
    surfaceEventCount,
    syntheticInputMentioned
  };
}

function captureEvidenceProvenance() {
  const revision = run("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: root });
  const status = run("/usr/bin/git", [
    "status", "--porcelain=v1", "--untracked-files=all"
  ], { cwd: root });
  const sources = evidenceSourcePaths.map((relativePath) => {
    const absolutePath = join(root, relativePath);
    return {
      path: relativePath,
      sha256: existsSync(absolutePath)
        ? createHash("sha256").update(readFileSync(absolutePath)).digest("hex")
        : null
    };
  });
  return {
    schemaVersion: 1,
    gitRevision: revision.status === 0 ? revision.stdout.trim() : null,
    sourceFilesClean: status.status === 0 && status.stdout.trim() === "",
    sourceStatusReadable: status.status === 0,
    sources
  };
}

function runtimeProcessEpochIssueCodes(expected, observed) {
  const issues = [];
  if (
    !expected ||
    !Number.isInteger(expected.processIdentifier) ||
    expected.processIdentifier <= 1 ||
    typeof expected.executablePath !== "string" ||
    !expected.executablePath ||
    !/^\d{1,20}:\d{1,6}$/u.test(expected.processStartToken ?? "")
  ) {
    issues.push("runtime-process-epoch-not-pinned");
    return issues;
  }
  if (
    observed?.status !== 0 ||
    observed?.state !== "running" ||
    observed?.processIdentifier !== expected.processIdentifier
  ) {
    issues.push("runtime-process-instance-unavailable");
    return issues;
  }
  if (observed.executablePath !== expected.executablePath) {
    issues.push("runtime-process-executable-changed");
  }
  if (observed.processStartToken !== expected.processStartToken) {
    issues.push("runtime-process-start-epoch-changed");
  }
  return issues;
}

function verifyRuntimeEpoch(step) {
  const read = readRuntimeHealth(runtimeHealthPath);
  const record = read.record;
  const issueCodes = [];
  if (!runtimeEpoch || !record) {
    issueCodes.push("runtime-record-unavailable");
  } else {
    if (record.processIdentifier !== runtimeEpoch.processIdentifier) issueCodes.push("process-identifier-changed");
    if (record.activationIdentifier !== runtimeEpoch.activationIdentifier) issueCodes.push("activation-identifier-changed");
    if (record.controllerInstanceIdentifier !== runtimeEpoch.controllerInstanceIdentifier) issueCodes.push("controller-instance-changed");
    if (record.executableStartedAt !== runtimeEpoch.executableStartedAt) issueCodes.push("executable-epoch-changed");
    if (record.bundleIdentifier !== bundleIdentity.bundleIdentifier) issueCodes.push("bundle-identifier-changed");
    if (record.bundleVersion !== bundleIdentity.buildVersion) issueCodes.push("bundle-version-changed");
    if (record.connectionName !== bundleIdentity.connectionName) issueCodes.push("connection-name-changed");
    const currentBundle = installedBundleIdentity(appBundle);
    if (currentBundle.bundlePath !== bundleIdentity.bundlePath) issueCodes.push("installed-bundle-path-changed");
    if (currentBundle.executablePath !== bundleIdentity.executablePath) issueCodes.push("installed-executable-path-changed");
    if (currentBundle.executableSha256 !== bundleIdentity.executableSha256) issueCodes.push("installed-executable-digest-changed");
    if (currentBundle.codeDirectoryHash !== bundleIdentity.codeDirectoryHash) issueCodes.push("installed-code-directory-changed");
    if (currentBundle.buildVersion !== bundleIdentity.buildVersion) issueCodes.push("installed-build-version-changed");
    const runningIdentity = processIdentity(runtimeEpoch.processIdentifier);
    issueCodes.push(...runtimeProcessEpochIssueCodes(runtimeEpoch, runningIdentity));
    if (runningIdentity.state !== "running" || runningIdentity.executablePath !== bundleIdentity.executablePath) {
      issueCodes.push("running-executable-changed");
    } else {
      const digest = run("/usr/bin/shasum", ["-a", "256", runningIdentity.executablePath]);
      const runningSha256 = digest.status === 0 ? digest.stdout.trim().split(/\s+/)[0] ?? "" : "";
      if (!runningSha256 || runningSha256 !== bundleIdentity.executableSha256) {
        issueCodes.push("running-executable-digest-changed");
      }
    }
    const dynamicCode = runningCodeIdentity(runtimeEpoch.processIdentifier);
    if (
      dynamicCode.status !== 0 ||
      dynamicCode.codeDirectoryHash !== bundleIdentity.codeDirectoryHash
    ) {
      issueCodes.push("running-code-directory-changed");
    }
  }
  runtimeEpochCheckpoints.push({ step, verified: issueCodes.length === 0, issueCodes });
  if (issueCodes.length > 0) {
    failed("verify-runtime-epoch", "The exact installed IMK process/build changed during secure-field evidence collection.", {
      checkpoint: step,
      runtimeEpochIssueCodes: issueCodes
    });
  }
}

function writeReport() {
  const finalResult = result ?? { status: "failed", details: { step: "unknown" }, code: 1 };
  mkdirSync(join(root, "reports"), { recursive: true });
  let report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-macos-imk-host-secure-field.mjs",
    suite: "macos-imk-host-secure-field",
    durationMs: Math.round(performance.now() - startedAt),
    hostFramework: "AppKit",
    hostControl: "NSSecureTextField",
    appBundle,
    bundleIdentity,
    automation: automationEvidence,
    runtime: runtimeEvidence,
    artifactProvenance,
    evidenceProvenance,
    recovery: recoveryEvidence,
    failures,
    cleanup: cleanupEvidence,
    privacy: {
      rawPayloadIncluded: false,
      candidateTextIncluded: false,
      databaseRowsIncluded: false,
      databaseDigestIncluded: false,
      logLinesIncluded: false,
      secureAXValueRead: false,
      eventTapInstalled: false,
      syntheticCanaryAbsentFromSerializedReport: null
    },
    ...finalResult.details,
    status: finalResult.status
  };
  const serializedForCanary = JSON.stringify(report);
  const canaryVariants = [
    syntheticRawToken,
    syntheticExpectedText,
    Buffer.from(syntheticRawToken, "utf8").toString("base64"),
    Buffer.from(syntheticExpectedText, "utf8").toString("base64"),
    Buffer.from(syntheticRawToken, "utf8").toString("hex"),
    createHash("sha256").update(syntheticRawToken, "utf8").digest("hex")
  ];
  const containsSyntheticCanary = canaryVariants.some((variant) => serializedForCanary.includes(variant));
  report.privacy.syntheticCanaryAbsentFromSerializedReport = !containsSyntheticCanary;
  let exitCode = finalResult.code;
  if (containsSyntheticCanary) {
    exitCode = 1;
    report = {
      generatedAt: report.generatedAt,
      command: report.command,
      suite: report.suite,
      durationMs: report.durationMs,
      status: "failed",
      failures: ["The content-free report canary detected forbidden synthetic input in serialized evidence."],
      cleanup: cleanupEvidence,
      privacy: {
        rawPayloadIncluded: false,
        candidateTextIncluded: false,
        databaseRowsIncluded: false,
        databaseDigestIncluded: false,
        logLinesIncluded: false,
        secureAXValueRead: false,
        eventTapInstalled: false,
        syntheticCanaryAbsentFromSerializedReport: false
      }
    };
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(reportPath, serialized);
  console[exitCode === 0 ? "log" : exitCode === 2 ? "warn" : "error"](serialized.trim());
  process.exitCode = exitCode;
}

function waitForHostProcessExit(timeoutMs) {
  if (!hostProcess || hostProcess.exitCode !== null || hostProcess.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      hostProcess.off("close", onClose);
      resolve(value);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    hostProcess.once("close", onClose);
  });
}

async function terminateDisposableHost() {
  if (!Number.isInteger(hostPid) || !hostExecutable || !hostProcessIdentity) {
    return { status: 0, terminated: true };
  }
  const current = exactProcessIdentity(hostProcessIdentity);
  if (["absent", "terminated"].includes(current.state)) {
    return { status: 0, terminated: true };
  }
  if (current.state === "running" && !current.matches) {
    return { status: 0, terminated: true };
  }
  if (current.status !== 0 || !current.matches) return { status: 3, terminated: false };

  const term = signalExactProcess(hostProcessIdentity, "TERM");
  if (term.status !== 0) return { status: 3, terminated: false };
  if (term.disposition !== "signaled") return { status: 0, terminated: true };
  if (await waitForHostProcessExit(3_000)) return { status: 0, terminated: true };

  const kill = signalExactProcess(hostProcessIdentity, "KILL");
  if (kill.status !== 0) return { status: 3, terminated: false };
  if (kill.disposition !== "signaled") return { status: 0, terminated: true };
  return await waitForHostProcessExit(1_000)
    ? { status: 0, terminated: true }
    : { status: 3, terminated: false };
}

async function performCleanup() {
  if (cleanupState === "done") return cleanupFailuresCache;
  if (cleanupState === "running") return ["Secure-probe cleanup was re-entered before it completed."];
  cleanupState = "running";
  const cleanupFailures = [];

  try {
    const termination = await terminateDisposableHost();
    cleanupEvidence.hostTerminated = termination.terminated;
    if (termination.status !== 0 || !termination.terminated) {
      cleanupFailures.push("The fresh secure-host PID could not be terminated exactly.");
    }
  } catch {
    cleanupFailures.push("The exact secure-host termination check failed.");
  }

  try {
    if (secureInputObservedDuringProbe || baselineSecureInput?.enabled === false) {
      const deadline = Date.now() + 4_000;
      let state = secureEventInputState();
      while (Date.now() < deadline && state.status === 0 && state.enabled === true) {
        wait(100);
        state = secureEventInputState();
      }
      secureInputRestored = state.status === 0 && state.enabled === false;
      cleanupEvidence.secureInputReturnedToBaseline = secureInputRestored;
      if (!secureInputRestored) {
        cleanupFailures.push("Secure Event Input did not return to its false baseline after the disposable host terminated.");
      }
    } else {
      cleanupEvidence.secureInputReturnedToBaseline = true;
    }
  } catch {
    cleanupFailures.push("Secure Event Input baseline restoration could not be verified.");
  }

  try {
    if (previousInputSource?.id) {
      const restored = restoreExactInputSource(previousInputSource.id);
      cleanupEvidence.inputSourceRestored = restored.status === 0 && currentInputSource().id === previousInputSource.id;
      if (!cleanupEvidence.inputSourceRestored) {
        run(restoreScript, []);
        cleanupFailures.push(`Could not restore exact prior input source ${previousInputSource.id}.`);
      }
    } else {
      cleanupEvidence.inputSourceRestored = true;
    }
  } catch {
    cleanupFailures.push("The exact prior input source restoration check failed.");
  }

  try {
    if (preferenceSnapshots) {
      const restores = Object.entries(preferenceSnapshots).map(([key, snapshot]) =>
        restorePreference(preferencesDomain, key, snapshot)
      );
      const notified = notifyPreferenceChange();
      cleanupEvidence.preferencesRestored = restores.every((restore) => restore.status === 0) && notified.status === 0;
      if (!cleanupEvidence.preferencesRestored) {
        cleanupFailures.push("Could not restore every exact preference value or absence.");
      }
    } else {
      cleanupEvidence.preferencesRestored = true;
    }
  } catch {
    cleanupFailures.push("Exact preference restoration raised an unexpected content-free harness error.");
  }

  try {
    // The executable inside buildRoot is part of the durable host identity.
    // Keep it available for guardian verification whenever exact termination
    // was not proven; deleting it first would make safe retry impossible.
    if (buildRoot && cleanupEvidence.hostTerminated) {
      rmSync(buildRoot, { recursive: true, force: true });
    }
    cleanupEvidence.temporaryHostRemoved = !buildRoot || !existsSync(buildRoot);
    if (!cleanupEvidence.temporaryHostRemoved) {
      cleanupFailures.push("Could not remove the disposable secure-host bundle and status file.");
    }
  } catch {
    cleanupFailures.push("Disposable secure-host removal failed.");
  }

  cleanupFailuresCache = cleanupFailures;
  cleanupState = "done";
  return cleanupFailuresCache;
}

function normalCleanupEvidence() {
  return {
    hostTerminated: cleanupEvidence.hostTerminated === true,
    inputSourceRestored: cleanupEvidence.inputSourceRestored === true,
    preferencesRestored: cleanupEvidence.preferencesRestored === true,
    secureInputReturnedToBaseline: cleanupEvidence.secureInputReturnedToBaseline === true,
    temporaryHostRemoved: cleanupEvidence.temporaryHostRemoved === true
  };
}

function recoveryCompletedExactly(recovery) {
  return recovery?.status === "recovered" &&
    recovery.cleanupEvidence?.hostTerminated === true &&
    recovery.cleanupEvidence?.inputSourceRestored === true &&
    recovery.cleanupEvidence?.preferencesRestored === true &&
    recovery.cleanupEvidence?.secureInputReturnedToBaseline === true &&
    recovery.cleanupEvidence?.temporaryHostRemoved === true;
}

async function settleRecoveryGuardian(primaryCleanupFailures) {
  const settlementFailures = [];
  const cleanup = normalCleanupEvidence();
  const normalCleanupPassed = primaryCleanupFailures.length === 0 &&
    Object.values(cleanup).every((value) => value === true);

  try {
    if (recoveryTransaction && recoveryGuardian) {
      const expectedDisposition = normalCleanupPassed ? "normal-completion" : "crash-recovery";
      if (normalCleanupPassed) {
        markSecureProbeRecoveryComplete(recoveryTransaction, cleanup);
        signalSecureProbeRecoveryGuardianCompletion(recoveryGuardian);
      } else {
        triggerSecureProbeRecoveryGuardian(recoveryGuardian);
      }
      const settlement = await waitForSecureProbeRecoveryGuardian(recoveryGuardian);
      recoveryEvidence.guardian = {
        status: settlement.status,
        disposition: settlement.disposition,
        processIdentifier: recoveryGuardian.processIdentifier,
        exitCode: settlement.exitCode,
        signal: settlement.signal
      };
      if (
        settlement.status !== "completed" ||
        settlement.disposition !== expectedDisposition ||
        settlement.exitCode !== 0 ||
        settlement.signal !== null
      ) {
        throw new Error("Unexpected secure-probe recovery disposition.");
      }
    } else if (recoveryTransaction) {
      const recovery = recoverSecureProbeState({ lock: recoveryLock });
      recoveryEvidence.guardian = {
        status: recoveryCompletedExactly(recovery) ? "completed" : "failed",
        disposition: "parent-recovery",
        processIdentifier: null,
        cleanupEvidence: recovery.cleanupEvidence ?? null
      };
      if (!recoveryCompletedExactly(recovery)) {
        settlementFailures.push("The parent could not recover a prepared secure-probe transaction after guardian startup failed.");
      }
    } else if (recoveryLock) {
      recoveryEvidence.guardian = {
        status: "not-required",
        disposition: null,
        processIdentifier: null
      };
    }
  } catch {
    settlementFailures.push("The crash-recovery guardian settlement raised a content-free recovery error.");
    try {
      if (recoveryGuardian) {
        try {
          assertSecureProbeRecoveryGuardianAlive(recoveryGuardian);
          triggerSecureProbeRecoveryGuardian(recoveryGuardian);
        } catch {
          // The guardian either already received control or exited; parent recovery below is authoritative.
        }
        try {
          await waitForSecureProbeRecoveryGuardian(recoveryGuardian, { timeoutMs: 5_000 });
        } catch {
          if (recoveryGuardian.child.exitCode === null && recoveryGuardian.child.signalCode === null) {
            recoveryGuardian.child.kill("SIGTERM");
            try {
              await waitForSecureProbeRecoveryGuardian(recoveryGuardian, { timeoutMs: 2_000 });
            } catch {
              // The durable journal is intentionally retained when the child cannot be settled.
            }
          }
        }
      }
      if (recoveryLock && recoveryTransaction) {
        const recovery = recoverSecureProbeState({ lock: recoveryLock });
        recoveryEvidence.guardian = {
          status: recoveryCompletedExactly(recovery) || recovery.status === "no-recovery-required"
            ? "recovered-after-settlement-error"
            : "failed",
          disposition: recovery.status === "no-recovery-required"
            ? "guardian-recovery"
            : "parent-recovery",
          processIdentifier: recoveryGuardian?.processIdentifier ?? null,
          cleanupEvidence: recovery.cleanupEvidence ?? null
        };
        if (!(recoveryCompletedExactly(recovery) || recovery.status === "no-recovery-required")) {
          settlementFailures.push("The durable recovery journal remained incomplete after guardian settlement failed.");
        }
      }
    } catch {
      settlementFailures.push("The parent fallback could not prove exact restoration from the durable recovery journal.");
    }
  } finally {
    if (recoveryLock) {
      try {
        if (!releaseSecureProbeRecoveryLock(recoveryLock)) {
          settlementFailures.push("The parent recovery lock was not held through final settlement.");
        }
      } catch {
        settlementFailures.push("The parent recovery lock could not be released after final settlement.");
      }
      recoveryLock = null;
    }
  }
  return settlementFailures;
}

function finalizeProbe() {
  if (finalizationPromise) return finalizationPromise;
  finalizationPromise = (async () => {
    if (activeSecurePostingPromise) {
      await activeSecurePostingPromise;
      activeSecurePostingPromise = null;
    }
    const primaryCleanupFailures = await performCleanup();
    const recoveryFailures = await settleRecoveryGuardian(primaryCleanupFailures);
    const cleanupFailures = [...primaryCleanupFailures, ...recoveryFailures];
    if (cleanupFailures.length > 0) {
      failures.push(...cleanupFailures.filter((failure) => !failures.includes(failure)));
      result = {
        status: "failed",
        details: { ...(result?.details ?? {}), cleanupFailures },
        code: 1
      };
    }
    if (!reportWritten) {
      reportWritten = true;
      writeReport();
    }
  })();
  return finalizationPromise;
}

function handleTerminationSignal(signal, exitCode) {
  if (terminationSignal) return;
  terminationSignal = signal;
  failures.push(`The secure-field probe was interrupted by ${signal}; exact cleanup and recovery settlement were attempted.`);
  result = {
    status: "interrupted",
    details: { step: "signal-interruption", signal },
    code: exitCode
  };
  void finalizeProbe().finally(() => {
    process.exit(Number.isInteger(process.exitCode) ? process.exitCode : exitCode);
  });
}

function throwIfTerminationRequested() {
  if (terminationSignal) throw new ProbeFinished("interrupted");
}

async function executeProbe() {
  try {
    if (process.platform !== "darwin") {
      failed("platform", "Secure-field host proof must run on macOS.", { platform: process.platform });
    }
    if (![appBundle, registerScript, restoreScript, hostSource, hostPlist].every(existsSync)) {
      failed("preflight", "The installed IMK bundle or secure-host support files are missing.");
    }

    const consoleSession = consoleSessionPrecondition();
    if (!consoleSession.eligible) {
      blocked("host-session-precondition", {
        prerequisite: consoleSession,
        sideEffectsPrevented: {
          preferencesChanged: true,
          inputSourceChanged: true,
          hostApplicationLaunched: true
        }
      });
    }

    try {
      recoveryLock = acquireSecureProbeRecoveryLock();
    } catch (error) {
      if (error?.code === "secure-probe-lock-busy") {
        blocked("recovery-lock-precondition", {
          sideEffectsPrevented: {
            preferencesChanged: true,
            inputSourceChanged: true,
            hostApplicationLaunched: true
          }
        });
      }
      failed("recovery-lock-precondition", "The secure-field proof could not acquire its exact recovery lock.", {
        recoveryErrorCode: error?.code ?? "unknown"
      });
    }
    try {
      const startupRecovery = recoverSecureProbeState({ lock: recoveryLock });
      recoveryEvidence.startup = {
        status: startupRecovery.status,
        cleanupEvidence: startupRecovery.cleanupEvidence ?? null
      };
      if (startupRecovery.status === "recovery-incomplete") {
        failed("recover-prior-probe", "A prior interrupted secure-field proof could not be restored exactly.", {
          recoveryStatus: startupRecovery.status,
          recoveryCleanup: startupRecovery.cleanupEvidence
        });
      }
    } catch (error) {
      if (error instanceof ProbeFinished) throw error;
      failed("recover-prior-probe", "A prior secure-field recovery journal was invalid or could not be applied.");
    }

    automationEvidence = automationPermissionPrecondition();
    if (!automationEvidence.eligible) {
      blocked("automation-permissions", {
        prerequisite: automationEvidence,
        inputMonitoringNote: "Event-listening/Input Monitoring access is informational and is not required or used."
      });
    }

    baselineSecureInput = secureEventInputState();
    if (baselineSecureInput.status !== 0 || baselineSecureInput.enabled !== false) {
      blocked("secure-input-baseline", {
        secureInputAlreadyEnabled: baselineSecureInput.enabled,
        note: "Secure Event Input is global; an existing owner makes causal attribution impossible."
      });
    }

    buildDisposableHost();
    previousInputSource = currentInputSource();
    if (previousInputSource.status !== 0 || !previousInputSource.id) {
      failed("snapshot-input-source", "Could not snapshot the user's exact current input source.");
    }

    const preferenceKeys = [...preferenceMutations.keys(), excludedApplicationsKey];
    preferenceSnapshots = Object.fromEntries(
      preferenceKeys.map((key) => [key, snapshotPreference(preferencesDomain, key)])
    );
    if (Object.values(preferenceSnapshots).some((snapshot) => snapshot.status !== 0)) {
      failed("snapshot-preferences", "Could not snapshot exact preference values before the secure-field probe.");
    }
    const excluded = readStringArrayPreference(preferencesDomain, excludedApplicationsKey);
    if (excluded.status !== 0) {
      failed("read-learning-exclusions", "Could not read application learning exclusions for test isolation.");
    }
    try {
      recoveryTransaction = prepareSecureProbeRecovery({
        lock: recoveryLock,
        priorInputSourceIdentifier: previousInputSource.id,
        preferences: preferenceRecoveryEntries(preferenceSnapshots),
        temporaryPaths: [buildRoot]
      });
      recoveryGuardian = await launchSecureProbeRecoveryGuardian({
        lock: recoveryLock,
        transaction: recoveryTransaction
      });
      throwIfTerminationRequested();
      ensureRecoveryGuardian("before-first-preference-mutation");
      recoveryEvidence.guardian = {
        status: "ready",
        disposition: null,
        processIdentifier: recoveryGuardian.processIdentifier
      };
    } catch (error) {
      if (error instanceof ProbeFinished || terminationSignal) {
        throw error instanceof ProbeFinished ? error : new ProbeFinished("interrupted");
      }
      failed("prepare-crash-recovery", "The secure-field proof could not durably arm its crash-recovery guardian.");
    }
    const writes = [
      ...[...preferenceMutations].map(([key, value]) => writePreference(preferencesDomain, key, value)),
      writePreference(
        preferencesDomain,
        excludedApplicationsKey,
        excluded.value.filter((identifier) => identifier !== secureHostBundleIdentifier)
      )
    ];
    if (writes.some((write) => write.status !== 0) || notifyPreferenceChange().status !== 0) {
      failed("prepare-test-preferences", "Could not enable the observable secure-field test configuration.");
    }
    await signalCheckpoint();

    bundleIdentity = installedBundleIdentity(appBundle);
    const priorHealth = readRuntimeHealth(runtimeHealthPath);
    const select = run("swift", [registerScript, appBundle, "--select-only"]);
    const selected = currentInputSource();
    if (select.status !== 0 || selected.id !== lekhInputSourceId) {
      failed("select-before-host-launch", "Could not select the installed Lekh .Main source before creating the host input context.");
    }
    await signalCheckpoint();

    await launchDisposableHost();
    throwIfTerminationRequested();
    try {
      const updatedRecovery = updateSecureProbeRecovery(recoveryTransaction, {
        temporaryPaths: [buildRoot],
        hostProcess: {
          processIdentifier: hostPid,
          executablePath: hostExecutable
        }
      });
      hostProcessIdentity = updatedRecovery.hostProcess;
      ensureRecoveryGuardian("secure-host-launched");
    } catch (error) {
      if (error instanceof ProbeFinished) throw error;
      failed("bind-recovery-host", "The crash-recovery journal could not bind the exact disposable host PID/path/digest.");
    }
    const calibrationFocus = focusAccessibilityElement(hostPid, "lekh.secureHost.calibration");
    if (calibrationFocus.status !== 0) blocked("focus-calibration-field", { accessibility: calibrationFocus.snapshot });
    if (currentInputSource().id !== lekhInputSourceId) {
      failed("source-changed-before-calibration", "The selected Lekh source changed while the fresh host input context was being created.");
    }

    postEvents(keys("lekh"), "post-calibration-input");
    const calibration = waitForHostStatus((status) => status.calibrationReceivedUTF16Length > 0);
    if (!calibration) blocked("verify-calibration-delivery", { hostPid });
    await signalCheckpoint();

    const runtime = waitForExactRuntimeHealth({
      runtimeHealthPath,
      bundleIdentity,
      activatedAfterMs: hostLaunchedAtMs,
      previousActivation: priorHealth.record?.controllerActivatedAt ?? null,
      previousActivationIdentifier: priorHealth.record?.activationIdentifier ?? null,
      previousHealthMtimeMs: priorHealth.mtimeMs ?? null
    });
    runtimeEvidence = {
      exactInstalledRuntimeVerified: runtime.verified,
      issues: runtime.issues,
      processIdentifier: runtime.record?.processIdentifier ?? null,
      bundleVersionMatches: runtime.record?.bundleVersion === bundleIdentity.buildVersion,
      executablePathMatches: Number.isInteger(runtime.record?.processIdentifier)
        ? processExecutablePath(runtime.record.processIdentifier) === bundleIdentity.executablePath
        : false
    };
    if (!runtime.verified) {
      failed("verify-exact-imk-runtime", "The calibration field did not activate the exact installed Lekh PID/build.", {
        runtime: runtimeEvidence
      });
    }
    const runtimePid = runtime.record.processIdentifier;
    const runtimeProcess = processIdentity(runtimePid);
    const pinnedRuntimeEpoch = {
      processIdentifier: runtimePid,
      executablePath: bundleIdentity.executablePath,
      processStartToken: runtimeProcess.processStartToken,
      activationIdentifier: runtime.record.activationIdentifier,
      controllerInstanceIdentifier: runtime.record.controllerInstanceIdentifier,
      executableStartedAt: runtime.record.executableStartedAt
    };
    const runtimeProcessPinIssues = runtimeProcessEpochIssueCodes(pinnedRuntimeEpoch, runtimeProcess);
    if (runtimeProcessPinIssues.length > 0) {
      failed(
        "pin-runtime-process-epoch",
        "The exact installed IMK executable path and process-birth epoch could not be pinned.",
        { runtimeProcessIssueCodes: runtimeProcessPinIssues }
      );
    }
    runtimeEpoch = pinnedRuntimeEpoch;
    const initialArtifact = artifactProvenanceEvidence({
      root,
      appBundle,
      bundleIdentity,
      runtimeRecord: runtime.record,
      evidenceRevision: evidenceProvenance.gitRevision
    });
    artifactProvenance = initialArtifact.artifactProvenance;
    if (!initialArtifact.localArtifactIntegrityVerified) {
      failed("verify-local-artifact-integrity", "The signed bundle's local manifest claim, installed executable, and running code identity were not internally consistent with the clean evidence revision. This local check is not source-to-binary attestation.", {
        artifactIssueCodes: initialArtifact.issues
      });
    }
    verifyRuntimeEpoch("calibration-complete");
    await signalCheckpoint();

    const secureFocus = focusAccessibilityElement(hostPid, "lekh.secureHost.field", "AXSecureTextField");
    if (secureFocus.status !== 0) blocked("focus-secure-field", { accessibility: secureFocus.snapshot });
    const secureReady = freshSecureHostStatus();
    const externalSecureReady = secureEventInputState();
    if (!secureReady || externalSecureReady.status !== 0 || externalSecureReady.enabled !== true) {
      failed("verify-secure-input-transition", "The focused NSSecureTextField did not cause a verifiable false-to-true Secure Event Input transition.");
    }
    secureInputObservedDuringProbe = true;
    const secureRouteSamples = [currentInputSource()];
    if (secureRouteSamples[0].status !== 0 || !secureRouteSamples[0].id) {
      failed("verify-secure-input-route", "The active input route could not be identified immediately after secure focus.");
    }
    const lekhHandledSecureRoute = secureRouteSamples[0].id === lekhInputSourceId;
    if (!lekhHandledSecureRoute && (
      secureRouteSamples[0].asciiCapable !== true ||
      secureRouteSamples[0].enabled !== true ||
      secureRouteSamples[0].categoryIsKeyboardInputSource !== true ||
      secureRouteSamples[0].typeIsKeyboardLayoutOrInputMode !== true
    )) {
      failed("verify-secure-input-route", "macOS substituted a non-Lekh source that was not provably enabled, ASCII-capable keyboard input.", {
        substitutedSourceIdentifier: secureRouteSamples[0].id,
        substitutedSourceASCIICapable: secureRouteSamples[0].asciiCapable,
        substitutedSourceEnabled: secureRouteSamples[0].enabled,
        substitutedSourceCategoryValid: secureRouteSamples[0].categoryIsKeyboardInputSource,
        substitutedSourceTypeValid: secureRouteSamples[0].typeIsKeyboardLayoutOrInputMode
      });
    }
    verifyRuntimeEpoch("secure-focus");
    const secureIntervalStartedAtMs = Date.now();
    const securePostingRoutes = [];
    await signalCheckpoint();

    const noInitialSurface = waitForNoVisibleLekhSurface(runtimePid);
    if (noInitialSurface.blocked) {
      blocked("inspect-secure-input-surfaces", {
        surfaceInspectionStatus: noInitialSurface.latest?.status ?? null
      });
    }
    if (!noInitialSurface.ready) {
      failed("clear-preexisting-surfaces", "A Lekh candidate or inline-completion panel remained visible after secure focus.");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    throwIfTerminationRequested();
    const databaseBefore = logicalDatabaseSnapshot();
    if (!databaseBefore.ready) {
      failed("database-baseline", "The personalization database was not logically readable with the expected secure-test schema.");
    }
    const ghostBefore = ghostEvidenceSnapshot();
    if (!ghostBefore.readable) failed("runtime-health-baseline", "Runtime ghost evidence was unavailable after exact activation.");
    const runtimeHealthBefore = runtimeHealthFileSnapshot();
    if (!runtimeHealthBefore.ready) {
      failed("runtime-health-file-baseline", "The runtime-health file could not be snapshotted before secure entry.");
    }
    const metricBefore = metricLogSnapshot();

    const tokenPosting = await postSecureEvents(keys(syntheticRawToken), "post-secure-token");
    securePostingRoutes.push(tokenPosting.sourceIdentifierBefore, tokenPosting.sourceIdentifierAfter);
    const tokenStatus = waitForHostStatus((status) => status.secureReceivedUTF16Length > 0);
    if (!tokenStatus) {
      blocked("secure-event-injection", {
        note: "Nonsecure calibration succeeded, but macOS did not deliver the synthetic secure-field events. Use the same host with physical keys for manual evidence."
      });
    }
    if (tokenStatus.secureReceivedUTF16Length !== syntheticRawToken.length || tokenStatus.secureHasMarkedText) {
      failed("assert-secure-token-isolation", "The secure host result was transformed, retained as marked text, or delivered with an unexpected length.", {
        expectedUTF16Length: syntheticRawToken.length,
        actualUTF16Length: tokenStatus.secureReceivedUTF16Length,
        hasMarkedText: tokenStatus.secureHasMarkedText
      });
    }
    secureRouteSamples.push(currentInputSource());
    verifyRuntimeEpoch("secure-token");
    await signalCheckpoint();
    const tokenSurface = visibleLekhInputMethodSurfaces(runtimePid);
    if (tokenSurface.status !== 0) blocked("inspect-token-surfaces");
    if (tokenSurface.forbiddenVisibleCount !== 0) {
      failed("assert-no-token-surface", "Lekh displayed candidate or inline-completion UI over the secure field.");
    }

    const downPosting = await postSecureEvents([{ code: 125, flag: null }], "post-secure-down-arrow");
    securePostingRoutes.push(downPosting.sourceIdentifierBefore, downPosting.sourceIdentifierAfter);
    const downStatus = waitForHostStatus((status) =>
      status.statusSequence > downPosting.afterStatusSequence &&
      status.secureDownCommandReceived === true
    );
    const downSurface = visibleLekhInputMethodSurfaces(runtimePid);
    if (!downStatus || downSurface.status !== 0) blocked("inspect-down-arrow-result");
    if (
      downStatus.secureReceivedUTF16Length !== syntheticRawToken.length ||
      downStatus.secureHasMarkedText ||
      downStatus.secureDownCommandReceived !== true ||
      downSurface.forbiddenVisibleCount !== 0
    ) {
      failed("assert-secure-candidate-navigation-suppressed", "Down Arrow changed secure text state or exposed Lekh candidate UI.");
    }
    secureRouteSamples.push(currentInputSource());
    verifyRuntimeEpoch("secure-down-arrow");
    await signalCheckpoint();

    const spacePosting = await postSecureEvents([{ code: 49, flag: null }], "post-secure-space");
    securePostingRoutes.push(spacePosting.sourceIdentifierBefore, spacePosting.sourceIdentifierAfter);
    const finalHostStatus = waitForHostStatus((status) =>
      status.statusSequence > spacePosting.afterStatusSequence &&
      status.secureReceivedUTF16Length >= status.secureExpectedUTF16Length
    );
    if (!finalHostStatus) {
      failed("assert-secure-space-delivery", "Space did not reach the secure field after prior synthetic events were delivered.");
    }
    if (
      finalHostStatus.secureExactMatch !== true ||
      finalHostStatus.secureReceivedUTF16Length !== finalHostStatus.secureExpectedUTF16Length ||
      finalHostStatus.secureHasMarkedText
    ) {
      failed("assert-raw-secure-result", "The secure field did not retain the exact raw synthetic result.", {
        expectedUTF16Length: finalHostStatus.secureExpectedUTF16Length,
        actualUTF16Length: finalHostStatus.secureReceivedUTF16Length,
        exactMatch: finalHostStatus.secureExactMatch,
        hasMarkedText: finalHostStatus.secureHasMarkedText
      });
    }
    secureRouteSamples.push(currentInputSource());
    verifyRuntimeEpoch("secure-space");
    await signalCheckpoint();
    const finalSurface = visibleLekhInputMethodSurfaces(runtimePid);
    if (finalSurface.status !== 0) blocked("inspect-final-secure-surfaces");
    if (finalSurface.forbiddenVisibleCount !== 0) {
      failed("assert-no-final-secure-surface", "A Lekh candidate or inline-completion surface became visible during secure entry.");
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    throwIfTerminationRequested();
    const databaseAfterSamples = [logicalDatabaseSnapshot()];
    await new Promise((resolve) => setTimeout(resolve, 250));
    throwIfTerminationRequested();
    databaseAfterSamples.push(logicalDatabaseSnapshot());
    await new Promise((resolve) => setTimeout(resolve, 250));
    throwIfTerminationRequested();
    databaseAfterSamples.push(logicalDatabaseSnapshot());
    const afterStable = databaseAfterSamples.every((snapshot) =>
      snapshot.ready &&
      snapshot.canonicalDigest === databaseAfterSamples[0].canonicalDigest &&
      JSON.stringify(snapshot.aggregateRows) === JSON.stringify(databaseAfterSamples[0].aggregateRows)
    );
    const databaseEvidence = databaseComparison(databaseBefore, databaseAfterSamples.at(-1));
    if (!afterStable || !databaseEvidence.equal) {
      failed("assert-no-secure-personalization", "Logical personalization rows changed or failed to stabilize after secure typing.", {
        database: databaseEvidence,
        writerDrainStable: afterStable
      });
    }

    const ghostAfter = ghostEvidenceSnapshot();
    const runtimeGhostEvidenceUnchanged = ghostEvidenceEqual(ghostBefore, ghostAfter);
    if (!runtimeGhostEvidenceUnchanged) {
      failed("assert-no-secure-ghost-evidence", "Runtime ghost evidence changed during the secure-input interval.");
    }
    const runtimeHealthAfter = runtimeHealthFileSnapshot();
    const runtimeHealthUnchanged = runtimeHealthFileUnchanged(runtimeHealthBefore, runtimeHealthAfter);
    if (!runtimeHealthUnchanged) {
      failed("assert-no-secure-runtime-telemetry", "The runtime-health file changed during secure entry; secure activity must not persist timing or count metadata.");
    }
    const metricEvidence = inspectMetricLogAppend(metricBefore);
    if (
      !metricEvidence.reliable ||
      metricEvidence.appendedByteCount !== 0 ||
      metricEvidence.appendedLineCount !== 0 ||
      metricEvidence.appendedPayloadContainsSyntheticInput !== false
    ) {
      failed("assert-no-secure-metric-content", "The MetricKit log changed during the secure-input interval.", {
        metricSnapshotReliable: metricEvidence.reliable,
        appendedByteCount: metricEvidence.appendedByteCount
      });
    }
    await signalCheckpoint();
    const logEvidence = unifiedLogEvidence(runtimePid, secureIntervalStartedAtMs);
    if (
      !logEvidence.reliable ||
      logEvidence.eventCount !== 0 ||
      logEvidence.surfaceEventCount !== 0 ||
      logEvidence.syntheticInputMentioned
    ) {
      failed("assert-no-secure-diagnostics", "Lekh emitted unified-log events during the secure-input interval.", {
        logSnapshotReliable: logEvidence.reliable,
        eventCount: logEvidence.eventCount,
        malformedEventCount: logEvidence.malformedEventCount,
        summaryRecordCount: logEvidence.summaryRecordCount,
        surfaceEventCount: logEvidence.surfaceEventCount,
        syntheticInputMentioned: logEvidence.syntheticInputMentioned
      });
    }
    await signalCheckpoint();
    const finalSecureState = secureEventInputState();
    const finalSecureHostStatus = freshSecureHostStatus();
    if (
      finalSecureState.status !== 0 ||
      finalSecureState.enabled !== true ||
      !finalSecureHostStatus ||
      processExecutablePath(hostPid) !== hostExecutable
    ) {
      failed("assert-secure-input-remained-active", "The exact frontmost secure host and Secure Event Input did not remain active for the entire evidence interval.");
    }
    const secureRouteStable = secureRouteSamples.every((sample) =>
      sample.status === 0 &&
      sample.id === secureRouteSamples[0].id &&
      sample.asciiCapable === secureRouteSamples[0].asciiCapable &&
      sample.enabled === secureRouteSamples[0].enabled &&
      sample.category === secureRouteSamples[0].category &&
      sample.sourceType === secureRouteSamples[0].sourceType
    ) && securePostingRoutes.length === 6 &&
      securePostingRoutes.every((identifier) => identifier === secureRouteSamples[0].id);
    if (!secureRouteStable) {
      failed("verify-secure-input-route-stability", "The active input source changed during the secure-entry interval.", {
        routeSampleCount: secureRouteSamples.length,
        stable: false
      });
    }
    verifyRuntimeEpoch("secure-evidence-finalized");
    const finalArtifact = artifactProvenanceEvidence({
      root,
      appBundle,
      bundleIdentity,
      runtimeRecord: readRuntimeHealth(runtimeHealthPath).record,
      evidenceRevision: evidenceProvenance.gitRevision
    });
    if (
      !finalArtifact.localArtifactIntegrityVerified ||
      JSON.stringify(finalArtifact.artifactProvenance) !== JSON.stringify(artifactProvenance)
    ) {
      failed("verify-final-local-artifact-integrity", "The local manifest claim, installed bundle, or running code identity changed during evidence collection. This check does not provide source-to-binary attestation.", {
        artifactIssueCodes: finalArtifact.issues
      });
    }
    artifactProvenance = finalArtifact.artifactProvenance;

    conclude("passed", {
      host: {
        bundleIdentifier: secureHostBundleIdentifier,
        freshProcessVerified: true,
        calibrationDelivered: true,
        expectedUTF16Length: syntheticExpectedText.length
      },
      secureInput: {
        baselineEnabled: false,
        enabledDuringFocusedEntry: true,
        causalFalseToTrueTransition: true,
        sourceIdentifierDuringSecureEntry: secureRouteSamples[0].id,
        sourceWasASCIICapable: secureRouteSamples[0].asciiCapable,
        sourceWasEnabled: secureRouteSamples[0].enabled,
        sourceCategory: secureRouteSamples[0].category,
        sourceType: secureRouteSamples[0].sourceType,
        sourceCategoryValid: secureRouteSamples[0].categoryIsKeyboardInputSource,
        sourceTypeValid: secureRouteSamples[0].typeIsKeyboardLayoutOrInputMode,
        sourceStableThroughEntry: secureRouteStable,
        sourceSampleCount: secureRouteSamples.length + securePostingRoutes.length,
        liveControllerCallbackAttributed: false,
        controllerAttributionNote: lekhHandledSecureRoute
          ? "TIS selection does not prove whether macOS invoked or bypassed the IMK controller; callback guards are covered by the separate native functional probe."
          : "macOS visibly substituted an ASCII-capable keyboard source for secure entry.",
        protectionPath: lekhHandledSecureRoute
          ? "lekh-selected-route-attribution-unavailable"
          : "macos-ascii-source-substitution",
        osInputSourceSubstitutionObserved: !lekhHandledSecureRoute
      },
      assertions: {
        rawHostResultMatched: true,
        secureInputRouteObserved: true,
        secureInputRouteStable: true,
        noMarkedText: true,
        noVisibleLekhCandidateOrGhostSurface: true,
        personalizationPreferenceRequested: true,
        database: databaseEvidence,
        writerDrainStable: true,
        runtimeGhostEvidenceUnchanged,
        runtimeHealthFileUnchanged: runtimeHealthUnchanged,
        unifiedLog: {
          reliable: logEvidence.reliable,
          eventCount: logEvidence.eventCount,
          malformedEventCount: logEvidence.malformedEventCount,
          summaryRecordCount: logEvidence.summaryRecordCount,
          surfaceEventCount: logEvidence.surfaceEventCount,
          syntheticInputMentioned: logEvidence.syntheticInputMentioned
        },
        metricLog: metricEvidence
      },
      runtimeEpoch: {
        originalProcessIdentifier: runtimeEpoch.processIdentifier,
        executablePathPinned: runtimeEpoch.executablePath === bundleIdentity.executablePath,
        processStartTokenPinned: /^\d{1,20}:\d{1,6}$/u.test(runtimeEpoch.processStartToken),
        stable: runtimeEpochCheckpoints.every((checkpoint) => checkpoint.verified),
        checkpoints: runtimeEpochCheckpoints
      }
    });
  } catch (error) {
    if (!(error instanceof ProbeFinished)) {
      failures.push("The secure-field probe ended with an unexpected content-free harness error.");
      result = {
        status: "failed",
        details: { step: "unexpected-harness-error", errorType: error?.constructor?.name ?? "UnknownError" },
        code: 1
      };
    }
  } finally {
    await finalizeProbe();
  }
}

function key(code, flag = null) {
  return { code, flag };
}

function keys(text) {
  const codes = {
    a: 0, b: 11, c: 8, d: 2, e: 14, f: 3, g: 5, h: 4, i: 34, j: 38,
    k: 40, l: 37, m: 46, n: 45, o: 31, p: 35, q: 12, r: 15, s: 1,
    t: 17, u: 32, v: 9, w: 13, x: 7, y: 16, z: 6
  };
  return Array.from(text, (character) => key(codes[character]));
}

function secureTargetedPostingSource(events, targetIdentity) {
  const targetPid = targetIdentity.processIdentifier;
  const expectedExecutableBase64 = Buffer.from(targetIdentity.executablePath, "utf8").toString("base64");
  const parentIdentity = processIdentity(process.pid);
  const parentExecutableBase64 = Buffer.from(parentIdentity.executablePath, "utf8").toString("base64");
  const rows = events.map((event) => {
    const flags = event.flag ? `CGEventFlags.${event.flag}` : "[]";
    return `(code: ${event.code}, flags: ${flags})`;
  }).join(",\n  ");
  return `
import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Darwin
import Foundation

let targetPid = pid_t(${targetPid})
let expectedBundleIdentifier = "${secureHostBundleIdentifier}"
let expectedFocusedIdentifier = "lekh.secureHost.field"
let expectedExecutablePath = String(
  data: Data(base64Encoded: ${JSON.stringify(expectedExecutableBase64)})!,
  encoding: .utf8
)!
let expectedProcessStartToken = ${JSON.stringify(targetIdentity.processStartToken)}
let parentPid = pid_t(${parentIdentity.processIdentifier})
let parentExecutablePath = String(
  data: Data(base64Encoded: ${JSON.stringify(parentExecutableBase64)})!,
  encoding: .utf8
)!
let parentProcessStartToken = ${JSON.stringify(parentIdentity.processStartToken)}
let source = CGEventSource(stateID: .hidSystemState)
let requestedEvents: [(code: CGKeyCode, flags: CGEventFlags)] = [
  ${rows}
]

func stringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
        let value,
        CFGetTypeID(value) == CFStringGetTypeID() else { return nil }
  return value as? String
}

func currentInputSourceIdentifier() -> String? {
  let source = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
  guard let pointer = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else { return nil }
  return Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue() as String
}

func processInstanceMatches(
  _ pid: pid_t,
  _ expectedPath: String,
  _ expectedStartToken: String
) -> Bool {
  guard kill(pid, 0) == 0 else { return false }
  var pathBuffer = [CChar](repeating: 0, count: 4096)
  let pathLength = proc_pidpath(pid, &pathBuffer, UInt32(pathBuffer.count))
  var info = proc_bsdinfo()
  let expectedInfoSize = Int32(MemoryLayout<proc_bsdinfo>.stride)
  let infoSize = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, expectedInfoSize)
  guard pathLength > 0, infoSize == expectedInfoSize else { return false }
  let startToken = "\\(info.pbi_start_tvsec):\\(info.pbi_start_tvusec)"
  return String(cString: pathBuffer) == expectedPath && startToken == expectedStartToken
}

func secureGuard() -> (valid: Bool, sourceIdentifier: String) {
  guard CGPreflightPostEventAccess(),
        IsSecureEventInputEnabled(),
        processInstanceMatches(targetPid, expectedExecutablePath, expectedProcessStartToken),
        processInstanceMatches(parentPid, parentExecutablePath, parentProcessStartToken),
        let running = NSRunningApplication(processIdentifier: targetPid),
        running.bundleIdentifier == expectedBundleIdentifier,
        NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid,
        let sourceIdentifier = currentInputSourceIdentifier() else {
    return (false, "")
  }
  let app = AXUIElementCreateApplication(targetPid)
  var focusedValue: CFTypeRef?
  guard AXUIElementCopyAttributeValue(
          app,
          kAXFocusedUIElementAttribute as CFString,
          &focusedValue
        ) == .success,
        let focusedValue,
        CFGetTypeID(focusedValue) == AXUIElementGetTypeID() else {
    return (false, sourceIdentifier)
  }
  let focused = focusedValue as! AXUIElement
  let identifier = stringAttribute(focused, kAXIdentifierAttribute as CFString)
  let subrole = stringAttribute(focused, kAXSubroleAttribute as CFString)
  return (
    identifier == expectedFocusedIdentifier && subrole == (kAXSecureTextFieldSubrole as String),
    sourceIdentifier
  )
}

// A key-up cannot insert text. If any full custody guard changes after a down,
// balance it only against the same disposable host process epoch. Parent,
// focus, source, and Secure Event Input state deliberately do not authorize or
// suppress this narrowly scoped compensating release.
func compensateOutstandingKeyUp(_ keyUp: CGEvent) -> Bool {
  guard processInstanceMatches(targetPid, expectedExecutablePath, expectedProcessStartToken) else {
    return false
  }
  keyUp.postToPid(targetPid)
  return true
}

func emit(
  preconditionPassed: Bool,
  postconditionPassed: Bool,
  postedKeyCount: Int,
  sourceBefore: String,
  sourceAfter: String,
  exitCode: Int32
) -> Never {
  let output: [String: Any] = [
    "schemaVersion": 1,
    "preconditionPassed": preconditionPassed,
    "postconditionPassed": postconditionPassed,
    "postedKeyCount": postedKeyCount,
    "sourceIdentifierBefore": sourceBefore,
    "sourceIdentifierAfter": sourceAfter
  ]
  let data = try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
  print(String(decoding: data, as: UTF8.self))
  exit(exitCode)
}

guard CGPreflightPostEventAccess() else {
  emit(
    preconditionPassed: false,
    postconditionPassed: false,
    postedKeyCount: 0,
    sourceBefore: "",
    sourceAfter: "",
    exitCode: 2
  )
}
let pairs: [(down: CGEvent, up: CGEvent)] = requestedEvents.compactMap { item in
  guard let down = CGEvent(keyboardEventSource: source, virtualKey: item.code, keyDown: true),
        let up = CGEvent(keyboardEventSource: source, virtualKey: item.code, keyDown: false) else {
    return nil
  }
  down.flags = item.flags
  up.flags = item.flags
  return (down, up)
}
guard pairs.count == requestedEvents.count else {
  emit(
    preconditionPassed: false,
    postconditionPassed: false,
    postedKeyCount: 0,
    sourceBefore: "",
    sourceAfter: "",
    exitCode: 3
  )
}
let initial = secureGuard()
guard initial.valid else {
  emit(
    preconditionPassed: false,
    postconditionPassed: false,
    postedKeyCount: 0,
    sourceBefore: initial.sourceIdentifier,
    sourceAfter: initial.sourceIdentifier,
    exitCode: 10
  )
}
var postedKeyCount = 0
for pair in pairs {
  let perKey = secureGuard()
  guard perKey.valid, perKey.sourceIdentifier == initial.sourceIdentifier else {
    emit(
      preconditionPassed: false,
      postconditionPassed: false,
      postedKeyCount: postedKeyCount,
      sourceBefore: initial.sourceIdentifier,
      sourceAfter: perKey.sourceIdentifier,
      exitCode: 11
    )
  }
  pair.down.postToPid(targetPid)
  usleep(35_000)
  let beforeUp = secureGuard()
  guard beforeUp.valid, beforeUp.sourceIdentifier == initial.sourceIdentifier else {
    _ = compensateOutstandingKeyUp(pair.up)
    emit(
      preconditionPassed: false,
      postconditionPassed: false,
      postedKeyCount: postedKeyCount,
      sourceBefore: initial.sourceIdentifier,
      sourceAfter: beforeUp.sourceIdentifier,
      exitCode: 13
    )
  }
  pair.up.postToPid(targetPid)
  postedKeyCount += 1
  usleep(65_000)
}
let final = secureGuard()
guard final.valid, final.sourceIdentifier == initial.sourceIdentifier else {
  emit(
    preconditionPassed: true,
    postconditionPassed: false,
    postedKeyCount: postedKeyCount,
    sourceBefore: initial.sourceIdentifier,
    sourceAfter: final.sourceIdentifier,
    exitCode: 12
  )
}
emit(
  preconditionPassed: true,
  postconditionPassed: true,
  postedKeyCount: postedKeyCount,
  sourceBefore: initial.sourceIdentifier,
  sourceAfter: final.sourceIdentifier,
  exitCode: 0
)
`;
}

function emergencySecureKeyUpSource(events, targetIdentity) {
  const targetPid = targetIdentity.processIdentifier;
  const expectedExecutableBase64 = Buffer.from(targetIdentity.executablePath, "utf8").toString("base64");
  const parentIdentity = processIdentity(process.pid);
  const parentExecutableBase64 = Buffer.from(parentIdentity.executablePath, "utf8").toString("base64");
  const rows = events.map((event) => {
    const flags = event.flag ? `CGEventFlags.${event.flag}` : "[]";
    return `(code: ${event.code}, flags: ${flags})`;
  }).join(",\n  ");
  return `
import AppKit
import CoreGraphics
import Darwin
import Foundation
let targetPid = pid_t(${targetPid})
let expectedExecutablePath = String(
  data: Data(base64Encoded: ${JSON.stringify(expectedExecutableBase64)})!,
  encoding: .utf8
)!
let expectedProcessStartToken = ${JSON.stringify(targetIdentity.processStartToken)}
let parentPid = pid_t(${parentIdentity.processIdentifier})
let parentExecutablePath = String(data: Data(base64Encoded: ${JSON.stringify(parentExecutableBase64)})!, encoding: .utf8)!
let parentProcessStartToken = ${JSON.stringify(parentIdentity.processStartToken)}
func exactProcessInstance(_ pid: pid_t, _ expectedPath: String, _ expectedStart: String) -> Bool {
  var pathBuffer = [CChar](repeating: 0, count: 4096)
  let pathLength = proc_pidpath(pid, &pathBuffer, UInt32(pathBuffer.count))
  var info = proc_bsdinfo()
  let expectedInfoSize = Int32(MemoryLayout<proc_bsdinfo>.stride)
  let infoSize = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, expectedInfoSize)
  guard pathLength > 0, infoSize == expectedInfoSize else { return false }
  return String(cString: pathBuffer) == expectedPath &&
    "\\(info.pbi_start_tvsec):\\(info.pbi_start_tvusec)" == expectedStart
}
guard let running = NSRunningApplication(processIdentifier: targetPid),
      running.bundleIdentifier == "${secureHostBundleIdentifier}",
      exactProcessInstance(targetPid, expectedExecutablePath, expectedProcessStartToken),
      exactProcessInstance(parentPid, parentExecutablePath, parentProcessStartToken) else { exit(0) }
let source = CGEventSource(stateID: .hidSystemState)
let events: [(code: CGKeyCode, flags: CGEventFlags)] = [
  ${rows}
]
for item in events {
  guard exactProcessInstance(targetPid, expectedExecutablePath, expectedProcessStartToken),
        exactProcessInstance(parentPid, parentExecutablePath, parentProcessStartToken) else { exit(0) }
  guard let keyUp = CGEvent(
          keyboardEventSource: source,
          virtualKey: item.code,
          keyDown: false
        ) else { exit(2) }
  keyUp.flags = item.flags
  keyUp.postToPid(targetPid)
}
`;
}

function targetedPostingSource(events, targetIdentity) {
  const targetPid = targetIdentity.processIdentifier;
  const expectedExecutableBase64 = Buffer.from(targetIdentity.executablePath, "utf8").toString("base64");
  const parentIdentity = processIdentity(process.pid);
  const parentExecutableBase64 = Buffer.from(parentIdentity.executablePath, "utf8").toString("base64");
  const rows = events.map((event) => {
    const flags = event.flag ? `CGEventFlags.${event.flag}` : "[]";
    return `(code: ${event.code}, flags: ${flags})`;
  }).join(",\n  ");
  return `
import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Darwin
import Foundation
guard CGPreflightPostEventAccess() else { exit(2) }
let targetPid = pid_t(${targetPid})
let expectedExecutablePath = String(
  data: Data(base64Encoded: ${JSON.stringify(expectedExecutableBase64)})!,
  encoding: .utf8
)!
let expectedProcessStartToken = ${JSON.stringify(targetIdentity.processStartToken)}
let parentPid = pid_t(${parentIdentity.processIdentifier})
let parentExecutablePath = String(data: Data(base64Encoded: ${JSON.stringify(parentExecutableBase64)})!, encoding: .utf8)!
let parentProcessStartToken = ${JSON.stringify(parentIdentity.processStartToken)}
let expectedInputSource = "${lekhInputSourceId}"
func currentInputSourceIdentifier() -> String? {
  let inputSource = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
  guard let pointer = TISGetInputSourceProperty(inputSource, kTISPropertyInputSourceID) else { return nil }
  return Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue() as String
}
func stringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
        let value, CFGetTypeID(value) == CFStringGetTypeID() else { return nil }
  return value as? String
}
func exactCalibrationContext() -> Bool {
  guard exactProcessInstance(parentPid, parentExecutablePath, parentProcessStartToken),
        exactProcessInstance(targetPid, expectedExecutablePath, expectedProcessStartToken) else { return false }
  let running = NSRunningApplication(processIdentifier: targetPid)
  guard running?.bundleIdentifier == "${secureHostBundleIdentifier}",
        NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid,
        currentInputSourceIdentifier() == expectedInputSource else { return false }
  let app = AXUIElementCreateApplication(targetPid)
  var focusedValue: CFTypeRef?
  guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focusedValue) == .success,
        let focusedValue, CFGetTypeID(focusedValue) == AXUIElementGetTypeID() else { return false }
  return stringAttribute(focusedValue as! AXUIElement, kAXIdentifierAttribute as CFString) ==
    "lekh.secureHost.calibration"
}
func exactProcessInstance(_ pid: pid_t, _ executablePath: String, _ startToken: String) -> Bool {
  guard kill(pid, 0) == 0 else { return false }
  var pathBuffer = [CChar](repeating: 0, count: 4096)
  let pathLength = proc_pidpath(pid, &pathBuffer, UInt32(pathBuffer.count))
  var info = proc_bsdinfo()
  let expectedInfoSize = Int32(MemoryLayout<proc_bsdinfo>.stride)
  let infoSize = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, expectedInfoSize)
  return pathLength > 0 &&
    infoSize == expectedInfoSize &&
    String(cString: pathBuffer) == executablePath &&
    "\\(info.pbi_start_tvsec):\\(info.pbi_start_tvusec)" == startToken
}
func compensateCalibrationKeyUp(_ keyUp: CGEvent) -> Bool {
  guard exactProcessInstance(targetPid, expectedExecutablePath, expectedProcessStartToken) else {
    return false
  }
  keyUp.postToPid(targetPid)
  return true
}
guard exactCalibrationContext() else { exit(10) }
let source = CGEventSource(stateID: .hidSystemState)
let events: [(code: CGKeyCode, flags: CGEventFlags)] = [
  ${rows}
]
for event in events {
  guard exactCalibrationContext() else { exit(11) }
  guard let down = CGEvent(keyboardEventSource: source, virtualKey: event.code, keyDown: true),
        let up = CGEvent(keyboardEventSource: source, virtualKey: event.code, keyDown: false) else {
    exit(3)
  }
  down.flags = event.flags
  up.flags = event.flags
  down.postToPid(targetPid)
  usleep(35_000)
  guard exactCalibrationContext() else {
    _ = compensateCalibrationKeyUp(up)
    exit(12)
  }
  up.postToPid(targetPid)
  usleep(65_000)
}`;
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url));
if (invokedDirectly) {
  process.once("SIGINT", () => handleTerminationSignal("SIGINT", 130));
  process.once("SIGTERM", () => handleTerminationSignal("SIGTERM", 143));
  await executeProbe();
}

export {
  emergencySecureKeyUpSource,
  exactSecurePostingEvidence,
  runtimeProcessEpochIssueCodes,
  secureTargetedPostingSource,
  targetedPostingSource
};
