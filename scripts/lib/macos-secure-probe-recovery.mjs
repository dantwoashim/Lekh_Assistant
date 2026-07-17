import { spawn, spawnSync } from "node:child_process";
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
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  currentInputSource,
  processIdentity,
  restoreExactInputSource,
  restorePreference,
  run,
  secureEventInputState,
  snapshotPreference,
  terminateExactProcess,
  wait
} from "./macos-imk-host-harness.mjs";
import {
  acquireMacOSHostStateLease,
  assertMacOSHostStateLeaseDescriptor,
  macOSHostStateLeasePath,
  releaseMacOSHostStateLease
} from "./macos-host-state-lease.mjs";

export const SECURE_PROBE_RECOVERY_SCHEMA_VERSION = 1;
export const SECURE_PROBE_RECOVERY_RECORD_TYPE = "lekh-secure-field-probe-recovery";
export const SECURE_PROBE_PREFERENCES_DOMAIN = "com.lekh.inputmethod.LekhKeyboard";
export const SECURE_PROBE_PREFERENCES_NOTIFICATION = "com.lekh.inputmethod.preferences.changed";
export const SECURE_PROBE_PREFERENCE_SCHEMA = "lekh.cfpreferences.current-user-any-host.v1";
export const SECURE_PROBE_PREFERENCE_SCOPE = "current-user-any-host";
export const SECURE_PROBE_PREFERENCE_KEYS = Object.freeze([
  "LekhCustomCandidatePanelEnabled",
  "LekhExcludedApplicationBundleIdentifiers",
  "LekhHostProbeDiagnosticsEnabled",
  "LekhInlinePreviewEnabled",
  "LekhNativeTypingMode",
  "LekhNativeTypingModeChosen.v2",
  "LekhNextWordPredictionEnabled",
  "LekhPersonalizationEnabled"
]);

const allowedPreferenceKeys = new Set(SECURE_PROBE_PREFERENCE_KEYS);
const allowedPropertyListTypes = new Set([
  "array", "boolean", "data", "date", "dictionary", "number", "string"
]);
const modulePath = fileURLToPath(import.meta.url);
const moduleDirectory = dirname(modulePath);
const defaultLockHelper = resolve(moduleDirectory, "..", "macos-companion-publication-lock.swift");
const guardianArgument = "--secure-probe-recovery-guardian";
const journalName = "secure-field-probe-recovery.v1.json";
const lockName = "secure-field-probe-recovery.lock";
const maximumJournalBytes = 256 * 1024;
const maximumSnapshotBytes = 128 * 1024;
const maximumGuardianControlBytes = 256;
const temporaryDirectoryPrefix = "lekh-secure-field-host-";
const cleanupEvidenceKeys = Object.freeze([
  "hostTerminated",
  "inputSourceRestored",
  "preferencesRestored",
  "secureInputReturnedToBaseline",
  "temporaryHostRemoved"
]);
const activeLocks = new WeakSet();
const transactionPrivateState = new WeakMap();
const guardianPrivateState = new WeakMap();

function ownerUserId() {
  const uid = process.getuid?.();
  if (!Number.isInteger(uid) || uid < 0) {
    throw new Error("The secure-probe recovery owner could not be identified.");
  }
  return uid;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains an unexpected or missing field.`);
  }
}

function isPlainString(value, maximumLength) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function validateOwnedNode(metadata, { label, kind, mode }) {
  const correctKind = kind === "file" ? metadata.isFile() : metadata.isDirectory();
  if (!correctKind || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a regular ${kind}.`);
  }
  if (metadata.uid !== ownerUserId()) {
    throw new Error(`${label} is not owned by the invoking user.`);
  }
  if ((metadata.mode & 0o777) !== mode) {
    throw new Error(`${label} has unsafe permissions.`);
  }
  if (kind === "file" && metadata.nlink !== 1) {
    throw new Error(`${label} must have exactly one hard link.`);
  }
}

function assertDescriptorMatchesPath(descriptor, path, label, mode = 0o600) {
  const descriptorMetadata = fstatSync(descriptor);
  const pathMetadata = lstatSync(path);
  validateOwnedNode(descriptorMetadata, { label: `${label} descriptor`, kind: "file", mode });
  validateOwnedNode(pathMetadata, { label, kind: "file", mode });
  if (descriptorMetadata.dev !== pathMetadata.dev || descriptorMetadata.ino !== pathMetadata.ino) {
    throw new Error(`${label} descriptor does not identify the validated path.`);
  }
  return descriptorMetadata;
}

