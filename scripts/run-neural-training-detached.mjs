#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  canonicalNeuralTrainingConfigPath,
  resolveNeuralTrainingLayout,
  validateNeuralTrainingConfig
} from "./lib/neural-training-contract.mjs";

const TRAINER = "scripts/train-open-vocab-seq2seq-transliterator.py";
const TOOLCHAIN_CHECK = "scripts/check-neural-open-vocab-toolchain.py";
const PYTHON = ".tmp/neural-seq2seq-venv/bin/python";
const CAFFEINATE = "/usr/bin/caffeinate";
const STARTUP_GRACE_MS = 3_000;

export function buildDetachedTrainingCommand(options) {
  const root = resolve(options.repoRoot);
  const args = [
    "-ims",
    resolve(options.pythonPath),
    resolve(root, TRAINER),
    "--config",
    resolve(options.configPath)
  ];
  if (options.restartTraining) args.push("--restart-training");
  return Object.freeze({
    executable: CAFFEINATE,
    args: Object.freeze(args),
    cwd: root
  });
}

async function main() {
  const root = realpathSync(resolve(process.cwd()));
  const parsed = parseArguments(process.argv.slice(2));
  const requestedConfig = containedRegularFile(
    root,
    parsed.config,
    "Training config"
  );
  const config = readJson(requestedConfig, "Training config");
  const validation = validateNeuralTrainingConfig(config);
  if (validation.failures.length > 0) {
    throw new TypeError(validation.failures.join("\n"));
  }
  const canonicalConfig = realpathSync(
    canonicalNeuralTrainingConfigPath(config.modelId, root)
  );
  if (requestedConfig !== canonicalConfig) {
    throw new TypeError(
      `Training config for ${config.modelId} must be its canonical ` +
      "allowlisted repository config."
    );
  }
  const layout = resolveNeuralTrainingLayout(config, canonicalConfig, root);
  refuseActiveLaunch(layout.candidateRoot);

  const pythonPath = resolve(root, PYTHON);
  const trainerPath = containedRegularFile(root, TRAINER, "Neural trainer");
  const toolchainPath = containedRegularFile(
    root,
    TOOLCHAIN_CHECK,
    "Neural toolchain verifier"
  );
  if (!existsSync(pythonPath) ||
      !statSync(realpathSync(pythonPath)).isFile()) {
    throw new TypeError(
      "Pinned neural Python environment is missing; run " +
      "npm run neural:open-vocab:setup first."
    );
  }
  if (!existsSync(CAFFEINATE) || !lstatSync(CAFFEINATE).isFile()) {
    throw new TypeError("macOS caffeinate is unavailable.");
  }

  const toolchain = spawnSync(pythonPath, [toolchainPath], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  if (toolchain.status !== 0 || toolchain.signal || toolchain.error) {
    throw new TypeError(
      "Pinned neural toolchain verification failed: " +
      `${toolchain.error?.message ?? toolchain.signal ?? toolchain.stderr}`
    );
  }

  const command = buildDetachedTrainingCommand({
    repoRoot: root,
    configPath: canonicalConfig,
    pythonPath,
    restartTraining: parsed.restartTraining
  });
  const launchRoot = safeLaunchRoot(root);
  const launchId = randomUUID().replaceAll("-", "");
  const logPath = join(
    launchRoot,
    `${config.modelId}.${launchId}.log`
  );
  const statusPath = join(launchRoot, `${config.modelId}.latest.json`);
  if (parsed.dryRun) {
    process.stdout.write(`${JSON.stringify({
      status: "passed-detached-neural-training-dry-run",
      modelId: config.modelId,
      candidateRoot: portable(root, layout.candidateRoot),
      executable: command.executable,
      args: command.args.map((value) => portableArgument(root, value)),
      log: portable(root, logPath),
      statusFile: portable(root, statusPath)
    }, null, 2)}\n`);
    return;
  }

  const logDescriptor = openSync(logPath, "wx", 0o600);
  let child;
  try {
    writeSync(
      logDescriptor,
      `${JSON.stringify({
        schemaVersion: 1,
        status: "starting-detached-neural-training",
        launchId,
        launchedAt: new Date().toISOString(),
        modelId: config.modelId,
        config: portable(root, canonicalConfig),
        candidateRoot: portable(root, layout.candidateRoot),
        restartTraining: parsed.restartTraining
      })}\n`
    );
    child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      detached: true,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1"
      },
      stdio: ["ignore", logDescriptor, logDescriptor]
    });
    await waitForSpawn(child);
  } finally {
    closeSync(logDescriptor);
  }
  child.unref();
  await delay(STARTUP_GRACE_MS);
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new TypeError(
      "Detached neural training exited during startup; inspect " +
      `${portable(root, logPath)}.`
    );
  }

  const status = {
    schemaVersion: 1,
    status: "running-detached-neural-training",
    launchId,
    launchedAt: new Date().toISOString(),
    supervisorPid: child.pid,
    modelId: config.modelId,
    config: portable(root, canonicalConfig),
    candidateRoot: portable(root, layout.candidateRoot),
    trainer: portable(root, trainerPath),
    restartTraining: parsed.restartTraining,
    command: {
      executable: command.executable,
      args: command.args.map((value) => portableArgument(root, value))
    },
    log: portable(root, logPath)
  };
  writeJsonAtomically(statusPath, status);
  process.stdout.write(`${JSON.stringify({
    ...status,
    statusFile: portable(root, statusPath)
  }, null, 2)}\n`);
}

