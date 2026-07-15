#!/usr/bin/env node
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import {
  findCodeSignBlockedExtendedAttributes,
  isValidCompanionShortVersion,
  parseCodeSignInspection,
  resolveCompanionBundleVersions
} from "./lib/macos-companion-package-metadata.mjs";

const root = process.cwd();
const startedAt = performance.now();
const signed = process.argv.includes("--signed");
const publicationTestMode = process.env.LEKH_PACKAGE_TEST_MODE === "1";
const appSwapFault = process.env.LEKH_PACKAGE_TEST_FAULT_AFTER_APP_SWAP ?? null;
const dmgSwapFault = process.env.LEKH_PACKAGE_TEST_FAULT_AFTER_DMG_SWAP ?? null;
const finalizationFault = process.env.LEKH_PACKAGE_TEST_FAULT_AFTER_FINALIZATION_MARKER ?? null;
const deliveredAppBundle = join(root, "release", "Lekh Keyboard Companion.app");
const deliveryExchange = join(root, "release", ".Lekh Keyboard Companion.app.exchange.nosync");
const publicationJournal = join(root, "release", ".lekh-companion-publication-transaction.json");
const publicationJournalCandidate = `${publicationJournal}.${process.pid}.tmp`;
const stagingRoot = mkdtempSync(join(tmpdir(), "lekh-native-companion-"));
const appBundle = join(stagingRoot, "Lekh Keyboard Companion.app");
const publicationLockFile = join(root, "release", ".lekh-companion-publication.lockfile");
const publicationLockHelper = join(root, "scripts", "macos-companion-publication-lock.swift");
const executableName = "LekhKeyboardCompanion";
const executable = join(appBundle, "Contents", "MacOS", executableName);
const buildRoot = join(root, ".tmp", `native-macos-companion-${process.pid}`);
const sourceRelativePaths = [
  "native/macos-companion/LekhCompanionApp.swift",
  "native/macos-companion/LekhCompanionCopy.swift",
  "native/macos-companion/LekhCompanionModel.swift"
];
const sources = sourceRelativePaths.map((path) => join(root, path));
let compileSources = sources;
const reportPath = join(root, "reports", signed
  ? "macos-native-signed-package-report.json"
  : "macos-native-unsigned-package-report.json");
const recoveryReportPath = join(root, "reports", "macos-native-companion-publication-recovery-report.json");
const reportCandidate = `${reportPath}.${process.pid}.tmp`;
let bundleVersions = null;
let sourceRevision = null;
let sourceTreeClean = null;
let dmgCandidateForPublication = null;
let deliveredDmg = null;
let dmgDeliveryExchange = null;
let dmgEmbeddedAppIdentity = null;
let recoveredInterruptedPublicationAtStartup = null;
let iconSourceForPackage = join(root, "build", "icon.icns");
const publicationState = {
  lockHeld: false,
  readyToCommit: false,
  committed: false
};
let publicationLockDescriptor = null;

process.on("exit", () => {
  rmSync(stagingRoot, { recursive: true, force: true });
  rmSync(buildRoot, { recursive: true, force: true });
  rmSync(publicationJournalCandidate, { force: true });
  rmSync(reportCandidate, { force: true });
  // A surviving journal means an atomic swap may already have happened. Keep
  // the lock, journal, canonical artifacts, and exchanges intact so the next
  // invocation can either roll a prepared pair back or finish a committed
  // pair's bound report without rebuilding or using signing credentials.
  if (publicationState.lockHeld && !existsSync(publicationJournal)) {
    rmSync(deliveryExchange, { recursive: true, force: true });
    if (dmgDeliveryExchange) rmSync(dmgDeliveryExchange, { force: true });
  }
  if (publicationLockDescriptor !== null) {
    try { closeSync(publicationLockDescriptor); } catch {}
    publicationLockDescriptor = null;
  }
});

function finish(status, details, exitCode) {
  mkdirSync(join(root, "reports"), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: signed ? "npm run package:macos" : "npm run package:macos:unsigned",
    suite: "native-macos-companion-package",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    appBundle: deliveredAppBundle,
    shortVersion: bundleVersions?.shortVersion ?? null,
    buildVersion: bundleVersions?.buildVersion ?? null,
    shortVersionSource: bundleVersions?.shortVersionSource ?? null,
    buildVersionSource: bundleVersions?.buildVersionSource ?? null,
    sourceRevision,
    sourceTreeClean,
    testMode: publicationTestMode,
    ...details
  };
  try {
    if (exitCode === 0 && publicationState.readyToCommit) {
      commitPublicationWithReport(report);
    } else {
      writeJsonAtomically(reportPath, report);
    }
    console.log(JSON.stringify({ ...report, report: reportPath.replace(`${root}/`, "") }, null, 2));
    process.exit(exitCode);
  } catch (error) {
    const failure = {
      generatedAt: new Date().toISOString(),
      suite: "native-macos-companion-publication-finalization",
      status: "failed-finalization-recoverable",
      reason: error instanceof Error ? error.message : String(error),
      evidence: error?.evidence ?? null,
      journal: publicationJournal
    };
    try {
      writeJsonAtomically(recoveryReportPath, failure);
    } catch {
      // The durable journal remains the recovery authority even if diagnostics
      // cannot be written.
    }
    console.error(JSON.stringify(failure, null, 2));
    process.exit(1);
  }
}

