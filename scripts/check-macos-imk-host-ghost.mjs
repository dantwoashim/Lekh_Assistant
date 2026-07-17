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
const reportPath = join(root, "reports", "macos-imk-host-ghost-smoke.json");
const tempTextEditFile = `/tmp/lekh-native-ghost-smoke-${process.pid}.txt`;
const documentPrefix = "probe ";
const preferencesDomain = "com.lekh.inputmethod.LekhKeyboard";
const personalizationKey = "LekhPersonalizationEnabled";
const inlinePreviewKey = "LekhInlinePreviewEnabled";
const hostProbeDiagnosticsKey = "LekhHostProbeDiagnosticsEnabled";
const preferencesNotification = "com.lekh.inputmethod.preferences.changed";
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

function conclude(status, details = {}, code = 0) {
  result = { status, details, code };
  throw new ProbeFinished(status);
}

function blocked(step, details = {}) {
  failures.push(`Automation was blocked at ${step}.`);
  conclude("blocked-automation", {
    step,
    note: "Ghost proof needs Accessibility and Input Monitoring permission for one fresh PID-targeted TextEdit document.",
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
    .slice(-100);
}

function accessibilityWindowProbe(pid) {
  if (!Number.isInteger(pid)) return { status: 1, rows: [], stderr: "Missing exact IMK process id." };
  const probe = run("swift", ["-e", `
import ApplicationServices
import Foundation

func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
  return value
}

func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String {
  attribute(element, name) as? String ?? ""
}

func findElement(_ element: AXUIElement, identifier: String, depth: Int = 0) -> AXUIElement? {
  guard depth < 12 else { return nil }
  if stringAttribute(element, kAXIdentifierAttribute as CFString) == identifier { return element }
  let children = attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
  for child in children {
    if let match = findElement(child, identifier: identifier, depth: depth + 1) { return match }
  }
  return nil
}

let app = AXUIElementCreateApplication(pid_t(${pid}))
let windows = attribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
var rows: [[String: Any]] = []
for window in windows {
  var size = CGSize.zero
  if let value = attribute(window, kAXSizeAttribute as CFString) {
    let sizeValue = value as! AXValue
    AXValueGetValue(sizeValue, .cgSize, &size)
  }
  let completion = findElement(window, identifier: "lekh.inlineCompletion")
  rows.append([
    "identifier": stringAttribute(window, kAXIdentifierAttribute as CFString),
    "width": Int(size.width.rounded()),
    "height": Int(size.height.rounded()),
    "completionIdentifier": completion.map { stringAttribute($0, kAXIdentifierAttribute as CFString) } ?? "",
    "completionDescription": completion.map { stringAttribute($0, kAXDescriptionAttribute as CFString) } ?? "",
    "completionHelp": completion.map { stringAttribute($0, kAXHelpAttribute as CFString) } ?? "",
    "completionRole": completion.map { stringAttribute($0, kAXRoleAttribute as CFString) } ?? ""
  ])
}
let data = try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
`]);
  let rows = (() => {
    try {
      const parsed = JSON.parse(probe.stdout.trim().split(/\r?\n/).at(-1) ?? "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  return { status: probe.status, rows, stderr: probe.stderr };
}

function writeReport() {
  const finalResult = result ?? { status: "failed", details: { step: "unknown" }, code: 1 };
  mkdirSync(join(root, "reports"), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "npm run probe:macos-imk-host:ghost",
    suite: "macos-imk-host-ghost",
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

try {
  if (process.platform !== "darwin") failed("platform", "Ghost host proof must run on macOS.", { platform: process.platform });
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
    personalization: snapshotBooleanPreference(personalizationKey),
    inlinePreview: snapshotBooleanPreference(inlinePreviewKey),
    diagnostics: snapshotBooleanPreference(hostProbeDiagnosticsKey)
  };
  const preferenceWrites = [
    setBooleanPreference(personalizationKey, false),
    setBooleanPreference(inlinePreviewKey, true),
    setBooleanPreference(hostProbeDiagnosticsKey, true)
  ];
  if (preferenceWrites.some((write) => write.status !== 0)) {
    failed("prepare-test-preferences", "Could not isolate personalization and inline-preview preferences for the ghost probe.");
  }

  writeFileSync(tempTextEditFile, documentPrefix);
  realTempTextEditFile = realpathSync(tempTextEditFile);
  bundleIdentity = installedBundleIdentity(appBundle);
  const priorHealth = readRuntimeHealth(runtimeHealthPath);

  // The source is selected before the fresh process creates NSTextInputContext.
  // This prevents an ABC/PressAndHold context from surviving a later TIS switch.
  const select = run("swift", [registerScript, appBundle, "--select-only"]);
  const selectedSource = currentInputSource();
  if (select.status !== 0 || selectedSource.id !== lekhInputSourceId) {
    failed("select-before-host-launch", "Could not select the installed Lekh .Main source before launching TextEdit.", {
      selectStatus: select.status,
      selectStdout: select.stdout,
      selectStderr: select.stderr,
      selectedSource
    });
  }

  const coldLaunch = launchColdTextEdit(realTempTextEditFile);
  coldTextEditPid = coldLaunch.pid;
  coldTextEditIdentity = coldLaunch;
  if (coldLaunch.status !== 0 || !Number.isInteger(coldTextEditPid)) blocked("launch-fresh-textedit", coldLaunch);

  const prepared = prepareExactTextEdit(coldTextEditPid, realTempTextEditFile, documentPrefix);
  if (prepared.status !== 0 || prepared.snapshot?.text !== documentPrefix) {
    blocked("prepare-exact-textedit-document", prepared);
  }
  if (currentInputSource().id !== lekhInputSourceId) {
    failed("source-changed-before-runtime", "The selected source changed while the cold TextEdit input context was being created.");
  }

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
  const runtimePid = runtime.record.processIdentifier;

  const prefixPost = run("swift", ["-e", targetedKeyPostingSource([37, 14, 40, 4], coldTextEditPid)]);
  if (prefixPost.status !== 0) blocked("post-prefix", { stdout: prefixPost.stdout, stderr: prefixPost.stderr });
  wait(120);

  const compositionRead = readExactTextEdit(coldTextEditPid, realTempTextEditFile);
  const compositionDocumentText = compositionRead.snapshot?.text ?? "";
  const compositionText = compositionDocumentText.startsWith(documentPrefix)
    ? compositionDocumentText.slice(documentPrefix.length)
    : compositionDocumentText;
  const windows = run("swift", ["-e", windowProbeSource(runtimePid)]);
  const bounds = windows.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("x").map(Number))
    .filter(([width, height]) => Number.isFinite(width) && Number.isFinite(height));
  const accessibilityWindows = accessibilityWindowProbe(runtimePid);
  const surfaceDiagnostics = readSurfaceDiagnostics(runtimePid);
  const hasExactInlineWindow = accessibilityWindows.rows.some((row) =>
    row.identifier === "lekh.inlineCompletionPanel" &&
    row.completionIdentifier === "lekh.inlineCompletion" &&
    row.completionRole === "AXStaticText" &&
    row.completionDescription.includes("हरू") &&
    row.completionHelp.length > 0
  );
  const loggedVisibleGhost = surfaceDiagnostics.some((line) =>
    line.includes("surface.result ghost=1")
  );
  if (compositionText !== "लेख" || !hasExactInlineWindow || !loggedVisibleGhost) {
    failed("assert-ghost-window", "No exact Lekh suffix-only ghost window was proven after composing lekh.", {
      compositionText,
      textEditPid: coldTextEditPid,
      inputMethodPid: runtimePid,
      windowBounds: bounds,
      windowProbeStderr: windows.stderr,
      accessibilityWindows,
      surfaceDiagnostics
    });
  }

  const beforeAcceptance = readExactTextEdit(coldTextEditPid, realTempTextEditFile);
  const sourceBeforeAcceptance = currentInputSource();
  if (
    beforeAcceptance.status !== 0 ||
    beforeAcceptance.snapshot?.frontmostPid !== coldTextEditPid ||
    sourceBeforeAcceptance.id !== lekhInputSourceId
  ) {
    failed("preflight-targeted-acceptance", "Focus, document identity or input source changed while the ghost was visible.", {
      sourceBeforeAcceptance,
      accessibility: beforeAcceptance.snapshot
    });
  }

  const acceptPost = run("swift", ["-e", targetedKeyPostingSource([48], coldTextEditPid)]);
  if (acceptPost.status !== 0) blocked("post-targeted-acceptance", { stdout: acceptPost.stdout, stderr: acceptPost.stderr });
  wait(700);
  const acceptedRead = readExactTextEdit(coldTextEditPid, realTempTextEditFile);
  const documentText = acceptedRead.snapshot?.text ?? "";
  const actual = documentText.startsWith(documentPrefix)
    ? documentText.slice(documentPrefix.length)
    : documentText;
  const rawABCObserved = /^[\x00-\x7F]*$/.test(actual);
  if (acceptedRead.status !== 0 || actual !== "लेखहरू" || actual.includes("\t") || rawABCObserved) {
    failed("assert-tab-acceptance", `Tab did not explicitly accept the visible ghost completion; observed ${JSON.stringify(actual)}.`, {
      actual,
      rawABCObserved,
      accessibility: acceptedRead.snapshot,
      windowBounds: bounds
    });
  }

  conclude("passed", {
    typedPrefix: "lekh",
    acceptedText: actual,
    rawABCObserved: false,
    exactInstalledRuntimeVerified: true,
    runtimeLaunchMode: "tis-before-cold-host",
    productionLifecycleEvidence: true,
    eventDelivery: "CGEvent.postToPid",
    textEditPid: coldTextEditPid,
    inputMethodPid: runtimePid,
    priorTextEditPids: coldLaunch.priorPids,
    windowBounds: bounds,
    accessibilityWindows: accessibilityWindows.rows,
    personalizationIsolated: true,
    surfaceDiagnostics,
    note: "A fresh exact TextEdit PID activated the installed IMK build, showed a suffix-only window, and accepted it with Tab without inserting a tab character."
  }, 0);
} catch (error) {
  if (!(error instanceof ProbeFinished)) throw error;
} finally {
  const cleanupFailures = [];
  if (Number.isInteger(coldTextEditPid)) {
    const termination = terminateColdTextEdit(coldTextEditIdentity);
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
    restoreBooleanPreference(inlinePreviewKey, preferenceSnapshots.inlinePreview);
    restoreBooleanPreference(hostProbeDiagnosticsKey, preferenceSnapshots.diagnostics);
  }
  if (realTempTextEditFile) removeProbeFile(tempTextEditFile);
  if (cleanupFailures.length > 0) {
    failures.push(...cleanupFailures);
    result = { status: "failed", details: { ...(result?.details ?? {}), cleanupFailures }, code: 1 };
  }
  writeReport();
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

function windowProbeSource(inputMethodPid) {
  return `
import CoreGraphics
import Foundation
let inputMethodPid = Int32(${inputMethodPid})
let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for row in rows {
  guard let ownerPid = row[kCGWindowOwnerPID as String] as? NSNumber,
        ownerPid.int32Value == inputMethodPid,
        let bounds = row[kCGWindowBounds as String] as? [String: Any],
        let width = bounds["Width"] as? NSNumber,
        let height = bounds["Height"] as? NSNumber else { continue }
  print("\\(width.intValue)x\\(height.intValue)")
}`;
}
