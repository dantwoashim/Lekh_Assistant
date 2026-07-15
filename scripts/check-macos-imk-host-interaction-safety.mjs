#!/usr/bin/env node
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  currentInputSource,
  installedBundleIdentity,
  launchColdTextEdit,
  lekhInputSourceId,
  prepareExactTextEdit,
  readExactTextEdit,
  readRuntimeHealth,
  removeProbeFile,
  restoreExactInputSource,
  run,
  terminateColdTextEdit,
  wait,
  waitForExactRuntimeHealth
} from "./lib/macos-imk-host-harness.mjs";

const root = process.cwd();
const startedAt = performance.now();
const appBundle = join(homedir(), "Library", "Input Methods", "Lekh Keyboard.app");
const registerScript = join(root, "native", "macos-imk", "skeleton", "register-dev.swift");
const restoreScript = join(root, "native", "macos-imk", "skeleton", "restore-system-keyboard.sh");
const runtimeHealthPath = join(homedir(), "Library", "Application Support", "Lekh Keyboard", "runtime-health.v1.json");
const reportPath = join(root, "reports", "macos-imk-host-interaction-safety.json");
const tempTextEditFile = `/tmp/lekh-native-interaction-safety-${process.pid}.txt`;
const documentPrefix = "probe ";
const preferencesDomain = "com.lekh.inputmethod.LekhKeyboard";
const personalizationKey = "LekhPersonalizationEnabled";
const hostProbeDiagnosticsKey = "LekhHostProbeDiagnosticsEnabled";
const inlinePreviewKey = "LekhInlinePreviewEnabled";
const customCandidatePanelKey = "LekhCustomCandidatePanelEnabled";
const preferencesNotification = "com.lekh.inputmethod.preferences.changed";
const failures = [];
const evidence = [];

const allCases = [
  {
    id: "uncalibrated-forward-space-raw",
    events: keys("swasthya").concat(key(49)),
    expected: "swasthya ",
    provesEngine: false,
    proves: "Repository heuristic confidence cannot silently authorize forward conversion."
  },
  {
    id: "explicit-down-space",
    events: keys("swasthya").concat(key(125), key(49)),
    expected: "स्वास्थ्य ",
    provesEngine: true,
    proves: "Down then Space explicitly accepts the visible first deterministic candidate."
  },
  {
    id: "ambiguous-space-raw",
    events: keys("pani").concat(key(49)),
    expected: "pani ",
    provesEngine: false,
    proves: "Space preserves raw input when confidence/margin cannot authorize a default."
  },
  {
    id: "pani-first-explicit",
    events: keys("pani").concat(key(125), key(49)),
    expectedAny: ["पानी ", "पनि "],
    provesEngine: true,
    proves: "Down then Space accepts whichever deterministic pani row is currently ranked first."
  },
  {
    id: "passive-digit-is-text",
    events: keys("pani").concat(key(19), key(49)),
    expected: "pani2 ",
    provesEngine: false,
    proves: "A plain candidate number remains ordinary input before explicit browsing."
  },
  {
    id: "option-two-explicit",
    events: keys("pani").concat(key(125), key(19, "maskAlternate"), key(49)),
    expectedAny: ["पानी ", "पनि "],
    provesEngine: true,
    proves: "After Down enters explicit browsing, Option-2 selects the second alternative even across panel-render latency."
  },
  {
    id: "two-stage-escape",
    events: keys("pani").concat(key(53), key(53)),
    expected: "pani",
    provesEngine: false,
    proves: "Escape first reverts to raw and then preserves it while dismissing the host surface."
  }
];
const requestedCaseId = process.env.LEKH_HOST_PROBE_CASE?.trim();
const cases = requestedCaseId
  ? allCases.filter((testCase) => testCase.id === requestedCaseId)
  : allCases;

class ProbeFinished extends Error {}

let result = null;
let coldTextEditPid = null;
let realTempTextEditFile = null;
let previousInputSource = null;
let preferenceSnapshots = null;
let bundleIdentity = null;
let runtimeEvidence = null;

