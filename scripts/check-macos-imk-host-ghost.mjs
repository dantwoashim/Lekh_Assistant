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
const reportPath = join(root, "reports", "macos-imk-host-ghost-smoke.json");
const tempTextEditFile = `/tmp/lekh-native-ghost-smoke-${process.pid}.txt`;
const documentPrefix = "probe ";
const preferencesDomain = "com.lekh.inputmethod.LekhKeyboard";
const personalizationKey = "LekhPersonalizationEnabled";
const inlinePreviewKey = "LekhInlinePreviewEnabled";
const hostProbeDiagnosticsKey = "LekhHostProbeDiagnosticsEnabled";
const preferencesNotification = "com.lekh.inputmethod.preferences.changed";
const allowDevPrelaunch = process.env.LEKH_HOST_PROBE_ALLOW_DEV_PRELAUNCH === "1";
const failures = [];

class ProbeFinished extends Error {}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function inputMethodPids() {
  const result = run("pgrep", ["-x", "LekhInputMethodApp"]);
  return result.stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter(Number.isInteger);
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

function installedBundleIdentity() {
  const plist = join(appBundle, "Contents", "Info.plist");
  const executable = join(appBundle, "Contents", "MacOS", "LekhInputMethodApp");
  const plistValue = (key) => run("plutil", ["-extract", key, "raw", "-o", "-", plist]).stdout.trim();
  const digest = run("shasum", ["-a", "256", executable]).stdout.trim().split(/\s+/)[0] ?? "";
  const signature = run("codesign", ["-dvvv", executable]);
  return {
    bundlePath: existsSync(appBundle) ? realpathSync(appBundle) : appBundle,
    bundleIdentifier: plistValue("CFBundleIdentifier"),
    shortVersion: plistValue("CFBundleShortVersionString"),
    buildVersion: plistValue("CFBundleVersion"),
    connectionName: plistValue("InputMethodConnectionName"),
    executableSha256: digest,
    codeDirectoryHash: /CDHash=([^\s]+)/.exec(signature.stderr)?.[1] ?? "",
    architecture: run("uname", ["-m"]).stdout.trim(),
    macOS: run("sw_vers", ["-productVersion"]).stdout.trim()
  };
}

function waitForInputMethodPid(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = inputMethodPids();
    if (pids.length > 0) return pids.at(-1);
    wait(125);
  }
  return null;
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

function writeReport(status, details = {}) {
  mkdirSync(join(root, "reports"), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "npm run probe:macos-imk-host:ghost",
    suite: "macos-imk-host-ghost",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    appBundle,
    failures,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function closeProbeDocument() {
  run("osascript", [
    "-e", `tell application "TextEdit" to repeat with d in documents`,
    "-e", `try`,
    "-e", `if (path of d) is "${realpathSync(tempTextEditFile)}" then close d saving no`,
    "-e", `end try`,
    "-e", `end repeat`
  ]);
}

function focusAndPrepare(realPath) {
  return run("osascript", [
    "-e", "tell application \"TextEdit\" to activate",
    "-e", "tell application \"System Events\" to set frontmost of process \"TextEdit\" to true",
    "-e", "delay 0.25",
    "-e", `tell application "TextEdit" to if (path of front document) is not "${realPath}" then error "Front TextEdit document is not the ghost probe file."`,
    "-e", `tell application "TextEdit" to set text of front document to "${documentPrefix}"`,
    "-e", "tell application \"System Events\" to tell process \"TextEdit\" to key code 125 using command down"
  ]);
}

function currentInputSourceId() {
  const result = run("swift", ["-e", `
import Carbon
import Foundation
let source = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
if let pointer = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) {
  print(Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue() as String)
}`]);
  return { status: result.status, value: result.stdout.trim(), stderr: result.stderr };
}

function frontmostApplicationName() {
  const result = run("osascript", [
    "-e", "tell application \"System Events\" to get name of first application process whose frontmost is true"
  ]);
  return { status: result.status, value: result.stdout.trim(), stderr: result.stderr };
}

function ensureFocusedLekh(realPath) {
  const expectedIds = new Set([
    "com.lekh.inputmethod.LekhKeyboard.Main",
    "com.lekh.inputmethod.LekhKeyboard"
  ]);
  const attempts = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const focus = focusAndPrepare(realPath);
    const select = focus.status === 0
      ? run("swift", [registerScript, appBundle, "--select-only"])
      : { status: 1, stdout: "", stderr: focus.stderr };
    wait(200);
    let source = currentInputSourceId();
    let frontmost = frontmostApplicationName();
    let recoveredFocus = false;
    if (select.status === 0 && frontmost.value !== "TextEdit") {
      const recover = run("osascript", [
        "-e", "tell application \"System Events\" to if exists process \"System Settings\" then set visible of process \"System Settings\" to false",
        "-e", "tell application \"TextEdit\" to activate",
        "-e", "tell application \"System Events\" to set frontmost of process \"TextEdit\" to true",
        "-e", "delay 0.25"
      ]);
      recoveredFocus = recover.status === 0;
      wait(150);
      source = currentInputSourceId();
      frontmost = frontmostApplicationName();
    }
    const state = {
      attempt,
      focusStatus: focus.status,
      selectStatus: select.status,
      recoveredFocus,
      inputSourceId: source.value,
      frontmostApplication: frontmost.value
    };
    attempts.push(state);
    if (focus.status === 0 &&
        select.status === 0 &&
        expectedIds.has(source.value) &&
        frontmost.value === "TextEdit") {
      return { ready: true, attempts };
    }
    wait(250);
  }
  return { ready: false, attempts };
}

function readSurfaceDiagnostics(pid = null) {
  const result = run("log", [
    "show", "--last", "2m", "--style", "compact",
    "--predicate", 'subsystem == "com.lekh.inputmethod.keyboard" AND category == "imk"'
  ]);
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.includes("surface.") && (!Number.isInteger(pid) || line.includes(`LekhInputMethodApp[${pid}:`)))
    .slice(-80);
}

function accessibilityWindowProbe(pid) {
  if (!Number.isInteger(pid)) return { status: 1, rows: [], stderr: "Missing IMK process id." };
  const result = run("osascript", [
    "-e", "tell application \"System Events\"",
    "-e", `set targetProcess to first application process whose unix id is ${pid}`,
    "-e", "set outputRows to {}",
    "-e", "repeat with targetWindow in windows of targetProcess",
    "-e", "set windowSize to size of targetWindow",
    "-e", "set windowIdentifier to \"\"",
    "-e", "try",
    "-e", "set windowIdentifier to value of attribute \"AXIdentifier\" of targetWindow as text",
    "-e", "end try",
    "-e", "set end of outputRows to windowIdentifier & \"|\" & (item 1 of windowSize as text) & \"x\" & (item 2 of windowSize as text)",
    "-e", "end repeat",
    "-e", "set AppleScript's text item delimiters to linefeed",
    "-e", "return outputRows as text",
    "-e", "end tell"
  ]);
  const rows = result.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [identifier, dimensions = ""] = line.split("|");
      const [width, height] = dimensions.split("x").map(Number);
      return { identifier, width, height };
    });
  return { status: result.status, rows, stderr: result.stderr };
}