function fsyncDirectory(directoryPath) {
  const descriptor = openSync(directoryPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function secureProbeRecoveryPaths({
  homeDirectory = homedir(),
  directoryPath = join(
    homeDirectory,
    "Library",
    "Application Support",
    "Lekh Keyboard",
    "QA Recovery",
    "Secure Field Probe"
  )
} = {}) {
  if (!isAbsolute(directoryPath)) {
    throw new Error("The secure-probe recovery directory must be absolute.");
  }
  return Object.freeze({
    directoryPath: resolve(directoryPath),
    journalPath: join(resolve(directoryPath), journalName),
    lockPath: join(resolve(directoryPath), lockName)
  });
}

export function ensureSecureProbeRecoveryDirectory(options = {}) {
  const paths = secureProbeRecoveryPaths(options);
  mkdirSync(paths.directoryPath, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(paths.directoryPath);
  validateOwnedNode(metadata, {
    label: "Secure-probe recovery directory",
    kind: "directory",
    mode: 0o700
  });
  return paths;
}

function assertActiveLock(lock) {
  if (!activeLocks.has(lock)) {
    throw new Error("The secure-probe recovery operation does not hold its parent lock.");
  }
  assertDescriptorMatchesPath(lock.descriptor, lock.paths.lockPath, "Secure-probe recovery lock");
  assertMacOSHostStateLeaseDescriptor(lock.hostStateLease.descriptor, lock.hostStateLease.path);
}

export function acquireSecureProbeRecoveryLock({
  directoryPath,
  homeDirectory,
  lockHelperPath = defaultLockHelper,
  swiftExecutable = "/usr/bin/swift"
} = {}) {
  const paths = ensureSecureProbeRecoveryDirectory({ directoryPath, homeDirectory });
  let descriptor = null;
  let hostStateLease = null;
  try {
    descriptor = openSync(
      paths.lockPath,
      constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    assertDescriptorMatchesPath(descriptor, paths.lockPath, "Secure-probe recovery lock");
    const acquisition = spawnSync(swiftExecutable, [lockHelperPath, "--lock-fd", "3"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe", descriptor],
      timeout: 30_000
    });
    let evidence = null;
    try {
      evidence = JSON.parse(acquisition.stdout || "null");
    } catch {
      // Exit status and a fixed error category remain authoritative.
    }
    if (acquisition.status !== 0 || evidence?.status !== "acquired") {
      const busy = acquisition.status === 75 || evidence?.status === "busy";
      const error = new Error(
        busy
          ? "Another secure-field proof owns the recovery lock."
          : "The secure-field proof could not acquire its recovery lock."
      );
      error.code = busy ? "secure-probe-lock-busy" : "secure-probe-lock-failed";
      error.evidence = {
        helperExitStatus: acquisition.status,
        helperSignal: acquisition.signal ?? null,
        helperStatus: typeof evidence?.status === "string" ? evidence.status : null
      };
      throw error;
    }
    hostStateLease = acquireMacOSHostStateLease({
      lockHelperPath,
      swiftExecutable,
      waitMilliseconds: 60_000
    });
    const lock = Object.freeze({ descriptor, paths, hostStateLease });
    activeLocks.add(lock);
    return lock;
  } catch (error) {
    if (hostStateLease !== null) {
      try { releaseMacOSHostStateLease(hostStateLease); } catch {}
    }
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {}
    }
    throw error;
  }
}

export function releaseSecureProbeRecoveryLock(lock) {
  if (!activeLocks.has(lock)) return false;
  assertActiveLock(lock);
  activeLocks.delete(lock);
  closeSync(lock.descriptor);
  releaseMacOSHostStateLease(lock.hostStateLease);
  return true;
}

function canonicalTemporaryRoot() {
  return realpathSync(tmpdir());
}

function validateSafeTemporaryPath(path) {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error("A recovery temporary path is not canonical and absolute.");
  }
  const root = canonicalTemporaryRoot();
  const relationship = relative(root, path);
  if (
    !relationship ||
    relationship.startsWith("..") ||
    isAbsolute(relationship) ||
    dirname(path) !== root ||
    !basename(path).startsWith(temporaryDirectoryPrefix)
  ) {
    throw new Error("A recovery temporary path is outside the disposable-host namespace.");
  }
  return path;
}

export function canonicalSecureProbeTemporaryPath(path) {
  if (!isPlainString(path, 4096) || !existsSync(path)) {
    throw new Error("The disposable-host recovery path does not exist.");
  }
  const canonical = realpathSync(path);
  validateSafeTemporaryPath(canonical);
  const metadata = lstatSync(canonical);
  validateOwnedNode(metadata, {
    label: "Disposable secure-host directory",
    kind: "directory",
    mode: 0o700
  });
  return canonical;
}

export function removeSecureProbeTemporaryPath(path) {
  validateSafeTemporaryPath(path);
  if (!existsSync(path)) return true;
  const metadata = lstatSync(path);
  validateOwnedNode(metadata, {
    label: "Disposable secure-host directory",
    kind: "directory",
    mode: 0o700
  });
  rmSync(path, { recursive: true, force: false });
  return !existsSync(path);
}

function validatePreferenceEntry(entry) {
  exactKeys(entry, [
    "schema", "scope", "domain", "key", "exists", "propertyListType", "propertyListBase64"
  ], "Recovery preference entry");
  if (
    entry.schema !== SECURE_PROBE_PREFERENCE_SCHEMA ||
    entry.scope !== SECURE_PROBE_PREFERENCE_SCOPE ||
    entry.domain !== SECURE_PROBE_PREFERENCES_DOMAIN ||
    !allowedPreferenceKeys.has(entry.key)
  ) {
    throw new Error("A recovery preference is outside the secure-probe allowlist.");
  }
  if (
    typeof entry.exists !== "boolean" ||
    typeof entry.propertyListType !== "string" ||
    typeof entry.propertyListBase64 !== "string"
  ) {
    throw new Error("A recovery preference snapshot is malformed.");
  }
  if (!entry.exists && (entry.propertyListType !== "absent" || entry.propertyListBase64 !== "")) {
    throw new Error("An absent recovery preference contains unexpected data.");
  }
  if (entry.exists) {
    if (!allowedPropertyListTypes.has(entry.propertyListType)) {
      throw new Error("A recovery preference has an unsupported property-list type.");
    }
    if (entry.propertyListBase64.length === 0 || entry.propertyListBase64.length > maximumSnapshotBytes * 2) {
      throw new Error("A recovery preference snapshot has an invalid size.");
    }
    const decoded = Buffer.from(entry.propertyListBase64, "base64");
    if (
      decoded.length === 0 ||
      decoded.length > maximumSnapshotBytes ||
      decoded.toString("base64") !== entry.propertyListBase64
    ) {
      throw new Error("A recovery preference snapshot is not canonical base64.");
    }
  }
  return Object.freeze({ ...entry });
}

function validateNormalCleanupEvidence(evidence) {
  exactKeys(evidence, cleanupEvidenceKeys, "Normal cleanup evidence");
  if (Object.values(evidence).some((value) => value !== true)) {
    throw new Error("Normal completion requires every recovery invariant to be true.");
  }
  return Object.freeze({ ...evidence });
}

function cleanupFailureMask(evidence) {
  return cleanupEvidenceKeys.reduce(
    (mask, key, index) => mask | (evidence?.[key] === true ? 0 : (1 << index)),
    0
  );
}

function validateJournalRecord(record, { expectedOwner = ownerUserId() } = {}) {
  exactKeys(record, [
    "schemaVersion",
    "recordType",
    "recoveryIdentifier",
    "ownerUserId",
    "parentProcessIdentifier",
    "createdAtUnixMs",
    "phase",
    "priorInputSourceIdentifier",
    "preferences",
    "temporaryPaths",
    "hostProcess",
    "normalCompletionTokenSha256",
    "normalCleanupEvidence"
  ], "Secure-probe recovery journal");
  if (
    record.schemaVersion !== SECURE_PROBE_RECOVERY_SCHEMA_VERSION ||
    record.recordType !== SECURE_PROBE_RECOVERY_RECORD_TYPE ||
    record.ownerUserId !== expectedOwner ||
    !Number.isInteger(record.parentProcessIdentifier) ||
    record.parentProcessIdentifier <= 0 ||
    !Number.isSafeInteger(record.createdAtUnixMs) ||
    record.createdAtUnixMs <= 0 ||
    !/^[a-f0-9]{32}$/u.test(record.recoveryIdentifier ?? "") ||
    !["prepared", "normal-completion-recorded"].includes(record.phase) ||
    !isPlainString(record.priorInputSourceIdentifier, 512)
  ) {
    throw new Error("The secure-probe recovery journal identity is invalid.");
  }
  if (!Array.isArray(record.preferences) || record.preferences.length !== SECURE_PROBE_PREFERENCE_KEYS.length) {
    throw new Error("The secure-probe recovery journal does not contain every exact preference snapshot.");
  }
  const preferences = record.preferences.map(validatePreferenceEntry);
  const preferenceIdentities = new Set(preferences.map(({ domain, key }) => `${domain}\u0000${key}`));
  if (preferenceIdentities.size !== preferences.length) {
    throw new Error("The secure-probe recovery journal repeats a preference snapshot.");
  }
  if (SECURE_PROBE_PREFERENCE_KEYS.some((key) =>
    !preferences.some((entry) => entry.domain === SECURE_PROBE_PREFERENCES_DOMAIN && entry.key === key)
  )) {
    throw new Error("The secure-probe recovery journal omits an allowlisted preference snapshot.");
  }
  if (!Array.isArray(record.temporaryPaths) || record.temporaryPaths.length > 4) {
    throw new Error("The secure-probe recovery journal has an invalid temporary-path set.");
  }
  const temporaryPaths = record.temporaryPaths.map((path) => {
    if (!isPlainString(path, 4096)) throw new Error("A recovery temporary path is invalid.");
    return validateSafeTemporaryPath(path);
  });
  if (new Set(temporaryPaths).size !== temporaryPaths.length) {
    throw new Error("The secure-probe recovery journal repeats a temporary path.");
  }
  let hostProcess = null;
  if (record.hostProcess !== null) {
    exactKeys(
      record.hostProcess,
      ["processIdentifier", "executablePath", "executableSha256", "processStartToken"],
      "Recovery host process"
    );
    if (
      !Number.isInteger(record.hostProcess.processIdentifier) ||
      record.hostProcess.processIdentifier <= 1 ||
      !isPlainString(record.hostProcess.executablePath, 4096) ||
      !/^[a-f0-9]{64}$/u.test(record.hostProcess.executableSha256 ?? "") ||
      !/^\d{1,20}:\d{1,6}$/u.test(record.hostProcess.processStartToken ?? "") ||
      !isAbsolute(record.hostProcess.executablePath) ||
      resolve(record.hostProcess.executablePath) !== record.hostProcess.executablePath ||
      !temporaryPaths.some((path) => {
        const relationship = relative(path, record.hostProcess.executablePath);
        return relationship && !relationship.startsWith("..") && !isAbsolute(relationship);
      })
    ) {
      throw new Error("The recovery host identity is outside its disposable bundle.");
    }
    hostProcess = Object.freeze({ ...record.hostProcess });
  }
  if (record.phase === "prepared") {
    if (record.normalCompletionTokenSha256 !== null || record.normalCleanupEvidence !== null) {
      throw new Error("A prepared recovery journal contains completion evidence.");
    }
  } else {
    if (!/^[a-f0-9]{64}$/u.test(record.normalCompletionTokenSha256 ?? "")) {
      throw new Error("The recovery journal completion token is invalid.");
    }
    validateNormalCleanupEvidence(record.normalCleanupEvidence);
  }
  return Object.freeze({
    ...record,
    preferences: Object.freeze(preferences),
    temporaryPaths: Object.freeze(temporaryPaths),
    hostProcess,
    normalCleanupEvidence: record.normalCleanupEvidence === null
      ? null
      : Object.freeze({ ...record.normalCleanupEvidence })
  });
}

function atomicWriteJournal(paths, record) {
  const validated = validateJournalRecord(record);
  const serialized = `${JSON.stringify(validated)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maximumJournalBytes) {
    throw new Error("The secure-probe recovery journal exceeds its size limit.");
  }
  const temporaryPath = join(
    paths.directoryPath,
    `.secure-field-probe-recovery.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  let descriptor = null;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    writeFileSync(descriptor, serialized, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    validateOwnedNode(lstatSync(temporaryPath), {
      label: "Temporary secure-probe recovery journal",
      kind: "file",
      mode: 0o600
    });
    renameSync(temporaryPath, paths.journalPath);
    fsyncDirectory(paths.directoryPath);
    const verified = openValidatedJournal(paths);
    closeSync(verified.descriptor);
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {}
    }
    if (existsSync(temporaryPath)) {
      const metadata = lstatSync(temporaryPath);
      validateOwnedNode(metadata, {
        label: "Temporary secure-probe recovery journal",
        kind: "file",
        mode: 0o600
      });
      unlinkSync(temporaryPath);
    }
  }
}

function openValidatedJournal(paths) {
  const descriptor = openSync(paths.journalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = assertDescriptorMatchesPath(
      descriptor,
      paths.journalPath,
      "Secure-probe recovery journal"
    );
    if (metadata.size <= 0 || metadata.size > maximumJournalBytes) {
      throw new Error("The secure-probe recovery journal has an invalid size.");
    }
    return { descriptor, metadata };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function readJournal(paths) {
  if (!existsSync(paths.journalPath)) return null;
  const opened = openValidatedJournal(paths);
  try {
    const serialized = readFileSync(opened.descriptor, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new Error("The secure-probe recovery journal is not valid JSON.");
    }
    return validateJournalRecord(parsed);
  } finally {
    closeSync(opened.descriptor);
  }
}

function removeJournal(paths) {
  if (!existsSync(paths.journalPath)) return;
  validateOwnedNode(lstatSync(paths.journalPath), {
    label: "Secure-probe recovery journal",
    kind: "file",
    mode: 0o600
  });
  unlinkSync(paths.journalPath);
  fsyncDirectory(paths.directoryPath);
}

export function inspectSecureProbeRecoveryJournal(lock) {
  assertActiveLock(lock);
  return readJournal(lock.paths);
}

export function preferenceRecoveryEntries(preferenceSnapshots, {
  domain = SECURE_PROBE_PREFERENCES_DOMAIN
} = {}) {
  if (!preferenceSnapshots || typeof preferenceSnapshots !== "object" || Array.isArray(preferenceSnapshots)) {
    throw new Error("Preference snapshots must be keyed by preference name.");
  }
  const suppliedKeys = Object.keys(preferenceSnapshots).sort();
  if (
    suppliedKeys.length !== SECURE_PROBE_PREFERENCE_KEYS.length ||
    suppliedKeys.some((key, index) => key !== [...SECURE_PROBE_PREFERENCE_KEYS].sort()[index])
  ) {
    throw new Error("Recovery requires exactly all secure-probe preference snapshots.");
  }
  return Object.entries(preferenceSnapshots).map(([key, snapshot]) => {
    if (!snapshot || snapshot.status !== 0 || snapshot.stderr !== "") {
      throw new Error("Every preference recovery snapshot must be complete.");
    }
    return validatePreferenceEntry({
      schema: snapshot.schema,
      scope: snapshot.scope,
      domain: snapshot.domain,
      key: snapshot.key,
      exists: snapshot.exists === true,
      propertyListType: snapshot.propertyListType,
      propertyListBase64: snapshot.exists === true ? String(snapshot.propertyListBase64 ?? "") : ""
    });
  }).sort((left, right) => left.key.localeCompare(right.key));
}

function secureHostExecutableSha256(executablePath) {
  const metadata = lstatSync(executablePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== ownerUserId() ||
    metadata.nlink !== 1
  ) {
    throw new Error("The disposable secure-host executable identity is unsafe.");
  }
  return createHash("sha256").update(readFileSync(executablePath)).digest("hex");
}

export function prepareSecureProbeRecovery({
  lock,
  priorInputSourceIdentifier,
  preferences,
  temporaryPaths = []
}) {
  assertActiveLock(lock);
  if (readJournal(lock.paths)) {
    throw new Error("A prior secure-probe recovery journal must be recovered before preparation.");
  }
  const normalCompletionToken = randomBytes(32).toString("hex");
  const record = validateJournalRecord({
    schemaVersion: SECURE_PROBE_RECOVERY_SCHEMA_VERSION,
    recordType: SECURE_PROBE_RECOVERY_RECORD_TYPE,
    recoveryIdentifier: randomBytes(16).toString("hex"),
    ownerUserId: ownerUserId(),
    parentProcessIdentifier: process.pid,
    createdAtUnixMs: Date.now(),
    phase: "prepared",
    priorInputSourceIdentifier,
    preferences,
    temporaryPaths: temporaryPaths.map(canonicalSecureProbeTemporaryPath),
    hostProcess: null,
    normalCompletionTokenSha256: null,
    normalCleanupEvidence: null
  });
  atomicWriteJournal(lock.paths, record);
  const transaction = Object.freeze({
    recoveryIdentifier: record.recoveryIdentifier,
    journalPath: lock.paths.journalPath,
    directoryPath: lock.paths.directoryPath
  });
  transactionPrivateState.set(transaction, {
    lock,
    normalCompletionToken,
    completionRecorded: false
  });
  return transaction;
}

function transactionRecord(transaction) {
  const state = transactionPrivateState.get(transaction);
  if (!state) throw new Error("The secure-probe recovery transaction is unknown.");
  assertActiveLock(state.lock);
  const record = readJournal(state.lock.paths);
  if (!record || record.recoveryIdentifier !== transaction.recoveryIdentifier) {
    throw new Error("The durable secure-probe recovery transaction no longer matches its handle.");
  }
  return { state, record };
}

export function updateSecureProbeRecovery(transaction, {
  temporaryPaths,
  hostProcess
} = {}) {
  const { state, record } = transactionRecord(transaction);
  if (record.phase !== "prepared") {
    throw new Error("A completed secure-probe recovery transaction cannot be updated.");
  }
  const nextTemporaryPaths = temporaryPaths === undefined
    ? record.temporaryPaths
    : temporaryPaths.map(canonicalSecureProbeTemporaryPath);
  let nextHostProcess = record.hostProcess;
  if (hostProcess !== undefined) {
    if (hostProcess === null) {
      nextHostProcess = null;
    } else {
      const executablePath = realpathSync(hostProcess.executablePath);
      const identity = processIdentity(hostProcess.processIdentifier);
      if (
        identity.status !== 0 ||
        identity.state !== "running" ||
        identity.executablePath !== executablePath
      ) {
        throw new Error("The secure host process instance could not be bound exactly.");
      }
      nextHostProcess = {
        processIdentifier: hostProcess.processIdentifier,
        executablePath,
        executableSha256: secureHostExecutableSha256(executablePath),
        processStartToken: identity.processStartToken
      };
    }
  }
  const next = validateJournalRecord({
    ...record,
    temporaryPaths: nextTemporaryPaths,
    hostProcess: nextHostProcess
  });
  atomicWriteJournal(state.lock.paths, next);
  return next;
}

export function markSecureProbeRecoveryComplete(transaction, cleanupEvidence) {
  const { state, record } = transactionRecord(transaction);
  if (record.phase !== "prepared") {
    throw new Error("The secure-probe recovery completion was already recorded.");
  }
  const verifiedCleanup = validateNormalCleanupEvidence(cleanupEvidence);
  const next = validateJournalRecord({
    ...record,
    phase: "normal-completion-recorded",
    normalCompletionTokenSha256: createHash("sha256")
      .update(state.normalCompletionToken, "utf8")
      .digest("hex"),
    normalCleanupEvidence: verifiedCleanup
  });
  atomicWriteJournal(state.lock.paths, next);
  state.completionRecorded = true;
  return next;
}

function callbackSucceeded(result) {
  return result === true || result?.status === 0;
}

function snapshotsEqual(expected, actual) {
  try {
    exactKeys(actual, [
      "status", "schema", "scope", "domain", "key", "exists",
      "propertyListType", "propertyListBase64", "stderr"
    ], "Observed recovery preference snapshot");
  } catch {
    return false;
  }
  return actual.status === 0 &&
    actual.schema === expected.schema &&
    actual.scope === expected.scope &&
    actual.domain === expected.domain &&
    actual.key === expected.key &&
    actual.exists === expected.exists &&
    actual.propertyListType === expected.propertyListType &&
    actual.propertyListBase64 === expected.propertyListBase64 &&
    actual.stderr === "";
}

export function restoreSecureProbeRecoveryRecord(record, adapters) {
  const validated = validateJournalRecord(record);
  const requiredCallbacks = [
    "terminateHost",
    "secureInputReturnedToBaseline",
    "restoreInputSource",
    "currentInputSource",
    "restorePreference",
    "snapshotPreference",
    "notifyPreferencesChanged",
    "removeTemporaryPath"
  ];
  if (requiredCallbacks.some((name) => typeof adapters?.[name] !== "function")) {
    throw new Error("The secure-probe recovery adapter is incomplete.");
  }

  const hostTerminated = validated.hostProcess === null || callbackSucceeded(
    adapters.terminateHost(validated.hostProcess)
  );
  const secureInputReturnedToBaseline = callbackSucceeded(adapters.secureInputReturnedToBaseline());
  const inputSourceRestoreResult = adapters.restoreInputSource(validated.priorInputSourceIdentifier);
  const inputSourceRestored = callbackSucceeded(inputSourceRestoreResult) &&
    adapters.currentInputSource()?.id === validated.priorInputSourceIdentifier;

  const preferenceRestoreResults = validated.preferences.map((entry) => ({
    key: entry.key,
    restored: callbackSucceeded(adapters.restorePreference(entry.domain, entry.key, {
      status: 0,
      schema: entry.schema,
      scope: entry.scope,
      domain: entry.domain,
      key: entry.key,
      exists: entry.exists,
      propertyListType: entry.propertyListType,
      propertyListBase64: entry.propertyListBase64,
      stderr: ""
    }))
  }));
  const preferencesNotified = callbackSucceeded(adapters.notifyPreferencesChanged());
  const preferenceVerificationResults = validated.preferences.map((entry) => ({
    key: entry.key,
    exact: snapshotsEqual(entry, adapters.snapshotPreference(entry.domain, entry.key))
  }));
  const preferencesRestored = preferencesNotified &&
    preferenceRestoreResults.every(({ restored }) => restored) &&
    preferenceVerificationResults.every(({ exact }) => exact);

  const temporaryPathResults = validated.temporaryPaths.map((path) => ({
    removed: hostTerminated && callbackSucceeded(adapters.removeTemporaryPath(path))
  }));
  const temporaryHostRemoved = temporaryPathResults.every(({ removed }) => removed);
  const cleanupEvidence = {
    hostTerminated,
    inputSourceRestored,
    preferencesRestored,
    secureInputReturnedToBaseline,
    temporaryHostRemoved
  };
  return {
    status: Object.values(cleanupEvidence).every(Boolean) ? "recovered" : "recovery-incomplete",
    cleanupEvidence,
    preferenceRestoreFailures: preferenceRestoreResults.filter(({ restored }) => !restored).map(({ key }) => key),
    preferenceVerificationFailures: preferenceVerificationResults.filter(({ exact }) => !exact).map(({ key }) => key),
    temporaryPathFailureCount: temporaryPathResults.filter(({ removed }) => !removed).length
  };
}

export function createDefaultSecureProbeRecoveryAdapters() {
  return Object.freeze({
    terminateHost(hostProcess) {
      const current = processIdentity(hostProcess.processIdentifier);
      if (["absent", "terminated"].includes(current.state)) return { status: 0 };
      if (current.status !== 0 || current.state !== "running") return { status: 3 };
      if (
        current.executablePath !== hostProcess.executablePath ||
        current.processStartToken !== hostProcess.processStartToken
      ) return { status: 0 };
      try {
        if (secureHostExecutableSha256(current.executablePath) !== hostProcess.executableSha256) {
          return { status: 3 };
        }
      } catch {
        return { status: 3 };
      }
      const termination = terminateExactProcess(hostProcess);
      return { status: termination.status === 0 && termination.terminated ? 0 : 3 };
    },
    secureInputReturnedToBaseline() {
      const deadline = Date.now() + 4_000;
      let state = secureEventInputState();
      while (Date.now() < deadline && state.status === 0 && state.enabled === true) {
        wait(100);
        state = secureEventInputState();
      }
      return { status: state.status === 0 && state.enabled === false ? 0 : 2 };
    },
    restoreInputSource: restoreExactInputSource,
    currentInputSource,
    restorePreference,
    snapshotPreference,
    notifyPreferencesChanged() {
      return run("/usr/bin/notifyutil", ["-p", SECURE_PROBE_PREFERENCES_NOTIFICATION]);
    },
    removeTemporaryPath: removeSecureProbeTemporaryPath
  });
}

export function recoverSecureProbeState({
  lock,
  adapters = createDefaultSecureProbeRecoveryAdapters()
}) {
  assertActiveLock(lock);
  const record = readJournal(lock.paths);
  if (!record) return { status: "no-recovery-required", cleanupEvidence: null };
  const recovery = restoreSecureProbeRecoveryRecord(record, adapters);
  if (recovery.status === "recovered") removeJournal(lock.paths);
  return recovery;
}

function guardianDescriptorIsValid(paths) {
  assertDescriptorMatchesPath(3, paths.lockPath, "Inherited secure-probe recovery lock");
  assertMacOSHostStateLeaseDescriptor(4, macOSHostStateLeasePath());
  return true;
}

async function readGuardianControl() {
  const chunks = [];
  let byteCount = 0;
  for await (const chunk of process.stdin) {
    byteCount += chunk.length;
    if (byteCount > maximumGuardianControlBytes) return { valid: false, token: "" };
    chunks.push(chunk);
  }
  const value = Buffer.concat(chunks).toString("utf8");
  const token = value.endsWith("\n") ? value.slice(0, -1) : "";
  return {
    valid: /^[a-f0-9]{64}$/u.test(token) && value === `${token}\n`,
    token
  };
}

function completionTokenMatches(record, control) {
  if (
    record.phase !== "normal-completion-recorded" ||
    !control.valid ||
    !record.normalCleanupEvidence ||
    !Object.values(record.normalCleanupEvidence).every(Boolean)
  ) return false;
  const actual = createHash("sha256").update(control.token, "utf8").digest();
  const expected = Buffer.from(record.normalCompletionTokenSha256, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function guardianMain(directoryPath) {
  const paths = ensureSecureProbeRecoveryDirectory({ directoryPath });
  guardianDescriptorIsValid(paths);
  const initialRecord = readJournal(paths);
  if (!initialRecord) throw new Error("The guardian did not receive a durable recovery journal.");
  process.stdout.write("READY\n");
  const control = await readGuardianControl();
  const currentRecord = readJournal(paths);
  if (!currentRecord || currentRecord.recoveryIdentifier !== initialRecord.recoveryIdentifier) {
    throw new Error("The guardian recovery journal changed identity.");
  }
  if (completionTokenMatches(currentRecord, control)) {
    removeJournal(paths);
    process.stdout.write("SKIPPED\n");
    return 0;
  }
  const recovery = restoreSecureProbeRecoveryRecord(
    currentRecord,
    createDefaultSecureProbeRecoveryAdapters()
  );
  if (recovery.status !== "recovered") {
    process.stdout.write(`INCOMPLETE:${cleanupFailureMask(recovery.cleanupEvidence).toString(16).padStart(2, "0")}\n`);
    return 1;
  }
  removeJournal(paths);
  process.stdout.write("RECOVERED\n");
  return 0;
}

export async function launchSecureProbeRecoveryGuardian({
  lock,
  transaction,
  nodeExecutable = process.execPath,
  readyTimeoutMs = 5_000
}) {
  const { state, record } = transactionRecord(transaction);
  if (state.lock !== lock || record.phase !== "prepared") {
    throw new Error("The guardian must start for the matching prepared transaction.");
  }
  const child = spawn(nodeExecutable, [modulePath, guardianArgument, lock.paths.directoryPath], {
    stdio: ["pipe", "pipe", "ignore", lock.descriptor, lock.hostStateLease.descriptor]
  });
  child.stdout.setEncoding("utf8");
  let output = "";
  let standardInputError = null;
  child.stdin.on("error", (error) => {
    standardInputError = error;
  });
  const closed = new Promise((resolveClosed) => {
    child.once("close", (exitCode, signal) => resolveClosed({ exitCode, signal }));
  });
  const guardian = Object.freeze({ child, processIdentifier: child.pid ?? null });
  const ready = await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error("The secure-probe recovery guardian did not become ready.")), readyTimeoutMs);
    const fail = () => {
      clearTimeout(timer);
      rejectReady(new Error("The secure-probe recovery guardian exited before readiness."));
    };
    child.once("error", fail);
    child.once("exit", fail);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 128) {
        clearTimeout(timer);
        rejectReady(new Error("The secure-probe recovery guardian emitted invalid readiness output."));
      } else if (output.startsWith("READY\n")) {
        clearTimeout(timer);
        child.off("error", fail);
        child.off("exit", fail);
        resolveReady(true);
      }
    });
  }).catch((error) => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    throw error;
  });
  if (!ready) throw new Error("The secure-probe recovery guardian readiness failed.");
  guardianPrivateState.set(guardian, {
    transaction,
    output: () => output,
    standardInputError: () => standardInputError,
    closed,
    completionSignaled: false
  });
  return guardian;
}

