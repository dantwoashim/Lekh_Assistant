import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const directoryMode = 0o700;
const fileMode = 0o600;
const leaseDirectoryName = "Host State";
const leaseFileName = "host-state-mutation.lock";

function ownerUserId() {
  const value = process.getuid?.();
  if (!Number.isInteger(value) || value < 0) throw new Error("Host-state lease owner is unavailable.");
  return value;
}

function validateOwnedNode(metadata, { label, directory }) {
  const correctKind = directory ? metadata.isDirectory() : metadata.isFile();
  if (!correctKind || metadata.isSymbolicLink()) throw new Error(`${label} has an unsafe kind.`);
  if (metadata.uid !== ownerUserId()) throw new Error(`${label} has an unsafe owner.`);
  const requiredMode = directory ? directoryMode : fileMode;
  if ((metadata.mode & 0o777) !== requiredMode) throw new Error(`${label} has unsafe permissions.`);
  if (!directory && metadata.nlink !== 1) throw new Error(`${label} has an unsafe link count.`);
}

export function macOSHostStateLeasePath({ homeDirectory = homedir() } = {}) {
  if (!isAbsolute(homeDirectory)) throw new Error("Host-state lease home directory must be absolute.");
  return join(
    resolve(homeDirectory),
    "Library",
    "Application Support",
    "Lekh Keyboard",
    "QA Recovery",
    leaseDirectoryName,
    leaseFileName
  );
}

function ensureLeasePath(options = {}) {
  const path = macOSHostStateLeasePath(options);
  const directoryPath = resolve(path, "..");
  mkdirSync(directoryPath, { recursive: true, mode: directoryMode });
  validateOwnedNode(lstatSync(directoryPath), { label: "Host-state lease directory", directory: true });
  return path;
}

export function assertMacOSHostStateLeaseDescriptor(descriptor, path) {
  const descriptorMetadata = fstatSync(descriptor);
  const pathMetadata = lstatSync(path);
  validateOwnedNode(descriptorMetadata, { label: "Host-state lease descriptor", directory: false });
  validateOwnedNode(pathMetadata, { label: "Host-state lease", directory: false });
  if (descriptorMetadata.dev !== pathMetadata.dev || descriptorMetadata.ino !== pathMetadata.ino) {
    throw new Error("Host-state lease descriptor does not match its path.");
  }
  return true;
}

export function acquireMacOSHostStateLease({
  homeDirectory,
  lockHelperPath,
  swiftExecutable = "/usr/bin/swift",
  waitMilliseconds = 60_000
} = {}) {
  if (!isAbsolute(lockHelperPath ?? "")) throw new Error("Host-state lock helper path must be absolute.");
  if (!Number.isInteger(waitMilliseconds) || waitMilliseconds < 0 || waitMilliseconds > 60_000) {
    throw new Error("Host-state lease wait is invalid.");
  }
  const path = ensureLeasePath({ homeDirectory });
  let descriptor = null;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      fileMode
    );
    assertMacOSHostStateLeaseDescriptor(descriptor, path);
    const acquisition = spawnSync(
      swiftExecutable,
      [lockHelperPath, "--lock-fd", "3", "--wait-ms", String(waitMilliseconds)],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe", descriptor],
        timeout: waitMilliseconds + 30_000
      }
    );
    let evidence = null;
    try { evidence = JSON.parse(acquisition.stdout || "null"); } catch {}
    if (acquisition.status !== 0 || evidence?.status !== "acquired") {
      const busy = acquisition.status === 75 || evidence?.status === "busy";
      const error = new Error(busy
        ? "Another macOS host-state probe owns the mutation lease."
        : "The macOS host-state mutation lease could not be acquired.");
      error.code = busy ? "macos-host-state-lease-busy" : "macos-host-state-lease-failed";
      throw error;
    }
    return Object.freeze({ descriptor, path });
  } catch (error) {
    if (descriptor !== null) try { closeSync(descriptor); } catch {}
    throw error;
  }
}

export function releaseMacOSHostStateLease(lease) {
  assertMacOSHostStateLeaseDescriptor(lease.descriptor, lease.path);
  closeSync(lease.descriptor);
  return true;
}
