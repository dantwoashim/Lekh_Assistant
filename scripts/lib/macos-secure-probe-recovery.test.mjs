import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  acquireSecureProbeRecoveryLock,
  assertSecureProbeRecoveryGuardianAlive,
  inspectSecureProbeRecoveryJournal,
  launchSecureProbeRecoveryGuardian,
  markSecureProbeRecoveryComplete,
  preferenceRecoveryEntries,
  prepareSecureProbeRecovery,
  recoverSecureProbeState,
  releaseSecureProbeRecoveryLock,
  removeSecureProbeTemporaryPath,
  SECURE_PROBE_PREFERENCE_KEYS,
  SECURE_PROBE_PREFERENCE_SCHEMA,
  SECURE_PROBE_PREFERENCE_SCOPE,
  SECURE_PROBE_PREFERENCES_DOMAIN,
  signalSecureProbeRecoveryGuardianCompletion,
  triggerSecureProbeRecoveryGuardian,
  updateSecureProbeRecovery,
  waitForSecureProbeRecoveryGuardian
} from "./macos-secure-probe-recovery.mjs";
import {
  currentInputSource,
  snapshotPreference
} from "./macos-imk-host-harness.mjs";

const roots = [];
const temporaryHosts = [];
const locks = [];

function fixtureDirectory() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lekh-secure-recovery-test-"));
  roots.push(root);
  return join(root, "recovery");
}

function disposableHostDirectory() {
  const path = mkdtempSync(join(realpathSync(tmpdir()), "lekh-secure-field-host-"));
  chmodSync(path, 0o700);
  temporaryHosts.push(path);
  return path;
}

function acquire(directoryPath) {
  const lock = acquireSecureProbeRecoveryLock({ directoryPath });
  locks.push(lock);
  return lock;
}

function absentPreferenceSnapshots() {
  return Object.fromEntries(SECURE_PROBE_PREFERENCE_KEYS.map((key) => [key, {
    status: 0,
    schema: SECURE_PROBE_PREFERENCE_SCHEMA,
    scope: SECURE_PROBE_PREFERENCE_SCOPE,
    domain: SECURE_PROBE_PREFERENCES_DOMAIN,
    key,
    exists: false,
    propertyListType: "absent",
    propertyListBase64: "",
    stderr: ""
  }]));
}

function absentPreferenceEntries() {
  return preferenceRecoveryEntries(absentPreferenceSnapshots());
}

function successfulAdapters(expectedSource) {
  const values = new Map();
  return {
    terminateHost: () => ({ status: 0 }),
    secureInputReturnedToBaseline: () => ({ status: 0 }),
    restoreInputSource: () => ({ status: 0 }),
    currentInputSource: () => ({ id: expectedSource }),
    restorePreference(domain, key, snapshot) {
      values.set(`${domain}\u0000${key}`, snapshot);
      return { status: 0 };
    },
    snapshotPreference(domain, key) {
      const snapshot = values.get(`${domain}\u0000${key}`);
      return snapshot ? { ...snapshot, stderr: "" } : null;
    },
    notifyPreferencesChanged: () => ({ status: 0 }),
    removeTemporaryPath: removeSecureProbeTemporaryPath
  };
}

const completeEvidence = Object.freeze({
  hostTerminated: true,
  inputSourceRestored: true,
  preferencesRestored: true,
  secureInputReturnedToBaseline: true,
  temporaryHostRemoved: true
});

