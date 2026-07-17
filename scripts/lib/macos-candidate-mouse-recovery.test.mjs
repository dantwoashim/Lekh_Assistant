import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireCandidateMouseRecoveryLock,
  assertCandidateMouseRecoveryGuardianAlive,
  candidateEmergencyMouseUpSource,
  candidatePreferenceRecoveryEntries,
  CANDIDATE_RECOVERY_PREFERENCE_KEYS,
  CANDIDATE_RECOVERY_PREFERENCES_DOMAIN,
  createCandidateMouseTemporaryDocument,
  inspectCandidateMouseRecoveryJournal,
  launchCandidateMouseRecoveryGuardian,
  markCandidateMouseRecoveryComplete,
  prepareCandidateMouseRecovery,
  recoverCandidateMouseState,
  releaseCandidateMouseRecoveryLock,
  restoreCandidateMouseRecoveryRecord,
  signalCandidateMouseRecoveryGuardianCompletion,
  triggerCandidateMouseRecoveryGuardian,
  updateCandidateMouseRecovery,
  waitForCandidateMouseRecoveryGuardian
} from "./macos-candidate-mouse-recovery.mjs";
import {
  currentInputSource,
  processExecutablePath,
  run,
  snapshotPreference,
  wait
} from "./macos-imk-host-harness.mjs";

const roots = [];
const temporaryDocuments = [];
const locks = [];
let documentCounter = 8_000_000;

function recoveryDirectory() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lekh-candidate-recovery-test-"));
  roots.push(root);
  return join(root, "recovery");
}

function temporaryDocument(lock) {
  const path = createCandidateMouseTemporaryDocument(lock, "probe ");
  temporaryDocuments.push(path);
  return path;
}

function acquire(directoryPath) {
  const lock = acquireCandidateMouseRecoveryLock({ directoryPath });
  locks.push(lock);
  return lock;
}

function absentSnapshots() {
  return Object.fromEntries(CANDIDATE_RECOVERY_PREFERENCE_KEYS.map((key) => [key, {
    status: 0,
    schema: "lekh.cfpreferences.current-user-any-host.v1",
    scope: "current-user-any-host",
    domain: CANDIDATE_RECOVERY_PREFERENCES_DOMAIN,
    key,
    exists: false,
    propertyListType: "absent",
    propertyListBase64: "",
    stderr: ""
  }]));
}

function liveSnapshots() {
  return Object.fromEntries(CANDIDATE_RECOVERY_PREFERENCE_KEYS.map((key) => [
    key,
    snapshotPreference(CANDIDATE_RECOVERY_PREFERENCES_DOMAIN, key)
  ]));
}

const completeCleanup = Object.freeze({
  textEditTerminated: true,
  inputSourceRestored: true,
  preferencesRestored: true,
  temporaryDocumentRemoved: true,
  mouseButtonReleased: true,
  pointerRestored: true
});

function currentPointer() {
  const result = run("/usr/bin/swift", ["-e", `
import CoreGraphics
import Foundation
guard let point = CGEvent(source: nil)?.location else { exit(2) }
let data = try! JSONSerialization.data(withJSONObject: ["x": point.x, "y": point.y])
print(String(decoding: data, as: UTF8.self))
`]);
  if (result.status !== 0) throw new Error("Pointer baseline unavailable.");
  return JSON.parse(result.stdout.trim());
}

