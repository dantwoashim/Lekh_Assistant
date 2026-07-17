import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  currentInputSource,
  processIdentity,
  restoreExactInputSource,
  restorePreference,
  run,
  signalExactProcess,
  terminateExactProcess,
  wait
} from "./macos-imk-host-harness.mjs";
import {
  acquireMacOSHostStateLease,
  assertMacOSHostStateLeaseDescriptor,
  macOSHostStateLeasePath,
  releaseMacOSHostStateLease
} from "./macos-host-state-lease.mjs";

export const CANDIDATE_RECOVERY_PREFERENCES_DOMAIN = "com.lekh.inputmethod.LekhKeyboard";
export const CANDIDATE_RECOVERY_PREFERENCES_NOTIFICATION = "com.lekh.inputmethod.preferences.changed";
export const CANDIDATE_RECOVERY_PREFERENCE_KEYS = Object.freeze([
  "LekhCustomCandidatePanelEnabled",
  "LekhHostProbeDiagnosticsEnabled",
  "LekhInlinePreviewEnabled",
  "LekhNativeTypingMode",
  "LekhNativeTypingModeChosen.v2",
  "LekhPersonalizationEnabled"
]);

const schemaVersion = 1;
const recordType = "lekh-candidate-mouse-probe-recovery";
const preferenceSchema = "lekh.cfpreferences.current-user-any-host.v1";
const preferenceScope = "current-user-any-host";
const allowedKeys = new Set(CANDIDATE_RECOVERY_PREFERENCE_KEYS);
const allowedPropertyListTypes = new Set([
  "array", "boolean", "data", "date", "dictionary", "number", "string"
]);
const allowedGestureHelperRoles = new Set([
  "targeted-keys",
  "mouse-gesture",
  "textedit-launch-custodian"
]);
const modulePath = fileURLToPath(import.meta.url);
const lockHelperPath = resolve(dirname(modulePath), "..", "macos-companion-publication-lock.swift");
const guardianArgument = "--candidate-mouse-recovery-guardian";
const journalName = "candidate-mouse-probe-recovery.v1.json";
const lockName = "candidate-mouse-probe-recovery.lock";
const maximumJournalBytes = 256 * 1024;
const cleanupEvidenceKeys = Object.freeze([
  "textEditTerminated",
  "inputSourceRestored",
  "preferencesRestored",
  "temporaryDocumentRemoved",
  "mouseButtonReleased",
  "pointerRestored"
]);
const activeLocks = new WeakSet();
const transactionStates = new WeakMap();
const guardianStates = new WeakMap();

