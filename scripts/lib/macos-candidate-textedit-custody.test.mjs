import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  candidateTextEditCustodianSource,
  startCandidateTextEditCustodian
} from "./macos-candidate-textedit-custody.mjs";
import {
  exactProcessIdentity,
  processIdentity,
  processPids,
  terminateExactProcess
} from "./macos-imk-host-harness.mjs";

const documents = [];

function privateDocument() {
  const directory = join(
    homedir(),
    "Library", "Application Support", "Lekh Keyboard", "QA Recovery", "Candidate Mouse Probe"
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `.candidate-document.${randomBytes(16).toString("hex")}.txt`);
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeFileSync(descriptor, "probe ", "utf8"); } finally { closeSync(descriptor); }
  documents.push(path);
  return path;
}

async function waitUntil(check, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

afterEach(() => {
  for (const path of documents.splice(0)) rmSync(path, { force: true });
});

describe.skipIf(process.platform !== "darwin")("candidate TextEdit launch custody", () => {
  it("type-checks the exact Swift READY/GO/HOST/RELEASE custodian", () => {
    const source = candidateTextEditCustodianSource({
      documentPath: join(
        homedir(), "Library", "Application Support", "Lekh Keyboard", "QA Recovery",
        "Candidate Mouse Probe", `.candidate-document.${"a".repeat(32)}.txt`
      ),
      parentIdentity: {
        processIdentifier: process.pid,
        executablePath: process.execPath,
        processStartToken: "1:1"
      }
    });
    const compilation = spawnSync("/usr/bin/swiftc", ["-warnings-as-errors", "-typecheck", "-"], {
      input: source,
      encoding: "utf8"
    });
    expect(compilation.status, compilation.stderr).toBe(0);
    expect(source).toContain('NSSelectorFromString("openURLs:withApplicationAtURL:options:configuration:error:")');
    expect(source).toContain("hostEpoch = exact\n  guard parentIsExact() else { abortCustody(77) }");
    expect(source).not.toContain("launchPending");
    expect(source).not.toContain("NSWorkspace.shared.open(");
  });

  it("stays side-effect-free when EOF arrives at READY before GO", async () => {
    const before = processPids("TextEdit").sort((a, b) => a - b);
    const session = startCandidateTextEditCustodian({
      documentPath: privateDocument(),
      parentIdentity: processIdentity(process.pid)
    });
    const ready = await session.waitForReady();
    expect(ready).toMatchObject({ launchCount: 0, sideEffectsAuthorized: false });
    session.abort();
    const completion = await session.closed;
    expect(completion.status).not.toBe(0);
    expect(processPids("TextEdit").sort((a, b) => a - b)).toEqual(before);
  }, 15_000);

  it("terminates the exact fresh TextEdit when its parent is SIGKILLed before RELEASE", async () => {
    const documentPath = privateDocument();
    const statusPath = join(tmpdir(), `lekh-candidate-custody-${randomBytes(16).toString("hex")}.json`);
    const moduleUrl = pathToFileURL(join(process.cwd(), "scripts", "lib", "macos-candidate-textedit-custody.mjs")).href;
    const harnessUrl = pathToFileURL(join(process.cwd(), "scripts", "lib", "macos-imk-host-harness.mjs")).href;
    const fixture = `
import { writeFileSync } from "node:fs";
import { startCandidateTextEditCustodian } from ${JSON.stringify(moduleUrl)};
import { processIdentity } from ${JSON.stringify(harnessUrl)};
const session = startCandidateTextEditCustodian({
  documentPath: ${JSON.stringify(documentPath)},
  parentIdentity: processIdentity(process.pid)
});
await session.waitForReady();
session.authorizeLaunch(processIdentity(session.pid));
const host = await session.waitForHost();
writeFileSync(${JSON.stringify(statusPath)}, JSON.stringify({
  host,
  custodian: processIdentity(session.pid)
}));
setInterval(() => {}, 1_000);
`;
    const parent = spawn(process.execPath, ["--input-type=module", "-e", fixture], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let host = null;
    let custodian = null;
    try {
      const status = await waitUntil(() => {
        if (!existsSync(statusPath)) return null;
        try { return JSON.parse(readFileSync(statusPath, "utf8")); } catch { return null; }
      }, 12_000);
      expect(status).not.toBeNull();
      host = status.host;
      custodian = status.custodian;
      expect(exactProcessIdentity(host)).toMatchObject({ state: "running", matches: true });
      expect(exactProcessIdentity(custodian)).toMatchObject({ state: "running", matches: true });
      parent.kill("SIGKILL");
      await new Promise((resolve) => parent.once("close", resolve));
      const hostGone = await waitUntil(() => {
        const observed = exactProcessIdentity(host);
        return ["absent", "terminated"].includes(observed.state) ||
          (observed.state === "running" && observed.matches === false);
      }, 5_000);
      expect(hostGone).toBe(true);
      const custodianGone = await waitUntil(() => {
        const observed = exactProcessIdentity(custodian);
        return ["absent", "terminated"].includes(observed.state) ||
          (observed.state === "running" && observed.matches === false);
      }, 3_000);
      expect(custodianGone).toBe(true);
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
      if (host) terminateExactProcess(host);
      rmSync(statusPath, { force: true });
    }
  }, 25_000);
});