function writeJsonAtomically(path, value) {
  mkdirSync(join(root, "reports"), { recursive: true });
  const candidate = `${path}.${process.pid}.tmp`;
  rmSync(candidate, { force: true });
  writeFileSync(candidate, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  spawnSync("/bin/sync", [], { stdio: "ignore" });
  renameSync(candidate, path);
  spawnSync("/bin/sync", [], { stdio: "ignore" });
}

function finishRecovery(status, disposition, exitCode) {
  const report = {
    generatedAt: new Date().toISOString(),
    suite: "native-macos-companion-publication-recovery",
    status,
    disposition,
    journal: publicationJournal,
    appBundle: deliveredAppBundle
  };
  writeJsonAtomically(recoveryReportPath, report);
  console.log(JSON.stringify({ ...report, report: recoveryReportPath.replace(`${root}/`, "") }, null, 2));
  process.exit(exitCode);
}

function gitObjectAtRevision(revision, relativePath, { binary = false } = {}) {
  const result = spawnSync("git", ["show", `${revision}:${relativePath}`], {
    cwd: root,
    encoding: binary ? null : "utf8",
    stdio: "pipe",
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`Could not materialize ${relativePath} from ${revision}: ${String(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function assertSignedSourceProvenance(step) {
  if (!signed) return;
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: "pipe" });
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe"
  });
  if (
    revision.status !== 0 ||
    status.status !== 0 ||
    revision.stdout.trim() !== sourceRevision ||
    status.stdout.trim().length !== 0
  ) {
    throw new Error(`Signed source provenance changed during ${step}; refusing to sign or publish.`);
  }
}

function run(step, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    timeout: options.timeout ?? 300_000,
    env: options.env ?? process.env
  });
  if (result.status !== 0) {
    const redactedIndexes = new Set(options.redactArgumentIndexes ?? []);
    const secretValues = (options.secretValues ?? []).filter((value) => typeof value === "string" && value.length > 0);
    const redact = (value) => secretValues.reduce(
      (output, secret) => String(output ?? "").split(secret).join("[REDACTED]"),
      String(value ?? "")
    );
    const reportedArgs = args.map((argument, index) =>
      redactedIndexes.has(index) ? "[REDACTED]" : redact(argument)
    );
    const failure = {
      step,
      command: [command, ...reportedArgs],
      signal: result.signal ?? null,
      stdout: redact(result.stdout),
      stderr: redact(result.stderr)
    };
    if (options.throwOnFailure) {
      throw Object.assign(new Error(`${step} failed.`), { evidence: failure });
    }
    finish(result.signal ? "timeout" : "failed", failure, result.status ?? 1);
  }
  return result;
}

function sleep(milliseconds) {
  spawnSync("/bin/sleep", [(milliseconds / 1000).toFixed(3)], { stdio: "ignore" });
}

function acquirePublicationLock() {
  if (publicationState.lockHeld) return;
  mkdirSync(join(root, "release"), { recursive: true });
  try {
    publicationLockDescriptor = openSync(publicationLockFile, "a+", 0o600);
  } catch (error) {
    throw Object.assign(new Error(`Could not open the companion publication lock file: ${error instanceof Error ? error.message : String(error)}`), {
      code: "publication-lock-open-failed"
    });
  }
  const result = spawnSync("/usr/bin/swift", [publicationLockHelper, "--lock-fd", "3"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe", publicationLockDescriptor],
    timeout: 30_000
  });
  let evidence = null;
  try {
    evidence = JSON.parse(result.stdout || "null");
  } catch {
    // The exit status and stderr below retain fail-closed diagnostics.
  }
  if (result.status !== 0 || evidence?.status !== "acquired") {
    try {
      closeSync(publicationLockDescriptor);
    } catch {}
    publicationLockDescriptor = null;
    const busy = result.status === 75 || evidence?.status === "busy";
    throw Object.assign(new Error(
      busy
        ? "Another companion publication holds the kernel advisory lock."
        : `Could not acquire the companion publication advisory lock: ${evidence?.reason ?? result.stderr?.trim() ?? "unknown helper failure"}.`
    ), {
      code: busy ? "publication-lock-busy" : "publication-lock-failed",
      evidence: {
        helperStatus: result.status,
        helperSignal: result.signal ?? null,
        helperEvidence: evidence
      }
    });
  }
  assertPublicationLockHeld();
  publicationState.lockHeld = true;
}

function assertPublicationLockHeld() {
  if (publicationLockDescriptor === null) {
    throw new Error("The companion publication process does not own a lock descriptor.");
  }
  try {
    const descriptorMetadata = fstatSync(publicationLockDescriptor);
    if (!descriptorMetadata.isFile()) throw new Error("lock descriptor is not a regular file");
  } catch (error) {
    throw new Error(`The companion publication lock descriptor is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function dmgPaths(shortVersion) {
  if (!isValidCompanionShortVersion(shortVersion)) {
    throw new Error("Publication journal contains an invalid DMG short version.");
  }
  return {
    canonical: join(root, "release", `Lekh-Keyboard-Companion-${shortVersion}.dmg`),
    exchange: join(root, "release", `.Lekh-Keyboard-Companion-${shortVersion}.dmg.exchange.nosync`)
  };
}

function sameAppIdentity(left, right) {
  if (!left || !right) return false;
  return [
    "identifier",
    "codeDirectoryHash",
    "teamIdentifier",
    "signingKind",
    "designatedRequirement",
    "hardenedRuntime",
    "secureTimestamp",
    "timestamp",
    "executableSha256",
    "infoPlistSha256"
  ].every((field) => left[field] === right[field]);
}

function inspectedAppIdentity(path) {
  if (!existsSync(path)) return null;
  try {
    return appArtifactIdentity(path);
  } catch {
    return null;
  }
}

function inspectedFileSha256(path) {
  if (!existsSync(path)) return null;
  try {
    return sha256File(path);
  } catch {
    return null;
  }
}

function rollbackJournalArtifact({ kind, canonical, exchange, hadPrevious, targetMatches }) {
  assertPublicationLockHeld();
  const canonicalExists = existsSync(canonical);
  const exchangeExists = existsSync(exchange);
  const canonicalIsTarget = canonicalExists && targetMatches(canonical);
  const exchangeIsTarget = exchangeExists && targetMatches(exchange);

  if (hadPrevious) {
    if (canonicalExists && exchangeExists) {
      if (canonicalIsTarget && !exchangeIsTarget) {
        atomicSwapBundles(exchange, canonical);
      } else if (!canonicalIsTarget && exchangeIsTarget) {
        // The intent was durable but the swap had not happened.
      } else if (!(canonicalIsTarget && exchangeIsTarget)) {
        throw new Error(`Cannot safely recover ${kind}: neither side matches the journaled target.`);
      }
      rmSync(exchange, { recursive: kind === "app", force: true });
      return;
    }
    if (canonicalExists && !exchangeExists && !canonicalIsTarget) return;
    throw new Error(`Cannot safely recover ${kind}: the previous artifact backup is missing.`);
  }

  if (canonicalExists) {
    if (!canonicalIsTarget) {
      throw new Error(`Cannot safely recover ${kind}: an unexpected canonical artifact appeared.`);
    }
    rmSync(canonical, { recursive: kind === "app", force: true });
  }
  if (exchangeExists) {
    if (!exchangeIsTarget) {
      throw new Error(`Cannot safely recover ${kind}: the candidate does not match the journaled target.`);
    }
    rmSync(exchange, { recursive: kind === "app", force: true });
  }
}

function recoverInterruptedPublication() {
  assertPublicationLockHeld();
  if (!existsSync(publicationJournal)) {
    // No journal is the commit marker. Any remaining exchange is either an
    // uncommitted pre-swap candidate or an old backup left after a committed
    // pair; neither is canonical and both are safe to remove.
    rmSync(deliveryExchange, { recursive: true, force: true });
    for (const entry of readdirSync(join(root, "release"))) {
      if (
        /^\.Lekh-Keyboard-Companion-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.dmg\.exchange\.nosync$/.test(entry) ||
        /^\.lekh-companion-publication-transaction\.json\.\d+\.tmp$/.test(entry)
      ) {
        rmSync(join(root, "release", entry), { force: true });
      }
    }
    return null;
  }

  let transaction;
  try {
    transaction = JSON.parse(readFileSync(publicationJournal, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse the companion publication journal: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (transaction?.version !== 1 || !transaction.app?.targetIdentity) {
    throw new Error("Companion publication journal has an unsupported or incomplete schema.");
  }
  if (transaction.phase === "committed-awaiting-report") {
    finalizeCommittedPublication(transaction);
    return "finalized-committed-publication";
  }
  if (transaction.phase !== undefined && transaction.phase !== "prepared") {
    throw new Error(`Companion publication journal has unsupported phase ${JSON.stringify(transaction.phase)}.`);
  }

  rollbackJournalArtifact({
    kind: "app",
    canonical: deliveredAppBundle,
    exchange: deliveryExchange,
    hadPrevious: transaction.app.hadPrevious === true,
    targetMatches: (path) => sameAppIdentity(inspectedAppIdentity(path), transaction.app.targetIdentity)
  });

  if (transaction.dmg) {
    const paths = dmgPaths(transaction.dmg.shortVersion);
    rollbackJournalArtifact({
      kind: "DMG",
      canonical: paths.canonical,
      exchange: paths.exchange,
      hadPrevious: transaction.dmg.hadPrevious === true,
      targetMatches: (path) => inspectedFileSha256(path) === transaction.dmg.targetSha256
    });
  }

  rmSync(publicationJournal, { force: true });
  spawnSync("/bin/sync", [], { stdio: "ignore" });
  return "rolled-back-interrupted-publication";
}

function writePublicationTransaction(transaction) {
  assertPublicationLockHeld();
  rmSync(publicationJournalCandidate, { force: true });
  writeFileSync(publicationJournalCandidate, `${JSON.stringify(transaction, null, 2)}\n`, { flag: "wx" });
  spawnSync("/bin/sync", [], { stdio: "ignore" });
  renameSync(publicationJournalCandidate, publicationJournal);
  spawnSync("/bin/sync", [], { stdio: "ignore" });
}

function reportPathForTransaction(transaction) {
  const expectedName = transaction.signed
    ? "macos-native-signed-package-report.json"
    : "macos-native-unsigned-package-report.json";
  if (transaction.reportFileName !== expectedName) {
    throw new Error("Publication finalization record names an unexpected report path.");
  }
  return join(root, "reports", expectedName);
}

function finalizeCommittedPublication(transaction) {
  assertPublicationLockHeld();
  if (transaction.phase !== "committed-awaiting-report" || !transaction.report) {
    throw new Error("Publication finalization record is incomplete.");
  }
  const deliveredIdentity = inspectedAppIdentity(deliveredAppBundle);
  if (!sameAppIdentity(deliveredIdentity, transaction.app.targetIdentity)) {
    throw new Error("Committed companion no longer matches its finalization record.");
  }
  if (!rawBundleEvidenceIsSafe(rawBundleEvidence(deliveredAppBundle))) {
    throw new Error("Committed companion failed raw metadata/signature validation during finalization.");
  }
  if (!sameAppIdentity(transaction.report.artifactIdentity, transaction.app.targetIdentity)) {
    throw new Error("Finalization report is not bound to the committed companion identity.");
  }

  if (transaction.signed) {
    run("recover-validate-app-ticket", "xcrun", ["stapler", "validate", deliveredAppBundle], {
      throwOnFailure: true
    });
    run("recover-gatekeeper-app", "spctl", [
      "--assess", "--type", "execute", "--verbose=2", deliveredAppBundle
    ], { throwOnFailure: true });
  }

  if (transaction.dmg) {
    const paths = dmgPaths(transaction.dmg.shortVersion);
    if (inspectedFileSha256(paths.canonical) !== transaction.dmg.targetSha256) {
      throw new Error("Committed DMG no longer matches its finalization record.");
    }
    if (transaction.report.notarizedArtifact !== paths.canonical ||
        transaction.report.notarizedArtifactSha256 !== transaction.dmg.targetSha256) {
      throw new Error("Finalization report is not bound to the committed DMG.");
    }
    const dmgIdentity = codeSignIdentity(paths.canonical);
    if (!sameCodeSignIdentity(dmgIdentity, transaction.dmg.targetIdentity) ||
        !sameCodeSignIdentity(transaction.report.dmgArtifactIdentity, transaction.dmg.targetIdentity)) {
      throw new Error("Committed DMG signer identity is not bound to its finalization record and report.");
    }
    if (
      transaction.signed &&
      (
        dmgIdentity.signingKind !== "developer-id" ||
        dmgIdentity.teamIdentifier !== transaction.app.targetIdentity.teamIdentifier ||
        dmgIdentity.secureTimestamp !== true
      )
    ) {
      throw new Error("Committed DMG no longer matches the transaction's Developer ID Team ID.");
    }
    run("recover-verify-dmg-signature", "codesign", [
      "--verify", "--strict", "--verbose=2", paths.canonical
    ], { throwOnFailure: true });
    if (transaction.signed) {
      run("recover-validate-dmg-ticket", "xcrun", ["stapler", "validate", paths.canonical], {
        throwOnFailure: true
      });
      run("recover-gatekeeper-dmg", "spctl", [
        "--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", paths.canonical
      ], { throwOnFailure: true });
    }
  }

  writeJsonAtomically(reportPathForTransaction(transaction), transaction.report);
  rmSync(deliveryExchange, { recursive: true, force: true });
  if (transaction.dmg) rmSync(dmgPaths(transaction.dmg.shortVersion).exchange, { force: true });
  spawnSync("/bin/sync", [], { stdio: "ignore" });
  rmSync(publicationJournal, { force: true });
  spawnSync("/bin/sync", [], { stdio: "ignore" });
  publicationState.readyToCommit = false;
  publicationState.committed = true;
}

function commitPublicationWithReport(report) {
  assertSignedSourceProvenance("publication finalization");
  const transaction = JSON.parse(readFileSync(publicationJournal, "utf8"));
  if (transaction?.version !== 1 || transaction.phase !== "prepared") {
    throw new Error("Cannot commit companion publication without a prepared durable transaction.");
  }
  const committedRecord = {
    ...transaction,
    phase: "committed-awaiting-report",
    reportFileName: signed
      ? "macos-native-signed-package-report.json"
      : "macos-native-unsigned-package-report.json",
    report
  };
  writePublicationTransaction(committedRecord);
  if (finalizationFault === "throw") {
    throw new Error("Injected post-finalization-marker companion publication failure.");
  }
  if (finalizationFault === "sigkill") {
    process.kill(process.pid, "SIGKILL");
  }
  finalizeCommittedPublication(committedRecord);
}

function atomicSwapBundles(firstPath, secondPath) {
  assertPublicationLockHeld();
  const result = spawnSync("/usr/bin/swift", [
    join(root, "native/macos-imk/skeleton/atomic-install-swap.swift"),
    firstPath,
    secondPath
  ], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe"
  });
  if (result.status !== 0) {
    throw Object.assign(new Error("Atomic RENAME_SWAP publication failed."), {
      evidence: {
        status: result.status,
        signal: result.signal ?? null,
        stdout: result.stdout,
        stderr: result.stderr
      }
    });
  }
}

function rawBundleEvidence(path) {
  const xattrs = spawnSync("/usr/bin/xattr", ["-r", path], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe"
  });
  const signature = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", path], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe"
  });
  return {
    xattrInspectionSucceeded: xattrs.status === 0,
    xattrStdout: xattrs.stdout,
    xattrStderr: xattrs.stderr,
    blockedExtendedAttributes: xattrs.status === 0
      ? findCodeSignBlockedExtendedAttributes(xattrs.stdout)
      : [],
    signatureVerified: signature.status === 0,
    signatureStdout: signature.stdout,
    signatureStderr: signature.stderr
  };
}

function sha256File(path) {
  const result = spawnSync("/usr/bin/shasum", ["-a", "256", path], { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) throw new Error(`Could not hash ${path}: ${result.stderr || result.stdout}`.trim());
  return result.stdout.trim().split(/\s+/)[0] ?? "";
}

function codeSignIdentity(path, { requireDesignatedRequirement = false } = {}) {
  const display = spawnSync("/usr/bin/codesign", ["-d", "--verbose=4", path], {
    encoding: "utf8",
    stdio: "pipe"
  });
  const requirement = spawnSync("/usr/bin/codesign", ["-d", "-r-", path], {
    encoding: "utf8",
    stdio: "pipe"
  });
  if (display.status !== 0 || (requireDesignatedRequirement && requirement.status !== 0)) {
    throw new Error(`Could not inspect delivered code identity: ${display.stderr || requirement.stderr}`.trim());
  }
  return parseCodeSignInspection(
    `${display.stdout}${display.stderr}\n${requirement.stdout}${requirement.stderr}`
  );
}

function appArtifactIdentity(path) {
  const identity = codeSignIdentity(path, { requireDesignatedRequirement: true });
  const deliveredExecutable = join(path, "Contents", "MacOS", executableName);
  const deliveredPlist = join(path, "Contents", "Info.plist");
  return {
    ...identity,
    executableSha256: sha256File(deliveredExecutable),
    infoPlistSha256: sha256File(deliveredPlist)
  };
}

function sameCodeSignIdentity(left, right) {
  if (!left || !right) return false;
  return [
    "identifier",
    "codeDirectoryHash",
    "teamIdentifier",
    "signingKind",
    "designatedRequirement",
    "secureTimestamp",
    "timestamp"
  ].every((field) => left[field] === right[field]);
}

function validateAppArtifactIdentity(identity, label) {
  if (identity.identifier !== "com.lekh.keyboard.companion") {
    throw new Error(`${label} does not carry the required bundle signing identifier.`);
  }
  if (identity.hardenedRuntime !== true) {
    throw new Error(`${label} is missing hardened-runtime code-signing flags.`);
  }
  if (
    signed &&
    (
      identity.signingKind !== "developer-id" ||
      identity.teamIdentifier !== process.env.APPLE_TEAM_ID ||
      identity.secureTimestamp !== true
    )
  ) {
    throw new Error(`${label} does not match the required timestamped Developer ID identity.`);
  }
  if (!signed && identity.signingKind !== "ad-hoc") {
    throw new Error(`${label} is not explicitly ad-hoc signed for development.`);
  }
}

function validateDmgArtifactIdentity(identity, label) {
  if (
    identity.signingKind !== "developer-id" ||
    identity.teamIdentifier !== process.env.APPLE_TEAM_ID ||
    identity.secureTimestamp !== true
  ) {
    throw new Error(`${label} does not match the required timestamped Developer ID Team ID.`);
  }
}

function rawBundleEvidenceIsSafe(evidence) {
  return evidence.xattrInspectionSucceeded &&
    evidence.blockedExtendedAttributes.length === 0 &&
    evidence.signatureVerified;
}

function waitForSettledRawBundle(path, { requiredSafeSamples = 5, intervalMs = 500 } = {}) {
  let safeSamples = 0;
  let latestEvidence = null;
  const observations = [];
  while (safeSamples < requiredSafeSamples) {
    latestEvidence = rawBundleEvidence(path);
    const safe = rawBundleEvidenceIsSafe(latestEvidence);
    observations.push({
      safe,
      blockedExtendedAttributes: latestEvidence.blockedExtendedAttributes,
      signatureVerified: latestEvidence.signatureVerified
    });
    if (!safe) {
      return { settled: false, safeSamples, observations, evidence: latestEvidence };
    }
    safeSamples += 1;
    if (safeSamples < requiredSafeSamples) sleep(intervalMs);
  }
  return { settled: true, safeSamples, observations, evidence: latestEvidence };
}

function publishDeliveredArtifacts() {
  acquirePublicationLock();
  const recoveredInterruptedPublication = recoveredInterruptedPublicationAtStartup || recoverInterruptedPublication();
  assertSignedSourceProvenance("pre-publication verification");
  rmSync(deliveryExchange, { recursive: true, force: true });
  run("deliver-candidate", "/usr/bin/ditto", ["--norsrc", "--noextattr", "--noacl", appBundle, deliveryExchange]);
  run("strip-delivery-candidate-extended-attributes", "/usr/bin/xattr", ["-cr", deliveryExchange]);

  // iCloud Drive/File Provider can synthesize FinderInfo on a directory named
  // *.app after publication. Giving the private candidate a .nosync suffix
  // lets File Provider mark it excluded before the atomic final rename. On a
  // normal filesystem no marker appears, and the settled raw verification
  // below remains the authority.
  let fileProviderExclusionMarkerPresent = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const marker = spawnSync("/usr/bin/xattr", ["-p", "com.apple.fileprovider.dir#N", deliveryExchange], {
      encoding: "utf8",
      stdio: "pipe"
    });
    if (marker.status === 0) {
      fileProviderExclusionMarkerPresent = true;
      break;
    }
    sleep(50);
  }

  const candidateEvidence = rawBundleEvidence(deliveryExchange);
  if (!rawBundleEvidenceIsSafe(candidateEvidence)) {
    rmSync(deliveryExchange, { recursive: true, force: true });
    throw Object.assign(new Error("The delivery candidate is not metadata-safe and code-signature-valid."), {
      evidence: candidateEvidence
    });
  }
  const candidateIdentity = appArtifactIdentity(deliveryExchange);
  validateAppArtifactIdentity(candidateIdentity, "Delivery candidate");

  let dmgTargetSha256 = null;
  let dmgTargetIdentity = null;
  if (dmgCandidateForPublication) {
    const paths = dmgPaths(shortVersion);
    deliveredDmg = paths.canonical;
    dmgDeliveryExchange = paths.exchange;
    rmSync(dmgDeliveryExchange, { force: true });
    run("deliver-dmg-candidate", "/usr/bin/ditto", [
      "--norsrc", "--noextattr", dmgCandidateForPublication, dmgDeliveryExchange
    ]);
    run("verify-dmg-delivery-candidate", "codesign", [
      "--verify", "--strict", "--verbose=2", dmgDeliveryExchange
    ]);
    run("validate-dmg-delivery-ticket", "xcrun", ["stapler", "validate", dmgDeliveryExchange]);
    run("gatekeeper-dmg-delivery-candidate", "spctl", [
      "--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", dmgDeliveryExchange
    ]);
    dmgTargetSha256 = sha256File(dmgDeliveryExchange);
    dmgTargetIdentity = codeSignIdentity(dmgDeliveryExchange);
    validateDmgArtifactIdentity(dmgTargetIdentity, "DMG delivery candidate");
  }

  const transaction = {
    version: 1,
    phase: "prepared",
    signed,
    createdAt: new Date().toISOString(),
    sourceRevision,
    app: {
      hadPrevious: existsSync(deliveredAppBundle),
      targetIdentity: candidateIdentity
    },
    dmg: dmgDeliveryExchange
      ? {
          shortVersion,
          hadPrevious: existsSync(deliveredDmg),
          targetSha256: dmgTargetSha256,
          targetIdentity: dmgTargetIdentity
        }
      : null
  };
  writePublicationTransaction(transaction);
  try {
    if (transaction.app.hadPrevious) {
      atomicSwapBundles(deliveryExchange, deliveredAppBundle);
    } else {
      assertPublicationLockHeld();
      renameSync(deliveryExchange, deliveredAppBundle);
    }
    spawnSync("/bin/sync", [], { stdio: "ignore" });
    if (appSwapFault === "throw") {
      throw new Error("Injected post-swap companion publication failure.");
    }
    if (appSwapFault === "sigkill") {
      process.kill(process.pid, "SIGKILL");
    }

    if (transaction.dmg) {
      if (transaction.dmg.hadPrevious) {
        atomicSwapBundles(dmgDeliveryExchange, deliveredDmg);
      } else {
        assertPublicationLockHeld();
        renameSync(dmgDeliveryExchange, deliveredDmg);
      }
      spawnSync("/bin/sync", [], { stdio: "ignore" });
      if (dmgSwapFault === "throw") {
        throw new Error("Injected post-DMG-swap companion publication failure.");
      }
      if (dmgSwapFault === "sigkill") {
        process.kill(process.pid, "SIGKILL");
      }
    }

    // Prove the actual path after File Provider has had a chance to decorate
    // it. Verification of a sanitized copy would hide the release defect.
    sleep(1_000);
    const settledDelivery = waitForSettledRawBundle(deliveredAppBundle);
    if (!settledDelivery.settled) {
      throw Object.assign(new Error("The delivered raw .app failed settled metadata/signature verification."), {
        evidence: settledDelivery.evidence,
        observations: settledDelivery.observations
      });
    }
    if (signed) {
      run("validate-delivered-app-ticket", "xcrun", ["stapler", "validate", deliveredAppBundle], {
        throwOnFailure: true
      });
      run("gatekeeper-delivered-app", "spctl", [
        "--assess", "--type", "execute", "--verbose=2", deliveredAppBundle
      ], { throwOnFailure: true });
    }
    const deliveredIdentity = appArtifactIdentity(deliveredAppBundle);
    validateAppArtifactIdentity(deliveredIdentity, "Delivered companion");
    if (!sameAppIdentity(deliveredIdentity, candidateIdentity)) {
      throw new Error("Delivered companion identity does not match the pre-swap candidate.");
    }
    if (transaction.dmg) {
      if (sha256File(deliveredDmg) !== dmgTargetSha256) {
        throw new Error("Delivered DMG digest does not match the pre-swap candidate.");
      }
      run("verify-delivered-dmg-signature", "codesign", [
        "--verify", "--strict", "--verbose=2", deliveredDmg
      ], { throwOnFailure: true });
      run("validate-delivered-dmg-ticket", "xcrun", ["stapler", "validate", deliveredDmg], {
        throwOnFailure: true
      });
      run("gatekeeper-delivered-dmg", "spctl", [
        "--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", deliveredDmg
      ], { throwOnFailure: true });
      const deliveredDmgIdentity = codeSignIdentity(deliveredDmg);
      validateDmgArtifactIdentity(deliveredDmgIdentity, "Delivered DMG");
      if (!sameCodeSignIdentity(deliveredDmgIdentity, dmgTargetIdentity)) {
        throw new Error("Delivered DMG signer identity does not match the pre-swap candidate.");
      }
    }

    // The prepared journal and old artifacts remain until finish() atomically
    // transitions the journal to a committed finalization record containing
    // the complete report. This closes the artifact/report crash window.
    publicationState.readyToCommit = true;
    return {
      recoveredInterruptedPublication: Boolean(recoveredInterruptedPublication),
      recoveryDisposition: recoveredInterruptedPublication,
      fileProviderExclusionMarkerPresent,
      metadataSafe: true,
      blockedExtendedAttributes: [],
      signatureVerifiedOnDeliveredBundle: true,
      settledVerificationSamples: settledDelivery.safeSamples,
      artifactIdentity: deliveredIdentity,
      dmgArtifactIdentity: transaction.dmg ? dmgTargetIdentity : null,
      notarizedArtifactSha256: transaction.dmg ? dmgTargetSha256 : null
    };
  } catch (error) {
    try {
      recoverInterruptedPublication();
    } catch (recoveryError) {
      throw Object.assign(new Error(
        `${error instanceof Error ? error.message : String(error)} Recovery also failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`
      ), {
        evidence: {
          failure: error?.evidence ?? null,
          recovery: recoveryError?.evidence ?? null,
          journal: publicationJournal
        }
      });
    }
    throw error;
  }
}

if (process.platform !== "darwin") {
  finish("blocked-native-environment", { reason: "The native SwiftUI companion must be packaged on macOS." }, 2);
}

try {
  acquirePublicationLock();
  recoveredInterruptedPublicationAtStartup = recoverInterruptedPublication();
} catch (error) {
  const lockBusy = error?.code === "publication-lock-busy";
  finishRecovery(lockBusy ? "retry-publication-lock-busy" : "failed-recovery", {
    reason: error instanceof Error ? error.message : String(error),
    evidence: error?.evidence ?? null
  }, lockBusy ? 75 : 1);
}
if (recoveredInterruptedPublicationAtStartup) {
  const explicitRecovery = process.argv.includes("--recover-publication");
  if (recoveredInterruptedPublicationAtStartup === "finalized-committed-publication") {
    finishRecovery("passed-recovery-completed", recoveredInterruptedPublicationAtStartup, 0);
  }
  finishRecovery(
    explicitRecovery ? "passed-recovery-retry-required" : "recovered-rollback-retry-required",
    recoveredInterruptedPublicationAtStartup,
    explicitRecovery ? 0 : 75
  );
}
if (process.argv.includes("--recover-publication")) {
  finishRecovery("passed-no-recovery-required", null, 0);
}

const requestedFaults = [appSwapFault, dmgSwapFault, finalizationFault].filter((value) => value !== null);
if (
  Object.prototype.hasOwnProperty.call(process.env, "LEKH_PACKAGE_TEST_MODE") &&
  process.env.LEKH_PACKAGE_TEST_MODE !== "1"
) {
  finish("failed", {
    step: "publication-test-mode",
    reason: "LEKH_PACKAGE_TEST_MODE, when present, must be exactly 1."
  }, 1);
}
if (requestedFaults.some((value) => value !== "throw" && value !== "sigkill")) {
  finish("failed", {
    step: "publication-test-mode",
    reason: "Publication fault values must be exactly throw or sigkill."
  }, 1);
}
if (requestedFaults.length > 0 && !publicationTestMode) {
  finish("failed", {
    step: "publication-test-mode",
    reason: "Publication faults require the explicit LEKH_PACKAGE_TEST_MODE=1 opt-in."
  }, 1);
}
if (dmgSwapFault && !signed) {
  finish("failed", {
    step: "publication-test-mode",
    reason: "A DMG publication fault is invalid for unsigned app-only packaging."
  }, 1);
}

try {
  const revisionResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: "pipe" });
  const statusResult = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe"
  });
  if (revisionResult.status !== 0 || statusResult.status !== 0) {
    throw new Error("Could not establish Git source provenance for the companion package.");
  }
  sourceRevision = revisionResult.stdout.trim();
  sourceTreeClean = statusResult.stdout.trim().length === 0;
  if (signed && !Object.prototype.hasOwnProperty.call(process.env, "LEKH_APP_BUILD")) {
    throw new Error("Signed releases require an explicit trusted monotonic LEKH_APP_BUILD value; Git commit count is development-only.");
  }
  if (signed && !sourceTreeClean) {
    throw new Error("Signed releases require a clean Git worktree so artifact provenance matches sourceRevision.");
  }
  const packageJsonText = signed
    ? gitObjectAtRevision(sourceRevision, "package.json")
    : readFileSync(join(root, "package.json"), "utf8");
  const packageVersion = JSON.parse(packageJsonText).version;
  let gitCount = null;
  if (!Object.prototype.hasOwnProperty.call(process.env, "LEKH_APP_BUILD")) {
    const gitCountResult = spawnSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe"
    });
    if (gitCountResult.status !== 0) {
      throw new Error(`Could not derive CFBundleVersion from git: ${gitCountResult.stderr || gitCountResult.stdout}`.trim());
    }
    gitCount = gitCountResult.stdout.trim();
  }
  bundleVersions = resolveCompanionBundleVersions({
    environment: process.env,
    packageVersion,
    gitCount
  });
} catch (error) {
  finish("failed", {
    step: "bundle-versions",
    reason: error instanceof Error ? error.message : String(error),
    requestedShortVersion: process.env.LEKH_APP_SHORT_VERSION ?? null,
    requestedBuildVersion: process.env.LEKH_APP_BUILD ?? null
  }, 1);
}