function ownerUserId() {
  const value = process.getuid?.();
  if (!Number.isInteger(value) || value < 0) throw new Error("Candidate recovery owner is unavailable.");
  return value;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an unexpected field set.`);
  }
}

function ownedNode(metadata, { label, kind, mode }) {
  const kindMatches = kind === "file" ? metadata.isFile() : metadata.isDirectory();
  if (!kindMatches || metadata.isSymbolicLink()) throw new Error(`${label} has an unsafe kind.`);
  if (metadata.uid !== ownerUserId()) throw new Error(`${label} has an unsafe owner.`);
  if ((metadata.mode & 0o777) !== mode) throw new Error(`${label} has unsafe permissions.`);
  if (kind === "file" && metadata.nlink !== 1) throw new Error(`${label} has an unsafe link count.`);
}

function descriptorMatchesPath(descriptor, path, label) {
  const descriptorMetadata = fstatSync(descriptor);
  const pathMetadata = lstatSync(path);
  ownedNode(descriptorMetadata, { label: `${label} descriptor`, kind: "file", mode: 0o600 });
  ownedNode(pathMetadata, { label, kind: "file", mode: 0o600 });
  if (descriptorMetadata.dev !== pathMetadata.dev || descriptorMetadata.ino !== pathMetadata.ino) {
    throw new Error(`${label} descriptor does not match its path.`);
  }
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

export function candidateMouseRecoveryPaths({
  directoryPath = join(
    homedir(),
    "Library",
    "Application Support",
    "Lekh Keyboard",
    "QA Recovery",
    "Candidate Mouse Probe"
  )
} = {}) {
  if (!isAbsolute(directoryPath)) throw new Error("Candidate recovery directory must be absolute.");
  const canonical = resolve(directoryPath);
  return Object.freeze({
    directoryPath: canonical,
    journalPath: join(canonical, journalName),
    lockPath: join(canonical, lockName)
  });
}

function ensureRecoveryDirectory(options = {}) {
  const paths = candidateMouseRecoveryPaths(options);
  mkdirSync(paths.directoryPath, { recursive: true, mode: 0o700 });
  ownedNode(lstatSync(paths.directoryPath), {
    label: "Candidate recovery directory",
    kind: "directory",
    mode: 0o700
  });
  return paths;
}

function assertActiveLock(lock) {
  if (!activeLocks.has(lock)) throw new Error("Candidate recovery lock is not active in this process.");
  descriptorMatchesPath(lock.descriptor, lock.paths.lockPath, "Candidate recovery lock");
  assertMacOSHostStateLeaseDescriptor(lock.hostStateLease.descriptor, lock.hostStateLease.path);
}

export function acquireCandidateMouseRecoveryLock({ directoryPath } = {}) {
  const paths = ensureRecoveryDirectory({ directoryPath });
  let descriptor = null;
  let hostStateLease = null;
  try {
    descriptor = openSync(
      paths.lockPath,
      constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    descriptorMatchesPath(descriptor, paths.lockPath, "Candidate recovery lock");
    const acquisition = spawnSync("/usr/bin/swift", [lockHelperPath, "--lock-fd", "3"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe", descriptor],
      timeout: 30_000
    });
    let evidence = null;
    try { evidence = JSON.parse(acquisition.stdout || "null"); } catch {}
    if (acquisition.status !== 0 || evidence?.status !== "acquired") {
      const busy = acquisition.status === 75 || evidence?.status === "busy";
      const error = new Error(busy
        ? "Another candidate-mouse proof owns the recovery lock."
        : "Candidate-mouse recovery lock acquisition failed.");
      error.code = busy ? "candidate-recovery-lock-busy" : "candidate-recovery-lock-failed";
      throw error;
    }
    hostStateLease = acquireMacOSHostStateLease({
      lockHelperPath,
      waitMilliseconds: 60_000
    });
    const lock = Object.freeze({ descriptor, paths, hostStateLease });
    activeLocks.add(lock);
    return lock;
  } catch (error) {
    if (hostStateLease !== null) try { releaseMacOSHostStateLease(hostStateLease); } catch {}
    if (descriptor !== null) try { closeSync(descriptor); } catch {}
    throw error;
  }
}

export function releaseCandidateMouseRecoveryLock(lock) {
  if (!activeLocks.has(lock)) return false;
  assertActiveLock(lock);
  activeLocks.delete(lock);
  closeSync(lock.descriptor);
  releaseMacOSHostStateLease(lock.hostStateLease);
  return true;
}

function validateTemporaryDocumentPath(path, recoveryDirectoryPath) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
    throw new Error("Candidate recovery document path is not canonical and absolute.");
  }
  if (
    dirname(path) !== recoveryDirectoryPath ||
    !/^\.candidate-document\.[a-f0-9]{32}\.txt$/u.test(basename(path))
  ) throw new Error("Candidate recovery document is outside its fixed namespace.");
  return path;
}

function removeTemporaryDocument(path, recoveryDirectoryPath = dirname(path)) {
  validateTemporaryDocumentPath(path, recoveryDirectoryPath);
  if (!existsSync(path)) return true;
  ownedNode(lstatSync(path), { label: "Candidate temporary document", kind: "file", mode: 0o600 });
  unlinkSync(path);
  fsyncDirectory(dirname(path));
  return !existsSync(path);
}

export function createCandidateMouseTemporaryDocument(lock, initialText) {
  assertActiveLock(lock);
  if (typeof initialText !== "string" || Buffer.byteLength(initialText, "utf8") > 4096) {
    throw new Error("Candidate temporary document seed is invalid.");
  }
  const path = join(
    lock.paths.directoryPath,
    `.candidate-document.${randomBytes(16).toString("hex")}.txt`
  );
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600
  );
  try {
    writeFileSync(descriptor, initialText, "utf8");
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  fsyncDirectory(lock.paths.directoryPath);
  return path;
}

function removeOrphanCandidateDocuments(paths) {
  let removed = 0;
  for (const name of readdirSync(paths.directoryPath)) {
    if (!/^\.candidate-document\.[a-f0-9]{32}\.txt$/u.test(name)) continue;
    if (!removeTemporaryDocument(join(paths.directoryPath, name), paths.directoryPath)) return -1;
    removed += 1;
  }
  return removed;
}

function validatePreference(entry) {
  exactKeys(entry, [
    "schema", "scope", "domain", "key", "exists", "propertyListType", "propertyListBase64"
  ], "Candidate recovery preference");
  if (
    entry.schema !== preferenceSchema ||
    entry.scope !== preferenceScope ||
    entry.domain !== CANDIDATE_RECOVERY_PREFERENCES_DOMAIN ||
    !allowedKeys.has(entry.key) ||
    typeof entry.exists !== "boolean" ||
    typeof entry.propertyListType !== "string" ||
    typeof entry.propertyListBase64 !== "string"
  ) throw new Error("Candidate recovery preference is invalid.");
  if (!entry.exists) {
    if (entry.propertyListType !== "absent" || entry.propertyListBase64 !== "") {
      throw new Error("Absent candidate recovery preference is malformed.");
    }
  } else {
    if (!allowedPropertyListTypes.has(entry.propertyListType)) {
      throw new Error("Candidate recovery preference type is unsupported.");
    }
    const data = Buffer.from(entry.propertyListBase64, "base64");
    if (!entry.propertyListBase64 || data.length > 128 * 1024 || data.toString("base64") !== entry.propertyListBase64) {
      throw new Error("Candidate recovery preference payload is invalid.");
    }
  }
  return Object.freeze({ ...entry });
}

export function candidatePreferenceRecoveryEntries(snapshots) {
  if (!snapshots || typeof snapshots !== "object" || Array.isArray(snapshots)) {
    throw new Error("Candidate recovery preference snapshots are missing.");
  }
  const expected = [...CANDIDATE_RECOVERY_PREFERENCE_KEYS].sort();
  const actual = Object.keys(snapshots).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Candidate recovery requires every exact preference snapshot.");
  }
  return expected.map((key) => {
    const snapshot = snapshots[key];
    if (!snapshot || snapshot.status !== 0 || snapshot.stderr !== "") {
      throw new Error("Candidate recovery preference snapshot is incomplete.");
    }
    return validatePreference({
      schema: snapshot.schema,
      scope: snapshot.scope,
      domain: snapshot.domain,
      key: snapshot.key,
      exists: snapshot.exists,
      propertyListType: snapshot.propertyListType,
      propertyListBase64: snapshot.propertyListBase64
    });
  });
}

function validatePoint(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
      Math.abs(point.x) > 1_000_000 || Math.abs(point.y) > 1_000_000) {
    throw new Error("Candidate recovery mouse point is invalid.");
  }
  return Object.freeze({ x: point.x, y: point.y });
}

function validateMouseSafety(value) {
  exactKeys(value, [
    "mayBeDown", "releasePoint", "originalPointer", "initialLeftButtonReleased"
  ], "Candidate recovery mouse safety");
  if (
    typeof value.mayBeDown !== "boolean" ||
    ![null, true, false].includes(value.initialLeftButtonReleased)
  ) throw new Error("Candidate recovery mouse phase is invalid.");
  const releasePoint = value.releasePoint === null ? null : validatePoint(value.releasePoint);
  const originalPointer = value.originalPointer === null ? null : validatePoint(value.originalPointer);
  if (value.mayBeDown && (
    releasePoint === null ||
    originalPointer === null ||
    value.initialLeftButtonReleased !== true
  )) {
    throw new Error("An armed candidate mouse recovery lacks a released-button pointer baseline.");
  }
  return Object.freeze({
    mayBeDown: value.mayBeDown,
    releasePoint,
    originalPointer,
    initialLeftButtonReleased: value.initialLeftButtonReleased
  });
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function textEditIdentity(processIdentifier, executablePath) {
  const canonical = realpathSync(executablePath);
  if (!canonical.endsWith("/TextEdit.app/Contents/MacOS/TextEdit")) {
    throw new Error("Candidate recovery host is not TextEdit.");
  }
  const identity = processIdentity(processIdentifier);
  if (identity.status !== 0 || identity.state !== "running" || identity.executablePath !== canonical) {
    throw new Error("Candidate recovery could not bind the exact TextEdit process instance.");
  }
  return Object.freeze({
    processIdentifier,
    executablePath: canonical,
    executableSha256: hashFile(canonical),
    processStartToken: identity.processStartToken
  });
}

function gestureHelperIdentity(processIdentifier, executablePath, role) {
  const canonical = realpathSync(executablePath);
  if (
    !/(?:^|\/)(?:swift|swift-driver|swift-frontend)$/u.test(canonical) ||
    !(
      canonical.startsWith("/usr/bin/") ||
      canonical.startsWith("/Library/Developer/CommandLineTools/usr/bin/") ||
      canonical.includes("/Toolchains/")
    )
  ) throw new Error("Candidate recovery gesture helper is not an exact Swift toolchain process.");
  if (!allowedGestureHelperRoles.has(role)) {
    throw new Error("Candidate recovery gesture-helper role is invalid.");
  }
  const identity = processIdentity(processIdentifier);
  if (identity.status !== 0 || identity.state !== "running" || identity.executablePath !== canonical) {
    throw new Error("Candidate recovery could not bind the exact gesture-helper process instance.");
  }
  return Object.freeze({
    processIdentifier,
    executablePath: canonical,
    executableSha256: hashFile(canonical),
    processStartToken: identity.processStartToken,
    role
  });
}

function validateCleanupEvidence(value) {
  exactKeys(value, cleanupEvidenceKeys, "Candidate normal cleanup evidence");
  if (Object.values(value).some((item) => item !== true)) {
    throw new Error("Candidate normal completion requires every cleanup invariant.");
  }
  return Object.freeze({ ...value });
}

function cleanupFailureMask(evidence) {
  return cleanupEvidenceKeys.reduce(
    (mask, key, index) => mask | (evidence?.[key] === true ? 0 : (1 << index)),
    0
  );
}

function validateRecord(record, expectedRecoveryDirectoryPath = null) {
  exactKeys(record, [
    "schemaVersion", "recordType", "recoveryIdentifier", "ownerUserId",
    "parentProcessIdentifier", "createdAtUnixMs", "phase", "recoveryDirectoryPath", "priorInputSourceIdentifier",
    "preferences", "temporaryDocumentPath", "hostProcess", "mouseSafety",
    "gestureHelperProcess",
    "normalCompletionTokenSha256", "normalCleanupEvidence"
  ], "Candidate recovery journal");
  if (
    record.schemaVersion !== schemaVersion || record.recordType !== recordType ||
    record.ownerUserId !== ownerUserId() || !Number.isInteger(record.parentProcessIdentifier) ||
    record.parentProcessIdentifier <= 1 || !Number.isSafeInteger(record.createdAtUnixMs) ||
    !/^[a-f0-9]{32}$/u.test(record.recoveryIdentifier ?? "") ||
    !["prepared", "normal-completion-recorded"].includes(record.phase) ||
    typeof record.priorInputSourceIdentifier !== "string" || !record.priorInputSourceIdentifier ||
    !isAbsolute(record.recoveryDirectoryPath) || resolve(record.recoveryDirectoryPath) !== record.recoveryDirectoryPath ||
    (expectedRecoveryDirectoryPath !== null && record.recoveryDirectoryPath !== expectedRecoveryDirectoryPath)
  ) throw new Error("Candidate recovery journal identity is invalid.");
  const preferences = record.preferences.map(validatePreference);
  if (preferences.length !== CANDIDATE_RECOVERY_PREFERENCE_KEYS.length ||
      CANDIDATE_RECOVERY_PREFERENCE_KEYS.some((key) => !preferences.some((entry) => entry.key === key))) {
    throw new Error("Candidate recovery journal preference set is invalid.");
  }
  const temporaryDocumentPath = validateTemporaryDocumentPath(
    record.temporaryDocumentPath,
    record.recoveryDirectoryPath
  );
  let hostProcess = null;
  if (record.hostProcess !== null) {
    exactKeys(record.hostProcess, [
      "processIdentifier", "executablePath", "executableSha256", "processStartToken"
    ], "Candidate recovery host");
    if (!Number.isInteger(record.hostProcess.processIdentifier) || record.hostProcess.processIdentifier <= 1 ||
        !isAbsolute(record.hostProcess.executablePath) || resolve(record.hostProcess.executablePath) !== record.hostProcess.executablePath ||
        !record.hostProcess.executablePath.endsWith("/TextEdit.app/Contents/MacOS/TextEdit") ||
        !/^[a-f0-9]{64}$/u.test(record.hostProcess.executableSha256 ?? "") ||
        !/^\d{1,20}:\d{1,6}$/u.test(record.hostProcess.processStartToken ?? "")) {
      throw new Error("Candidate recovery host identity is invalid.");
    }
    hostProcess = Object.freeze({ ...record.hostProcess });
  }
  let gestureHelperProcess = null;
  if (record.gestureHelperProcess !== null) {
    exactKeys(
      record.gestureHelperProcess,
      ["processIdentifier", "executablePath", "executableSha256", "processStartToken", "role"],
      "Candidate recovery gesture helper"
    );
    if (
      !Number.isInteger(record.gestureHelperProcess.processIdentifier) ||
      record.gestureHelperProcess.processIdentifier <= 1 ||
      !isAbsolute(record.gestureHelperProcess.executablePath) ||
      resolve(record.gestureHelperProcess.executablePath) !== record.gestureHelperProcess.executablePath ||
      !/(?:^|\/)(?:swift|swift-driver|swift-frontend)$/u.test(record.gestureHelperProcess.executablePath) ||
      !(
        record.gestureHelperProcess.executablePath.startsWith("/usr/bin/") ||
        record.gestureHelperProcess.executablePath.startsWith("/Library/Developer/CommandLineTools/usr/bin/") ||
        record.gestureHelperProcess.executablePath.includes("/Toolchains/")
      ) ||
      !/^[a-f0-9]{64}$/u.test(record.gestureHelperProcess.executableSha256 ?? "") ||
      !/^\d{1,20}:\d{1,6}$/u.test(record.gestureHelperProcess.processStartToken ?? "") ||
      !allowedGestureHelperRoles.has(record.gestureHelperProcess.role)
    ) throw new Error("Candidate recovery gesture-helper identity is invalid.");
    gestureHelperProcess = Object.freeze({ ...record.gestureHelperProcess });
  }
  const mouseSafety = validateMouseSafety(record.mouseSafety);
  if (record.phase === "prepared") {
    if (record.normalCompletionTokenSha256 !== null || record.normalCleanupEvidence !== null) {
      throw new Error("Prepared candidate recovery journal contains completion evidence.");
    }
  } else {
    if (!/^[a-f0-9]{64}$/u.test(record.normalCompletionTokenSha256 ?? "")) {
      throw new Error("Candidate recovery completion token is invalid.");
    }
    validateCleanupEvidence(record.normalCleanupEvidence);
  }
  return Object.freeze({
    ...record,
    preferences,
    temporaryDocumentPath,
    hostProcess,
    gestureHelperProcess,
    mouseSafety
  });
}

function atomicWrite(paths, record) {
  const validated = validateRecord(record, paths.directoryPath);
  const serialized = `${JSON.stringify(validated)}\n`;
  if (Buffer.byteLength(serialized) > maximumJournalBytes) throw new Error("Candidate recovery journal is too large.");
  const temporary = join(paths.directoryPath, `.candidate-recovery.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let descriptor = null;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, paths.journalPath);
    fsyncDirectory(paths.directoryPath);
  } finally {
    if (descriptor !== null) try { closeSync(descriptor); } catch {}
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function readJournal(paths) {
  if (!existsSync(paths.journalPath)) return null;
  const descriptor = openSync(paths.journalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    descriptorMatchesPath(descriptor, paths.journalPath, "Candidate recovery journal");
    const metadata = fstatSync(descriptor);
    if (metadata.size <= 0 || metadata.size > maximumJournalBytes) throw new Error("Candidate recovery journal size is invalid.");
    return validateRecord(JSON.parse(readFileSync(descriptor, "utf8")), paths.directoryPath);
  } finally { closeSync(descriptor); }
}

function removeJournal(paths) {
  if (!existsSync(paths.journalPath)) return;
  ownedNode(lstatSync(paths.journalPath), { label: "Candidate recovery journal", kind: "file", mode: 0o600 });
  unlinkSync(paths.journalPath);
  fsyncDirectory(paths.directoryPath);
}

export function inspectCandidateMouseRecoveryJournal(lock) {
  assertActiveLock(lock);
  return readJournal(lock.paths);
}

export function prepareCandidateMouseRecovery({
  lock,
  priorInputSourceIdentifier,
  preferences,
  temporaryDocumentPath
}) {
  assertActiveLock(lock);
  if (readJournal(lock.paths)) throw new Error("Prior candidate recovery must finish before preparation.");
  const normalCompletionToken = randomBytes(32).toString("hex");
  const record = validateRecord({
    schemaVersion,
    recordType,
    recoveryIdentifier: randomBytes(16).toString("hex"),
    ownerUserId: ownerUserId(),
    parentProcessIdentifier: process.pid,
    createdAtUnixMs: Date.now(),
    phase: "prepared",
    recoveryDirectoryPath: lock.paths.directoryPath,
    priorInputSourceIdentifier,
    preferences,
    temporaryDocumentPath,
    hostProcess: null,
    gestureHelperProcess: null,
    mouseSafety: {
      mayBeDown: false,
      releasePoint: null,
      originalPointer: null,
      initialLeftButtonReleased: null
    },
    normalCompletionTokenSha256: null,
    normalCleanupEvidence: null
  });
  atomicWrite(lock.paths, record);
  const transaction = Object.freeze({ recoveryIdentifier: record.recoveryIdentifier, journalPath: lock.paths.journalPath });
  transactionStates.set(transaction, { lock, normalCompletionToken, completionRecorded: false });
  return transaction;
}

function transactionRecord(transaction) {
  const state = transactionStates.get(transaction);
  if (!state) throw new Error("Candidate recovery transaction is unknown.");
  assertActiveLock(state.lock);
  const record = readJournal(state.lock.paths);
  if (!record || record.recoveryIdentifier !== transaction.recoveryIdentifier) {
    throw new Error("Candidate recovery transaction no longer matches durable state.");
  }
  return { state, record };
}

export function updateCandidateMouseRecovery(transaction, {
  hostProcess,
  gestureHelperProcess,
  mouseSafety
} = {}) {
  const { state, record } = transactionRecord(transaction);
  if (record.phase !== "prepared") throw new Error("Completed candidate recovery cannot be updated.");
  const next = validateRecord({
    ...record,
    hostProcess: hostProcess === undefined
      ? record.hostProcess
      : hostProcess === null ? null : textEditIdentity(hostProcess.processIdentifier, hostProcess.executablePath),
    gestureHelperProcess: gestureHelperProcess === undefined
      ? record.gestureHelperProcess
      : gestureHelperProcess === null
        ? null
        : gestureHelperIdentity(
          gestureHelperProcess.processIdentifier,
          gestureHelperProcess.executablePath,
          gestureHelperProcess.role
        ),
    mouseSafety: mouseSafety === undefined ? record.mouseSafety : validateMouseSafety(mouseSafety)
  });
  atomicWrite(state.lock.paths, next);
  return next;
}

export function markCandidateMouseRecoveryComplete(transaction, cleanupEvidence) {
  const { state, record } = transactionRecord(transaction);
  if (record.phase !== "prepared") throw new Error("Candidate recovery completion was already recorded.");
  if (record.gestureHelperProcess !== null) {
    throw new Error("Candidate recovery cannot complete while a gesture helper remains journaled.");
  }
  const next = validateRecord({
    ...record,
    phase: "normal-completion-recorded",
    normalCompletionTokenSha256: createHash("sha256").update(state.normalCompletionToken).digest("hex"),
    normalCleanupEvidence: validateCleanupEvidence(cleanupEvidence)
  });
  atomicWrite(state.lock.paths, next);
  state.completionRecorded = true;
  return next;
}

export function candidateEmergencyMouseUpSource(point = { x: 0, y: 0 }, forcePost = true) {
  const safePoint = validatePoint(point);
  return `
import CoreGraphics
import Foundation
let releasePoint = CGPoint(x: ${safePoint.x}, y: ${safePoint.y})
let forcePost = ${forcePost ? "true" : "false"}
let before = CGEventSource.buttonState(.combinedSessionState, button: .left)
var posted = false
var pointerDisposition = "observe-only"
// Observe-only checks must never synthesize a global mouse-up: the observed state can
// represent a user-owned physical drag that this probe did not create.
if forcePost {
  guard let currentPointer = CGEvent(source: nil)?.location else { exit(2) }
  let userMoved = abs(currentPointer.x - releasePoint.x) > 2 || abs(currentPointer.y - releasePoint.y) > 2
  let causalReleasePoint = userMoved ? currentPointer : releasePoint
  let source = CGEventSource(stateID: .hidSystemState)
  guard let mouseUp = CGEvent(
    mouseEventSource: source,
    mouseType: .leftMouseUp,
    mouseCursorPosition: causalReleasePoint,
    mouseButton: .left
  ) else { exit(2) }
  mouseUp.setIntegerValueField(.eventSourceUserData, value: 0x4C454B4800000004)
  mouseUp.post(tap: .cghidEventTap)
  posted = true
  pointerDisposition = userMoved ? "user-movement-preserved" : "synthetic-release-point"
  usleep(100_000)
}
let after = CGEventSource.buttonState(.combinedSessionState, button: .left)
let output: [String: Any] = [
  "beforeDown": before,
  "pointerDisposition": pointerDisposition,
  "posted": posted,
  "released": !after
]
let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
if after { exit(3) }
`;
}

export function ensureCandidateMouseButtonReleased({ point = { x: 0, y: 0 }, forcePost = false } = {}) {
  const result = run("/usr/bin/swift", ["-e", candidateEmergencyMouseUpSource(point, forcePost)]);
  let observed = null;
  try { observed = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1) ?? "null"); } catch {}
  return {
    status: result.status === 0 && observed?.released === true ? 0 : result.status || 3,
    released: observed?.released === true,
    posted: observed?.posted === true,
    pointerDisposition: ["observe-only", "synthetic-release-point", "user-movement-preserved"]
      .includes(observed?.pointerDisposition) ? observed.pointerDisposition : "unknown"
  };
}