export function assertSecureProbeRecoveryGuardianAlive(guardian) {
  if (!guardianPrivateState.has(guardian)) throw new Error("The secure-probe recovery guardian is unknown.");
  if (guardian.child.exitCode !== null || guardian.child.signalCode !== null || guardian.child.killed) {
    throw new Error("The secure-probe recovery guardian is no longer alive.");
  }
  return true;
}

export function signalSecureProbeRecoveryGuardianCompletion(guardian) {
  const guardianState = guardianPrivateState.get(guardian);
  if (!guardianState) throw new Error("The secure-probe recovery guardian is unknown.");
  const transactionState = transactionPrivateState.get(guardianState.transaction);
  if (!transactionState?.completionRecorded || guardianState.completionSignaled) {
    throw new Error("The guardian completion token requires one durable normal-completion record.");
  }
  assertSecureProbeRecoveryGuardianAlive(guardian);
  guardianState.completionSignaled = true;
  guardian.child.stdin.end(`${transactionState.normalCompletionToken}\n`);
}

/**
 * Ends the guardian pipe without the normal token. The guardian treats this as
 * the same fail-closed condition as parent death and restores the journal.
 */
export function triggerSecureProbeRecoveryGuardian(guardian) {
  const guardianState = guardianPrivateState.get(guardian);
  if (!guardianState || guardianState.completionSignaled) {
    throw new Error("The secure-probe recovery guardian control pipe is unavailable.");
  }
  assertSecureProbeRecoveryGuardianAlive(guardian);
  guardianState.completionSignaled = true;
  guardian.child.stdin.end();
}

