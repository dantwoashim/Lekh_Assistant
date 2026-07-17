import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const probePath = join(root, "scripts", "check-macos-imk-host-candidate-mouse.mjs");
const recoveryPath = join(root, "scripts", "lib", "macos-candidate-mouse-recovery.mjs");
const probe = readFileSync(probePath, "utf8");
const recovery = readFileSync(recoveryPath, "utf8");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("candidate targeted-key custody", () => {
  it("typechecks the generated Swift helper with warnings promoted to errors", () => {
    if (process.platform !== "darwin") return;
    const result = spawnSync(process.execPath, [probePath], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, LEKH_CANDIDATE_KEY_COMPILE_ONLY: "1" },
      timeout: 20_000
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "passed",
      check: { name: "targeted-keys", status: 0 }
    });
  });

  it("authorizes only after READY and durable exact-process journaling", () => {
    const posting = between(
      probe,
      "async function postTextEditKeys(keyCodes, targetPid)",
      "function inspectCandidatePostcondition()"
    );
    const readyIndex = posting.indexOf("const readyIsExact");
    const journalIndex = posting.indexOf("journalActiveSyntheticHelper(state, helperIdentity.executablePath)");
    const goIndex = posting.indexOf('helper.stdin.end("GO\\n")');
    const closeIndex = posting.indexOf("awaitSyntheticHelperClosure(state, 5_000)");
    const retireIndex = posting.indexOf("await retireSyntheticHelper(state)");

    expect(posting).toContain('spawn("/usr/bin/swift"');
    expect(posting).toContain('item.startsWith("LEKH_KEY_READY:")');
    expect(readyIndex).toBeGreaterThanOrEqual(0);
    expect(journalIndex).toBeGreaterThan(readyIndex);
    expect(goIndex).toBeGreaterThan(journalIndex);
    expect(closeIndex).toBeGreaterThan(goIndex);
    expect(retireIndex).toBeGreaterThan(closeIndex);
    expect(probe).toContain("durable?.processStartToken !== observed.processStartToken");
    expect(probe).toContain("durable?.role !== state.kind");
    expect(probe).toContain("role: state.kind");
    expect(posting).toContain("bounded post-GO execution window");
  });

  it("guards every normal key down and up against the full exact host epoch", () => {
    const swift = between(
      probe,
      "function targetedKeyPostingSource({",
      "function candidateSurfaceSource(inputMethodPid)"
    );
    const loop = between(swift, "for event in events {", "emit(completed: true, failureKind: nil)");
    const downGuard = loop.indexOf('guard exactEventCustodyMatches() else { failGuard("guard-before-down") }');
    const downPost = loop.indexOf("down.postToPid(targetPid)");
    const upGuard = loop.indexOf('guard exactEventCustodyMatches() else { failGuard("guard-before-up") }');
    const upPost = loop.indexOf("up.postToPid(targetPid)");

    expect(swift).toContain("getppid() == parentPid");
    expect(swift).toContain("parentProcessStartToken");
    expect(swift).toContain("targetProcessStartToken");
    expect(swift).toContain("focusedExactTextEditDocumentMatches()");
    expect(swift).toContain("CFEqual(focusedWindow, exactDocumentWindows[0])");
    expect(swift).toContain("kAXFocusedUIElementAttribute");
    expect(swift).toContain("kAXTextAreaRole");
    expect(swift).toContain('currentInputSourceID() == "${lekhInputSourceId}"');
    expect(swift).toContain("runtimeEpochMatches()");
    expect(swift).toContain("processStartToken");
    expect(downGuard).toBeGreaterThanOrEqual(0);
    expect(downPost).toBeGreaterThan(downGuard);
    expect(upGuard).toBeGreaterThan(downPost);
    expect(upPost).toBeGreaterThan(upGuard);
    expect(swift.match(/guard exactEventCustodyMatches\(\)/gu)).toHaveLength(2);
    expect(swift).not.toContain(".post(tap:");
  });

  it("fails closed and limits a compensating release to the same TextEdit process instance", () => {
    const swift = between(
      probe,
      "function targetedKeyPostingSource({",
      "function candidateSurfaceSource(inputMethodPid)"
    );
    const failure = between(swift, "func failGuard(_ phase: String) -> Never", "for event in events {");
    expect(failure).toContain("runningProcessMatches(targetPid, path: targetExecutablePath, startToken: targetProcessStartToken)");
    expect(failure).toContain("release.postToPid(targetPid)");
    expect(failure).not.toContain("cghidEventTap");
    expect(swift).toContain('guard readLine(strippingNewline: true) == "GO" else { exit(78) }');
    expect(swift).toContain("guardCheckCount");
    expect(swift).toContain("compensatingKeyUpCount");
  });

  it("stops and awaits any key or mouse helper before all cleanup and recovery", () => {
    const finalizer = between(probe, "function finalizeProbe()", "function handleTerminationSignal(signal)");
    expect(finalizer.indexOf("await stopAndAwaitActiveSyntheticHelper()"))
      .toBeLessThan(finalizer.indexOf("performCleanup()"));
    expect(finalizer).toContain("if (!helperStopped)");
    expect(finalizer.indexOf("if (!helperStopped)")).toBeLessThan(finalizer.indexOf("performCleanup()"));

    const mouse = between(probe, "async function postMouseGesture({", "function targetedKeyPostingSource({");
    expect(mouse).toContain('registerActiveSyntheticHelper({ child: helper, closed, kind: "mouse-gesture" })');
    expect(mouse).toContain("journalActiveSyntheticHelper(helperState, helperExecutablePath)");
    expect(mouse).toContain("awaitSyntheticHelperClosure(helperState, 8_000)");

    const restore = between(
      recovery,
      "export function restoreCandidateMouseRecoveryRecord(record, adapters = {})",
      "export function recoverCandidateMouseState"
    );
    expect(restore.indexOf("operations.terminateGestureHelper(validated.gestureHelperProcess)"))
      .toBeLessThan(restore.indexOf("operations.releaseMouse"));
  });
});