export function restoreCandidatePointer(originalPointer, syntheticReleasePoint) {
  const validated = validatePoint(originalPointer);
  const release = validatePoint(syntheticReleasePoint);
  const result = run("/usr/bin/swift", ["-e", `
import CoreGraphics
import Foundation
let expected = CGPoint(x: ${validated.x}, y: ${validated.y})
let synthetic = CGPoint(x: ${release.x}, y: ${release.y})
guard let before = CGEvent(source: nil)?.location else { exit(2) }
let movedBeforeRecovery = abs(before.x - synthetic.x) > 2 || abs(before.y - synthetic.y) > 2
var disposition = "user-movement-preserved"
var restored = movedBeforeRecovery
if !movedBeforeRecovery {
  CGWarpMouseCursorPosition(expected)
  usleep(100_000)
  guard let observed = CGEvent(source: nil)?.location else { exit(2) }
  if abs(observed.x - expected.x) <= 2 && abs(observed.y - expected.y) <= 2 {
    disposition = "original-pointer-restored"
    restored = true
  } else if abs(observed.x - synthetic.x) > 2 || abs(observed.y - synthetic.y) > 2 {
    // A user or WindowServer transition won the race after the warp. The safe
    // result is to preserve that movement, not to fight it with another warp.
    disposition = "user-movement-preserved"
    restored = true
  } else {
    disposition = "synthetic-pointer-remains"
    restored = false
  }
}
let output: [String: Any] = ["disposition": disposition, "restored": restored]
let data = try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
if !restored { exit(3) }
`]);
  let evidence = null;
  try { evidence = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1) ?? "null"); } catch {}
  return {
    status: result.status === 0 && evidence?.restored === true ? 0 : result.status || 3,
    restored: evidence?.restored === true,
    disposition: ["original-pointer-restored", "user-movement-preserved"]
      .includes(evidence?.disposition) ? evidence.disposition : "unknown"
  };
}