function finishFailure(step, details = {}) {
  const report = writeReport("blocked-automation", {
    step,
    ...details,
    bundleIdentity: installedBundleIdentity(),
    note: "Ghost host proof needs TextEdit automation plus Accessibility permission for targeted event posting."
  });
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 2;
  throw new ProbeFinished(step);
}

if (process.platform !== "darwin") {
  failures.push("Ghost host proof must run on macOS.");
  const report = writeReport("failed", { platform: process.platform });
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

if (!existsSync(appBundle)) failures.push("Installed Lekh Keyboard bundle is missing.");
if (!existsSync(registerScript)) failures.push("register-dev.swift is missing.");
if (!existsSync(restoreScript)) failures.push("restore-system-keyboard.sh is missing.");
if (failures.length > 0) {
  const report = writeReport("failed");
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

run(restoreScript, []);
writeFileSync(tempTextEditFile, "");
const realTempTextEditFile = realpathSync(tempTextEditFile);
const personalizationSnapshot = snapshotBooleanPreference(personalizationKey);
const inlinePreviewSnapshot = snapshotBooleanPreference(inlinePreviewKey);
const diagnosticsSnapshot = snapshotBooleanPreference(hostProbeDiagnosticsKey);

try {
  const disableLearning = setBooleanPreference(personalizationKey, false);
  const enablePreview = setBooleanPreference(inlinePreviewKey, true);
  const enableDiagnostics = setBooleanPreference(hostProbeDiagnosticsKey, true);
  if (disableLearning.status !== 0 || enablePreview.status !== 0 || enableDiagnostics.status !== 0) {
    failures.push("Could not isolate personalization and inline-preview preferences for the ghost probe.");
    finishFailure("prepare-test-preferences", {
      personalizationStderr: disableLearning.stderr,
      previewStderr: enablePreview.stderr,
      diagnosticsStderr: enableDiagnostics.stderr
    });
  }
  run("open", ["-a", "TextEdit", tempTextEditFile]);
  wait(900);
  const prep = focusAndPrepare(realTempTextEditFile);
  if (prep.status !== 0) {
    finishFailure("prepare-textedit", { stdout: prep.stdout, stderr: prep.stderr });
  } else {
    // Never launch an input method as a normal application. TIS selection must
    // ask imklaunchagent to create the server process and publish its endpoint.
    const select = run("swift", [registerScript, appBundle, "--select-only"]);
    if (select.status !== 0) {
      failures.push("Could not select the installed Lekh input source.");
      finishFailure("select-input-source", { stdout: select.stdout, stderr: select.stderr });
    } else {
      // Never terminate an input method as part of a routine smoke test. IMK
      // counts repeated deaths and can deliberately suppress relaunch, which
      // made the old probe damage the very lifecycle it was trying to verify.
      let runtimeLaunchMode = "tis";
      let runtimePid = waitForInputMethodPid(8_000);
      if (!Number.isInteger(runtimePid) && allowDevPrelaunch) {
        runtimeLaunchMode = "development-prelaunch";
        run("open", ["-gj", appBundle]);
        runtimePid = waitForInputMethodPid(8_000);
        if (Number.isInteger(runtimePid)) {
          // Re-select only after the endpoint exists so TextEdit binds to this
          // exact development process. This mode is never production evidence.
          focusAndPrepare(realTempTextEditFile);
          run("swift", [registerScript, appBundle, "--select-only"]);
        }
      }
      if (!Number.isInteger(runtimePid)) {
        failures.push("The selected input source did not start an IMK server process.");
        finishFailure("wait-for-imk-runtime", {
          allowDevPrelaunch,
          note: "A Developer ID signed/notarized build must launch through TIS. Set LEKH_HOST_PROBE_ALLOW_DEV_PRELAUNCH=1 only for explicitly labeled local development diagnosis."
        });
      } else {
        wait(500);
        const focusedContext = ensureFocusedLekh(realTempTextEditFile);
        if (!focusedContext.ready) {
        failures.push("TextEdit and the selected Lekh source never became ready together.");
        finishFailure("focus-and-source-readiness", { attempts: focusedContext.attempts });
      } else {
        const targetTextEditPid = textEditPid();
        const beforePostSource = currentInputSourceId();
        const beforePostFrontmost = frontmostApplicationName();
        if (!Number.isInteger(targetTextEditPid) ||
            beforePostFrontmost.value !== "TextEdit" ||
            beforePostSource.value !== "com.lekh.inputmethod.LekhKeyboard.Main") {
          failures.push("TextEdit focus or the exact Lekh child source changed before the typing event.");
          finishFailure("preflight-targeted-post", {
            targetTextEditPid,
            inputSourceId: beforePostSource.value,
            frontmostApplication: beforePostFrontmost.value
          });
        }
        const prefixPost = run("swift", ["-e", targetedKeyPostingSource([37, 14, 40, 4], targetTextEditPid)]);
        if (prefixPost.status !== 0) {
          finishFailure("post-prefix", { stdout: prefixPost.stdout, stderr: prefixPost.stderr });
        } else {
          // Query shortly after the final key-up. The event poster itself has
          // already waited 65 ms; this samples the surface at ~185 ms while
          // remaining within the bounded 216 ms anchor retry window.
          wait(120);
          const compositionRead = run("osascript", [
            "-e", `tell application "TextEdit" to get text of front document`
          ]);
          const compositionDocumentText = compositionRead.stdout.replace(/\r?\n$/, "");
          const compositionText = compositionDocumentText.startsWith(documentPrefix)
            ? compositionDocumentText.slice(documentPrefix.length)
            : compositionDocumentText;
          const runtimePids = inputMethodPids();
          const windows = run("swift", ["-e", windowProbeSource(runtimePids)]);
          const bounds = windows.stdout
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => line.split("x").map(Number))
            .filter(([width, height]) => Number.isFinite(width) && Number.isFinite(height));
          const accessibilityWindows = accessibilityWindowProbe(runtimePid);
          const surfaceDiagnostics = readSurfaceDiagnostics(runtimePid);
          const hasExactInlineWindow = accessibilityWindows.rows.some((row) =>
            row.identifier === "lekh.inlineCompletionPanel"
          );
          const loggedVisibleGhost = surfaceDiagnostics.some((line) =>
            line.includes("surface.result ghost=1")
          );
          if (!hasExactInlineWindow || !loggedVisibleGhost) {
            failures.push("No small on-screen Lekh ghost window was present after composing lekh.");
            finishFailure("assert-ghost-window", {
              compositionText,
              focusedContext,
              runtimeLaunchMode,
              inputMethodPids: runtimePids,
              windowBounds: bounds,
              windowProbeStderr: windows.stderr,
              accessibilityWindows,
              surfaceDiagnostics
            });
          } else {
            const acceptFrontmost = frontmostApplicationName();
            const acceptSource = currentInputSourceId();
            if (acceptFrontmost.value !== "TextEdit" ||
                acceptSource.value !== "com.lekh.inputmethod.LekhKeyboard.Main") {
              failures.push("Focus or input source changed while the ghost was visible; acceptance was not attempted.");
              finishFailure("preflight-targeted-acceptance", {
                frontmostApplication: acceptFrontmost.value,
                inputSourceId: acceptSource.value,
                accessibilityWindows,
                surfaceDiagnostics
              });
            }
            const acceptPost = run("swift", ["-e", targetedKeyPostingSource([48], targetTextEditPid)]);
            if (acceptPost.status !== 0) {
              failures.push("Could not post the Tab acceptance event directly to the proven TextEdit process.");
              finishFailure("post-targeted-acceptance", { stdout: acceptPost.stdout, stderr: acceptPost.stderr });
            }
            wait(700);
            const read = run("osascript", [
              "-e", `tell application "TextEdit" to if (path of front document) is not "${realTempTextEditFile}" then error "Front TextEdit document changed before ghost read."`,
              "-e", 'tell application "TextEdit" to get text of front document'
            ]);
            const documentText = read.stdout.replace(/\r?\n$/, "");
            const actual = documentText.startsWith(documentPrefix)
              ? documentText.slice(documentPrefix.length)
              : documentText;
            if (read.status !== 0 || actual !== "लेखहरू" || actual.includes("\t")) {
              failures.push(`Tab did not explicitly accept the visible ghost completion; observed ${JSON.stringify(actual)}.`);
              finishFailure("assert-tab-acceptance", { actual, stdout: read.stdout, stderr: read.stderr, windowBounds: bounds });
            } else {
              const report = writeReport("passed", {
                typedPrefix: "lekh",
                acceptedText: actual,
                focusedContext,
                runtimeLaunchMode,
                productionLifecycleEvidence: runtimeLaunchMode === "tis",
                eventDelivery: "CGEvent.postToPid",
                textEditPid: targetTextEditPid,
                bundleIdentity: installedBundleIdentity(),
                inputMethodPids: runtimePids,
                windowBounds: bounds,
                accessibilityWindows: accessibilityWindows.rows,
                personalizationIsolated: true,
                surfaceDiagnostics,
                note: "HID-level TextEdit proof found the separate ghost window and accepted it with Tab without inserting a tab character or modifying personal learning."
              });
              console.log(JSON.stringify({ status: "passed", report: "reports/macos-imk-host-ghost-smoke.json", acceptedText: actual }, null, 2));
            }
          }
        }
        }
      }
    }
  }
} catch (error) {
  if (!(error instanceof ProbeFinished)) throw error;
} finally {
  closeProbeDocument();
  run(restoreScript, []);
  restoreBooleanPreference(personalizationKey, personalizationSnapshot);
  restoreBooleanPreference(inlinePreviewKey, inlinePreviewSnapshot);
  restoreBooleanPreference(hostProbeDiagnosticsKey, diagnosticsSnapshot);
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

function windowProbeSource(inputMethodPids) {
  return `
import CoreGraphics
import Foundation
let inputMethodPids = Set<Int32>([${inputMethodPids.join(", ")}])
let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for row in rows {
  guard let ownerPid = row[kCGWindowOwnerPID as String] as? NSNumber,
        inputMethodPids.contains(ownerPid.int32Value),
        let bounds = row[kCGWindowBounds as String] as? [String: Any],
        let width = bounds["Width"] as? NSNumber,
        let height = bounds["Height"] as? NSNumber else { continue }
  print("\\(width.intValue)x\\(height.intValue)")
}`;
}
