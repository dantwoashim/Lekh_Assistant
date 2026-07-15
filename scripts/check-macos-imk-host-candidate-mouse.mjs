#!/usr/bin/env node
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  consoleSessionPrecondition,
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
const reportPath = join(root, "reports", "macos-imk-host-candidate-mouse.json");
const tempTextEditFile = `/tmp/lekh-native-candidate-mouse-${process.pid}.txt`;
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
    note: "The candidate mouse proof needs Accessibility and Input Monitoring permission for exact AX geometry and CGEvent delivery.",
    ...details
  }, 2);
}

function failed(step, message, details = {}) {
  failures.push(message);
  conclude("failed", { step, ...details }, 1);
}

function snapshotPreference(key) {
  const value = run("defaults", ["read", preferencesDomain, key]);
  return { existed: value.status === 0, value: value.stdout.trim() };
}

function writeBooleanPreference(key, enabled) {
  return run("defaults", ["write", preferencesDomain, key, "-bool", enabled ? "true" : "false"]);
}

function writeStringPreference(key, value) {
  return run("defaults", ["write", preferencesDomain, key, "-string", value]);
}

function restorePreference(key, snapshot, type) {
  if (!snapshot.existed) {
    run("defaults", ["delete", preferencesDomain, key]);
  } else if (type === "bool") {
    run("defaults", ["write", preferencesDomain, key, "-bool", /^(1|true|yes)$/i.test(snapshot.value) ? "true" : "false"]);
  } else {
    run("defaults", ["write", preferencesDomain, key, "-string", snapshot.value]);
  }
}

function notifyPreferencesChanged() {
  run("notifyutil", ["-p", preferencesNotification]);
}