function terminateTextEdit(host) {
  if (!host) return true;
  const running = processIdentity(host.processIdentifier);
  if (["absent", "terminated"].includes(running.state)) return true;
  if (running.status !== 0 || running.state !== "running") return false;
  if (running.executablePath !== host.executablePath || running.processStartToken !== host.processStartToken) return true;
  if (hashFile(running.executablePath) !== host.executableSha256) return false;
  const termination = terminateExactProcess(host);
  return termination.status === 0 && termination.terminated === true;
}

function terminateGestureHelper(helper) {
  if (!helper) return true;
  const running = processIdentity(helper.processIdentifier);
  if (["absent", "terminated"].includes(running.state)) return true;
  if (running.status !== 0 || running.state !== "running") return false;
  if (running.executablePath !== helper.executablePath || running.processStartToken !== helper.processStartToken) return true;
  if (hashFile(running.executablePath) !== helper.executableSha256) return false;
  const termination = terminateExactProcess(helper, {
    termTimeoutMs: 1_500,
    killTimeoutMs: 1_000,
    pollIntervalMs: 50
  });
  return termination.status === 0 && termination.terminated === true;
}

function settleTextEditLaunchCustodian(helper) {
  if (!helper) return true;
  const running = processIdentity(helper.processIdentifier);
  if (["absent", "terminated"].includes(running.state)) return true;
  if (running.status !== 0 || running.state !== "running") return false;
  if (running.executablePath !== helper.executablePath || running.processStartToken !== helper.processStartToken) {
    return true;
  }
  if (hashFile(running.executablePath) !== helper.executableSha256) return false;
  const term = signalExactProcess(helper, "TERM");
  if (term.status !== 0) return false;
  if (["absent", "identity-mismatch"].includes(term.disposition)) return true;
  if (term.disposition !== "signaled") return false;
  // Never escalate this role to SIGKILL. Its synchronous LaunchServices call
  // may be between request and PID return; the custodian must regain control,
  // bind any created TextEdit epoch, and terminate it itself. If it cannot do
  // so within this bounded grace period, retain the journal and mutate nothing.
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const observed = processIdentity(helper.processIdentifier);
    if (["absent", "terminated"].includes(observed.state)) return true;
    if (observed.state === "running" && (
      observed.executablePath !== helper.executablePath ||
      observed.processStartToken !== helper.processStartToken
    )) return true;
    if (observed.status !== 0 || observed.state !== "running") return false;
    wait(50);
  }
  return false;
}

