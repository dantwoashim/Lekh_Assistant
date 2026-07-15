#!/usr/bin/env node
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const startedAt = performance.now();
const appBundle = join(homedir(), "Library", "Input Methods", "Lekh Keyboard.app");
const registerScript = join(root, "native", "macos-imk", "skeleton", "register-dev.swift");
const restoreScript = join(root, "native", "macos-imk", "skeleton", "restore-system-keyboard.sh");
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
    proves: "Repository heuristic confidence cannot silently authorize forward conversion."
  },
  {
    id: "explicit-down-space",
    events: keys("swasthya").concat(key(125), key(49)),
    expected: "स्वास्थ्य ",
    proves: "Down then Space explicitly accepts the visible first deterministic candidate."
  },
  {
    id: "ambiguous-space-raw",
    events: keys("pani").concat(key(49)),
    expected: "pani ",
    proves: "Space preserves raw input when confidence/margin cannot authorize a default."
  },
  {
    id: "pani-first-explicit",
    events: keys("pani").concat(key(125), key(49)),
    expectedAny: ["पानी ", "पनि "],
    proves: "Down then Space accepts whichever deterministic pani row is currently ranked first."
  },
  {
    id: "passive-digit-is-text",
    events: keys("pani").concat(key(19), key(49)),
    expected: "pani2 ",
    proves: "A plain candidate number remains ordinary input before explicit browsing."
  },
  {
    id: "option-two-explicit",
    events: keys("pani").concat(key(125), key(19, "maskAlternate"), key(49)),
    expectedAny: ["पानी ", "पनि "],
    proves: "After Down enters explicit browsing, Option-2 selects the second alternative even across panel-render latency."
  },
  {
    id: "two-stage-escape",
    events: keys("pani").concat(key(53), key(53)),
    expected: "pani",
    proves: "Escape first reverts to raw and then preserves it while dismissing the host surface."
  }
];
const requestedCaseId = process.env.LEKH_HOST_PROBE_CASE?.trim();
const cases = requestedCaseId
  ? allCases.filter((testCase) => testCase.id === requestedCaseId)
  : allCases;

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function finish(status, details = {}, code = 0) {
  mkdirSync(join(root, "reports"), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "npm run probe:macos-imk-host:interaction-safety",
    suite: "macos-imk-host-interaction-safety",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    appBundle,
    cases: evidence,
    failures,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console[code === 0 ? "log" : "error"](JSON.stringify(report, null, 2));
  process.exitCode = code;
}

function blocked(step, details = {}) {
  failures.push(`Automation was blocked at ${step}.`);
  finish("blocked-automation", {
    step,
    note: "This HID/TextEdit proof requires Accessibility and Input Monitoring permission for the invoking shell.",
    ...details
  }, 2);
}

function snapshotBooleanPreference(key) {
  const result = run("defaults", ["read", preferencesDomain, key]);
  return {
    existed: result.status === 0,
    enabled: /^(1|true|yes)$/i.test(result.stdout.trim())
  };
}

function setBooleanPreference(key, enabled) {
  const write = run("defaults", ["write", preferencesDomain, key, "-bool", enabled ? "true" : "false"]);
  if (write.status !== 0) return write;
  run("notifyutil", ["-p", preferencesNotification]);
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
  const result = run("log", [
    "show", "--last", "2m", "--style", "compact",
    "--predicate", 'subsystem == "com.lekh.inputmethod.keyboard" AND category == "imk"'
  ]);
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.includes("surface.") && line.includes(`LekhInputMethodApp[${pid}:`))
    .slice(-120);
}

function currentInputSourceId() {
  const result = run("swift", ["-e", `
import Carbon
import Foundation
let source = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
if let pointer = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) {
  print(Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue() as String)
}`]);
  return result.stdout.trim();
}

function textEditPid() {
  const result = run("pgrep", ["-x", "TextEdit"]);
  const pids = result.stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter(Number.isInteger);
  return pids.at(-1) ?? null;
}

function frontmostApplicationName() {
  return run("osascript", [
    "-e", "tell application \"System Events\" to get name of first application process whose frontmost is true"
  ]).stdout.trim();
}