afterEach(() => {
  for (const lock of locks.splice(0)) {
    try { releaseCandidateMouseRecoveryLock(lock); } catch {}
  }
  for (const path of temporaryDocuments.splice(0)) {
    if (existsSync(path)) unlinkSync(path);
  }
  for (const root of roots.splice(0)) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "darwin")("candidate-mouse crash recovery", () => {
  it("removes only orphan documents from the dedicated private recovery namespace", () => {
    const lock = acquire(recoveryDirectory());
    const path = temporaryDocument(lock);
    expect(recoverCandidateMouseState({ lock })).toEqual({
      status: "recovered",
      cleanupEvidence: null
    });
    expect(existsSync(path)).toBe(false);
  });

  it("executes every exact recovery adapter, including forced mouse-up", () => {
    const lock = acquire(recoveryDirectory());
    const temporaryDocumentPath = temporaryDocument(lock);
    const transaction = prepareCandidateMouseRecovery({
      lock,
      priorInputSourceIdentifier: "com.apple.keylayout.ABC",
      preferences: candidatePreferenceRecoveryEntries(absentSnapshots()),
      temporaryDocumentPath
    });
    updateCandidateMouseRecovery(transaction, {
      mouseSafety: {
        mayBeDown: true,
        releasePoint: { x: 20, y: 30 },
        originalPointer: { x: 40, y: 50 },
        initialLeftButtonReleased: true
      }
    });
    const record = inspectCandidateMouseRecoveryJournal(lock);
    const restored = new Map();
    let forcedMouseUp = null;
    const recovery = restoreCandidateMouseRecoveryRecord(record, {
      releaseMouse(options) {
        forcedMouseUp = options;
        return { status: 0, released: true };
      },
      restorePointer(point) {
        expect(point).toEqual({ x: 40, y: 50 });
        return { status: 0, restored: true };
      },
      terminateTextEdit: () => true,
      restoreInputSource: () => ({ status: 0 }),
      currentInputSource: () => ({ id: "com.apple.keylayout.ABC" }),
      restorePreference(domain, key, snapshot) {
        restored.set(`${domain}\0${key}`, snapshot);
        return { status: 0, readBackEqual: true };
      },
      snapshotPreference(domain, key) {
        return restored.get(`${domain}\0${key}`);
      },
      notifyPreferencesChanged: () => ({ status: 0 }),
      removeTemporaryDocument(path) {
        unlinkSync(path);
        return true;
      }
    });
    expect(recovery).toEqual({ status: "recovered", cleanupEvidence: completeCleanup });
    expect(forcedMouseUp).toEqual({ point: { x: 20, y: 30 }, forcePost: true });
    expect(restored.size).toBe(CANDIDATE_RECOVERY_PREFERENCE_KEYS.length);
    expect(existsSync(temporaryDocumentPath)).toBe(false);
  });

  it("preserves causal user pointer movement instead of warping it away", () => {
    const lock = acquire(recoveryDirectory());
    const temporaryDocumentPath = temporaryDocument(lock);
    const transaction = prepareCandidateMouseRecovery({
      lock,
      priorInputSourceIdentifier: "com.apple.keylayout.ABC",
      preferences: candidatePreferenceRecoveryEntries(absentSnapshots()),
      temporaryDocumentPath
    });
    updateCandidateMouseRecovery(transaction, {
      mouseSafety: {
        mayBeDown: true,
        releasePoint: { x: 20, y: 30 },
        originalPointer: { x: 40, y: 50 },
        initialLeftButtonReleased: true
      }
    });
    const forbiddenWarp = () => { throw new Error("A user-moved pointer must not be warped."); };
    const recovery = restoreCandidateMouseRecoveryRecord(inspectCandidateMouseRecoveryJournal(lock), {
      releaseMouse: () => ({
        status: 0,
        released: true,
        pointerDisposition: "user-movement-preserved"
      }),
      restorePointer: forbiddenWarp,
      terminateTextEdit: () => true,
      restoreInputSource: () => ({ status: 0 }),
      currentInputSource: () => ({ id: "com.apple.keylayout.ABC" }),
      restorePreference: () => ({ status: 0, readBackEqual: true }),
      notifyPreferencesChanged: () => ({ status: 0 }),
      removeTemporaryDocument(path) {
        unlinkSync(path);
        return true;
      }
    });
    expect(recovery).toEqual({ status: "recovered", cleanupEvidence: completeCleanup });
    expect(existsSync(temporaryDocumentPath)).toBe(false);
  });

  it("retains the inherited lock and accepts only durable normal completion", async () => {
    const directoryPath = recoveryDirectory();
    const lock = acquire(directoryPath);
    const source = currentInputSource();
    expect(source.status).toBe(0);
    const transaction = prepareCandidateMouseRecovery({
      lock,
      priorInputSourceIdentifier: source.id,
      preferences: candidatePreferenceRecoveryEntries(liveSnapshots()),
      temporaryDocumentPath: temporaryDocument(lock)
    });
    const guardian = await launchCandidateMouseRecoveryGuardian({ lock, transaction });
    expect(assertCandidateMouseRecoveryGuardianAlive(guardian)).toBe(true);
    markCandidateMouseRecoveryComplete(transaction, completeCleanup);
    expect(releaseCandidateMouseRecoveryLock(lock)).toBe(true);
    let contention = null;
    try { acquireCandidateMouseRecoveryLock({ directoryPath }); } catch (error) { contention = error; }
    expect(contention?.code).toBe("candidate-recovery-lock-busy");
    signalCandidateMouseRecoveryGuardianCompletion(guardian);
    expect(await waitForCandidateMouseRecoveryGuardian(guardian)).toEqual({
      status: "completed",
      exitCode: 0,
      signal: null,
      disposition: "normal-completion"
    });
    expect(existsSync(transaction.journalPath)).toBe(false);
  }, 20_000);

  it("executes fail-safe recovery on guardian EOF while a mouse-down may be outstanding", async () => {
    const directoryPath = recoveryDirectory();
    const lock = acquire(directoryPath);
    const source = currentInputSource();
    expect(source.status).toBe(0);
    const snapshots = liveSnapshots();
    expect(Object.values(snapshots).every((snapshot) => snapshot.status === 0)).toBe(true);
    const temporaryDocumentPath = temporaryDocument(lock);
    const transaction = prepareCandidateMouseRecovery({
      lock,
      priorInputSourceIdentifier: source.id,
      preferences: candidatePreferenceRecoveryEntries(snapshots),
      temporaryDocumentPath
    });
    const pointer = currentPointer();
    updateCandidateMouseRecovery(transaction, {
      mouseSafety: {
        mayBeDown: true,
        releasePoint: pointer,
        originalPointer: pointer,
        initialLeftButtonReleased: true
      }
    });
    const guardian = await launchCandidateMouseRecoveryGuardian({ lock, transaction });
    expect(releaseCandidateMouseRecoveryLock(lock)).toBe(true);
    triggerCandidateMouseRecoveryGuardian(guardian);
    expect(await waitForCandidateMouseRecoveryGuardian(guardian)).toEqual({
      status: "completed",
      exitCode: 0,
      signal: null,
      disposition: "crash-recovery"
    });
    expect(existsSync(temporaryDocumentPath)).toBe(false);
    expect(existsSync(transaction.journalPath)).toBe(false);
    expect(currentInputSource().id).toBe(source.id);
  }, 20_000);

  it("kills the exact authorized gesture helper before the guardian posts mouse-up", async () => {
    const directoryPath = recoveryDirectory();
    const lock = acquire(directoryPath);
    const source = currentInputSource();
    const snapshots = liveSnapshots();
    const temporaryDocumentPath = temporaryDocument(lock);
    const transaction = prepareCandidateMouseRecovery({
      lock,
      priorInputSourceIdentifier: source.id,
      preferences: candidatePreferenceRecoveryEntries(snapshots),
      temporaryDocumentPath
    });
    const pointer = currentPointer();
    updateCandidateMouseRecovery(transaction, {
      mouseSafety: {
        mayBeDown: true,
        releasePoint: pointer,
        originalPointer: pointer,
        initialLeftButtonReleased: true
      }
    });
    const guardian = await launchCandidateMouseRecoveryGuardian({ lock, transaction });
    const helper = spawn("/usr/bin/swift", ["-e", `
import Foundation
guard readLine(strippingNewline: true) == "GO" else { exit(78) }
Thread.sleep(forTimeInterval: 30)
`], { stdio: ["pipe", "ignore", "ignore"] });
    const helperClosed = new Promise((resolveClosed) => helper.once("close", resolveClosed));
    let helperPath = "";
    const deadline = Date.now() + 3_000;
    while (!helperPath && Date.now() < deadline) {
      helperPath = processExecutablePath(helper.pid);
      if (!helperPath) wait(25);
    }
    expect(helperPath).toMatch(/swift-frontend$/u);
    updateCandidateMouseRecovery(transaction, {
      gestureHelperProcess: {
        processIdentifier: helper.pid,
        executablePath: helperPath,
        role: "mouse-gesture"
      }
    });
    helper.stdin.end("GO\n");
    expect(releaseCandidateMouseRecoveryLock(lock)).toBe(true);
    triggerCandidateMouseRecoveryGuardian(guardian);
    expect(await waitForCandidateMouseRecoveryGuardian(guardian)).toMatchObject({
      status: "completed",
      disposition: "crash-recovery"
    });
    await helperClosed;
    expect(processExecutablePath(helper.pid)).toBe("");
    expect(existsSync(temporaryDocumentPath)).toBe(false);
    expect(existsSync(transaction.journalPath)).toBe(false);
  // This proof intentionally invokes the system Swift driver repeatedly to
  // bind process epochs and exercise the real guardian. A concurrent Vitest
  // worker can hold the toolchain's module-cache/compiler resources long
  // enough to exceed a short unit-test timeout even though every production
  // recovery deadline remains bounded inside the implementation.
  }, 90_000);

  it("keeps an incomplete journal for a later exact retry", () => {
    const lock = acquire(recoveryDirectory());
    const path = temporaryDocument(lock);
    const transaction = prepareCandidateMouseRecovery({
      lock,
      priorInputSourceIdentifier: "com.apple.keylayout.ABC",
      preferences: candidatePreferenceRecoveryEntries(absentSnapshots()),
      temporaryDocumentPath: path
    });
    const incomplete = recoverCandidateMouseState({
      lock,
      adapters: {
        releaseMouse: () => ({ status: 0, released: true }),
        terminateTextEdit: () => true,
        restoreInputSource: () => ({ status: 0 }),
        currentInputSource: () => ({ id: "wrong-source" }),
        restorePreference: () => ({ status: 0, readBackEqual: true }),
        snapshotPreference: (_domain, key) => absentSnapshots()[key],
        notifyPreferencesChanged: () => ({ status: 0 }),
        removeTemporaryDocument: () => true
      }
    });
    expect(incomplete.status).toBe("recovery-incomplete");
    expect(existsSync(transaction.journalPath)).toBe(true);
  });

  it("never arms recovery over a user-owned physical drag", () => {
    const lock = acquire(recoveryDirectory());
    const transaction = prepareCandidateMouseRecovery({
      lock,
      priorInputSourceIdentifier: "com.apple.keylayout.ABC",
      preferences: candidatePreferenceRecoveryEntries(absentSnapshots()),
      temporaryDocumentPath: temporaryDocument(lock)
    });
    expect(() => updateCandidateMouseRecovery(transaction, {
      mouseSafety: {
        mayBeDown: true,
        releasePoint: { x: 1, y: 1 },
        originalPointer: { x: 2, y: 2 },
        initialLeftButtonReleased: false
      }
    })).toThrow(/released-button pointer baseline/u);
  });

  it("keeps observe-only mouse cleanup strictly event-free", () => {
    const source = candidateEmergencyMouseUpSource({ x: 10, y: 20 }, false);
    expect(source).toContain("if forcePost {");
    expect(source).not.toContain("if forcePost || before");
    expect(source).toContain("let causalReleasePoint = userMoved ? currentPointer : releasePoint");
    expect(source).toContain('"user-movement-preserved"');
  });

  it("never escalates an in-flight TextEdit launch custodian to SIGKILL", () => {
    const moduleSource = readFileSync(join(process.cwd(), "scripts", "lib", "macos-candidate-mouse-recovery.mjs"), "utf8");
    const start = moduleSource.indexOf("function settleTextEditLaunchCustodian(helper)");
    const end = moduleSource.indexOf("export function restoreCandidateMouseRecoveryRecord", start);
    const settlement = moduleSource.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(settlement).toContain('signalExactProcess(helper, "TERM")');
    expect(settlement).not.toContain('signalExactProcess(helper, "KILL")');
    expect(settlement).not.toContain("terminateExactProcess(helper");
    expect(settlement).toContain("retain the journal and mutate nothing");
  });

  it("performs no downstream recovery mutation when helper termination is ambiguous", async () => {
    const lock = acquire(recoveryDirectory());
    const transaction = prepareCandidateMouseRecovery({
      lock,
      priorInputSourceIdentifier: "com.apple.keylayout.ABC",
      preferences: candidatePreferenceRecoveryEntries(absentSnapshots()),
      temporaryDocumentPath: temporaryDocument(lock)
    });
    const helper = spawn("/usr/bin/swift", ["-e", `
import Foundation
guard readLine(strippingNewline: true) != nil else { exit(0) }
Thread.sleep(forTimeInterval: 30)
`], { stdio: ["pipe", "ignore", "ignore"] });
    const helperClosed = new Promise((resolveClosed) => helper.once("close", resolveClosed));
    try {
      let helperPath = "";
      const deadline = Date.now() + 3_000;
      while (!helperPath && Date.now() < deadline) {
        helperPath = processExecutablePath(helper.pid);
        if (!helperPath) wait(25);
      }
      expect(helperPath).toMatch(/swift-frontend$/u);
      updateCandidateMouseRecovery(transaction, {
        gestureHelperProcess: {
          processIdentifier: helper.pid,
          executablePath: helperPath,
          role: "mouse-gesture"
        }
      });
      const record = inspectCandidateMouseRecoveryJournal(lock);
      let downstreamMutationCount = 0;
      const forbidden = () => {
        downstreamMutationCount += 1;
        throw new Error("downstream recovery mutation was attempted");
      };
      const recovery = restoreCandidateMouseRecoveryRecord(record, {
        terminateGestureHelper: () => false,
        releaseMouse: forbidden,
        restorePointer: forbidden,
        terminateTextEdit: forbidden,
        restoreInputSource: forbidden,
        currentInputSource: forbidden,
        restorePreference: forbidden,
        notifyPreferencesChanged: forbidden,
        removeTemporaryDocument: forbidden
      });
      expect(recovery.status).toBe("recovery-incomplete");
      expect(Object.values(recovery.cleanupEvidence).every((value) => value === false)).toBe(true);
      expect(downstreamMutationCount).toBe(0);
      expect(existsSync(transaction.journalPath)).toBe(true);
    } finally {
      helper.stdin.end();
      await helperClosed;
    }
    // The callback contains synchronous, fail-closed process-identity probes.
    // Give those real toolchain probes a load-tolerant harness budget; the
    // recovery adapter is still asserted to perform zero downstream mutation.
  }, 90_000);
});