const missingSources = sources.filter((source) => !existsSync(source));
if (missingSources.length > 0) {
  finish("failed", { step: "sources", missingSources }, 1);
}

if (signed) {
  const requiredSigningEnvironment = [
    "LEKH_MAC_DEVELOPER_ID",
    "LEKH_NOTARY_KEYCHAIN_PROFILE",
    "APPLE_TEAM_ID"
  ];
  const missingSigningEnvironment = requiredSigningEnvironment.filter((key) => !process.env[key]);
  if (missingSigningEnvironment.length > 0) {
    finish("blocked-external", {
      reason: "Developer ID signing plus Keychain-backed notarization credentials are required for a production companion.",
      missingEnvironment: missingSigningEnvironment,
      unsignedDevCommand: "npm run package:macos:unsigned"
    }, 2);
  }
}

if (signed) {
  const immutableSourceRoot = join(stagingRoot, "committed-source");
  mkdirSync(immutableSourceRoot, { recursive: true });
  compileSources = sourceRelativePaths.map((relativePath) => {
    const destination = join(immutableSourceRoot, relativePath.split("/").at(-1));
    writeFileSync(destination, gitObjectAtRevision(sourceRevision, relativePath));
    return destination;
  });
  iconSourceForPackage = join(immutableSourceRoot, "Lekh.icns");
  writeFileSync(iconSourceForPackage, gitObjectAtRevision(sourceRevision, "build/icon.icns", { binary: true }));
  assertSignedSourceProvenance("immutable source materialization");
}