function ensureFocusedLekh(realPath) {
  const expectedId = "com.lekh.inputmethod.LekhKeyboard.Main";
  const attempts = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const focus = focusAndClear(realPath);
    const select = focus.status === 0
      ? run("swift", [registerScript, appBundle, "--select-only"])
      : { status: 1 };
    wait(200);
    let sourceId = currentInputSourceId();
    let frontmost = frontmostApplicationName();
    let recoveredFocus = false;
    if (select.status === 0 && frontmost !== "TextEdit") {
      const recover = run("osascript", [
        "-e", "tell application \"System Events\" to if exists process \"System Settings\" then set visible of process \"System Settings\" to false",
        "-e", "tell application \"TextEdit\" to activate",
        "-e", "tell application \"System Events\" to set frontmost of process \"TextEdit\" to true",
        "-e", "delay 0.25"
      ]);
      recoveredFocus = recover.status === 0;
      wait(150);
      sourceId = currentInputSourceId();
      frontmost = frontmostApplicationName();
    }
    const state = { attempt, focusStatus: focus.status, selectStatus: select.status, recoveredFocus, inputSourceId: sourceId, frontmostApplication: frontmost };
    attempts.push(state);
    const targetPid = textEditPid();
    state.textEditPid = targetPid;
    if (focus.status === 0 &&
        select.status === 0 &&
        sourceId === expectedId &&
        frontmost === "TextEdit" &&
        Number.isInteger(targetPid)) {
      return { ready: true, attempts };
    }
    wait(250);
  }
  return { ready: false, attempts };
}

