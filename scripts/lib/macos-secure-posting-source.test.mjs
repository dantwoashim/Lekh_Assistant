import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  emergencySecureKeyUpSource,
  exactSecurePostingEvidence,
  runtimeProcessEpochIssueCodes,
  secureTargetedPostingSource,
  targetedPostingSource
} from "../check-macos-imk-host-secure-field.mjs";

const fixtureIdentity = Object.freeze({
  processIdentifier: 4242,
  executablePath: "/tmp/lekh-secure-field-host/LekhSecureFieldHost",
  processStartToken: "1784114000:123456"
});

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe.skipIf(process.platform !== "darwin")("secure posting helper", () => {
  it("typechecks the exact atomic AppKit/AX/SEI posting helper", () => {
    const directory = mkdtempSync(join(tmpdir(), "lekh-secure-posting-source-"));
    const sourcePath = join(directory, "main.swift");
    try {
      const source = secureTargetedPostingSource([
        { code: 1, flag: null },
        { code: 49, flag: null }
      ], fixtureIdentity);
      expect(source).not.toContain("swasthya");
      expect(source).not.toContain("kAXValueAttribute");
      writeFileSync(sourcePath, source, { encoding: "utf8", mode: 0o600 });
      execFileSync("/usr/bin/xcrun", [
        "swiftc", "-warnings-as-errors", "-typecheck", sourcePath,
        "-framework", "AppKit", "-framework", "Carbon"
      ], { stdio: "pipe" });
      const emergencyPath = join(directory, "emergency.swift");
      writeFileSync(
        emergencyPath,
        emergencySecureKeyUpSource([{ code: 1, flag: null }], fixtureIdentity),
        { encoding: "utf8", mode: 0o600 }
      );
      execFileSync("/usr/bin/xcrun", [
        "swiftc", "-warnings-as-errors", "-typecheck", emergencyPath,
        "-framework", "AppKit"
      ], { stdio: "pipe" });
      const calibrationPath = join(directory, "calibration.swift");
      writeFileSync(
        calibrationPath,
        targetedPostingSource([{ code: 1, flag: null }], fixtureIdentity),
        { encoding: "utf8", mode: 0o600 }
      );
      execFileSync("/usr/bin/xcrun", [
        "swiftc", "-warnings-as-errors", "-typecheck", calibrationPath,
        "-framework", "AppKit", "-framework", "Carbon"
      ], { stdio: "pipe" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts only the closed content-free posting evidence schema", () => {
    const valid = {
      schemaVersion: 1,
      preconditionPassed: true,
      postconditionPassed: true,
      postedKeyCount: 2,
      sourceIdentifierBefore: "com.apple.keylayout.ABC",
      sourceIdentifierAfter: "com.apple.keylayout.ABC"
    };
    expect(exactSecurePostingEvidence(valid, 2)).toBe(true);
    expect(exactSecurePostingEvidence({ ...valid, candidateText: "forbidden" }, 2)).toBe(false);
    expect(exactSecurePostingEvidence({ ...valid, postedKeyCount: 1 }, 2)).toBe(false);
    expect(exactSecurePostingEvidence({ ...valid, postconditionPassed: false }, 2)).toBe(false);
  });

  it("pins and distinguishes the exact IMK process-birth epoch", () => {
    const expected = {
      processIdentifier: 4242,
      executablePath: "/private/tmp/LekhInputMethodApp",
      processStartToken: "1784114000:123456"
    };
    expect(runtimeProcessEpochIssueCodes(expected, {
      status: 0,
      state: "running",
      ...expected
    })).toEqual([]);
    expect(runtimeProcessEpochIssueCodes(expected, {
      status: 0,
      state: "running",
      ...expected,
      processStartToken: "1784114001:1"
    })).toContain("runtime-process-start-epoch-changed");
    expect(runtimeProcessEpochIssueCodes(expected, {
      status: 0,
      state: "running",
      ...expected,
      executablePath: "/private/tmp/replacement/LekhInputMethodApp"
    })).toContain("runtime-process-executable-changed");
    expect(runtimeProcessEpochIssueCodes(expected, {
      status: 3,
      state: "probe-failed",
      processIdentifier: 4242,
      executablePath: "",
      processStartToken: ""
    })).toContain("runtime-process-instance-unavailable");
  });

  it("balances every post-down secure guard failure only against the exact host epoch", () => {
    const source = secureTargetedPostingSource([{ code: 1, flag: null }], fixtureIdentity);
    const compensation = between(
      source,
      "func compensateOutstandingKeyUp(_ keyUp: CGEvent) -> Bool",
      "func emit("
    );
    expect(compensation).toContain(
      "processInstanceMatches(targetPid, expectedExecutablePath, expectedProcessStartToken)"
    );
    expect(compensation).toContain("keyUp.postToPid(targetPid)");
    expect(compensation).not.toContain("parentPid");
    const loop = between(source, "for pair in pairs {", "let final = secureGuard()");
    const down = loop.indexOf("pair.down.postToPid(targetPid)");
    const beforeUpGuard = loop.indexOf("let beforeUp = secureGuard()");
    const compensationCall = loop.indexOf("_ = compensateOutstandingKeyUp(pair.up)");
    const normalUp = loop.indexOf("pair.up.postToPid(targetPid)");
    expect(down).toBeGreaterThanOrEqual(0);
    expect(beforeUpGuard).toBeGreaterThan(down);
    expect(compensationCall).toBeGreaterThan(beforeUpGuard);
    expect(normalUp).toBeGreaterThan(compensationCall);
  });

  it("balances every post-down calibration guard failure only against the exact host epoch", () => {
    const source = targetedPostingSource([{ code: 1, flag: null }], fixtureIdentity);
    const compensation = between(
      source,
      "func compensateCalibrationKeyUp(_ keyUp: CGEvent) -> Bool",
      "guard exactCalibrationContext() else { exit(10) }"
    );
    expect(compensation).toContain(
      "exactProcessInstance(targetPid, expectedExecutablePath, expectedProcessStartToken)"
    );
    expect(compensation).toContain("keyUp.postToPid(targetPid)");
    expect(compensation).not.toContain("parentPid");
    const loopStart = source.indexOf("for event in events {");
    expect(loopStart).toBeGreaterThanOrEqual(0);
    const loop = source.slice(loopStart);
    const down = loop.indexOf("down.postToPid(targetPid)");
    const guard = loop.indexOf("guard exactCalibrationContext() else {", down);
    const compensationCall = loop.indexOf("_ = compensateCalibrationKeyUp(up)");
    const normalUp = loop.lastIndexOf("up.postToPid(targetPid)");
    expect(down).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(down);
    expect(compensationCall).toBeGreaterThan(guard);
    expect(normalUp).toBeGreaterThan(compensationCall);
  });
});