function conclude(status, details = {}, code = 0) {
  result = { status, details, code };
  throw new ProbeFinished(status);
}

function blocked(step, details = {}) {
  failures.push(`Automation was blocked at ${step}.`);
  conclude("blocked-automation", {
    step,
    note: "This PID-targeted TextEdit proof requires Accessibility and Input Monitoring permission for the invoking shell.",
    ...details
  }, 2);
}

function failed(step, message, details = {}) {
  failures.push(message);
  conclude("failed", { step, ...details }, 1);
}

function snapshotBooleanPreference(key) {
  const value = run("defaults", ["read", preferencesDomain, key]);
  return { existed: value.status === 0, enabled: /^(1|true|yes)$/i.test(value.stdout.trim()) };
}

function setBooleanPreference(key, enabled) {
  const write = run("defaults", ["write", preferencesDomain, key, "-bool", enabled ? "true" : "false"]);
  if (write.status === 0) run("notifyutil", ["-p", preferencesNotification]);
  return write;
}

function restoreBooleanPreference(key, snapshot) {
  if (snapshot.existed) {
    run("defaults", ["write", preferencesDomain, key, "-bool", snapshot.enabled ? "true" : "false"]);
  } else {
    run("defaults", ["delete", preferencesDomain, key]);
  }
  run("notifyutil", ["-p", preferencesNotification]);
}

function readSurfaceDiagnostics(pid) {
  if (!Number.isInteger(pid)) return [];
  const logs = run("/usr/bin/log", [
    "show", "--last", "3m", "--style", "compact",
    "--predicate", 'subsystem == "com.lekh.inputmethod.keyboard" AND category == "imk"'
  ]);
  return logs.stdout
    .split(/\r?\n/)
    .filter((line) => line.includes("surface.") && line.includes(`LekhInputMethodApp[${pid}:`))
    .slice(-120);
}

function ensureExactContext(pid, realPath) {
  const attempts = [];
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    let source = currentInputSource();
    let reselectionStatus = null;
    if (source.id !== lekhInputSourceId) {
      const reselection = run("swift", [registerScript, appBundle, "--select-only"]);
      reselectionStatus = reselection.status;
      wait(200);
      source = currentInputSource();
    }
    const prepared = prepareExactTextEdit(pid, realPath, documentPrefix);
    const state = {
      attempt,
      inputSourceId: source.id,
      inputSourceStatus: source.status,
      reselectionStatus,
      textEditPid: pid,
      preparationStatus: prepared.status,
      accessibility: prepared.snapshot
    };
    attempts.push(state);
    if (
      source.status === 0 &&
      source.id === lekhInputSourceId &&
      prepared.status === 0 &&
      prepared.snapshot?.frontmostPid === pid &&
      prepared.snapshot?.text === documentPrefix
    ) {
      return { ready: true, attempts };
    }
    wait(200);
  }
  return { ready: false, attempts };
}