if (requestedCaseId && cases.length === 0) {
  failures.push(`Unknown host probe case: ${requestedCaseId}.`);
  finish("failed", { requestedCaseId }, 1);
} else if (process.platform !== "darwin") {
  failures.push("Interaction-safety host proof must run on macOS.");
  finish("failed", { platform: process.platform }, 1);
} else if (![appBundle, registerScript, restoreScript].every(existsSync)) {
  failures.push("Installed IMK bundle or host-probe support scripts are missing.");
  finish("failed", {}, 1);
} else {
  const personalizationSnapshot = snapshotBooleanPreference(personalizationKey);
  const diagnosticsSnapshot = snapshotBooleanPreference(hostProbeDiagnosticsKey);
  const inlinePreviewSnapshot = snapshotBooleanPreference(inlinePreviewKey);
  const candidatePanelSnapshot = snapshotBooleanPreference(customCandidatePanelKey);
  run(restoreScript, []);
  writeFileSync(tempTextEditFile, "");
  const realTempTextEditFile = realpathSync(tempTextEditFile);
  try {
    const disableLearning = setBooleanPreference(personalizationKey, false);
    const enableDiagnostics = setBooleanPreference(hostProbeDiagnosticsKey, true);
    const enablePreview = setBooleanPreference(inlinePreviewKey, true);
    const enableCandidatePanel = setBooleanPreference(customCandidatePanelKey, true);
    if (disableLearning.status !== 0 || enableDiagnostics.status !== 0 || enablePreview.status !== 0 || enableCandidatePanel.status !== 0) {
      failures.push("Could not isolate personalization, diagnostics and candidate UI for the host probe.");
      finish("failed", {
        step: "prepare-test-preferences",
        personalizationStderr: disableLearning.stderr,
        diagnosticsStderr: enableDiagnostics.stderr,
        previewStderr: enablePreview.stderr,
        candidatePanelStderr: enableCandidatePanel.stderr
      }, 1);
    }
    run("open", ["-a", "TextEdit", tempTextEditFile]);
    wait(900);
    const prep = focusAndClear(realTempTextEditFile);
    if (prep.status !== 0) {
      blocked("prepare-textedit", { stdout: prep.stdout, stderr: prep.stderr });
    } else {
      // TIS/imklaunchagent—not LaunchServices `open`—must launch the input
      // method server so TextEdit binds to the published IMK endpoint.
      const select = run("swift", [registerScript, appBundle, "--select-only"]);
      if (select.status !== 0) {
        failures.push("Could not select the installed Lekh input source.");
        finish("failed", { step: "select-input-source", stdout: select.stdout, stderr: select.stderr }, 1);
      } else {
        wait(1400);
        for (const testCase of cases) {
          const focusedContext = ensureFocusedLekh(realTempTextEditFile);
          if (!focusedContext.ready) {
            blocked(`focus-and-source-${testCase.id}`, { attempts: focusedContext.attempts });
            break;
          }
          const targetTextEditPid = focusedContext.attempts.at(-1)?.textEditPid;
          const post = run("swift", ["-e", targetedPostingSource(testCase.events, targetTextEditPid)]);
          if (post.status !== 0) {
            blocked(`post-${testCase.id}`, { stdout: post.stdout, stderr: post.stderr });
            break;
          }
          wait(900);
          const inputSourceAfter = currentInputSourceId();
          const frontmostAfter = frontmostApplicationName();
          const processQuery = run("pgrep", ["-x", "LekhInputMethodApp"]);
          const inputMethodPid = Number(processQuery.stdout.trim().split(/\s+/).filter(Boolean).at(-1));
          const read = run("osascript", [
            "-e", `tell application "TextEdit" to if (path of front document) is not "${realTempTextEditFile}" then error "Front TextEdit document changed."`,
            "-e", "tell application \"TextEdit\" to get text of front document"
          ]);
          const documentText = read.stdout.replace(/\r?\n$/, "");
          const actual = documentText.startsWith(documentPrefix)
            ? documentText.slice(documentPrefix.length)
            : documentText;
          const expectedValues = testCase.expectedAny ?? [testCase.expected];
          const pass = read.status === 0 && expectedValues.includes(actual);
          evidence.push({
            ...testCase,
            focusedContext,
            inputSourceAfter,
            frontmostAfter,
            eventDelivery: "CGEvent.postToPid",
            textEditPid: targetTextEditPid,
            inputMethodPid: Number.isInteger(inputMethodPid) ? inputMethodPid : null,
            surfaceDiagnostics: readSurfaceDiagnostics(inputMethodPid),
            actual,
            pass
          });
          if (!pass) failures.push(`${testCase.id}: expected one of ${JSON.stringify(expectedValues)}, got ${JSON.stringify(actual)}.`);
        }

        if (process.exitCode === undefined) {
          const paniFirst = evidence.find((item) => item.id === "pani-first-explicit");
          const paniSecond = evidence.find((item) => item.id === "option-two-explicit");
          if (paniFirst?.pass && paniSecond?.pass && paniFirst.actual === paniSecond.actual) {
            failures.push("Option-2 did not choose a distinct second pani candidate after explicit browsing.");
          }
          finish(failures.length === 0 ? "passed" : "failed", {
            personalizationIsolated: true,
            note: "HID-level TextEdit proof covers safe auto-commit, raw fallback, passive digit safety, explicit Option selection and two-stage Escape without modifying personal learning."
          }, failures.length === 0 ? 0 : 1);
        }
      }
    }
  } finally {
    run("osascript", [
      "-e", "tell application \"TextEdit\" to repeat with d in documents",
      "-e", "try",
      "-e", `if (path of d) is "${realTempTextEditFile}" then close d saving no`,
      "-e", "end try",
      "-e", "end repeat"
    ]);
    run(restoreScript, []);
    restoreBooleanPreference(personalizationKey, personalizationSnapshot);
    restoreBooleanPreference(hostProbeDiagnosticsKey, diagnosticsSnapshot);
    restoreBooleanPreference(inlinePreviewKey, inlinePreviewSnapshot);
    restoreBooleanPreference(customCandidatePanelKey, candidatePanelSnapshot);
  }
}

function focusAndClear(realPath) {
  return run("osascript", [
    "-e", "tell application \"TextEdit\" to activate",
    "-e", "tell application \"System Events\" to set frontmost of process \"TextEdit\" to true",
    "-e", "delay 0.25",
    "-e", `tell application "TextEdit" to if (path of front document) is not "${realPath}" then error "Front TextEdit document is not the safety probe file."`,
    "-e", `tell application "TextEdit" to set text of front document to "${documentPrefix}"`,
    "-e", "tell application \"System Events\" to tell process \"TextEdit\" to key code 125 using command down"
  ]);
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