export function restoreCandidateMouseRecoveryRecord(record, adapters = {}) {
  const validated = validateRecord(record);
  const operations = {
    releaseMouse: adapters.releaseMouse ?? ensureCandidateMouseButtonReleased,
    restorePointer: adapters.restorePointer ?? restoreCandidatePointer,
    terminateGestureHelper: adapters.terminateGestureHelper ?? terminateGestureHelper,
    settleLaunchCustodian: adapters.settleLaunchCustodian ?? settleTextEditLaunchCustodian,
    terminateTextEdit: adapters.terminateTextEdit ?? terminateTextEdit,
    restoreInputSource: adapters.restoreInputSource ?? restoreExactInputSource,
    currentInputSource: adapters.currentInputSource ?? currentInputSource,
    restorePreference: adapters.restorePreference ?? restorePreference,
    notifyPreferencesChanged: adapters.notifyPreferencesChanged ?? (() =>
      run("/usr/bin/notifyutil", ["-p", CANDIDATE_RECOVERY_PREFERENCES_NOTIFICATION])),
    removeTemporaryDocument: adapters.removeTemporaryDocument ?? ((path) =>
      removeTemporaryDocument(path, validated.recoveryDirectoryPath))
  };
  const releasePoint = validated.mouseSafety.releasePoint ?? { x: 0, y: 0 };
  // Stop the exact helper first. Otherwise an orphan could post a new down
  // after the guardian's compensating up and leave global button state stuck.
  const gestureHelperTerminated = validated.gestureHelperProcess?.role === "textedit-launch-custodian"
    ? operations.settleLaunchCustodian(validated.gestureHelperProcess) === true
    : operations.terminateGestureHelper(validated.gestureHelperProcess) === true;
  if (!gestureHelperTerminated) {
    // Do not mutate any other global or host state while the event producer's
    // exact disposition is unknown. Retain the journal for a later exclusive
    // owner that can prove termination and resume in the prescribed order.
    return {
      status: "recovery-incomplete",
      cleanupEvidence: {
        textEditTerminated: false,
        inputSourceRestored: false,
        preferencesRestored: false,
        temporaryDocumentRemoved: false,
        mouseButtonReleased: false,
        pointerRestored: false
      }
    };
  }
  const mouse = operations.releaseMouse({
    point: releasePoint,
    forcePost: validated.mouseSafety.mayBeDown
  });
  const mouseButtonReleased = gestureHelperTerminated &&
    (mouse === true || (mouse?.status === 0 && mouse?.released === true));
  const pointer = validated.mouseSafety.originalPointer === null
    ? { status: 0, restored: true }
    : mouseButtonReleased && mouse?.pointerDisposition === "user-movement-preserved"
      ? { status: 0, restored: true, disposition: "user-movement-preserved" }
    : gestureHelperTerminated && mouseButtonReleased
      ? operations.restorePointer(validated.mouseSafety.originalPointer, releasePoint)
      : { status: 3, restored: false };
  const pointerRestored = pointer === true || (pointer?.status === 0 && pointer?.restored === true);
  const textEditTerminated = operations.terminateTextEdit(validated.hostProcess) === true;
  const sourceRestore = operations.restoreInputSource(validated.priorInputSourceIdentifier);
  const inputSourceRestored = (sourceRestore === true || sourceRestore?.status === 0) &&
    operations.currentInputSource()?.id === validated.priorInputSourceIdentifier;
  const preferenceWritesRestored = validated.preferences.every((entry) => {
    const snapshot = { status: 0, ...entry, stderr: "" };
    const restored = operations.restorePreference(entry.domain, entry.key, snapshot);
    // restorePreference performs a type-preserving, semantic property-list
    // read-back in one Swift process. Binary plist bytes are not an equality
    // token because dictionary serialization order is nondeterministic.
    return restored === true || (restored?.status === 0 && restored?.readBackEqual === true);
  });
  const notification = operations.notifyPreferencesChanged();
  const preferencesRestored = preferenceWritesRestored &&
    (notification === true || notification?.status === 0);
  const temporaryDocumentRemoved = textEditTerminated &&
    operations.removeTemporaryDocument(validated.temporaryDocumentPath) === true;
  const cleanupEvidence = {
    textEditTerminated,
    inputSourceRestored,
    preferencesRestored,
    temporaryDocumentRemoved,
    mouseButtonReleased,
    pointerRestored
  };
  return {
    status: Object.values(cleanupEvidence).every(Boolean) ? "recovered" : "recovery-incomplete",
    cleanupEvidence
  };
}