const sdk = run("sdk", "xcrun", ["--sdk", "macosx", "--show-sdk-path"]).stdout.trim();
rmSync(buildRoot, { recursive: true, force: true });
rmSync(appBundle, { recursive: true, force: true });
mkdirSync(buildRoot, { recursive: true });
mkdirSync(join(appBundle, "Contents", "MacOS"), { recursive: true });
mkdirSync(join(appBundle, "Contents", "Resources"), { recursive: true });

for (const arch of ["arm64", "x86_64"]) {
  run(`compile-${arch}`, "swiftc", [
    "-parse-as-library",
    "-O",
    "-whole-module-optimization",
    "-module-name", "LekhKeyboardCompanion",
    "-target", `${arch}-apple-macos13`,
    "-sdk", sdk,
    "-framework", "SwiftUI",
    "-framework", "AppKit",
    "-framework", "Carbon",
    "-framework", "Security",
    "-framework", "UniformTypeIdentifiers",
    "-lsqlite3",
    ...compileSources,
    "-o", join(buildRoot, `${executableName}-${arch}`)
  ]);
}

run("lipo", "lipo", [
  "-create",
  join(buildRoot, `${executableName}-arm64`),
  join(buildRoot, `${executableName}-x86_64`),
  "-output", executable
]);

if (existsSync(iconSourceForPackage)) {
  copyFileSync(iconSourceForPackage, join(appBundle, "Contents", "Resources", "Lekh.icns"));
}