function writeReport() {
  const finalResult = result ?? { status: "failed", details: { step: "unknown" }, code: 1 };
  mkdirSync(join(root, "reports"), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "npm run probe:macos-imk-host:candidate-mouse",
    suite: "macos-imk-host-candidate-mouse",
    durationMs: Math.round(performance.now() - startedAt),
    status: finalResult.status,
    appBundle,
    failures,
    bundleIdentity,
    runtimeHealth: runtimeEvidence,
    ...finalResult.details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console[finalResult.code === 0 ? "log" : finalResult.code === 2 ? "warn" : "error"](JSON.stringify(report, null, 2));
  process.exitCode = finalResult.code;
}

function postTextEditKeys(keyCodes, targetPid) {
  return run("swift", ["-e", targetedKeyPostingSource(keyCodes, targetPid)]);
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

function composeAndOpenChoices(inputMethodPid, step) {
  const prepared = prepareExactTextEdit(coldTextEditPid, realTempTextEditFile, documentPrefix);
  if (prepared.status !== 0 || prepared.snapshot?.text !== documentPrefix) blocked(`${step}-prepare-document`, prepared);
  if (currentInputSource().id !== lekhInputSourceId) {
    failed(`${step}-source`, "The exact Lekh source was not current before composing candidates.");
  }
  const typing = postTextEditKeys([35, 0, 45, 34, 125], coldTextEditPid);
  if (typing.status !== 0) blocked(`${step}-post-token-and-down`, { stdout: typing.stdout, stderr: typing.stderr });
  wait(250);
  const surface = waitForCandidateSurface(inputMethodPid);
  const validated = validateCandidateSurface(surface, `${step}-candidate-surface`);
  const composition = readExactTextEdit(coldTextEditPid, realTempTextEditFile);
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
  return {
    composition: composition.snapshot,
    visibleCompositionText: actual,
    surface: surface.surface,
    ...validated
  };
}

if (process.env.LEKH_CANDIDATE_MOUSE_COMPILE_ONLY === "1") {
  const sources = [
    { name: "candidate-surface", source: candidateSurfaceSource(1) },
    {
      name: "mouse-gesture",
      source: mouseGestureSource({
        inputMethodPid: 1,
        textEditPid: 1,
        start: { x: 10, y: 10 },
        end: { x: 20, y: 20 },
        drag: true
      })
    },
    { name: "targeted-keys", source: targetedKeyPostingSource([35, 0, 45, 34, 125], 1) }
  ];
  const checks = sources.map(({ name, source }) => {
    const compilation = run("/usr/bin/swiftc", ["-typecheck", "-"], { input: source });
    return { name, status: compilation.status, stdout: compilation.stdout, stderr: compilation.stderr };
  });
  console.log(JSON.stringify({ status: checks.every((check) => check.status === 0) ? "passed" : "failed", checks }, null, 2));
  process.exit(checks.every((check) => check.status === 0) ? 0 : 1);
}

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

  previousInputSource = currentInputSource();
  if (previousInputSource.status !== 0 || !previousInputSource.id) {
    failed("snapshot-input-source", "Could not snapshot the user's exact current input source.", previousInputSource);
  }
  preferenceSnapshots = {
    personalization: snapshotPreference(preferenceKeys.personalization),
    diagnostics: snapshotPreference(preferenceKeys.diagnostics),
    inlinePreview: snapshotPreference(preferenceKeys.inlinePreview),
    customCandidatePanel: snapshotPreference(preferenceKeys.customCandidatePanel),
    nativeMode: snapshotPreference(preferenceKeys.nativeMode),
    nativeModeChosen: snapshotPreference(preferenceKeys.nativeModeChosen)
  };
  const preferenceWrites = [
    writeBooleanPreference(preferenceKeys.personalization, false),
    writeBooleanPreference(preferenceKeys.diagnostics, true),
    writeBooleanPreference(preferenceKeys.inlinePreview, false),
    writeBooleanPreference(preferenceKeys.customCandidatePanel, true),
    writeStringPreference(preferenceKeys.nativeMode, "romanized-traditional"),
    writeBooleanPreference(preferenceKeys.nativeModeChosen, true)
  ];
  if (preferenceWrites.some((write) => write.status !== 0)) {
    failed("prepare-test-preferences", "Could not isolate the candidate-panel probe preferences.");
  }
  notifyPreferencesChanged();

  writeFileSync(tempTextEditFile, documentPrefix);
  realTempTextEditFile = realpathSync(tempTextEditFile);
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

  const coldLaunch = launchColdTextEdit(realTempTextEditFile);
  coldTextEditPid = coldLaunch.pid;
  if (coldLaunch.status !== 0 || !Number.isInteger(coldTextEditPid)) blocked("launch-fresh-textedit", coldLaunch);

  const initialDocument = prepareExactTextEdit(coldTextEditPid, realTempTextEditFile, documentPrefix);
  if (initialDocument.status !== 0) blocked("prepare-exact-textedit", initialDocument);
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

  const dragChoices = composeAndOpenChoices(inputMethodPid, "drag-away");
  const dragStart = center(dragChoices.second.frame);
  const dragEnd = center(dragChoices.first.frame);
  const drag = postMouseGesture({
    inputMethodPid,
    textEditPid: coldTextEditPid,
    start: dragStart,
    end: dragEnd,
    drag: true
  });
  if (drag.status !== 0) blocked("drag-away-mouse-events", drag);
  wait(350);
  const afterDrag = readExactTextEdit(coldTextEditPid, realTempTextEditFile);
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

  // End the first composition without committing a candidate. Two Escapes are
  // the controller's explicit revert-then-dismiss contract.
  const dismiss = postTextEditKeys([53, 53], coldTextEditPid);
  if (dismiss.status !== 0) blocked("dismiss-after-drag-away", { stdout: dismiss.stdout, stderr: dismiss.stderr });
  wait(250);

  const clickChoices = composeAndOpenChoices(inputMethodPid, "non-first-click");
  if (clickChoices.secondText !== dragChoices.secondText) {
    failed("candidate-order-stability", "The non-first candidate changed between drag-away and click trials.", {
      dragSecond: dragChoices.secondText,
      clickSecond: clickChoices.secondText
    });
  }
  const clickPoint = center(clickChoices.second.frame);
  const click = postMouseGesture({
    inputMethodPid,
    textEditPid: coldTextEditPid,
    start: clickPoint,
    end: clickPoint,
    drag: false
  });
  if (click.status !== 0) blocked("non-first-mouse-click", click);
  wait(550);

  const accepted = readExactTextEdit(coldTextEditPid, realTempTextEditFile);
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

  conclude("passed", {
    token,
    exactInstalledRuntimeVerified: true,
    textEditPid: coldTextEditPid,
    inputMethodPid,
    eventDelivery: "CGEvent mouse events through cghidEventTap after exact topmost-window ownership check",
    candidatePanelIdentifier: "lekh.candidatePanel",
    candidateCount: clickChoices.window.rows.filter((row) => row.identifier.startsWith("lekh.candidate.")).length,
    firstCandidate: clickChoices.firstText,
    acceptedNonFirstCandidate: acceptedText,
    dragAway: {
      startCandidate: dragChoices.secondText,
      releaseCandidate: dragChoices.firstText,
      observedText: afterDragText,
      candidatePanelRemainedVisible: true,
      mouseEvidence: drag.evidence
    },
    click: {
      point: clickPoint,
      exactText: acceptedText,
      noCandidateRowsAfterCommit: true,
      frontmostTextEditPreserved: true,
      mouseEvidence: click.evidence
    },
    coldHostLaunch: true,
    priorTextEditPids: coldLaunch.priorPids,
    noStrayInputEvidence: `Document suffix equals exactly ${JSON.stringify(acceptedText)}; no extra click target, character, tab or newline was observed.`,
    note: "The exact custom panel exposed two AXButton rows; a drag-away did not commit, and a guarded real mouse down/up committed row 2 while TextEdit retained focus."
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
    restorePreference(preferenceKeys.personalization, preferenceSnapshots.personalization, "bool");
    restorePreference(preferenceKeys.diagnostics, preferenceSnapshots.diagnostics, "bool");
    restorePreference(preferenceKeys.inlinePreview, preferenceSnapshots.inlinePreview, "bool");
    restorePreference(preferenceKeys.customCandidatePanel, preferenceSnapshots.customCandidatePanel, "bool");
    restorePreference(preferenceKeys.nativeMode, preferenceSnapshots.nativeMode, "string");
    restorePreference(preferenceKeys.nativeModeChosen, preferenceSnapshots.nativeModeChosen, "bool");
    notifyPreferencesChanged();
  }
  if (realTempTextEditFile) removeProbeFile(tempTextEditFile);
  if (cleanupFailures.length > 0) {
    failures.push(...cleanupFailures);
    result = { status: "failed", details: { ...(result?.details ?? {}), cleanupFailures }, code: 1 };
  }
  writeReport();
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

function postMouseGesture({ inputMethodPid, textEditPid, start, end, drag }) {
  const probe = run("swift", ["-e", mouseGestureSource({ inputMethodPid, textEditPid, start, end, drag })]);
  const line = probe.stdout.trim().split(/\r?\n/).at(-1) ?? "";
  let evidence = null;
  try {
    evidence = JSON.parse(line);
  } catch {
    // Preserve compiler/event diagnostics below.
  }
  const valid = probe.status === 0 &&
    evidence?.exactWindowOwnerPreflight === true &&
    evidence?.frontmostTextEditPreflight === true &&
    evidence?.pointerRestored === true &&
    evidence?.gesture === (drag ? "drag-away" : "click");
  return {
    status: valid ? 0 : probe.status || 3,
    evidence,
    stdout: probe.stdout,
    stderr: probe.stderr
  };
}

function targetedKeyPostingSource(keyCodes, targetPid) {
  const rows = keyCodes.map((code) => `(code: ${code}, flags: [])`).join(",\n  ");
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

function mouseGestureSource({ inputMethodPid, textEditPid, start, end, drag }) {
  return `
import AppKit
import Carbon
import CoreGraphics
import Foundation

let inputMethodPid = pid_t(${inputMethodPid})
let textEditPid = pid_t(${textEditPid})
let startPoint = CGPoint(x: ${start.x}, y: ${start.y})
let endPoint = CGPoint(x: ${end.x}, y: ${end.y})
let shouldDrag = ${drag ? "true" : "false"}

func currentInputSourceID() -> String {
  let source = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
  return TISGetInputSourceProperty(source, kTISPropertyInputSourceID)
    .map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? ""
}

let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
func topmostWindow(at point: CGPoint) -> (pid: pid_t, windowID: Int, bounds: CGRect)? {
  for row in rows {
    guard let owner = row[kCGWindowOwnerPID as String] as? NSNumber,
          let windowNumber = row[kCGWindowNumber as String] as? NSNumber,
          let boundsDictionary = row[kCGWindowBounds as String] as? [String: Any],
          let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary),
          bounds.contains(point) else { continue }
    return (pid_t(owner.int32Value), windowNumber.intValue, bounds)
  }
  return nil
}

guard NSWorkspace.shared.frontmostApplication?.processIdentifier == textEditPid else {
  fputs("The exact probe TextEdit PID is not frontmost.\\n", stderr)
  exit(10)
}
guard currentInputSourceID() == "${lekhInputSourceId}" else {
  fputs("The exact Lekh source is not current.\\n", stderr)
  exit(11)
}
guard let startWindow = topmostWindow(at: startPoint),
      let endWindow = topmostWindow(at: endPoint),
      startWindow.pid == inputMethodPid,
      endWindow.pid == inputMethodPid,
      startWindow.windowID == endWindow.windowID else {
  fputs("Candidate gesture points are not topmost inside one exact IMK window.\\n", stderr)
  exit(12)
}

let source = CGEventSource(stateID: .hidSystemState)
guard let originalPointer = CGEvent(source: nil)?.location else { exit(13) }
defer { CGWarpMouseCursorPosition(originalPointer) }

func post(_ type: CGEventType, at point: CGPoint) {
  let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
  event?.post(tap: .cghidEventTap)
  usleep(70_000)
}

post(.mouseMoved, at: startPoint)
post(.leftMouseDown, at: startPoint)
if shouldDrag { post(.leftMouseDragged, at: endPoint) }
post(.leftMouseUp, at: endPoint)
CGWarpMouseCursorPosition(originalPointer)
usleep(80_000)
let restoredPointer = CGEvent(source: nil)?.location ?? CGPoint(x: CGFloat.infinity, y: CGFloat.infinity)
let pointerRestored = abs(restoredPointer.x - originalPointer.x) <= 2 && abs(restoredPointer.y - originalPointer.y) <= 2

let output: [String: Any] = [
  "gesture": shouldDrag ? "drag-away" : "click",
  "exactWindowOwnerPreflight": true,
  "frontmostTextEditPreflight": true,
  "inputSourcePreflight": true,
  "windowNumber": startWindow.windowID,
  "windowBounds": ["x": startWindow.bounds.origin.x, "y": startWindow.bounds.origin.y, "width": startWindow.bounds.width, "height": startWindow.bounds.height],
  "start": ["x": startPoint.x, "y": startPoint.y],
  "end": ["x": endPoint.x, "y": endPoint.y],
  "originalPointer": ["x": originalPointer.x, "y": originalPointer.y],
  "restoredPointer": ["x": restoredPointer.x, "y": restoredPointer.y],
  "pointerRestored": pointerRestored
]
let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
if !pointerRestored { exit(14) }
`;
}