export function recoverCandidateMouseState({ lock, adapters } = {}) {
  assertActiveLock(lock);
  const record = readJournal(lock.paths);
  if (!record) {
    const orphanCount = removeOrphanCandidateDocuments(lock.paths);
    return {
      status: orphanCount < 0 ? "recovery-incomplete" : orphanCount > 0 ? "recovered" : "no-recovery-required",
      cleanupEvidence: null
    };
  }
  const recovery = restoreCandidateMouseRecoveryRecord(record, adapters);
  if (recovery.status === "recovered") removeJournal(lock.paths);
  return recovery;
}

async function guardianControl() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 256) return { valid: false, token: "" };
    chunks.push(chunk);
  }
  const value = Buffer.concat(chunks).toString("utf8");
  const token = value.endsWith("\n") ? value.slice(0, -1) : "";
  return { valid: /^[a-f0-9]{64}$/u.test(token) && value === `${token}\n`, token };
}

function completionMatches(record, control) {
  if (record.phase !== "normal-completion-recorded" || !control.valid ||
      !record.normalCleanupEvidence || !Object.values(record.normalCleanupEvidence).every(Boolean)) return false;
  const actual = createHash("sha256").update(control.token).digest();
  const expected = Buffer.from(record.normalCompletionTokenSha256, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function guardianMain(directoryPath) {
  const paths = ensureRecoveryDirectory({ directoryPath });
  descriptorMatchesPath(3, paths.lockPath, "Inherited candidate recovery lock");
  assertMacOSHostStateLeaseDescriptor(4, macOSHostStateLeasePath());
  const initial = readJournal(paths);
  if (!initial) throw new Error("Candidate guardian has no durable journal.");
  process.stdout.write("READY\n");
  const control = await guardianControl();
  const current = readJournal(paths);
  if (!current || current.recoveryIdentifier !== initial.recoveryIdentifier) {
    throw new Error("Candidate guardian journal identity changed.");
  }
  if (completionMatches(current, control)) {
    removeJournal(paths);
    process.stdout.write("SKIPPED\n");
    return 0;
  }
  const recovery = restoreCandidateMouseRecoveryRecord(current);
  if (recovery.status !== "recovered") {
    process.stdout.write(`INCOMPLETE:${cleanupFailureMask(recovery.cleanupEvidence).toString(16).padStart(2, "0")}\n`);
    return 1;
  }
  removeJournal(paths);
  process.stdout.write("RECOVERED\n");
  return 0;
}

export async function launchCandidateMouseRecoveryGuardian({ lock, transaction, readyTimeoutMs = 5_000 }) {
  const { state, record } = transactionRecord(transaction);
  if (state.lock !== lock || record.phase !== "prepared") throw new Error("Candidate guardian transaction mismatch.");
  const child = spawn(process.execPath, [modulePath, guardianArgument, lock.paths.directoryPath], {
    stdio: ["pipe", "pipe", "ignore", lock.descriptor, lock.hostStateLease.descriptor]
  });
  child.stdout.setEncoding("utf8");
  let output = "";
  let stdinError = null;
  child.stdin.on("error", (error) => { stdinError = error; });
  const closed = new Promise((resolveClosed) => child.once("close", (exitCode, signal) =>
    resolveClosed({ exitCode, signal })));
  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error("Candidate guardian readiness timed out.")), readyTimeoutMs);
    const fail = () => { clearTimeout(timer); rejectReady(new Error("Candidate guardian exited before readiness.")); };
    child.once("error", fail);
    child.once("exit", fail);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 128) {
        clearTimeout(timer);
        rejectReady(new Error("Candidate guardian readiness output is invalid."));
      } else if (output.startsWith("READY\n")) {
        clearTimeout(timer);
        child.off("error", fail);
        child.off("exit", fail);
        resolveReady(true);
      }
    });
  }).catch((error) => {
    if (child.exitCode === null) child.kill("SIGTERM");
    throw error;
  });
  const guardian = Object.freeze({ child, processIdentifier: child.pid ?? null });
  guardianStates.set(guardian, { transaction, closed, output: () => output, stdinError: () => stdinError, signaled: false });
  return guardian;
}