const { shortVersion, buildVersion } = bundleVersions;
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Lekh Keyboard Companion</string>
  <key>CFBundleExecutable</key><string>${executableName}</string>
  <key>CFBundleIconFile</key><string>Lekh.icns</string>
  <key>CFBundleIdentifier</key><string>com.lekh.keyboard.companion</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Lekh Keyboard Companion</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${shortVersion}</string>
  <key>CFBundleVersion</key><string>${buildVersion}</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSMultipleInstancesProhibited</key><true/>
  <key>LekhSourceRevision</key><string>${sourceRevision}</string>
  <key>LekhSourceTreeClean</key>${sourceTreeClean ? "<true/>" : "<false/>"}
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Copyright © 2026 Lekh</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSQuitAlwaysKeepsWindows</key><false/>
  <key>NSSupportsAutomaticTermination</key><true/>
</dict>
</plist>
`;
writeFileSync(join(appBundle, "Contents", "Info.plist"), plist);
writeFileSync(join(appBundle, "Contents", "PkgInfo"), "APPL????");

assertSignedSourceProvenance("pre-sign verification");
run("strip-extended-attributes", "xattr", ["-cr", appBundle]);
const signArgs = signed
  ? ["--force", "--options", "runtime", "--timestamp", "--sign", process.env.LEKH_MAC_DEVELOPER_ID, appBundle]
  : ["--force", "--options", "runtime", "--timestamp=none", "--sign", "-", appBundle];
run("codesign", "codesign", signArgs);
// Documents may be backed by File Provider, which can reattach Finder metadata
// after bundle creation. It is not signed content and must be stripped again.
run("strip-post-sign-extended-attributes", "xattr", ["-cr", appBundle]);
run("codesign-verify", "codesign", ["--verify", "--deep", "--strict", "--verbose=2", appBundle]);

const architectureOutput = run("architecture", "lipo", ["-archs", executable]).stdout.trim();
const forbiddenUsageKeys = [
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSLocationUsageDescription"
];
const plistText = readFileSync(join(appBundle, "Contents", "Info.plist"), "utf8");
const presentForbiddenUsageKeys = forbiddenUsageKeys.filter((key) => plistText.includes(`<key>${key}</key>`));
if (presentForbiddenUsageKeys.length > 0 || plistText.includes("NSAllowsArbitraryLoads")) {
  finish("failed", { step: "least-privilege", presentForbiddenUsageKeys }, 1);
}

let notarizedArtifact = null;
let notarizationEvidence = null;
if (signed) {
  acquirePublicationLock();
  const profile = process.env.LEKH_NOTARY_KEYCHAIN_PROFILE;
  const optionalKeychain = process.env.LEKH_NOTARY_KEYCHAIN_PATH
    ? ["--keychain", process.env.LEKH_NOTARY_KEYCHAIN_PATH]
    : [];
  const submitWithStoredCredentials = (step, artifact) => {
    const args = [
      "notarytool", "submit", artifact,
      "--keychain-profile", profile,
      ...optionalKeychain,
      "--wait"
    ];
    run(step, "xcrun", args, {
      timeout: 900_000,
      redactArgumentIndexes: [4],
      secretValues: [profile]
    });
  };

  // Notarize and staple the exact app before placing it in the disk image, so
  // offline Gatekeeper validation does not depend only on the container ticket.
  const appZip = join(stagingRoot, `Lekh-Keyboard-Companion-${shortVersion}.zip`);
  run("notary-app-zip", "/usr/bin/ditto", ["-c", "-k", "--keepParent", appBundle, appZip]);
  submitWithStoredCredentials("notary-app", appZip);
  run("staple-app", "xcrun", ["stapler", "staple", appBundle]);
  run("validate-app-ticket", "xcrun", ["stapler", "validate", appBundle]);
  run("gatekeeper-app", "spctl", ["--assess", "--type", "execute", "--verbose=2", appBundle]);
  dmgEmbeddedAppIdentity = appArtifactIdentity(appBundle);
  validateAppArtifactIdentity(dmgEmbeddedAppIdentity, "DMG embedded companion");

  const dmgCandidate = join(stagingRoot, `Lekh-Keyboard-Companion-${shortVersion}.dmg`);
  run("dmg", "hdiutil", [
    "create", "-volname", "Lekh Keyboard", "-srcfolder", appBundle,
    "-ov", "-format", "UDZO", dmgCandidate
  ]);
  run("codesign-dmg", "codesign", [
    "--force", "--timestamp", "--sign", process.env.LEKH_MAC_DEVELOPER_ID, dmgCandidate
  ]);
  run("codesign-verify-dmg", "codesign", ["--verify", "--strict", "--verbose=2", dmgCandidate]);
  submitWithStoredCredentials("notary-dmg", dmgCandidate);
  run("staple-dmg", "xcrun", ["stapler", "staple", dmgCandidate]);
  run("validate-dmg-ticket", "xcrun", ["stapler", "validate", dmgCandidate]);
  run("gatekeeper-dmg", "spctl", [
    "--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", dmgCandidate
  ]);

  dmgCandidateForPublication = dmgCandidate;
  deliveredDmg = dmgPaths(shortVersion).canonical;
  dmgDeliveryExchange = dmgPaths(shortVersion).exchange;
  notarizedArtifact = deliveredDmg;
  notarizationEvidence = {
    authentication: "keychain-profile",
    appSubmitted: true,
    appTicketStapledAndValidated: true,
    appGatekeeperAccepted: true,
    dmgSubmitted: true,
    dmgSigned: true,
    dmgTicketStapledAndValidated: true,
    dmgGatekeeperAccepted: true
  };
}

let deliveryEvidence;
try {
  deliveryEvidence = publishDeliveredArtifacts();
} catch (error) {
  finish("failed", {
    step: "deliver-app",
    reason: error instanceof Error ? error.message : String(error),
    evidence: error?.evidence ?? null
  }, 1);
}

finish(
  signed
    ? publicationTestMode ? "passed-signed-notarized-test-only" : "passed-signed-notarized"
    : publicationTestMode ? "passed-unsigned-native-dev-test-only" : "passed-unsigned-native-dev",
  {
    signed,
    notarizedArtifact,
    architectures: architectureOutput.split(/\s+/).sort(),
    bundleBytes: directoryBytes(deliveredAppBundle),
    electronFrameworkPresent: existsSync(join(deliveredAppBundle, "Contents", "Frameworks", "Electron Framework.framework")),
    arbitraryNetworkLoads: false,
    hardwareUsageDescriptions: [],
    notarization: notarizationEvidence,
    dmgEmbeddedAppIdentity,
    notarizedArtifactSha256: deliveryEvidence.notarizedArtifactSha256,
    ...deliveryEvidence
  },
  0
);

function directoryBytes(directory) {
  const result = spawnSync("du", ["-sk", directory], { encoding: "utf8" });
  if (result.status === 0) return Number(result.stdout.trim().split(/\s+/)[0]) * 1024;
  return statSync(executable).size;
}