afterEach(() => {
  for (const lock of locks.splice(0)) {
    try {
      releaseSecureProbeRecoveryLock(lock);
    } catch {}
  }
  for (const path of temporaryHosts.splice(0)) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
  for (const path of roots.splice(0)) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "darwin")("macOS secure-probe recovery", () => {
  it("durably journals exact state with private ownership and recovers it", () => {
    const directoryPath = fixtureDirectory();
    const lock = acquire(directoryPath);
    const temporaryPath = disposableHostDirectory();
    const priorInputSourceIdentifier = "com.apple.keylayout.ABC";
    const transaction = prepareSecureProbeRecovery({
      lock,
      priorInputSourceIdentifier,
      preferences: absentPreferenceEntries(),
      temporaryPaths: [temporaryPath]
    });

    expect(statSync(directoryPath).mode & 0o777).toBe(0o700);
    expect(statSync(lock.paths.lockPath).mode & 0o777).toBe(0o600);
    expect(statSync(transaction.journalPath).mode & 0o777).toBe(0o600);
    const journal = inspectSecureProbeRecoveryJournal(lock);
    expect(journal.priorInputSourceIdentifier).toBe(priorInputSourceIdentifier);
    expect(journal.preferences).toHaveLength(SECURE_PROBE_PREFERENCE_KEYS.length);
    expect(journal.preferences.map(({ key }) => key).sort()).toEqual([...SECURE_PROBE_PREFERENCE_KEYS].sort());
    expect(journal.preferences.every((entry) =>
      entry.schema === SECURE_PROBE_PREFERENCE_SCHEMA &&
      entry.scope === SECURE_PROBE_PREFERENCE_SCOPE &&
      entry.propertyListType === "absent"
    )).toBe(true);

    chmodSync(transaction.journalPath, 0o644);
    expect(() => inspectSecureProbeRecoveryJournal(lock)).toThrow(/unsafe permissions/u);
    chmodSync(transaction.journalPath, 0o600);

    const recovery = recoverSecureProbeState({
      lock,
      adapters: successfulAdapters(priorInputSourceIdentifier)
    });
    expect(recovery.status).toBe("recovered");
    expect(recovery.cleanupEvidence).toEqual(completeEvidence);
    expect(existsSync(temporaryPath)).toBe(false);
    expect(existsSync(transaction.journalPath)).toBe(false);
  });

  it("retains the inherited kernel lock in the guardian and accepts only durable normal completion", async () => {
    const directoryPath = fixtureDirectory();
    const lock = acquire(directoryPath);
    const source = currentInputSource();
    expect(source.status).toBe(0);
    const snapshots = Object.fromEntries(SECURE_PROBE_PREFERENCE_KEYS.map((key) => [
      key,
      snapshotPreference(SECURE_PROBE_PREFERENCES_DOMAIN, key)
    ]));
    expect(Object.values(snapshots).every((snapshot) => snapshot.status === 0)).toBe(true);
    const transaction = prepareSecureProbeRecovery({
      lock,
      priorInputSourceIdentifier: source.id,
      preferences: preferenceRecoveryEntries(snapshots)
    });
    const guardian = await launchSecureProbeRecoveryGuardian({ lock, transaction });
    expect(assertSecureProbeRecoveryGuardianAlive(guardian)).toBe(true);
    markSecureProbeRecoveryComplete(transaction, completeEvidence);

    expect(releaseSecureProbeRecoveryLock(lock)).toBe(true);
    let contention = null;
    try {
      acquireSecureProbeRecoveryLock({ directoryPath });
    } catch (error) {
      contention = error;
    }
    expect(contention?.code).toBe("secure-probe-lock-busy");

    signalSecureProbeRecoveryGuardianCompletion(guardian);
    const completion = await waitForSecureProbeRecoveryGuardian(guardian);
    expect(completion).toEqual({
      status: "completed",
      exitCode: 0,
      signal: null,
      disposition: "normal-completion"
    });
    expect(existsSync(transaction.journalPath)).toBe(false);

    const successor = acquire(directoryPath);
    expect(releaseSecureProbeRecoveryLock(successor)).toBe(true);
  }, 45_000);

  it("keeps the journal when exact verification fails and removes it after a complete retry", () => {
    const directoryPath = fixtureDirectory();
    const lock = acquire(directoryPath);
    const priorInputSourceIdentifier = "com.apple.keylayout.ABC";
    const transaction = prepareSecureProbeRecovery({
      lock,
      priorInputSourceIdentifier,
      preferences: absentPreferenceEntries()
    });
    const incompleteAdapters = successfulAdapters(priorInputSourceIdentifier);
    incompleteAdapters.currentInputSource = () => ({ id: "com.apple.keylayout.US" });
    const incomplete = recoverSecureProbeState({ lock, adapters: incompleteAdapters });
    expect(incomplete.status).toBe("recovery-incomplete");
    expect(incomplete.cleanupEvidence.inputSourceRestored).toBe(false);
    expect(existsSync(transaction.journalPath)).toBe(true);

    const recovered = recoverSecureProbeState({
      lock,
      adapters: successfulAdapters(priorInputSourceIdentifier)
    });
    expect(recovered.status).toBe("recovered");
    expect(existsSync(transaction.journalPath)).toBe(false);
  });

  it("retains the executable and journal when process-instance termination is ambiguous", async () => {
    const directoryPath = fixtureDirectory();
    const lock = acquire(directoryPath);
    const temporaryPath = disposableHostDirectory();
    const executablePath = join(temporaryPath, "LekhSecureFieldHost");
    const fixtureSource = join(temporaryPath, "fixture.c");
    writeFileSync(fixtureSource, "#include <unistd.h>\nint main(void) { for (;;) pause(); }\n");
    const compile = spawnSync("/usr/bin/xcrun", ["clang", fixtureSource, "-o", executablePath], {
      encoding: "utf8"
    });
    expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
    chmodSync(executablePath, 0o700);
    const child = spawn(executablePath, [], { stdio: "ignore" });
    const closed = new Promise((resolve) => child.once("close", resolve));
    try {
      const transaction = prepareSecureProbeRecovery({
        lock,
        priorInputSourceIdentifier: "com.apple.keylayout.ABC",
        preferences: absentPreferenceEntries(),
        temporaryPaths: [temporaryPath]
      });
      const bound = updateSecureProbeRecovery(transaction, {
        hostProcess: { processIdentifier: child.pid, executablePath }
      });
      expect(bound.hostProcess.processStartToken).toMatch(/^\d{1,20}:\d{1,6}$/u);

      const adapters = successfulAdapters("com.apple.keylayout.ABC");
      adapters.terminateHost = () => ({ status: 3 });
      const recovery = recoverSecureProbeState({ lock, adapters });
      expect(recovery.status).toBe("recovery-incomplete");
      expect(recovery.cleanupEvidence.hostTerminated).toBe(false);
      expect(recovery.cleanupEvidence.temporaryHostRemoved).toBe(false);
      expect(existsSync(temporaryPath)).toBe(true);
      expect(existsSync(transaction.journalPath)).toBe(true);

      const serialized = JSON.parse(readFileSync(transaction.journalPath, "utf8"));
      delete serialized.hostProcess.processStartToken;
      writeFileSync(transaction.journalPath, `${JSON.stringify(serialized)}\n`, { mode: 0o600 });
      expect(() => inspectSecureProbeRecoveryJournal(lock)).toThrow(/unexpected or missing field/u);
    } finally {
      child.kill("SIGTERM");
      await closed;
    }
  }, 15_000);

  it("recovers exact state on guardian EOF and retains the lock until recovery finishes", async () => {
    const directoryPath = fixtureDirectory();
    const lock = acquire(directoryPath);
    const source = currentInputSource();
    expect(source.status).toBe(0);
    const snapshots = Object.fromEntries(SECURE_PROBE_PREFERENCE_KEYS.map((key) => [
      key,
      snapshotPreference(SECURE_PROBE_PREFERENCES_DOMAIN, key)
    ]));
    expect(Object.values(snapshots).every((snapshot) => snapshot.status === 0)).toBe(true);
    const temporaryPath = disposableHostDirectory();
    const transaction = prepareSecureProbeRecovery({
      lock,
      priorInputSourceIdentifier: source.id,
      preferences: preferenceRecoveryEntries(snapshots),
      temporaryPaths: [temporaryPath]
    });
    const guardian = await launchSecureProbeRecoveryGuardian({ lock, transaction });

    expect(releaseSecureProbeRecoveryLock(lock)).toBe(true);
    let contention = null;
    try {
      acquireSecureProbeRecoveryLock({ directoryPath });
    } catch (error) {
      contention = error;
    }
    expect(contention?.code).toBe("secure-probe-lock-busy");

    triggerSecureProbeRecoveryGuardian(guardian);
    const completion = await waitForSecureProbeRecoveryGuardian(guardian);
    expect(completion).toEqual({
      status: "completed",
      exitCode: 0,
      signal: null,
      disposition: "crash-recovery"
    });
    expect(existsSync(temporaryPath)).toBe(false);
    expect(existsSync(transaction.journalPath)).toBe(false);
    expect(currentInputSource().id).toBe(source.id);

    const successor = acquire(directoryPath);
    expect(releaseSecureProbeRecoveryLock(successor)).toBe(true);
  }, 45_000);

  it("recovers from a real SIGKILL of the guardian parent", async () => {
    const directoryPath = fixtureDirectory();
    const temporaryPath = disposableHostDirectory();
    const moduleURL = pathToFileURL(join(process.cwd(), "scripts", "lib", "macos-secure-probe-recovery.mjs")).href;
    const harnessURL = pathToFileURL(join(process.cwd(), "scripts", "lib", "macos-imk-host-harness.mjs")).href;
    const childSource = `
import {
  acquireSecureProbeRecoveryLock,
  launchSecureProbeRecoveryGuardian,
  preferenceRecoveryEntries,
  prepareSecureProbeRecovery,
  SECURE_PROBE_PREFERENCE_KEYS,
  SECURE_PROBE_PREFERENCES_DOMAIN
} from ${JSON.stringify(moduleURL)};
import { currentInputSource, snapshotPreference } from ${JSON.stringify(harnessURL)};
const lock = acquireSecureProbeRecoveryLock({ directoryPath: ${JSON.stringify(directoryPath)} });
const source = currentInputSource();
const snapshots = Object.fromEntries(SECURE_PROBE_PREFERENCE_KEYS.map((key) => [
  key,
  snapshotPreference(SECURE_PROBE_PREFERENCES_DOMAIN, key)
]));
const transaction = prepareSecureProbeRecovery({
  lock,
  priorInputSourceIdentifier: source.id,
  preferences: preferenceRecoveryEntries(snapshots),
  temporaryPaths: [${JSON.stringify(temporaryPath)}]
});
globalThis.guardian = await launchSecureProbeRecoveryGuardian({ lock, transaction });
process.stdout.write("READY\\n");
setInterval(() => {}, 1_000);
`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", childSource], {
      stdio: ["ignore", "pipe", "ignore"]
    });
    const ready = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("SIGKILL fixture did not arm recovery.")), 20_000);
      child.once("error", reject);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("READY\n")) {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
    expect(ready).toBe(true);
    expect(child.kill("SIGKILL")).toBe(true);
    await new Promise((resolve) => child.once("close", resolve));

    const deadline = Date.now() + 30_000;
    let successor = null;
    while (Date.now() < deadline && !successor) {
      try {
        successor = acquireSecureProbeRecoveryLock({ directoryPath });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(successor).not.toBeNull();
    expect(existsSync(temporaryPath)).toBe(false);
    expect(inspectSecureProbeRecoveryJournal(successor)).toBeNull();
    expect(releaseSecureProbeRecoveryLock(successor)).toBe(true);
  }, 60_000);

  it("rejects state outside the fixed preference and temporary-host namespaces", () => {
    expect(() => preferenceRecoveryEntries({
      ...absentPreferenceSnapshots(),
      ArbitraryUserText: {
        ...absentPreferenceSnapshots()[SECURE_PROBE_PREFERENCE_KEYS[0]],
        key: "ArbitraryUserText"
      }
    })).toThrow(/exactly all/u);

    const directoryPath = fixtureDirectory();
    const lock = acquire(directoryPath);
    expect(() => prepareSecureProbeRecovery({
      lock,
      priorInputSourceIdentifier: "com.apple.keylayout.ABC",
      preferences: absentPreferenceEntries(),
      temporaryPaths: [realpathSync(tmpdir())]
    })).toThrow(/disposable-host namespace/u);
  });
});