function parseArguments(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--dry-run", "--restart-training"].includes(argument)) {
      if (flags.has(argument)) {
        throw new TypeError(`Duplicate option ${argument}.`);
      }
      flags.add(argument);
      continue;
    }
    if (argument !== "--config") {
      throw new TypeError(`Unknown detached-training option ${argument}.`);
    }
    if (values.has(argument)) {
      throw new TypeError(`Duplicate option ${argument}.`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new TypeError("Missing value for --config.");
    }
    values.set(argument, value);
    index += 1;
  }
  if (!values.has("--config")) {
    throw new TypeError("--config is required.");
  }
  return {
    config: values.get("--config"),
    dryRun: flags.has("--dry-run"),
    restartTraining: flags.has("--restart-training")
  };
}

function safeLaunchRoot(root) {
  const temporaryRoot = resolve(root, ".tmp");
  if (existsSync(temporaryRoot) && lstatSync(temporaryRoot).isSymbolicLink()) {
    throw new TypeError(".tmp must not be a symbolic link.");
  }
  mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 });
  const launchRoot = join(temporaryRoot, "neural-training");
  if (existsSync(launchRoot) && lstatSync(launchRoot).isSymbolicLink()) {
    throw new TypeError(".tmp/neural-training must not be a symbolic link.");
  }
  mkdirSync(launchRoot, { recursive: true, mode: 0o700 });
  return launchRoot;
}

function refuseActiveLaunch(candidateRoot) {
  const lockPath = join(candidateRoot, ".training-export.lock");
  if (!existsSync(lockPath)) return;
  const lockStat = lstatSync(lockPath);
  if (lockStat.isSymbolicLink() || !lockStat.isFile()) {
    throw new TypeError("Candidate publication lock is unsafe.");
  }
  const lock = readJson(lockPath, "Candidate publication lock");
  if (lock.status !== "running" ||
      !Number.isSafeInteger(lock.pid) ||
      lock.pid < 1) {
    return;
  }
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    if (error?.code === "EPERM") {
      throw new TypeError(
        `Candidate training may already be running as PID ${lock.pid}.`
      );
    }
    throw error;
  }
  throw new TypeError(
    `Candidate training is already running as PID ${lock.pid}.`
  );
}

function containedRegularFile(root, value, label) {
  const path = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const child = relative(root, path);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) ||
      isAbsolute(child)) {
    throw new TypeError(`${label} must remain inside the repository.`);
  }
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() ||
      !lstatSync(path).isFile() || realpathSync(path) !== path) {
    throw new TypeError(`${label} must be a canonical regular file.`);
  }
  return path;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new TypeError(`${label} is invalid JSON: ${errorMessage(error)}`);
  }
}

function waitForSpawn(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("spawn", resolvePromise);
    child.once("error", rejectPromise);
  });
}

function writeJsonAtomically(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const staging = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(
      staging,
      `${JSON.stringify(value, null, 2)}\n`,
      { flag: "wx", mode: 0o600 }
    );
    renameSync(staging, path);
  } finally {
    if (existsSync(staging)) rmSync(staging);
  }
}

function portable(root, path) {
  return relative(root, resolve(path)).split(sep).join("/");
}

function portableArgument(root, value) {
  if (!isAbsolute(value)) return value;
  const child = relative(root, value);
  return child && child !== ".." && !child.startsWith(`..${sep}`) &&
      !isAbsolute(child)
    ? child.split(sep).join("/")
    : value;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