export function waitForSecureProbeRecoveryGuardian(guardian, { timeoutMs = 30_000 } = {}) {
  const state = guardianPrivateState.get(guardian);
  if (!state) return Promise.reject(new Error("The secure-probe recovery guardian is unknown."));
  return new Promise((resolveWait, rejectWait) => {
    const timer = setTimeout(
      () => rejectWait(new Error("The secure-probe recovery guardian did not finish in time.")),
      timeoutMs
    );
    state.closed.then(({ exitCode, signal }) => {
      clearTimeout(timer);
      const output = state.output();
      const incomplete = /(?:^|\n)INCOMPLETE:([0-9a-f]{2})\n/u.exec(output);
      const guardianFault = output.includes("FAULT\n");
      resolveWait({
        status: exitCode === 0 && state.standardInputError() === null ? "completed" : "failed",
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
    }).catch((error) => {
      clearTimeout(timer);
      rejectWait(error);
    });
  });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(modulePath);
if (invokedDirectly) {
  if (process.argv.length !== 4 || process.argv[2] !== guardianArgument) {
    process.exitCode = 64;
  } else {
    try {
      process.exitCode = await guardianMain(process.argv[3]);
    } catch {
      // The journal remains durable for the next lock owner. Emit only a fixed,
      // content-free fault category; never print journal or preference state.
      process.stdout.write("FAULT\n");
      process.exitCode = 1;
    }
  }
}