function writeReport() {
  const finalResult = result ?? { status: "failed", details: { step: "unknown" }, code: 1 };
  mkdirSync(join(root, "reports"), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "npm run probe:macos-imk-host:interaction-safety",
    suite: "macos-imk-host-interaction-safety",
    durationMs: Math.round(performance.now() - startedAt),
    status: finalResult.status,
    appBundle,
    cases: evidence,
    failures,
    bundleIdentity,
    runtimeHealth: runtimeEvidence,
    ...finalResult.details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console[finalResult.code === 0 ? "log" : finalResult.code === 2 ? "warn" : "error"](JSON.stringify(report, null, 2));
  process.exitCode = finalResult.code;
}

try {
  if (requestedCaseId && cases.length === 0) {
    failed("validate-case", `Unknown host probe case: ${requestedCaseId}.`, { requestedCaseId });
  }
  if (process.platform !== "darwin") failed("platform", "Interaction-safety host proof must run on macOS.", { platform: process.platform });
  if (![appBundle, registerScript, restoreScript].every(existsSync)) {
    failed("preflight", "Installed IMK bundle or host-probe support scripts are missing.");
  }

  previousInputSource = currentInputSource();
  if (previousInputSource.status !== 0 || !previousInputSource.id) {
    failed("snapshot-input-source", "Could not snapshot the user's exact current input source.", previousInputSource);
  }
  preferenceSnapshots = {
    personalization: snapshotBooleanPreference(personalizationKey),
    diagnostics: snapshotBooleanPreference(hostProbeDiagnosticsKey),
    inlinePreview: snapshotBooleanPreference(inlinePreviewKey),
    candidatePanel: snapshotBooleanPreference(customCandidatePanelKey)
  };

  const preferenceWrites = [
    setBooleanPreference(personalizationKey, false),
    setBooleanPreference(hostProbeDiagnosticsKey, true),
    setBooleanPreference(inlinePreviewKey, true),
    setBooleanPreference(customCandidatePanelKey, true)
  ];
  if (preferenceWrites.some((write) => write.status !== 0)) {
    failed("prepare-test-preferences", "Could not isolate personalization, diagnostics and candidate UI for the host probe.");
  }

  writeFileSync(tempTextEditFile, documentPrefix);
  realTempTextEditFile = realpathSync(tempTextEditFile);
  bundleIdentity = installedBundleIdentity(appBundle);
  const priorHealth = readRuntimeHealth(runtimeHealthPath);

  // Select the installed .Main source before TextEdit creates its input
  // context. Launching the host first can permanently bind that document to
  // ABC/PressAndHold and produces convincing raw-key false positives.
  const initialSelection = run("swift", [registerScript, appBundle, "--select-only"]);
  const selectedSource = currentInputSource();
  if (initialSelection.status !== 0 || selectedSource.id !== lekhInputSourceId) {
    failed("select-before-host-launch", "Could not select the installed Lekh .Main source before launching TextEdit.", {
      selectStatus: initialSelection.status,
      selectStdout: initialSelection.stdout,
      selectStderr: initialSelection.stderr,
      selectedSource
    });
  }

  const coldLaunch = launchColdTextEdit(realTempTextEditFile);
  coldTextEditPid = coldLaunch.pid;
  if (coldLaunch.status !== 0 || !Number.isInteger(coldTextEditPid)) {
    blocked("launch-fresh-textedit", coldLaunch);
  }

  const initialContext = ensureExactContext(coldTextEditPid, realTempTextEditFile);
  if (!initialContext.ready) blocked("prepare-exact-textedit-context", { attempts: initialContext.attempts });

  const runtime = waitForExactRuntimeHealth({
    runtimeHealthPath,
    bundleIdentity,
    activatedAfterMs: coldLaunch.launchedAtMs,
    previousActivation: priorHealth.record?.controllerActivatedAt ?? null,
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

  for (const testCase of cases) {
    const focusedContext = ensureExactContext(coldTextEditPid, realTempTextEditFile);
    if (!focusedContext.ready) blocked(`focus-and-source-${testCase.id}`, { attempts: focusedContext.attempts });

    const post = run("swift", ["-e", targetedPostingSource(testCase.events, coldTextEditPid)]);
    if (post.status !== 0) blocked(`post-${testCase.id}`, { stdout: post.stdout, stderr: post.stderr });
    wait(850);

    const read = readExactTextEdit(coldTextEditPid, realTempTextEditFile);
    const sourceAfter = currentInputSource();
    const documentText = read.snapshot?.text ?? "";
    const actual = documentText.startsWith(documentPrefix)
      ? documentText.slice(documentPrefix.length)
      : documentText;
    const expectedValues = testCase.expectedAny ?? [testCase.expected];
    const rawABCObserved = testCase.provesEngine && /^[\x00-\x7F]*$/.test(actual);
    const pass =
      read.status === 0 &&
      sourceAfter.id === lekhInputSourceId &&
      expectedValues.includes(actual) &&
      !rawABCObserved;
    evidence.push({
      ...testCase,
      focusedContext,
      inputSourceAfter: sourceAfter.id,
      eventDelivery: "CGEvent.postToPid",
      textEditPid: coldTextEditPid,
      inputMethodPid,
      exactInstalledRuntimeVerified: true,
      engineProof: testCase.provesEngine && pass,
      rawABCObserved,
      accessibility: read.snapshot,
      surfaceDiagnostics: readSurfaceDiagnostics(inputMethodPid),
      actual,
      pass
    });
    if (!pass) failures.push(`${testCase.id}: expected one of ${JSON.stringify(expectedValues)}, got ${JSON.stringify(actual)}.`);
  }

  const paniFirst = evidence.find((item) => item.id === "pani-first-explicit");
  const paniSecond = evidence.find((item) => item.id === "option-two-explicit");
  if (paniFirst?.pass && paniSecond?.pass && paniFirst.actual === paniSecond.actual) {
    failures.push("Option-2 did not choose a distinct second pani candidate after explicit browsing.");
  }
  const engineOutputEvidence = evidence.some((item) => item.engineProof === true);
  if (!requestedCaseId && !engineOutputEvidence) {
    failures.push("No Devanagari engine-bearing case passed; raw ABC behavior is never engine proof.");
  }
  if (failures.length > 0) {
    conclude("failed", { personalizationIsolated: true, engineOutputEvidence }, 1);
  }
  conclude(requestedCaseId && !engineOutputEvidence ? "passed-safety-only" : "passed", {
    personalizationIsolated: true,
    engineOutputEvidence,
    coldHostLaunch: true,
    priorTextEditPids: coldLaunch.priorPids,
    note: engineOutputEvidence
      ? "A cold exact TextEdit PID activated the installed IMK build; Devanagari output and guarded raw fallback both passed."
      : "The selected raw-behavior case passed inside a verified IMK session, but it is intentionally not engine-output evidence."
  }, 0);
} catch (error) {
  if (!(error instanceof ProbeFinished)) throw error;
} finally {
  const cleanupFailures = [];
  if (Number.isInteger(coldTextEditPid)) {
    const termination = terminateColdTextEdit(coldTextEditPid);
    if (termination.status !== 0) cleanupFailures.push(termination.note);
  }
  if (previousInputSource?.id) {
    const restored = restoreExactInputSource(previousInputSource.id);
    if (restored.status !== 0 || currentInputSource().id !== previousInputSource.id) {
      run(restoreScript, []);
      cleanupFailures.push(`Could not restore exact prior input source ${previousInputSource.id}.`);
    }
  }
  if (preferenceSnapshots) {
    restoreBooleanPreference(personalizationKey, preferenceSnapshots.personalization);
    restoreBooleanPreference(hostProbeDiagnosticsKey, preferenceSnapshots.diagnostics);
    restoreBooleanPreference(inlinePreviewKey, preferenceSnapshots.inlinePreview);
    restoreBooleanPreference(customCandidatePanelKey, preferenceSnapshots.candidatePanel);
  }
  if (realTempTextEditFile) removeProbeFile(tempTextEditFile);
  if (cleanupFailures.length > 0) {
    failures.push(...cleanupFailures);
    result = { status: "failed", details: { ...(result?.details ?? {}), cleanupFailures }, code: 1 };
  }
  writeReport();
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

function targetedPostingSource(events, targetPid) {
  const rows = events.map((event) => {
    const flags = event.flag ? `CGEventFlags.${event.flag}` : "[]";
    return `(code: ${event.code}, flags: ${flags})`;
  }).join(",\n  ");
  return `
import CoreGraphics
import Foundation
let targetPid = pid_t(${targetPid})
let source = CGEventSource(stateID: .hidSystemState)
let events: [(code: CGKeyCode, flags: CGEventFlags)] = [
  ${rows}
]
for event in events {
  let down = CGEvent(keyboardEventSource: source, virtualKey: event.code, keyDown: true)
  let up = CGEvent(keyboardEventSource: source, virtualKey: event.code, keyDown: false)
  down?.flags = event.flags
  up?.flags = event.flags
  down?.postToPid(targetPid)
  usleep(35_000)
  up?.postToPid(targetPid)
  usleep(65_000)
}`;
}