export function assertCandidateMouseRecoveryGuardianAlive(guardian) {
  if (!guardianStates.has(guardian) || guardian.child.exitCode !== null || guardian.child.signalCode !== null || guardian.child.killed) {
    throw new Error("Candidate recovery guardian is not alive.");
  }
  return true;
}

export function signalCandidateMouseRecoveryGuardianCompletion(guardian) {
  const guardianState = guardianStates.get(guardian);
  const transactionState = guardianState && transactionStates.get(guardianState.transaction);
  if (!guardianState || !transactionState?.completionRecorded || guardianState.signaled) {
    throw new Error("Candidate guardian normal completion is not durable.");
  }
  assertCandidateMouseRecoveryGuardianAlive(guardian);
  guardianState.signaled = true;
  guardian.child.stdin.end(`${transactionState.normalCompletionToken}\n`);
}

export function triggerCandidateMouseRecoveryGuardian(guardian) {
  const state = guardianStates.get(guardian);
  if (!state || state.signaled) throw new Error("Candidate guardian control pipe is unavailable.");
  assertCandidateMouseRecoveryGuardianAlive(guardian);
  state.signaled = true;
  guardian.child.stdin.end();
}

export function waitForCandidateMouseRecoveryGuardian(guardian, { timeoutMs = 12_000 } = {}) {
  const state = guardianStates.get(guardian);
  if (!state) return Promise.reject(new Error("Candidate recovery guardian is unknown."));
  return new Promise((resolveWait, rejectWait) => {
    const timer = setTimeout(() => rejectWait(new Error("Candidate guardian settlement timed out.")), timeoutMs);
    state.closed.then(({ exitCode, signal }) => {
      clearTimeout(timer);
      const output = state.output();
      const incomplete = /(?:^|\n)INCOMPLETE:([0-9a-f]{2})\n/u.exec(output);
      const guardianFault = output.includes("FAULT\n");
      resolveWait({
        status: exitCode === 0 && state.stdinError() === null ? "completed" : "failed",
        exitCode,
        signal,
        disposition: output.includes("SKIPPED\n")
          ? "normal-completion"
          : output.includes("RECOVERED\n")
            ? "crash-recovery"
            : incomplete
              ? "recovery-incomplete"
              : guardianFault ? "guardian-fault" : "unknown",
        ...(incomplete ? { cleanupFailureMask: incomplete[1] } : {})
      });
    }, (error) => { clearTimeout(timer); rejectWait(error); });
  });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(modulePath);
if (invokedDirectly) {
  if (process.argv.length !== 4 || process.argv[2] !== guardianArgument) {
    process.exitCode = 64;
  } else {
    try { process.exitCode = await guardianMain(process.argv[3]); }
    catch {
      process.stdout.write("FAULT\n");
      process.exitCode = 1;
    }
  }
}
